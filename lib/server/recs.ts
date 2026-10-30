import { and, eq, isNotNull } from 'drizzle-orm';
import { schema, type Db } from './db';
import { todayIsoDate, tsToIso } from './serialize';
import { sameWork } from './dedup';
import { cardChips, cardYear, plainDescription } from './recDisplay';

/** Port of schemas.py::RecommendationOut (note: no reject_reasons field). The row keeps
 *  the raw catalog fields; the wire carries the card's view of them (recDisplay.ts). */
export function recOut(r: typeof schema.recommendations.$inferSelect) {
  return {
    id: r.id,
    run_id: r.runId,
    rank: r.rank,
    title: r.title,
    author: r.author,
    year: cardYear(r.year, r.description),
    isbn13: r.isbn13,
    cover_url: r.coverUrl,
    subjects: cardChips(r.subjects as unknown[] | null),
    description: plainDescription(r.description),
    catalog_source: r.catalogSource,
    catalog_id: r.catalogId,
    retrieval_pool: r.retrievalPool,
    seed_reason: r.seedReason,
    score: r.score,
    rationale: r.rationale,
    grounded_trait_ids: r.groundedTraitIds,
    grounded_book_ids: r.groundedBookIds,
    status: r.status,
    user_note: r.userNote,
    created_at: tsToIso(r.createdAt),
  };
}

/** Port of feedback_vocab.REJECT_REASONS — order matters for the pyList() 422 detail. */
export const REJECT_REASONS = [
  'wrong_genre',
  'too_dark',
  'tried_author',
  'too_long',
  'not_now',
  'overhyped',
  'wrong_vibe',
  // Book-only additions (QA 2026-10). reject_reasons is a json column, so a new code needs
  // no migration; the rerank prompt reads the codes verbatim, so they say what they mean.
  'too_similar',
  'not_out_yet',
  'not_my_kind',
] as const;

type RecRow = typeof schema.recommendations.$inferSelect;

/** Idempotently land a recommended book in the user's library on `shelf`.
 *  Port of api.py::_ensure_library_book (same-work dedup, stub enrichment). */
export async function ensureLibraryBook(db: Db, rec: RecRow, shelf: string, userId: string) {
  const existing = await db
    .select()
    .from(schema.books)
    .where(and(eq(schema.books.userId, userId), isNotNull(schema.books.title)));
  for (const b of existing) {
    if (sameWork(b.title, b.author, rec.title, rec.author)) {
      const enr =
        (await db.select().from(schema.enrichment).where(eq(schema.enrichment.bookId, b.id)))[0] ??
        null;
      return { book: b, enrichment: enr };
    }
  }
  const [book] = await db
    .insert(schema.books)
    .values({
      userId,
      title: rec.title,
      author: rec.author,
      isbn13: rec.isbn13,
      // The card's year, so a mis-dated catalog edition does not land on the shelf either.
      yearPublished: cardYear(rec.year, rec.description),
      exclusiveShelf: shelf,
      // Without it a swiped book has no date added, so it sinks below every imported
      // book in the to-read shelf's "Date added" sort (#138).
      dateAdded: todayIsoDate(),
      source: 'recommendation',
      goodreadsRating: 0,
    })
    .returning();
  const [enr] = await db
    .insert(schema.enrichment)
    .values({
      bookId: book.id,
      resolvedSource: rec.catalogSource,
      resolvedId: rec.catalogId,
      subjects: rec.subjects,
      description: rec.description,
      coverUrl: rec.coverUrl,
      resolutionConfidence: 1.0,
      confidenceLabel: 'RECOMMENDATION',
      matchMethod: 'recommendation_' + shelf,
    })
    .returning();
  return { book, enrichment: enr };
}
