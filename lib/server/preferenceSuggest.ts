/**
 * Deterministic "suggest from your library" for the favorites editor. No Claude
 * call, no catalog call, no cost.
 *
 * Counts over LOVED books only — the same effectiveRating >= LOVED_MIN rule
 * recSignal.ts uses — deliberately: suggestions must reflect what actually drives
 * the recommender, not what merely fills the shelf.
 *
 * This deliberately does NOT extract buildSignal's counting loop. buildSignal is a
 * five-query function carrying byte-parity commitments, and its loop is interleaved
 * with library-key, series and loved-book accumulation; a separate simpler query is
 * the cheaper and safer choice.
 */
import { asc, eq } from 'drizzle-orm';
import { schema, type Db } from './db';
import { authorExcluded, subjectExcluded } from './exclusions';
import { LOVED_MIN, mostCommon } from './recSignal';
import { effectiveRating } from './serialize';

/** Proposals per family, before the reader's own lists are subtracted. */
const SUGGESTION_LIMIT = 12;

export interface Suggestion {
  value: string;
  count: number;
}

export interface PreferenceSuggestions {
  subjects: Suggestion[];
  authors: Suggestion[];
}

/** Lowercased fold of the values already on the reader's FAVORITES list. Exact match is
 *  right here and only here: these are values this same editor wrote, so accepting a
 *  suggestion must remove precisely that suggestion from the row. */
function claimed(constraints: Record<string, unknown>, key: string): Set<string> {
  const out = new Set<string>();
  for (const v of (Array.isArray(constraints[key]) ? constraints[key] : []) as unknown[]) {
    const s = String(v).trim().toLowerCase();
    if (s) out.add(s);
  }
  return out;
}

/**
 * Filter BEFORE truncating, so a reader who accepts a suggestion sees it replaced by
 * the next candidate rather than sees a shorter list. mostCommon keeps the
 * recommender's own tie ordering, so a suggestion list never disagrees with
 * top_subjects / top_authors.
 *
 * `excluded` is the recommender's own matching rule rather than a set lookup, because a
 * suggestion carries the library's VERBATIM value ('Frank Herbert', 'Space Opera') while
 * exclusions are surnames and whole-word subject terms. Comparing folded strings offered
 * the reader a favorite that applyDirectiveConstraints would delete the moment they
 * accepted it.
 */
function pick(
  counts: Map<string, number>,
  favorites: Set<string>,
  excluded: (value: string) => boolean
): Suggestion[] {
  const open = new Map<string, number>();
  for (const [value, count] of counts) {
    if (favorites.has(value.trim().toLowerCase())) continue;
    if (excluded(value)) continue;
    open.set(value, count);
  }
  return mostCommon(open, SUGGESTION_LIMIT).map((value) => ({
    value,
    count: open.get(value) as number,
  }));
}

export async function suggestPreferences(
  db: Db,
  userId: string,
  constraints: Record<string, unknown>
): Promise<PreferenceSuggestions> {
  const rows = await db
    .select({ b: schema.books, enr: schema.enrichment })
    .from(schema.books)
    // Safe against fan-out: enrichment.book_id carries a UNIQUE index, so this is 1:1.
    .leftJoin(schema.enrichment, eq(schema.enrichment.bookId, schema.books.id))
    .where(eq(schema.books.userId, userId))
    // Explicit order so mostCommon's insertion-order tiebreak is deterministic.
    .orderBy(asc(schema.books.id));

  const subjectCounts = new Map<string, number>();
  const authorCounts = new Map<string, number>();
  for (const { b, enr } of rows) {
    const rating = effectiveRating(b.appRating, b.goodreadsRating);
    if (rating === null || rating < LOVED_MIN) continue;
    for (const s of ((enr?.subjects as string[] | null) ?? []) as string[]) {
      subjectCounts.set(s, (subjectCounts.get(s) ?? 0) + 1);
    }
    // The verbatim string, matching top_authors: this value is handed to
    // googleBooksAuthor as a query.
    if (b.author) authorCounts.set(b.author, (authorCounts.get(b.author) ?? 0) + 1);
  }

  return {
    subjects: pick(subjectCounts, claimed(constraints, 'prefer_subjects'), (v) =>
      subjectExcluded(v, constraints.exclude_subjects)
    ),
    authors: pick(authorCounts, claimed(constraints, 'prefer_authors'), (v) =>
      authorExcluded(v, constraints.exclude_authors)
    ),
  };
}
