/**
 * Bulk catalog matching for onboarding: a pasted list of titles, or the curated quick-rate
 * picks. Every item goes through the add-a-book search (catalog.searchBooks and its
 * ranking), so a match is always a real catalog record the reader then confirms; nothing
 * here writes to the library.
 *
 * A request runs a bounded number of lookups at once under a time budget. Items the budget
 * did not reach come back `pending`, and the client sends them again in its next batch, so
 * no single invocation gets near the function ceiling however slow the catalogs are.
 */
import { plausibleYear, searchBooks, searchScore, type Candidate } from './catalog';
import { titleSeedMatch } from './recAssemble';
import { hasSameWork, type LibraryWork } from './addBook';
import { surname } from './dedup';

/** The add-a-book search result shape (GET /api/catalog/search). */
export interface CatalogHit {
  source: string;
  catalog_id: string | null;
  title: string;
  author: string | null;
  year: number | null;
  year_kind: 'first_published' | 'edition' | null;
  isbn13: string | null;
  cover_url: string | null;
  subjects: string[] | null;
  description: string | null;
}

export interface MatchedHit extends CatalogHit {
  /** The same work is already in this reader's library (dedup.sameWork). */
  in_library: boolean;
}

/** Shapes one search hit for the browser. Shared with GET /api/catalog/search. */
export function catalogHitOut(h: Candidate): CatalogHit {
  // Readers check a hit by its original year (Beloved, 1987), so show that when Open
  // Library gave one. A Google Books year alone is an edition's, and says so.
  const firstYear = plausibleYear(h.first_publish_year);
  const year = firstYear ?? plausibleYear(h.year);
  return {
    source: h.source ?? 'unknown',
    catalog_id: h.resolved_id ?? null,
    title: h.title ?? '',
    author: h.author ?? null,
    year,
    year_kind: firstYear ? 'first_published' : year ? 'edition' : null,
    isbn13: h.isbn13 ?? null,
    cover_url: h.cover_url ?? null,
    subjects: h.subjects ?? null,
    description: h.description ?? null,
  };
}

export interface MatchItem {
  title: string;
  author: string | null;
}

/**
 * `best`: the paste flow. The top-ranked hit when it clears MATCH_FLOOR (a named author
 * prefers the hit that is strongly that book), plus alternatives for "Not this book".
 * `strict`: the quick-rate grid. Only a hit that is strongly the named title by the named
 * author (recAssemble.titleSeedMatch, the cold-start seed rule); otherwise unmatched.
 */
export type MatchMode = 'best' | 'strict';

export type MatchResult =
  | { index: number; status: 'matched'; best: MatchedHit; alternatives: MatchedHit[] }
  | { index: number; status: 'unmatched' }
  | { index: number; status: 'pending' };

/** Most items one match request takes; the client sends smaller batches. */
export const MATCH_BATCH_MAX = 25;
/** Wall-clock budget for one match request's lookups. */
export const MATCH_BUDGET_MS = 20_000;
/** Lookups in flight at once. catalog.ts spaces the requests themselves. */
export const MATCH_CONCURRENCY = 3;
/** Hits shown per line: one best match plus a few alternatives. */
export const MATCH_HITS = 5;
/**
 * Hits fetched per line. The title-and-author query ranks records that put the author in
 * their own title ("Middlemarch George Eliot", study guides titled "Middlemarch, George
 * Eliot") above the book itself, so the book can sit below the first five; a wider fetch
 * keeps it in reach of rankForItem.
 */
export const MATCH_FETCH = 10;
/**
 * The lowest searchScore accepted as a match without an author: every query word in the
 * title (60) or the query inside the title (40). Below it the catalog only matched an
 * author's name or nothing at all, which is not this line's book.
 */
export const MATCH_FLOOR = 40;

export interface MatchOptions {
  mode: MatchMode;
  search: (query: string, limit: number) => Promise<Candidate[]>;
  /** The reader's library, for in_library flags. */
  library: LibraryWork[];
  budgetMs?: number;
  concurrency?: number;
  now?: () => number;
}

function queryFor(item: MatchItem): string {
  return item.author ? `${item.title} ${item.author}` : item.title;
}

// Anthologies and unattributed records, which win exact-title ties on a line with no author
// ("The Sense of an Ending" by Various over Julian Barnes's novel).
const COLLECTIVE_AUTHOR = /^(?:various|anonymous|unknown)\b/i;

function itemScore(item: MatchItem, h: Candidate): number {
  // Score the title against the line's title alone, so a record whose title is
  // "<title> <author>" no longer outscores the book, then credit the named author.
  let score = searchScore(item.title, h);
  if (item.author && surname(h.author ?? null) === surname(item.author)) score += 20;
  if (COLLECTIVE_AUTHOR.test((h.author ?? '').trim())) score -= 30;
  return score;
}

/** Orders one line's hits for that line: its own score, then a cover. Stable on ties. */
export function rankForItem(item: MatchItem, hits: Candidate[]): Candidate[] {
  const key = (h: Candidate) => [itemScore(item, h), h.cover_url ? 1 : 0];
  return [...hits].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return kb[i] - ka[i];
    return 0;
  });
}

function pickBest(item: MatchItem, hits: Candidate[], mode: MatchMode): Candidate | null {
  const strong = titleSeedMatch(item, hits);
  if (mode === 'strict' || strong) return strong;
  const q = queryFor(item);
  return hits.find((h) => h.title && searchScore(q, h) >= MATCH_FLOOR) ?? null;
}

async function matchOne(item: MatchItem, index: number, opts: MatchOptions): Promise<MatchResult> {
  let hits: Candidate[];
  try {
    hits = rankForItem(
      item,
      (await opts.search(queryFor(item), MATCH_FETCH)).filter((h) => h.title)
    );
  } catch {
    // A lookup that threw is not "no such book", but retrying it in the next batch risks a
    // loop; the reader can still search the line by hand from the review screen.
    return { index, status: 'unmatched' };
  }
  const best = pickBest(item, hits, opts.mode);
  if (!best) return { index, status: 'unmatched' };
  const out = (h: Candidate): MatchedHit => {
    const hit = catalogHitOut(h);
    return { ...hit, in_library: hasSameWork(opts.library, hit.title, hit.author) };
  };
  const alternatives =
    opts.mode === 'strict'
      ? []
      : hits
          .filter((h) => h !== best)
          .slice(0, MATCH_HITS - 1)
          .map(out);
  return { index, status: 'matched', best: out(best), alternatives };
}

/**
 * Match `items` in order with at most `concurrency` lookups in flight. A lookup starts only
 * while the budget lasts; anything not started is returned `pending`.
 */
export async function matchItems(items: MatchItem[], opts: MatchOptions): Promise<MatchResult[]> {
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.budgetMs ?? MATCH_BUDGET_MS);
  const results: MatchResult[] = items.map((_, index) => ({ index, status: 'pending' }));
  let next = 0;
  const worker = async () => {
    while (next < items.length && now() < deadline) {
      const index = next++;
      results[index] = await matchOne(items[index], index, opts);
    }
  };
  const workers = Math.max(1, Math.min(opts.concurrency ?? MATCH_CONCURRENCY, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

/** The default search: the add-a-book catalog search. */
export function catalogSearch(db: Parameters<typeof searchBooks>[0]) {
  return (query: string, limit: number) => searchBooks(db, query, limit);
}
