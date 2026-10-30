/**
 * Stage 1 retrieval: port of recommend._metadata_pool, _seed_pool, _assemble,
 * _cap_pool and _fill_ol_descriptions.
 *
 * Every catalog call is awaited SEQUENTIALLY, exactly as Python runs them. Do not
 * "optimize" these loops into Promise.all: the request order is what the recorded
 * catalog fixture replays, and catalog.ts's throttle assumes serial calls.
 */
import {
  googleBooksAuthor,
  googleBooksQuery,
  googleBooksSubject,
  openlibraryAuthor,
  openlibraryQuery,
  openlibrarySubject,
  openlibraryWorkDescription,
  plausibleYear,
  searchBooks,
  SEARCH_FETCH,
  type Candidate,
} from './catalog';
import type { Db } from './db';
import { hasPublisherAuthor } from './publisherAuthor';
import { surname } from './dedup';
import {
  allowedLanguages,
  applyAuthorCaps,
  dedupKey,
  descriptionSeriesOk,
  EMPTY_DEDUP_KEY,
  fuzzyDuplicate,
  isCollectionEdition,
  isLearnerEdition,
  isTranslatedLibraryEdition,
  isUnreleased,
  languageOk,
  seriesOk,
  subjectHits,
} from './recFilters';
import { genreLabel } from './libraryShape';
import { TOP_AUTHORS, TOP_SUBJECTS } from './recSignal';
import type { RecSignal } from './recSignal';
import { pyRoundHalfEven } from './serialize';
import { STRONG_SIM, titleSim } from './similarity';

/** recommend.py:53-56 tuning knobs. */
export const PER_QUERY = 8; // catalog hits per subject/author/seed query
export const SEED_QUERIES = 8; // search terms to ask Claude to propose
export const MAX_CANDIDATES = 60; // cap on the pool handed to the reranker (token budget)
export const SEED_RESERVE_SHARE = 0.3; // min share of the cap reserved for seed-only candidates
export const PER_AUTHOR = 20; // books fetched per author a discovery request names

/** Python's (candidate, reason) tuple. */
export type PoolEntry = [Candidate, string];

/**
 * The reader's explicit favorites, handed to metadataPool as an EXPLICIT argument
 * rather than pre-merged into the signal: cold start must treat preferred and
 * inferred authors differently, and a merged list cannot express that.
 */
export interface PoolPreferences {
  prefer_subjects: string[];
  prefer_authors: string[];
}

export interface AssembledCandidate {
  title: string;
  author: string | null;
  year: number | null;
  isbn13: string | null;
  subjects: string[];
  description: string | null;
  cover_url: string | null;
  catalog_source: string | null;
  catalog_id: string | null;
  language: string | null;
  seed_reason: string;
  retrieval_pool: string;
}

/** The subset of the signal that assembly reads — lets 3c-2/3c-3 pass a book-anchored signal. */
export type AssembleSignal = Pick<
  RecSignal,
  | 'library_keys'
  | 'library_isbns'
  | 'library_series'
  | 'library_titles'
  | 'library_languages'
  | 'library_authors'
>;

/** Inferred slots that survive the merge in each list, so a full favorites list can
 *  never silence the taste profile entirely. */
const INFERRED_RESERVE = 2;

/**
 * Merge-and-truncate, NOT an additive budget: preferred entries take slots from
 * inferred ones wherever the inferred list is already full, and the merged list is
 * still capped at the same TOP_* limit, so the per-run catalog-call CEILING does not
 * move. (A specific run can still gain calls — cold start issues no author calls
 * today, and an under-full inferred list has spare slots.)
 *
 * Returns [value, isPreferred] pairs, preferred first.
 *
 * DEDUP IS ONE-DIRECTIONAL ON PURPOSE: an inferred entry is skipped only when it
 * collides with a PREFERRED one. Inferred entries are never deduplicated against
 * each other, because today's metadataPool does not deduplicate them either --
 * /similar feeds it raw `enrichment.subjects` (recSignal.ts:363, only sliced to
 * TOP_SUBJECTS), which can hold duplicates and case variants. Folding those together
 * would silently change /similar's recorded catalog call sequence. With an empty
 * `preferred` this function is therefore a pass-through.
 *
 * THIS TRUNCATION IS RETRIEVAL-ONLY. It governs which favorites spend a catalog
 * call; recPrompts renders the FULL stored list (up to MAX_PREFER_ENTRIES), so a
 * favorite past this cut still boosts any candidate that reaches the reranker by
 * another route.
 */
function mergePreferred(
  preferred: string[],
  inferred: string[],
  limit: number
): Array<[string, boolean]> {
  const out: Array<[string, boolean]> = [];
  const claimed = new Set<string>();
  for (const value of preferred.slice(0, Math.max(0, limit - INFERRED_RESERVE))) {
    const fold = value.toLowerCase();
    if (claimed.has(fold)) continue;
    claimed.add(fold);
    out.push([value, true]);
  }
  for (const value of inferred) {
    if (out.length >= limit) break;
    // Note: `value` is NOT added to `claimed` — see the one-directional note above.
    if (claimed.has(value.toLowerCase())) continue;
    out.push([value, false]);
  }
  return out.slice(0, limit);
}

/**
 * Deterministic expansion from the reader's loved subjects/authors, merged with the
 * favorites they named explicitly. In cold-start (thin library) INFERRED author
 * expansion is skipped -- it produces same-author clones -- and discovery leans on
 * subjects plus the Claude-seeded comp queries; explicit favorite authors bypass that
 * skip, because a stated favorite is not an inference.
 */
export async function metadataPool(
  db: Db,
  signal: Pick<RecSignal, 'top_subjects' | 'top_authors'>,
  perQuery: number,
  coldStart: boolean,
  preferences: PoolPreferences = { prefer_subjects: [], prefer_authors: [] }
): Promise<PoolEntry[]> {
  const pool: PoolEntry[] = [];
  for (const [subject, preferred] of mergePreferred(
    preferences.prefer_subjects,
    signal.top_subjects,
    TOP_SUBJECTS
  )) {
    const reason = `${preferred ? 'preferred_subject' : 'subject'}:${subject}`;
    for (const c of await openlibrarySubject(db, subject, perQuery)) pool.push([c, reason]);
    for (const c of await googleBooksSubject(db, subject, perQuery)) pool.push([c, reason]);
  }
  // Preferred authors are queried FIRST and ALWAYS, cold start included: the cold-start
  // skip exists because inferred authors are unreliable in a thin library, and an
  // explicit favorite is not an inference. Inferred authors keep today's behavior.
  for (const [author, preferred] of mergePreferred(
    preferences.prefer_authors,
    coldStart ? [] : signal.top_authors,
    TOP_AUTHORS
  )) {
    const reason = `${preferred ? 'preferred_author' : 'author'}:${author}`;
    // Open Library first, as for subjects: Google's inauthor: operator has answered
    // totalItems 0 with no error since at least 2026-10-20 (#123), which left author
    // expansion, explicit favorites included, with no candidates at all. Google stays
    // in case the operator comes back.
    for (const c of await openlibraryAuthor(db, author, perQuery)) pool.push([c, reason]);
    for (const c of await googleBooksAuthor(db, author, perQuery)) pool.push([c, reason]);
  }
  return pool;
}

/** Run Claude's proposed search terms against the live catalog (recommend._seed_pool). */
export async function seedPool(db: Db, queries: string[], perQuery: number): Promise<PoolEntry[]> {
  const pool: PoolEntry[] = [];
  for (const q of queries) {
    for (const c of await googleBooksQuery(db, q, perQuery)) {
      pool.push([c, `query:${q}`]);
    }
  }
  return pool;
}

/** A real book Claude named at cold start, to be looked up (recPrompts' TITLE_SEED_TOOL). */
export interface TitleSeed {
  title: string;
  author: string;
  reason: string;
}

/** seed_reason prefix of a resolved title seed; capPool keeps these ahead of keyword hits. */
export const TITLE_SEED_PREFIX = 'title:';
/** Catalog time the cold-start title lookups may spend before the rest are skipped. */
export const TITLE_SEED_BUDGET_MS = 60_000;
/** searchBooks hits examined per title seed. */
const TITLE_SEED_HITS = 5;

/**
 * The catalog hit that IS the named book: a strongly similar title (the subtitle dropped, as
 * normalizeTitle does) and, when the author is known, the same author surname. A study guide,
 * a summary or a same-titled book by someone else is not the book, and a name with no such
 * hit is dropped rather than replaced by a near miss. `hits` come ranked by searchBooks,
 * which already sinks study aids and box sets, so the first match is the book itself.
 */
export function titleSeedMatch(
  seed: { title: string; author?: string | null },
  hits: Candidate[]
): Candidate | null {
  const last = surname(seed.author ?? null);
  for (const hit of hits) {
    if (!hit.title) continue;
    if (last && surname(hit.author ?? null) !== last) continue;
    if (!last && !hit.author) continue;
    if (titleSim(seed.title, hit.title) >= STRONG_SIM) return hit;
  }
  return null;
}

/**
 * Resolve Claude's cold-start title seeds through the add-a-book catalog search, keeping
 * only books the catalog holds. Seeds are lookup inputs, never picks: a resolved book joins
 * the pool like any other candidate and the reranker decides. Serial, like every catalog
 * loop here, and bounded by TITLE_SEED_BUDGET_MS so a slow catalog cannot eat the rerank's
 * time.
 */
export async function titleSeedPool(
  db: Db,
  seeds: TitleSeed[],
  budgetMs: number = TITLE_SEED_BUDGET_MS
): Promise<PoolEntry[]> {
  const deadline = Date.now() + budgetMs;
  const pool: PoolEntry[] = [];
  for (const seed of seeds) {
    if (Date.now() >= deadline) break;
    const hit = titleSeedMatch(
      seed,
      await searchBooks(db, `${seed.title} ${seed.author}`, TITLE_SEED_HITS)
    );
    if (!hit) continue;
    // Show the work's first year (Open Library's), not a Google edition's reprint year.
    const year = plausibleYear(hit.first_publish_year) ?? hit.year;
    pool.push([{ ...hit, year }, `${TITLE_SEED_PREFIX}${seed.title} by ${seed.author}`]);
  }
  return pool;
}

/** A book a discovery request names as a comparison ("a quiet novel like Gilead"). */
export interface ReferenceBook {
  title: string;
  author: string | null;
}

/** Subjects of a resolved reference book that seed the discovery pool. */
export const REFERENCE_SUBJECTS = 3;

/**
 * Resolve the books a discovery request names as comparisons through the add-a-book catalog
 * search, keeping only real matches (titleSeedMatch). Discovery queries are free text, and a
 * catalog answers "quiet literary novel like Gilead" with omnibuses; the named book's own
 * author and subjects are far better anchors.
 */
export async function resolveReferenceBooks(db: Db, refs: ReferenceBook[]): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const ref of refs) {
    const q = ref.author ? `${ref.title} ${ref.author}` : ref.title;
    const hit = titleSeedMatch(ref, await searchBooks(db, q, TITLE_SEED_HITS));
    if (!hit) continue;
    // searchBooks keeps the first sighting's subjects, usually Google's one-word category
    // ("Fiction"). Open Library's record lists the real ones, and this is the exact request
    // searchBooks just made, so it comes from the catalog cache.
    const ol = titleSeedMatch(
      { title: ref.title, author: hit.author },
      await openlibraryQuery(db, q, SEARCH_FETCH)
    );
    out.push(ol ? { ...hit, subjects: [...new Set([...hit.subjects, ...ol.subjects])] } : hit);
  }
  return out;
}

/** A crude English stem: "religion" and "religious" both become "relig". */
function wordStem(term: string): string {
  return term.replace(/(?:ions?|ious|ous|ies|s)$/, '');
}

/**
 * The subjects of a reference book worth searching: genre-like ones only (genreLabel drops
 * umbrella labels, LC headings, people headings and places with qualifiers), none the
 * request excludes, fiction forms ("Domestic fiction", "Epistolary fiction") first because
 * they describe the kind of book rather than its setting.
 *
 * Exclusion also matches a shared word stem, so "not about religion" (exclude_subjects:
 * religion) keeps "Religious fiction" out: a subject search for it would fetch exactly the
 * books the reader ruled out, each tagged only with that subject.
 */
export function referenceSubjects(ref: Candidate, excludeSubjects: string[] = []): string[] {
  const exclude = excludeSubjects.map((s) => s.toLowerCase().trim()).filter(Boolean);
  const stems = exclude.map(wordStem).filter((s) => s.length >= 5);
  const excluded = (lower: string) =>
    exclude.some((term) => subjectHits(term, lower)) ||
    lower.split(/[^a-z]+/).some((word) => stems.some((stem) => word.startsWith(stem)));
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const raw of ref.subjects ?? []) {
    const label = genreLabel(raw, ref.title);
    if (!label) continue;
    const lower = label.toLowerCase();
    if (seen.has(lower) || excluded(lower)) continue;
    seen.add(lower);
    labels.push(label);
  }
  const formish = (s: string) => /\b(?:fiction|novels?|literary)\b/i.test(s);
  return [...labels.filter(formish), ...labels.filter((s) => !formish(s))].slice(
    0,
    REFERENCE_SUBJECTS
  );
}

/**
 * Retrieval seeded by resolved reference books: their author's other books and their
 * genre-like subjects, from Open Library (Google's inauthor:/subject: operators answer
 * nothing, #123). The comparison author is NOT exempt from MAX_PER_AUTHOR, unlike an author
 * whose own books were requested.
 */
export async function referencePool(
  db: Db,
  refs: Candidate[],
  perQuery: number,
  excludeSubjects: string[] = []
): Promise<PoolEntry[]> {
  const pool: PoolEntry[] = [];
  for (const ref of refs) {
    const label = `reference:${ref.title}`;
    if (ref.author) {
      for (const c of await openlibraryAuthor(db, ref.author, perQuery)) {
        pool.push([c, `${label}:author`]);
      }
    }
    for (const subject of referenceSubjects(ref, excludeSubjects)) {
      for (const c of await openlibrarySubject(db, subject, perQuery)) {
        pool.push([c, `${label}:subject:${subject}`]);
      }
    }
  }
  return pool;
}

/**
 * recommend._discovery_pool: run the interpreted NL-discovery queries against the
 * live catalog. Unlike seedPool (Google-only), discovery has no library-metadata
 * backstop -- recall rests entirely on these queries -- so each runs against BOTH
 * sources. Google first, then Open Library: that order is what the recorded
 * fixture replays.
 */
export async function discoveryPool(
  db: Db,
  queries: string[],
  perQuery: number
): Promise<PoolEntry[]> {
  const pool: PoolEntry[] = [];
  for (const q of queries) {
    for (const c of await googleBooksQuery(db, q, perQuery)) pool.push([c, `query:${q}`]);
    for (const c of await openlibraryQuery(db, q, perQuery)) pool.push([c, `query:${q}`]);
  }
  return pool;
}

/**
 * Books BY the authors a discovery request names ("my next Scalzi read", #52). It is
 * deterministic expansion, not a Claude search term, so runDiscover passes it as the
 * metadata pool: capPool then keeps these ahead of the free-text hits, and a book the
 * queries also found comes out 'both'.
 */
export async function authorPool(
  db: Db,
  authors: string[],
  perAuthor: number
): Promise<PoolEntry[]> {
  const pool: PoolEntry[] = [];
  for (const author of authors) {
    for (const c of await openlibraryAuthor(db, author, perAuthor)) {
      pool.push([c, `author:${author}`]);
    }
  }
  return pool;
}

type PendingCandidate = Omit<AssembledCandidate, 'retrieval_pool'> & { pools: Set<string> };

/** Merge both pools, drop library books + duplicates, tag provenance, cap size. */
export function assemble(
  metadataEntries: PoolEntry[],
  seedEntries: PoolEntry[],
  signal: AssembleSignal,
  cap: number,
  // NOT a field on AssembleSignal: adding one would force buildBookSignal to supply
  // it and drag /similar into directive scope. recommendRun is the only caller that
  // passes it; /similar and /discover keep the empty default.
  preferredAuthorSurnames: Set<string> = new Set(),
  // Only /discover passes this: authors the request named, exempt from MAX_PER_AUTHOR.
  uncappedAuthorSurnames: Set<string> = new Set()
): AssembledCandidate[] {
  const allowedLangs = allowedLanguages(signal.library_languages);
  // A Map, so values() yields Python's dict insertion order.
  const byKey = new Map<string, PendingCandidate>();

  const add = (cand: Candidate, reason: string, poolName: string): void => {
    const title = cand.title;
    if (!title) return;
    const key = dedupKey(title, cand.author ?? null);
    if (signal.library_keys.has(key) || key === EMPTY_DEDUP_KEY) return;
    const isbn = cand.isbn13 ?? null;
    if (isbn && signal.library_isbns.has(isbn)) return;
    if (!languageOk(cand.language, allowedLangs)) return;
    if (!seriesOk(title, signal.library_series)) return;
    if (fuzzyDuplicate(title, signal.library_titles)) return;
    if (isTranslatedLibraryEdition(cand, signal.library_titles, signal.library_authors)) return;
    if (isLearnerEdition(cand)) return;
    if (isCollectionEdition(cand)) return;
    // A publisher or brand in the author field is unresolved authorship (publisherAuthor.ts).
    if (hasPublisherAuthor(cand)) return;
    // Every path serves real books a reader can get today, so preorders never reach a rerank.
    if (isUnreleased(cand)) return;

    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, {
        title,
        author: cand.author ?? null,
        year: cand.year ?? null,
        isbn13: isbn,
        subjects: (cand.subjects ?? []).slice(0, 8),
        description: cand.description ?? null,
        cover_url: cand.cover_url ?? null,
        catalog_source: cand.source ?? null,
        catalog_id: cand.resolved_id ?? null,
        language: cand.language ?? null,
        pools: new Set([poolName]),
        seed_reason: reason,
      });
    } else {
      existing.pools.add(poolName);
      if (!existing.author && cand.author) existing.author = cand.author;
      if (!existing.subjects.length && cand.subjects?.length) {
        existing.subjects = cand.subjects.slice(0, 8);
      }
      if (!existing.description && cand.description) existing.description = cand.description;
      if (!existing.language && cand.language) existing.language = cand.language;
    }
  };

  for (const [cand, reason] of metadataEntries) add(cand, reason, 'metadata');
  for (const [cand, reason] of seedEntries) add(cand, reason, 'claude_seed');

  const candidates: AssembledCandidate[] = [];
  for (const { pools, ...rest } of byKey.values()) {
    candidates.push({ ...rest, retrieval_pool: pools.size > 1 ? 'both' : [...pools][0] });
  }
  return capPool(
    applyAuthorCaps(
      // After the merge, so a description that arrived on a duplicate counts.
      candidates.filter((c) => descriptionSeriesOk(c, signal.library_authors)),
      signal.library_authors,
      preferredAuthorSurnames,
      uncappedAuthorSurnames
    ),
    cap
  );
}

/**
 * Trim to `cap` without letting the (larger) metadata pool starve the Claude-seeded
 * one. If we paid for seed queries, their candidates must actually reach the
 * reranker. 'both'-pool candidates and resolved title seeds are the most grounded and are
 * always kept.
 * Within each bucket, candidates with a description sort first.
 */
export function capPool(candidates: AssembledCandidate[], cap: number): AssembledCandidate[] {
  if (candidates.length <= cap) return candidates;

  // Python's sorted() is stable, as is Array.sort in V8, so equal keys keep order.
  const descFirst = (lst: AssembledCandidate[]) =>
    [...lst].sort((a, b) => (a.description ? 0 : 1) - (b.description ? 0 : 1));

  // A resolved cold-start title seed is a named, catalog-verified book: as grounded as a
  // 'both' candidate, and the reason the seed call was paid for, so it rides with them.
  const pinned = (c: AssembledCandidate) =>
    c.retrieval_pool === 'both' || c.seed_reason.startsWith(TITLE_SEED_PREFIX);
  const both = descFirst(candidates.filter(pinned));
  const meta = descFirst(candidates.filter((c) => !pinned(c) && c.retrieval_pool === 'metadata'));
  const seed = descFirst(
    candidates.filter((c) => !pinned(c) && c.retrieval_pool === 'claude_seed')
  );

  let chosen = both.slice(0, cap);
  const remaining = cap - chosen.length;
  if (remaining <= 0) return chosen;

  // Guarantee seed-only candidates a minimum slice of what is left (if any exist).
  // pyRoundHalfEven, not Math.round: Python's round() breaks .5 toward even.
  const seedQuota = Math.min(seed.length, pyRoundHalfEven(cap * SEED_RESERVE_SHARE), remaining);
  chosen = chosen.concat(seed.slice(0, seedQuota));
  chosen = chosen.concat(meta.slice(0, cap - chosen.length));
  // Backfill any slack (e.g. too few metadata hits) with leftover seed candidates.
  if (chosen.length < cap) {
    chosen = chosen.concat(seed.slice(seedQuota, seedQuota + (cap - chosen.length)));
  }
  return chosen.slice(0, cap);
}

/**
 * Re-run the description series check once fillOlDescriptions has fetched the Open
 * Library descriptions that assemble() could not see (#136).
 */
export function dropUnstartedLaterSeries(
  candidates: AssembledCandidate[],
  libraryAuthors: Set<string>
): AssembledCandidate[] {
  return candidates.filter((c) => descriptionSeriesOk(c, libraryAuthors));
}

/**
 * Fetch Work descriptions for OL candidates the pool query left without one. The OL
 * subjects endpoint returns works but no descriptions; we already hold the work key,
 * so one extra cached GET per OL candidate fills the gap. MUTATES in place, like Python.
 */
export async function fillOlDescriptions(db: Db, candidates: AssembledCandidate[]): Promise<void> {
  for (const c of candidates) {
    if (c.description || c.catalog_source !== 'openlibrary') continue;
    const workKey = c.catalog_id;
    // Python assigns unconditionally, so a miss overwrites null with null.
    if (workKey) c.description = await openlibraryWorkDescription(db, workKey);
  }
}
