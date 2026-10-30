/**
 * "Wrong genre" should teach. A reader who skips "Ghiblipedia" as the wrong genre must
 * not be served "Miyazaki and the Hero's Journey" next: the skip names the book's
 * genre, not the book. So the primary subjects (books) or genres (screen) of the most
 * recent wrong_genre rejections are suppressed in later runs: retrieval drops
 * candidates whose own primary subjects share one, and the reranker is told why.
 *
 * A genre the reader rates highly is NOT suppressed. When two or more of their loved
 * (4+) books or titles carry it, or they marked it a favorite subject, the rejection
 * was about something else, so the genre stays a soft signal for the reranker only.
 *
 * Matching is exact on a normalized heading, primary against primary, never whole-word
 * containment: a rejected "History" must not trip every "Science fiction -- history and
 * criticism". Catalog bookkeeping headings ("Fiction", "Accessible book", "nyt:...")
 * are not genres and are skipped wherever primary subjects are read.
 */
import type { PoolEntry } from './recAssemble';
import { dedupKey } from './recFilters';

export const WRONG_GENRE = 'wrong_genre';
/** How many of the most recent wrong_genre rejections still steer retrieval. */
export const RECENT_WRONG_GENRE = 10;
/** Leading non-generic subjects (or genres) that stand for an item's genre. */
export const PRIMARY_GENRES = 3;
/** Loved items carrying a genre that make a wrong_genre rejection of it soft. */
export const LOVED_GENRE_PROTECT = 2;

export interface GenreSuppression {
  /** Normalized genres retrieval drops and the reranker penalizes. */
  suppressed: string[];
  /** Normalized genres rejected as wrong but rated highly: a reranker hint only. */
  soft: string[];
}

export function emptyGenreSuppression(): GenreSuppression {
  return { suppressed: [], soft: [] };
}

/** Headings that describe the record, not its genre (Open Library and Google tags). */
const GENERIC_GENRES = new Set([
  'fiction',
  'fiction, general',
  'general',
  'nonfiction',
  'non-fiction',
  'literature',
  'novel',
  'novels',
  'english fiction',
  'american fiction',
  'accessible book',
  'protected daisy',
  'in library',
  'lending library',
  'large type books',
  'open library staff picks',
  'internet archive wishlist',
  // Screen: every candidate is one of these.
  'film',
  'feature film',
  'television series',
  'television program',
  'tv series',
]);

export function normGenre(s: unknown): string {
  return typeof s === 'string'
    ? s
        .normalize('NFKC')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/[\s.;,]+$/, '')
        .trim()
    : '';
}

function isGeneric(g: string): boolean {
  return (
    !g ||
    GENERIC_GENRES.has(g) ||
    g.startsWith('nyt:') ||
    g.startsWith('reading level') ||
    g.includes('=')
  );
}

/** The first `n` distinct non-generic subjects of an item, normalized. */
export function primaryGenres(subjects: unknown, n: number = PRIMARY_GENRES): string[] {
  const out: string[] = [];
  for (const raw of Array.isArray(subjects) ? subjects : []) {
    const g = normGenre(raw);
    if (isGeneric(g) || out.includes(g)) continue;
    out.push(g);
    if (out.length >= n) break;
  }
  return out;
}

/** Count each normalized, non-generic subject once per loved item. MUTATES `counts`. */
export function countLovedGenres(counts: Map<string, number>, subjects: unknown): void {
  const seen = new Set<string>();
  for (const raw of Array.isArray(subjects) ? subjects : []) {
    const g = normGenre(raw);
    if (isGeneric(g) || seen.has(g)) continue;
    seen.add(g);
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
}

export interface RejectionWithGenres {
  rejectReasons: unknown;
  genres: unknown;
}

/**
 * Derive the suppression from rejections given OLDEST FIRST (the order both signals
 * read them in). Only the RECENT_WRONG_GENRE most recent wrong_genre rejections count.
 * Output lists keep most-recent-first order, so the prompt leads with the latest skip.
 */
export function deriveGenreSuppression(
  rejections: RejectionWithGenres[],
  lovedGenreCounts: Map<string, number>,
  favoriteGenres: readonly string[] = []
): GenreSuppression {
  const favorites = new Set(favoriteGenres.map(normGenre).filter(Boolean));
  const recent = rejections
    .filter((r) => Array.isArray(r.rejectReasons) && r.rejectReasons.includes(WRONG_GENRE))
    .slice(-RECENT_WRONG_GENRE)
    .reverse();
  const suppressed: string[] = [];
  const soft: string[] = [];
  for (const r of recent) {
    for (const g of primaryGenres(r.genres)) {
      if (suppressed.includes(g) || soft.includes(g)) continue;
      const loved = (lovedGenreCounts.get(g) ?? 0) >= LOVED_GENRE_PROTECT || favorites.has(g);
      (loved ? soft : suppressed).push(g);
    }
  }
  return { suppressed, soft };
}

/** Does an item's own primary subject list share a suppressed genre? */
export function hitsSuppressedGenre(subjects: unknown, suppressed: readonly string[]): boolean {
  if (!suppressed.length) return false;
  return primaryGenres(subjects).some((g) => suppressed.includes(g));
}

/**
 * Drop every book whose pool entries carry a suppressed genre, from every pool. Keyed
 * by dedupKey, so a book Google tags "Performing Arts" goes even when its Open Library
 * twin, merged into the same candidate by assemble(), carries other headings. Runs
 * BEFORE assemble so the cap is spent on candidates that can survive.
 */
export function dropSuppressedGenreEntries(
  pools: PoolEntry[][],
  suppressed: readonly string[]
): PoolEntry[][] {
  if (!suppressed.length) return pools;
  const poisoned = new Set<string>();
  for (const pool of pools) {
    for (const [cand] of pool) {
      if (hitsSuppressedGenre(cand.subjects, suppressed)) {
        poisoned.add(dedupKey(cand.title, cand.author ?? null));
      }
    }
  }
  if (!poisoned.size) return pools;
  return pools.map((pool) =>
    pool.filter(([cand]) => !poisoned.has(dedupKey(cand.title, cand.author ?? null)))
  );
}
