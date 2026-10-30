/**
 * The one manual-add path. `POST /api/books` (the add-a-book modal, Discover, Similar books)
 * and `POST /api/books/bulk` (a pasted list, the quick-rate grid) both go through these
 * functions, so validation, the same-work duplicate rule, date handling and the `MANUAL`
 * enrichment row are identical however a book arrives. Do not write a second insert.
 */
import { and, eq, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Db } from './db';
import { ApiError } from './errors';
import { bookOut, VALID_SHELVES } from './books';
import { pyList, todayIsoDate, utcnowTs } from './serialize';
import { sameWork } from './dedup';
import { isValidRating } from './rating';

export const AddBookSchema = z.object({
  title: z.string(),
  author: z.string().nullish(),
  year: z.number().int().nullish(),
  isbn13: z.string().nullish(),
  shelf: z.string().default('read'),
  // Deliberately permissive: the manual isValidRating guard below owns the stable 422 message.
  rating: z.number().nullish(),
  review: z.string().nullish(),
  cover_url: z.string().nullish(),
  subjects: z.array(z.string()).nullish(),
  description: z.string().nullish(),
  catalog_source: z.string().nullish(),
  catalog_id: z.string().nullish(),
  // Same shape as PATCH /books/{id}/feedback's date_read.
  date_read: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish(),
});

export type AddBookBody = z.infer<typeof AddBookSchema>;

export interface ValidAddBook {
  body: AddBookBody;
  title: string;
  author: string | null;
  isbn13: string | null;
  review: string | null;
}

/** Port of library.add_book's validation. Order matters for parity; throws ApiError(422). */
export function validateAddBook(b: AddBookBody): ValidAddBook {
  const title = (b.title ?? '').trim();
  if (!title) throw new ApiError(422, 'title is required.');
  if (!VALID_SHELVES.includes(b.shelf)) {
    throw new ApiError(422, `shelf must be one of ${pyList(VALID_SHELVES)}.`);
  }
  // 0 is the "unrated" sentinel, not a rating.
  if (b.rating != null && b.rating !== 0 && !isValidRating(b.rating)) {
    throw new ApiError(
      422,
      'rating must be 0.5 to 5 in half-star steps (or omitted/0 for unrated).'
    );
  }
  const author = (b.author ?? '').trim() || null;
  const isbn13 = (b.isbn13 ?? '').trim() || null;
  const review = (b.review ?? '').trim() || null;
  if (review && (b.rating == null || b.rating === 0)) {
    throw new ApiError(
      422,
      'A review requires a rating (0.5 to 5). Rate the book, or omit the review.'
    );
  }
  return { body: b, title, author, isbn13, review };
}

export interface LibraryWork {
  title: string | null;
  author: string | null;
}

/** Every titled book in this user's library, for the same-work duplicate walk. */
export async function libraryWorks(db: Db, userId: string): Promise<LibraryWork[]> {
  return db
    .select({ title: schema.books.title, author: schema.books.author })
    .from(schema.books)
    .where(and(eq(schema.books.userId, userId), isNotNull(schema.books.title)));
}

/** Same-work identity (enrich.py::_same_work) against a list of works. */
export function hasSameWork(
  works: LibraryWork[],
  title: string | null,
  author: string | null
): boolean {
  return works.some((row) => sameWork(row.title, row.author, title, author));
}

/** Insert one validated book (and its catalog enrichment row, if any) for `userId`. */
export async function insertManualBook(db: Db, userId: string, v: ValidAddBook) {
  const b = v.body;
  const rated = b.rating != null && b.rating !== 0;
  const { book, enr } = await db.transaction(async (tx) => {
    const [book] = await tx
      .insert(schema.books)
      .values({
        userId,
        title: v.title,
        author: v.author,
        isbn13: v.isbn13,
        yearPublished: b.year ?? null,
        exclusiveShelf: b.shelf,
        source: 'manual',
        goodreadsRating: 0,
        dateAdded: todayIsoDate(),
        dateRead: b.date_read ?? null,
        appRating: rated ? b.rating : null,
        appReview: v.review,
        feedbackUpdatedAt: rated || v.review ? utcnowTs() : null,
      })
      .returning();

    // An unrated to-read book is filtered out of every background enrichment run, so a
    // description dropped here is never backfilled. Persist what the catalog already gave us.
    let enr = null;
    if (b.cover_url || b.subjects || b.description || b.catalog_source || b.catalog_id) {
      [enr] = await tx
        .insert(schema.enrichment)
        .values({
          bookId: book.id,
          resolvedSource: b.catalog_source ?? null,
          resolvedId: b.catalog_id ?? null,
          subjects: b.subjects ?? [],
          description: b.description ?? null,
          coverUrl: b.cover_url ?? null,
          resolutionConfidence: 1.0,
          confidenceLabel: 'MANUAL',
          matchMethod: 'manual_add',
          resolvedAt: utcnowTs(),
        })
        .returning();
    }
    return { book, enr };
  });
  return bookOut(book, enr);
}

/** Most books one bulk add takes: the paste parser's cap. */
export const BULK_ADD_MAX = 200;

export interface BulkAddOutcome {
  added: ReturnType<typeof bookOut>[];
  /** Already in the library, or the same work earlier in this request. Never inserted. */
  duplicates: { index: number; title: string }[];
  errors: { index: number; title: string; detail: string }[];
}

/**
 * Add many books through the single-add path: each is validated and inserted exactly as
 * `POST /api/books` would, and a duplicate is reported rather than raised, so one bad row
 * does not cost the reader the rest. The library is read once; books added earlier in the
 * same request count as owned for the ones after them.
 */
export async function addBooks(db: Db, userId: string, books: unknown[]): Promise<BulkAddOutcome> {
  const out: BulkAddOutcome = { added: [], duplicates: [], errors: [] };
  const works = await libraryWorks(db, userId);
  for (const [index, raw] of books.entries()) {
    const rawTitle =
      raw && typeof raw === 'object' && typeof (raw as { title?: unknown }).title === 'string'
        ? (raw as { title: string }).title
        : '';
    const parsed = AddBookSchema.safeParse(raw);
    if (!parsed.success) {
      out.errors.push({
        index,
        title: rawTitle,
        detail: `validation error: ${parsed.error.issues[0]?.message ?? 'invalid body'}`,
      });
      continue;
    }
    let valid: ValidAddBook;
    try {
      valid = validateAddBook(parsed.data);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      out.errors.push({ index, title: rawTitle, detail: err.detail });
      continue;
    }
    if (hasSameWork(works, valid.title, valid.author)) {
      out.duplicates.push({ index, title: valid.title });
      continue;
    }
    out.added.push(await insertManualBook(db, userId, valid));
    works.push({ title: valid.title, author: valid.author });
  }
  return out;
}
