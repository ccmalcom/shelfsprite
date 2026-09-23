/**
 * Stage 1 retrieval for screen recommendations (spec §6.3). Three pools, all real catalog
 * items: a metadata pool (people + genre overlap with loved titles), an adaptation bridge
 * (films and series based on a loved book's work or its series) and Claude's comparable
 * titles resolved by exact title + year. Claude never contributes a candidate directly.
 *
 * Every catalog call goes through ScreenCatalogPort, whose only production implementation
 * (defaultScreenCatalogPort) wraps wave 5's client. Tests inject a fake. Calls are made
 * SEQUENTIALLY: wave 5's per-host throttles assume serial calls.
 *
 * Failure is never fatal here. A retryable transport failure or a spent deadline yields an
 * empty pool; the run serves whatever the other pools found.
 */
import type { Db } from './db';
import { authorExcluded, subjectExcluded } from './exclusions';
import { logDebug } from './log';
import { SEED_RESERVE_SHARE } from './recAssemble';
import {
  tvmazeSingleSearch,
  wikidataSparql,
  type CatalogResult,
  type Deadline,
} from './screenCatalog';
import { fetchScreenMetadata, type ScreenCandidate } from './screenEnrichment';
import { titleVariants } from './screenMatch';
import type { MediaType, ScreenLovedBook, ScreenSignal } from './screenSignal';
import {
  adaptationQuery,
  lovedGenresQuery,
  lovedPeopleQuery,
  metadataQuery,
  POPULARITY_MIN_SITELINKS,
  qidOf,
  rowInt,
  rowLabel,
  rowStr,
  seedMovieQuery,
  tvmazeCrosswalkQuery,
  type AdaptationInput,
  type LabelYear,
  type SparqlRow,
} from './screenSparql';
import { pyRoundHalfEven } from './serialize';
import { normalizeTitleKey } from './titles';

export type MediaFilter = 'both' | 'movie' | 'tv';
export type RetrievalPool = 'adaptation' | 'metadata' | 'claude_seed';

/** Loved titles fed to the people/genre aggregation (most loved first). */
export const METADATA_LOVED_CAP = 100;
/** Per medium, after ranking. The spike kept the top 60 films; series are thinner. */
export const METADATA_POOL_LIMIT = 80;
/** Spec §6.3: at most 3 candidates per book, each candidate once however many books hit it. */
export const ADAPTATIONS_PER_BOOK = 3;
/** Input tuples per adaptation query, as in the spike (bridge_final.py). */
export const ADAPTATION_BATCH = 60;
export const SEED_MOVIE_BATCH = 20;
/** A TVmaze hit whose premiere year is further than this from the seed's year is dropped. */
export const SEED_TV_YEAR_TOLERANCE = 1;

export interface TvmazeHit {
  id: number;
  name: string;
  premiered: string | null;
}

export interface ScreenCatalogPort {
  sparql(query: string): Promise<CatalogResult<SparqlRow[]>>;
  tvmazeSingleSearch(name: string): Promise<CatalogResult<TvmazeHit>>;
  fetchMetadata(qids: string[]): Promise<CatalogResult<Map<string, ScreenCandidate>>>;
}

/**
 * The ONLY place wave 7 touches wave 5's client signatures. If Task 1's contract check found
 * a different result shape, adapt it here and nowhere else.
 */
export function defaultScreenCatalogPort(db: Db, deadline: Deadline): ScreenCatalogPort {
  return {
    sparql: (query) => wikidataSparql(db, query, deadline),
    tvmazeSingleSearch: async (name) => {
      const res = await tvmazeSingleSearch(db, name, deadline);
      if (res.kind !== 'ok') return res;
      return {
        kind: 'ok',
        value: { id: res.value.id, name: res.value.name, premiered: res.value.premiered ?? null },
      };
    },
    fetchMetadata: (qids) => fetchScreenMetadata(db, qids, deadline),
  };
}

export interface AdaptationProvenance {
  book_id: number;
  book_title: string;
  source_qid: string;
  via: 'work' | 'series';
}

export interface PoolHit {
  qid: string;
  media_type: MediaType;
  tvmaze_id: number | null;
  label: string | null;
  year: number | null;
  sitelinks: number;
  /** Has an English Wikipedia article. Every pool query requires one, so hits carry true. */
  enwiki: boolean;
  pool: RetrievalPool;
  seed_reason: string;
  adaptation: AdaptationProvenance | null;
}

export interface SeedProposal {
  title: string;
  media_type: MediaType;
  year: number;
  reason: string;
}

export function allows(filter: MediaFilter, type: MediaType): boolean {
  return filter === 'both' || filter === type;
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function yearOfDate(date: string | null): number | null {
  if (!date) return null;
  const y = Number(date.slice(0, 4));
  return Number.isInteger(y) ? y : null;
}

async function rowsOf(
  port: ScreenCatalogPort,
  query: string,
  deadline: Deadline,
  what: string
): Promise<SparqlRow[]> {
  if (deadline.remainingMs() <= 0) return [];
  const res = await port.sparql(query);
  if (res.kind === 'ok') return res.value;
  if (res.kind === 'retryable') {
    logDebug('screen-recommend', `${what} query skipped`, { reason: res.reason });
  }
  return [];
}

// --- metadata pool ---------------------------------------------------------------------

/**
 * pool_meta.py / pool_tv.py: the most common people and genres of the loved titles, then
 * films and series sharing a person AND a genre, ranked by shared people, then genres, then
 * sitelinks. Owned titles are dropped BEFORE the per-medium limit so they cannot crowd it.
 */
export async function metadataPool(
  port: ScreenCatalogPort,
  signal: Pick<ScreenSignal, 'loved_titles' | 'owned_qids' | 'owned_tvmaze_ids'>,
  filter: MediaFilter,
  deadline: Deadline
): Promise<PoolHit[]> {
  const loved = uniq(
    signal.loved_titles
      .map((t) => t.wikidata_qid)
      .filter((q): q is string => q !== null && /^Q[1-9]\d*$/.test(q))
  ).slice(0, METADATA_LOVED_CAP);
  if (!loved.length) return [];

  const people = (await rowsOf(port, lovedPeopleQuery(loved), deadline, 'loved people'))
    .map((r) => qidOf(r.p?.value))
    .filter((q): q is string => q !== null);
  if (!people.length) return [];
  const genres = (await rowsOf(port, lovedGenresQuery(loved), deadline, 'loved genres'))
    .map((r) => qidOf(r.g?.value))
    .filter((q): q is string => q !== null);
  if (!genres.length) return [];

  const hits: PoolHit[] = [];
  for (const kind of ['movie', 'tv'] as const) {
    if (!allows(filter, kind)) continue;
    const rows = await rowsOf(
      port,
      metadataQuery(kind, people, genres),
      deadline,
      `metadata ${kind}`
    );
    const ranked = rows
      .map((r) => ({
        qid: qidOf(r.f?.value),
        np: rowInt(r, 'np') ?? 0,
        ng: rowInt(r, 'ng') ?? 0,
        sl: rowInt(r, 'nsl') ?? 0,
        tvm: rowInt(r, 'tvm'),
        label: rowLabel(r),
        year: rowInt(r, 'yr'),
      }))
      .filter(
        (x): x is typeof x & { qid: string } =>
          x.qid !== null &&
          !signal.owned_qids.has(x.qid) &&
          !(x.tvm !== null && signal.owned_tvmaze_ids.has(x.tvm))
      )
      .sort((a, b) => b.np - a.np || b.ng - a.ng || b.sl - a.sl || (a.qid < b.qid ? -1 : 1))
      .slice(0, METADATA_POOL_LIMIT);
    for (const x of ranked) {
      hits.push({
        qid: x.qid,
        media_type: kind,
        tvmaze_id: kind === 'tv' ? x.tvm : null,
        label: x.label,
        year: x.year,
        sitelinks: x.sl,
        enwiki: true,
        pool: 'metadata',
        seed_reason: `metadata:people=${x.np};genres=${x.ng}`,
        adaptation: null,
      });
    }
  }
  return hits;
}

// --- adaptation bridge --------------------------------------------------------------------

/** Goodreads appends the series as a trailing parenthetical with a '#': "(The Expanse, #1)". */
export function stripSeriesSuffix(title: string): string {
  return title.replace(/\s*\([^)]*#[^)]*\)\s*$/u, '').trim();
}

/** The series-stripped full title and its pre-colon part (bridge_final.py). Unicode-safe. */
export function bookTitleVariants(title: string): string[] {
  const base = stripSeriesSuffix(title.normalize('NFC'));
  const pre = base.split(':')[0].trim();
  return uniq([base, pre].filter((v) => v !== ''));
}

/**
 * An order-insensitive token set, so "Liu Cixin" matches "Cixin Liu" (spec §6.3). Letters of
 * any script are kept (\p{L}); JS's \w is ASCII-only and would erase non-Latin names.
 */
export function authorTokens(name: string): string {
  return uniq(
    name
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean)
  )
    .sort()
    .join(' ');
}

/** The spike's coarse SPARQL pre-filter: the author's last whitespace token, lowercased. */
export function querySurname(author: string): string {
  const parts = author.trim().toLowerCase().split(/\s+/);
  return parts[parts.length - 1] ?? '';
}

interface FoundAdaptation {
  qid: string;
  kind: MediaType;
  tvm: number | null;
  sl: number;
  label: string | null;
  year: number | null;
  via: 'work' | 'series';
  src: string;
}

export async function adaptationPool(
  port: ScreenCatalogPort,
  signal: Pick<ScreenSignal, 'loved_books' | 'owned_qids' | 'owned_tvmaze_ids'>,
  filter: MediaFilter,
  deadline: Deadline
): Promise<PoolHit[]> {
  const inputs: AdaptationInput[] = [];
  const inputKeys = new Set<string>();
  const booksByVariant = new Map<string, ScreenLovedBook[]>();
  for (const book of signal.loved_books) {
    if (!book.author) continue; // nothing to match an adaptation's source author against
    const surname = querySurname(book.author);
    for (const variant of bookTitleVariants(book.title)) {
      const list = booksByVariant.get(variant) ?? [];
      if (!list.includes(book)) list.push(book);
      booksByVariant.set(variant, list);
      const key = `${variant}\u0000${surname}`;
      if (!inputKeys.has(key)) {
        inputKeys.add(key);
        inputs.push({ variant, surname });
      }
    }
  }

  const rows: SparqlRow[] = [];
  for (let i = 0; i < inputs.length; i += ADAPTATION_BATCH) {
    rows.push(
      ...(await rowsOf(
        port,
        adaptationQuery(inputs.slice(i, i + ADAPTATION_BATCH)),
        deadline,
        'adaptation'
      ))
    );
  }

  const perBook = new Map<number, Map<string, FoundAdaptation>>();
  for (const r of rows) {
    const variant = rowStr(r, 'title');
    const an = rowStr(r, 'an');
    const qid = qidOf(r.adapt?.value);
    const src = qidOf(r.src?.value);
    const kind = rowStr(r, 'kind');
    const via = rowStr(r, 'via');
    if (!variant || !an || !qid || !src) continue;
    if ((kind !== 'movie' && kind !== 'tv') || (via !== 'work' && via !== 'series')) continue;
    const tvm = rowInt(r, 'tvm');
    if (kind === 'tv' && tvm === null) continue; // spec §6.3: series must cross-walk to TVmaze
    if (!allows(filter, kind)) continue;
    const anTokens = authorTokens(an);
    const year = rowInt(r, 'yr');
    for (const book of booksByVariant.get(variant) ?? []) {
      const names = [book.author as string, ...book.additional_authors];
      if (!names.some((n) => authorTokens(n) === anTokens)) continue;
      const found = perBook.get(book.id) ?? new Map<string, FoundAdaptation>();
      perBook.set(book.id, found);
      const prev = found.get(qid);
      if (!prev) {
        found.set(qid, {
          qid,
          kind,
          tvm,
          sl: rowInt(r, 'sl') ?? 0,
          label: rowLabel(r),
          year,
          via,
          src,
        });
        continue;
      }
      // One row per (date, label) combination comes back; keep the earliest year, any label,
      // and prefer the direct work over the series hop for provenance.
      if (year !== null && (prev.year === null || year < prev.year)) prev.year = year;
      if (!prev.label) prev.label = rowLabel(r);
      if (via === 'work' && prev.via === 'series') {
        prev.via = 'work';
        prev.src = src;
      }
    }
  }

  const taken = new Set<string>();
  const hits: PoolHit[] = [];
  for (const book of signal.loved_books) {
    const found = perBook.get(book.id);
    if (!found) continue;
    const ranked = [...found.values()]
      .filter(
        (f) =>
          !taken.has(f.qid) &&
          !signal.owned_qids.has(f.qid) &&
          !(f.tvm !== null && signal.owned_tvmaze_ids.has(f.tvm))
      )
      .sort((a, b) => b.sl - a.sl || (a.qid < b.qid ? -1 : 1))
      .slice(0, ADAPTATIONS_PER_BOOK);
    for (const f of ranked) {
      taken.add(f.qid);
      hits.push({
        qid: f.qid,
        media_type: f.kind,
        tvmaze_id: f.kind === 'tv' ? f.tvm : null,
        label: f.label,
        year: f.year,
        sitelinks: f.sl,
        enwiki: true,
        pool: 'adaptation',
        seed_reason: `adaptation:${f.via}=${f.src};book=${book.id}`,
        adaptation: { book_id: book.id, book_title: book.title, source_qid: f.src, via: f.via },
      });
    }
  }
  return hits;
}

// --- Claude comparable-title seeds ----------------------------------------------------------

function seedReason(s: SeedProposal): string {
  return s.reason ? `seed:${s.reason}` : `seed:${s.title} (${s.year})`;
}

/**
 * Films resolve by exact en/mul label or alias (every titleVariants form) + any P577 year,
 * best by sitelinks. Series resolve through TVmaze singlesearch, a +/-1 premiere-year check,
 * then the P8600 crosswalk; an uncross-walked show is dropped (spec §6.3). Hits keep the
 * proposal order.
 */
export async function seedPool(
  port: ScreenCatalogPort,
  seeds: SeedProposal[],
  deadline: Deadline
): Promise<PoolHit[]> {
  const byIndex = new Map<number, PoolHit>();

  const films = seeds.map((s, i) => ({ s, i })).filter(({ s }) => s.media_type === 'movie');
  for (let b = 0; b < films.length; b += SEED_MOVIE_BATCH) {
    const lookups: LabelYear[] = [];
    const owners = new Map<string, number[]>();
    for (const { s, i } of films.slice(b, b + SEED_MOVIE_BATCH)) {
      for (const label of titleVariants(s.title)) {
        const key = `${label}\u0000${s.year}`;
        const list = owners.get(key);
        if (list) {
          if (!list.includes(i)) list.push(i);
        } else {
          owners.set(key, [i]);
          lookups.push({ label, year: s.year });
        }
      }
    }
    for (const row of await rowsOf(port, seedMovieQuery(lookups), deadline, 'seed film')) {
      const name = rowStr(row, 'name');
      const y = rowInt(row, 'y');
      const qid = qidOf(row.q?.value);
      if (name === null || y === null || !qid) continue;
      const sl = rowInt(row, 'sl') ?? 0;
      for (const i of owners.get(`${name}\u0000${y}`) ?? []) {
        const prev = byIndex.get(i);
        if (prev && prev.sitelinks >= sl) continue;
        byIndex.set(i, {
          qid,
          media_type: 'movie',
          tvmaze_id: null,
          label: rowLabel(row) ?? name,
          year: y,
          sitelinks: sl,
          enwiki: true,
          pool: 'claude_seed',
          seed_reason: seedReason(seeds[i]),
          adaptation: null,
        });
      }
    }
  }

  const shows: Array<{ i: number; hit: TvmazeHit; year: number }> = [];
  for (const [i, s] of seeds.entries()) {
    if (s.media_type !== 'tv') continue;
    if (deadline.remainingMs() <= 0) break;
    const res = await port.tvmazeSingleSearch(s.title);
    if (res.kind !== 'ok') continue;
    const premiered = yearOfDate(res.value.premiered);
    if (premiered !== null && Math.abs(premiered - s.year) > SEED_TV_YEAR_TOLERANCE) continue;
    shows.push({ i, hit: res.value, year: premiered ?? s.year });
  }
  if (shows.length) {
    const crosswalk = new Map<number, { qid: string; sl: number; label: string | null }>();
    const ids = uniq(shows.map((x) => x.hit.id));
    for (const row of await rowsOf(port, tvmazeCrosswalkQuery(ids), deadline, 'tv crosswalk')) {
      const tvm = rowInt(row, 'tvm');
      const qid = qidOf(row.s?.value);
      if (tvm === null || !qid) continue;
      const sl = rowInt(row, 'sl') ?? 0;
      const prev = crosswalk.get(tvm);
      if (!prev || sl > prev.sl) crosswalk.set(tvm, { qid, sl, label: rowLabel(row) });
    }
    for (const { i, hit, year } of shows) {
      const xw = crosswalk.get(hit.id);
      if (!xw) continue;
      byIndex.set(i, {
        qid: xw.qid,
        media_type: 'tv',
        tvmaze_id: hit.id,
        label: xw.label ?? hit.name,
        year,
        sitelinks: xw.sl,
        enwiki: true,
        pool: 'claude_seed',
        seed_reason: seedReason(seeds[i]),
        adaptation: null,
      });
    }
  }

  return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, h]) => h);
}

// --- assembly ------------------------------------------------------------------------------

/** Spec §6.3: the pool handed to the reranker is capped at 60 (token budget). */
export const SCREEN_MAX_CANDIDATES = 60;
/** Wikipedia summaries cost one fetch each; hydrate at most this many before filtering. */
export const HYDRATE_CAP = 90;
/** Adaptation candidates may take at most this share of the cap, so metadata keeps room. */
export const ADAPTATION_MAX_SHARE = 0.4;
/** Spec §6.3: cap 2 per director or creator. */
export const MAX_PER_PERSON = 2;

export type RetrievalPoolLabel = RetrievalPool | 'multiple';

export interface MergedHit extends Omit<PoolHit, 'pool'> {
  retrieval_pool: RetrievalPoolLabel;
}

export interface ScreenPoolCandidate extends ScreenCandidate {
  retrieval_pool: RetrievalPoolLabel;
  seed_reason: string;
  adaptation: AdaptationProvenance | null;
}

export function passesFloor(h: { sitelinks: number; enwiki: boolean }): boolean {
  return h.enwiki && h.sitelinks >= POPULARITY_MIN_SITELINKS;
}

/**
 * Merge the pools in the given order (the first pool's reason wins), dropping anything below
 * the popularity floor, any series without a TVmaze id, anything the reader owns or rejected
 * (by QID, TVmaze id or normalized title + year), and a second item with the same title + year.
 * The floor is enforced in every query too; this re-check keeps a future query edit honest.
 */
export function mergeHits(
  pools: PoolHit[][],
  owned: Pick<ScreenSignal, 'owned_qids' | 'owned_tvmaze_ids' | 'owned_keys'>
): MergedHit[] {
  const byQid = new Map<string, MergedHit & { pools: Set<RetrievalPool> }>();
  const keys = new Set<string>();
  for (const pool of pools) {
    for (const h of pool) {
      if (!passesFloor(h)) continue;
      if (h.media_type === 'tv' && h.tvmaze_id === null) continue;
      if (owned.owned_qids.has(h.qid)) continue;
      if (h.tvmaze_id !== null && owned.owned_tvmaze_ids.has(h.tvmaze_id)) continue;
      const key = h.label ? normalizeTitleKey(h.label, h.year) : null;
      if (key && owned.owned_keys.has(key)) continue;

      const existing = byQid.get(h.qid);
      if (existing) {
        existing.pools.add(h.pool);
        if (!existing.adaptation && h.adaptation) existing.adaptation = h.adaptation;
        if (!existing.label && h.label) existing.label = h.label;
        if (existing.year === null && h.year !== null) existing.year = h.year;
        continue;
      }
      if (key && keys.has(key)) continue;
      if (key) keys.add(key);
      const { pool, ...rest } = h;
      byQid.set(h.qid, { ...rest, retrieval_pool: pool, pools: new Set([pool]) });
    }
  }
  return [...byQid.values()].map(({ pools, ...rest }) => ({
    ...rest,
    retrieval_pool: pools.size > 1 ? 'multiple' : rest.retrieval_pool,
  }));
}

/**
 * capPool's screen twin (recAssemble.ts): multi-pool candidates first (most grounded), then a
 * reserved seed share (SEED_RESERVE_SHARE -- we paid for those seeds), then adaptation up to
 * ADAPTATION_MAX_SHARE, then metadata, then leftover adaptation and seeds as backfill.
 */
export function capHits<T extends { retrieval_pool: RetrievalPoolLabel }>(
  hits: T[],
  cap: number
): T[] {
  if (hits.length <= cap) return hits;
  const of = (p: RetrievalPoolLabel) => hits.filter((h) => h.retrieval_pool === p);
  const multiple = of('multiple');
  const adaptation = of('adaptation');
  const seed = of('claude_seed');
  const meta = of('metadata');

  let chosen = multiple.slice(0, cap);
  if (chosen.length >= cap) return chosen;
  const seedQuota = Math.min(
    seed.length,
    pyRoundHalfEven(cap * SEED_RESERVE_SHARE),
    cap - chosen.length
  );
  chosen = chosen.concat(seed.slice(0, seedQuota));
  const adaptQuota = Math.min(
    adaptation.length,
    pyRoundHalfEven(cap * ADAPTATION_MAX_SHARE),
    cap - chosen.length
  );
  chosen = chosen.concat(adaptation.slice(0, adaptQuota));
  chosen = chosen.concat(meta.slice(0, cap - chosen.length));
  if (chosen.length < cap)
    chosen = chosen.concat(adaptation.slice(adaptQuota, adaptQuota + cap - chosen.length));
  if (chosen.length < cap)
    chosen = chosen.concat(seed.slice(seedQuota, seedQuota + cap - chosen.length));
  return chosen.slice(0, cap);
}

function minimalCandidate(h: MergedHit, title: string): ScreenCandidate {
  return {
    media_type: h.media_type,
    title,
    year: h.year,
    wikidata_qid: h.qid,
    tvmaze_id: h.tvmaze_id,
    image_url: null,
    description: null,
    description_source: null,
    description_url: null,
    wikipedia_page: null,
    genres: [],
    directors: [],
    creators: [],
    writers: [],
    countries: [],
    original_language: null,
    based_on: [],
    main_subjects: [],
    series: [],
    production_companies: [],
    sitelinks: h.sitelinks,
  };
}

/**
 * One fetchScreenMetadata call for the whole capped list (wave 5 batches wbgetentities and
 * Wikipedia summaries, cached in catalog_cache). A retryable failure degrades to minimal
 * candidates; a hit with neither metadata nor a label is dropped (nothing to show or rank).
 */
export async function hydrate(
  port: ScreenCatalogPort,
  hits: MergedHit[],
  deadline: Deadline
): Promise<ScreenPoolCandidate[]> {
  let meta = new Map<string, ScreenCandidate>();
  if (hits.length && deadline.remainingMs() > 0) {
    const res = await port.fetchMetadata(hits.map((h) => h.qid));
    if (res.kind === 'ok') meta = res.value;
    else if (res.kind === 'retryable') {
      logDebug('screen-recommend', 'metadata hydration skipped', { reason: res.reason });
    }
  }
  const out: ScreenPoolCandidate[] = [];
  for (const h of hits) {
    const m = meta.get(h.qid);
    const title = m?.title || h.label;
    if (!title) continue;
    const base = m ?? minimalCandidate(h, title);
    out.push({
      ...base,
      media_type: h.media_type,
      title,
      year: base.year ?? h.year,
      wikidata_qid: h.qid,
      tvmaze_id: h.media_type === 'tv' ? (h.tvmaze_id ?? base.tvmaze_id) : null,
      sitelinks: base.sitelinks ?? h.sitelinks,
      retrieval_pool: h.retrieval_pool,
      seed_reason: h.seed_reason,
      adaptation: h.adaptation,
    });
  }
  return out;
}

/** English labels Wikidata uses for P364 (original language), mapped to ISO 639-1. */
const LANGUAGE_CODES: Record<string, string> = {
  arabic: 'ar',
  bengali: 'bn',
  cantonese: 'zh',
  chinese: 'zh',
  czech: 'cs',
  danish: 'da',
  dutch: 'nl',
  english: 'en',
  finnish: 'fi',
  french: 'fr',
  german: 'de',
  greek: 'el',
  hebrew: 'he',
  hindi: 'hi',
  hungarian: 'hu',
  icelandic: 'is',
  indonesian: 'id',
  irish: 'ga',
  italian: 'it',
  japanese: 'ja',
  korean: 'ko',
  malayalam: 'ml',
  'mandarin chinese': 'zh',
  mandarin: 'zh',
  norwegian: 'no',
  persian: 'fa',
  polish: 'pl',
  portuguese: 'pt',
  romanian: 'ro',
  russian: 'ru',
  spanish: 'es',
  swedish: 'sv',
  tagalog: 'tl',
  tamil: 'ta',
  telugu: 'te',
  thai: 'th',
  turkish: 'tr',
  ukrainian: 'uk',
  vietnamese: 'vi',
};

/**
 * The directive's `languages` are ISO 639-1 codes (recFilters.cleanConstraints). Wave 5 may
 * store original_language as a code or as Wikidata's English label; accept both. Unknown
 * values return null and therefore PASS the filter (spec §6.3: a missing value passes).
 */
export function languageCode(value: string | null): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (/^[a-z]{2}$/.test(v)) return v;
  return LANGUAGE_CODES[v.replace(/ language$/, '')] ?? null;
}

/**
 * The directive's hard constraints with spec §6.3's explicit mapping: year range -> release
 * year; exclude_subjects -> genres and main subjects; exclude_authors -> adaptation source
 * author; languages -> original language. A missing value always passes. Author and subject
 * matching reuse exclusions.ts so screen and book exclusions behave identically (including the
 * inherited surname quirk documented there).
 */
export function applyScreenDirective(
  cands: ScreenPoolCandidate[],
  constraints: Record<string, unknown>
): ScreenPoolCandidate[] {
  if (!constraints || Object.keys(constraints).length === 0) return cands;
  const minYear = constraints.min_year as number | null | undefined;
  const maxYear = constraints.max_year as number | null | undefined;
  const languages = ((constraints.languages as string[] | null) ?? []).map((l) => l.toLowerCase());
  return cands.filter((c) => {
    if (typeof c.year === 'number' && Number.isInteger(c.year)) {
      if (minYear != null && c.year < minYear) return false;
      if (maxYear != null && c.year > maxYear) return false;
    }
    for (const subject of [...c.genres, ...c.main_subjects]) {
      if (subjectExcluded(subject, constraints.exclude_subjects)) return false;
    }
    for (const source of c.based_on) {
      if (source.author && authorExcluded(source.author, constraints.exclude_authors)) return false;
    }
    if (languages.length) {
      const code = languageCode(c.original_language);
      if (code !== null && !languages.includes(code)) return false;
    }
    return true;
  });
}

/** At most MAX_PER_PERSON per first-listed director (films) or creator (series). */
export function applyPersonCap(cands: ScreenPoolCandidate[]): ScreenPoolCandidate[] {
  const counts = new Map<string, number>();
  return cands.filter((c) => {
    const person = (c.media_type === 'movie' ? c.directors : c.creators)[0]?.trim().toLowerCase();
    if (!person) return true;
    const n = counts.get(person) ?? 0;
    if (n >= MAX_PER_PERSON) return false;
    counts.set(person, n + 1);
    return true;
  });
}

export async function assembleScreenPool(
  port: ScreenCatalogPort,
  pools: PoolHit[][],
  signal: Pick<
    ScreenSignal,
    'owned_qids' | 'owned_tvmaze_ids' | 'owned_keys' | 'directive_constraints'
  >,
  mediaFilter: MediaFilter,
  deadline: Deadline
): Promise<ScreenPoolCandidate[]> {
  const merged = mergeHits(pools, signal).filter((h) => allows(mediaFilter, h.media_type));
  const hydrated = await hydrate(port, capHits(merged, HYDRATE_CAP), deadline);
  // Re-check after hydration: the Wikipedia title can differ from the pool's label.
  const kept = hydrated.filter(
    (c) =>
      allows(mediaFilter, c.media_type) &&
      !(c.media_type === 'tv' && c.tvmaze_id === null) &&
      !signal.owned_keys.has(normalizeTitleKey(c.title, c.year))
  );
  return capHits(
    applyPersonCap(applyScreenDirective(kept, signal.directive_constraints)),
    SCREEN_MAX_CANDIDATES
  );
}
