/**
 * Screen catalog transport and clients: Wikidata (Action API and WDQS SPARQL),
 * Wikipedia REST, TVmaze. Spec §4.1. Two deliberate departures from the book client
 * in catalog.ts:
 *  - Failure is not "no match". CatalogResult keeps a definite empty answer (a 404)
 *    apart from a retryable failure (network error, 5xx, 429 after retries, any other
 *    4xx, an unparseable body, or no time left). Only a definite answer may ever be
 *    persisted as "unresolved"; a retryable one defers the title to a later batch.
 *  - A deadline is threaded into every request and retry, and Retry-After is capped.
 * Throttling is per invocation, as in catalog.ts: each Vercel isolate spaces its own
 * requests; cross-request spacing is not attempted at invite-only scale. Requests are
 * strictly sequential, which satisfies Wikimedia's "concurrency 1" for the Action API.
 */
import { cacheGet, cachePut } from './catalogCache';
import type { Db } from './db';

/** Names the app and a contact website. Never an email address. */
export const SCREEN_USER_AGENT = 'ShelfSprite/0.1 (https://shelfsprite.app)';

export type CatalogResult<T> =
  { kind: 'ok'; value: T } | { kind: 'empty' } | { kind: 'retryable'; reason: string };

export interface Deadline {
  remainingMs(): number;
}

export function deadlineIn(ms: number, now: () => number = Date.now): Deadline {
  const end = now() + ms;
  return { remainingMs: () => end - now() };
}

/** catalog_cache.source values. The shared prefix is what cache retention prunes by. */
export const SCREEN_SOURCES = {
  wikidata: 'screen:wikidata',
  wdqs: 'screen:wdqs',
  wikipedia: 'screen:wikipedia',
  tvmaze: 'screen:tvmaze',
} as const;
export type ScreenSource = (typeof SCREEN_SOURCES)[keyof typeof SCREEN_SOURCES];

/**
 * Minimum spacing between two requests to one host. Wikimedia's robot policy allows
 * 5 req/s (Action API at concurrency 1); TVmaze allows 20 calls per 10 s. 250 ms and
 * 550 ms keep a margin under both.
 */
export const MIN_INTERVAL_MS: Record<ScreenSource, number> = {
  'screen:wikidata': 250,
  'screen:wdqs': 250,
  'screen:wikipedia': 250,
  'screen:tvmaze': 550,
};

const REQUEST_TIMEOUT_MS: Record<ScreenSource, number> = {
  'screen:wikidata': 15_000,
  'screen:wdqs': 30_000,
  'screen:wikipedia': 10_000,
  'screen:tvmaze': 10_000,
};

export const MAX_ATTEMPTS = 3;
/** The spike saw Retry-After of about 20 s; waiting that long inside a chunk is not worth it. */
export const RETRY_AFTER_CAP_MS = 10_000;
/** Never start a request with less than this left; the title is deferred instead. */
export const MIN_REQUEST_BUDGET_MS = 3_000;

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

interface Hooks {
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const defaultHooks: Hooks = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

let hooks: Hooks = defaultHooks;
const lastCallAt = new Map<ScreenSource, number>();

/** Test seam: replace sleeping and the throttle clock. `null` restores both. */
export function _setScreenCatalogHooksForTests(overrides: Partial<Hooks> | null): void {
  hooks = overrides ? { ...defaultHooks, ...overrides } : defaultHooks;
  lastCallAt.clear();
}

async function throttle(source: ScreenSource): Promise<void> {
  const last = lastCallAt.get(source);
  if (last !== undefined) {
    const wait = MIN_INTERVAL_MS[source] - (hooks.now() - last);
    if (wait > 0) await hooks.sleep(wait);
  }
  lastCallAt.set(source, hooks.now());
}

export interface ScreenRequest {
  url: string;
  source: ScreenSource;
  /** A form-encoded POST body (SPARQL). Absent means GET. */
  body?: string;
}

/** Cache identity: the URL for a GET; method, URL and body for a POST. */
export function requestIdentity(req: ScreenRequest): string {
  return req.body === undefined ? req.url : `POST ${req.url}\n${req.body}`;
}

function retryAfterMs(header: string | null): number | null {
  const value = header?.trim();
  if (!value || !/^\d+$/.test(value)) return null;
  return Math.min(Number(value) * 1_000, RETRY_AFTER_CAP_MS);
}

function requestHeaders(req: ScreenRequest): Record<string, string> {
  if (req.body === undefined)
    return { 'User-Agent': SCREEN_USER_AGENT, Accept: 'application/json' };
  return {
    'User-Agent': SCREEN_USER_AGENT,
    Accept: 'application/sparql-results+json',
    'Content-Type': 'application/x-www-form-urlencoded',
  };
}

export async function screenFetchJson(
  db: Db,
  req: ScreenRequest,
  deadline: Deadline
): Promise<CatalogResult<unknown>> {
  const identity = requestIdentity(req);
  const cached = await cacheGet(db, identity);
  if (cached.hit) {
    return cached.payload === null ? { kind: 'empty' } : { kind: 'ok', value: cached.payload };
  }

  let backoff = 1_000;
  let reason = 'no attempt';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const remaining = deadline.remainingMs();
    if (remaining < MIN_REQUEST_BUDGET_MS) {
      return { kind: 'retryable', reason: `deadline after ${reason}` };
    }
    await throttle(req.source);
    let resp: Response;
    try {
      resp = await fetch(req.url, {
        method: req.body === undefined ? 'GET' : 'POST',
        headers: requestHeaders(req),
        body: req.body,
        signal: AbortSignal.timeout(
          Math.max(1_000, Math.min(REQUEST_TIMEOUT_MS[req.source], remaining - 1_000))
        ),
      });
    } catch (err) {
      // Same guard as catalog.ts: a replay-harness miss is a broken test, not a network
      // failure. Duck-typed on `.name` so production code never imports a test helper.
      if (err instanceof Error && err.name === 'HttpReplayMissError') throw err;
      reason = `network error: ${err instanceof Error ? err.message : String(err)}`;
      if (attempt === MAX_ATTEMPTS) break;
      if (backoff > deadline.remainingMs() - MIN_REQUEST_BUDGET_MS) {
        return { kind: 'retryable', reason: `deadline after ${reason}` };
      }
      await hooks.sleep(backoff);
      backoff *= 2;
      continue;
    }
    if (resp.status === 404) {
      await cachePut(db, identity, req.source, null);
      return { kind: 'empty' };
    }
    if (!resp.ok) {
      reason = `HTTP ${resp.status}`;
      // A 400 from SPARQL is a bug in our query, not "no such film": never let it
      // become an unresolved row. It is retryable and the stall check surfaces it.
      if (!RETRYABLE_STATUS.has(resp.status)) return { kind: 'retryable', reason };
      if (attempt === MAX_ATTEMPTS) break;
      const wait = retryAfterMs(resp.headers.get('Retry-After')) ?? backoff;
      if (wait > deadline.remainingMs() - MIN_REQUEST_BUDGET_MS) {
        return { kind: 'retryable', reason: `deadline after ${reason}` };
      }
      await hooks.sleep(wait);
      backoff *= 2;
      continue;
    }
    let data: unknown;
    try {
      data = await resp.json();
    } catch {
      return { kind: 'retryable', reason: 'unparseable response body' };
    }
    await cachePut(db, identity, req.source, data);
    return { kind: 'ok', value: data };
  }
  return { kind: 'retryable', reason };
}

// --- Wikidata ---------------------------------------------------------------------

export const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
export const WDQS_ENDPOINT = 'https://query.wikidata.org/sparql';
export const ENTITIES_PER_CALL = 50;

export interface WikidataClaim {
  mainsnak?: { datavalue?: { value?: unknown } };
  rank?: string;
}

export interface WikidataEntity {
  id: string;
  labels?: Record<string, { value: string }>;
  aliases?: Record<string, Array<{ value: string }>>;
  claims?: Record<string, WikidataClaim[]>;
  sitelinks?: Record<string, { title: string }>;
}

export type EntityProps = 'labels|aliases|claims|sitelinks' | 'labels|claims' | 'labels';
export const FULL_ENTITY_PROPS: EntityProps = 'labels|aliases|claims|sitelinks';

export type SparqlBinding = Record<string, { type: string; value: string; 'xml:lang'?: string }>;

export interface WikipediaSummary {
  type?: string;
  title?: string;
  extract?: string;
  thumbnail?: { source?: string };
  content_urls?: { desktop?: { page?: string } };
}

export interface TvmazeShow {
  id: number;
  name: string;
  url?: string;
  premiered?: string | null;
  summary?: string | null;
  genres?: string[];
  language?: string | null;
  image?: { medium?: string; original?: string } | null;
}

export const screenUrls = {
  wikidataSearch: (term: string, limit: number) =>
    `${WIKIDATA_API}?${new URLSearchParams({
      action: 'wbsearchentities',
      search: term,
      language: 'en',
      uselang: 'en',
      type: 'item',
      limit: String(limit),
      format: 'json',
    })}`,
  wikidataEntities: (ids: readonly string[], props: EntityProps) =>
    `${WIKIDATA_API}?${new URLSearchParams({
      action: 'wbgetentities',
      ids: ids.join('|'),
      props,
      languages: 'en|mul',
      format: 'json',
    })}`,
  wikipediaSummary: (pageTitle: string) =>
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(
      pageTitle.replace(/ /g, '_')
    )}`,
  tvmazeSingleSearch: (q: string) =>
    `https://api.tvmaze.com/singlesearch/shows?${new URLSearchParams({ q })}`,
  tvmazeSearch: (q: string) => `https://api.tvmaze.com/search/shows?${new URLSearchParams({ q })}`,
  tvmazeShow: (id: number) => `https://api.tvmaze.com/shows/${id}`,
  sparqlBody: (query: string) => new URLSearchParams({ query }).toString(),
};

const QID_PATTERN = /^Q\d+$/;

export function isQid(value: unknown): value is string {
  return typeof value === 'string' && QID_PATTERN.test(value);
}

export function compareQids(a: string, b: string): number {
  return Number(a.slice(1)) - Number(b.slice(1));
}

/** `http://www.wikidata.org/entity/Q42` -> `Q42`. */
export function qidFromUri(uri: string): string | null {
  const id = uri.slice(uri.lastIndexOf('/') + 1);
  return isQid(id) ? id : null;
}

/** A SPARQL string literal (the caller appends @en / @mul). */
export function sparqlString(s: string): string {
  const escaped = s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

export async function wikidataSearch(
  db: Db,
  term: string,
  limit: number,
  deadline: Deadline
): Promise<CatalogResult<string[]>> {
  const out = await screenFetchJson(
    db,
    { url: screenUrls.wikidataSearch(term, limit), source: SCREEN_SOURCES.wikidata },
    deadline
  );
  if (out.kind === 'retryable') return out;
  if (out.kind === 'empty') return { kind: 'ok', value: [] };
  const hits = (out.value as { search?: Array<{ id?: unknown }> }).search ?? [];
  return { kind: 'ok', value: hits.map((hit) => hit.id).filter(isQid) };
}

export async function wikidataEntities(
  db: Db,
  qids: readonly string[],
  props: EntityProps,
  deadline: Deadline
): Promise<CatalogResult<Map<string, WikidataEntity>>> {
  const ids = [...new Set(qids)].filter(isQid).sort(compareQids);
  const found = new Map<string, WikidataEntity>();
  for (let i = 0; i < ids.length; i += ENTITIES_PER_CALL) {
    const batch = ids.slice(i, i + ENTITIES_PER_CALL);
    const out = await screenFetchJson(
      db,
      { url: screenUrls.wikidataEntities(batch, props), source: SCREEN_SOURCES.wikidata },
      deadline
    );
    if (out.kind === 'retryable') return out;
    if (out.kind === 'empty') continue;
    const entities = (out.value as { entities?: Record<string, WikidataEntity> }).entities ?? {};
    for (const [id, entity] of Object.entries(entities)) {
      if (entity && !('missing' in entity) && isQid(id)) found.set(id, entity);
    }
  }
  return { kind: 'ok', value: found };
}

export async function wikidataSparql(
  db: Db,
  query: string,
  deadline: Deadline
): Promise<CatalogResult<SparqlBinding[]>> {
  const out = await screenFetchJson(
    db,
    { url: WDQS_ENDPOINT, source: SCREEN_SOURCES.wdqs, body: screenUrls.sparqlBody(query) },
    deadline
  );
  if (out.kind === 'retryable') return out;
  if (out.kind === 'empty') return { kind: 'ok', value: [] };
  const bindings = (out.value as { results?: { bindings?: SparqlBinding[] } }).results?.bindings;
  return { kind: 'ok', value: Array.isArray(bindings) ? bindings : [] };
}

// --- Wikipedia ----------------------------------------------------------------------

export async function wikipediaSummary(
  db: Db,
  pageTitle: string,
  deadline: Deadline
): Promise<CatalogResult<WikipediaSummary>> {
  const out = await screenFetchJson(
    db,
    { url: screenUrls.wikipediaSummary(pageTitle), source: SCREEN_SOURCES.wikipedia },
    deadline
  );
  if (out.kind !== 'ok') return out;
  return { kind: 'ok', value: out.value as WikipediaSummary };
}

// --- TVmaze -------------------------------------------------------------------------

function isTvmazeShow(value: unknown): value is TvmazeShow {
  const show = value as TvmazeShow | null;
  return (
    !!show &&
    typeof show === 'object' &&
    typeof show.id === 'number' &&
    typeof show.name === 'string'
  );
}

async function tvmazeOne(
  db: Db,
  url: string,
  deadline: Deadline
): Promise<CatalogResult<TvmazeShow>> {
  const out = await screenFetchJson(db, { url, source: SCREEN_SOURCES.tvmaze }, deadline);
  if (out.kind !== 'ok') return out;
  return isTvmazeShow(out.value) ? { kind: 'ok', value: out.value } : { kind: 'empty' };
}

export function tvmazeSingleSearch(db: Db, q: string, deadline: Deadline) {
  return tvmazeOne(db, screenUrls.tvmazeSingleSearch(q), deadline);
}

export function tvmazeShow(db: Db, id: number, deadline: Deadline) {
  return tvmazeOne(db, screenUrls.tvmazeShow(id), deadline);
}

export async function tvmazeSearch(
  db: Db,
  q: string,
  deadline: Deadline
): Promise<CatalogResult<TvmazeShow[]>> {
  const out = await screenFetchJson(
    db,
    { url: screenUrls.tvmazeSearch(q), source: SCREEN_SOURCES.tvmaze },
    deadline
  );
  if (out.kind === 'retryable') return out;
  if (out.kind === 'empty') return { kind: 'ok', value: [] };
  const hits = Array.isArray(out.value) ? (out.value as Array<{ show?: unknown }>) : [];
  return { kind: 'ok', value: hits.map((hit) => hit.show).filter(isTvmazeShow) };
}

// --- Entity helpers (spike wd.py#claim_ids / #claim_years) -------------------------

function claimValues(entity: WikidataEntity, property: string): unknown[] {
  return (entity.claims?.[property] ?? [])
    .map((claim) => claim.mainsnak?.datavalue?.value)
    .filter((value) => value !== undefined && value !== null);
}

export function claimIds(entity: WikidataEntity, property: string): string[] {
  return claimValues(entity, property)
    .map((value) => (value as { id?: unknown }).id)
    .filter(isQid);
}

export function claimStrings(entity: WikidataEntity, property: string): string[] {
  return claimValues(entity, property).filter(
    (value): value is string => typeof value === 'string'
  );
}

/** Every distinct year among a time property's values, ascending. Any P577 year counts (§2.1 finding 3). */
export function claimYears(entity: WikidataEntity, property = 'P577'): number[] {
  const years = new Set<number>();
  for (const value of claimValues(entity, property)) {
    const time = (value as { time?: unknown }).time;
    if (typeof time !== 'string') continue;
    const match = /^([+-])(\d+)-/.exec(time);
    if (match) years.add((match[1] === '-' ? -1 : 1) * Number(match[2]));
  }
  return [...years].sort((a, b) => a - b);
}

/** en first, then mul: famous items often carry only a mul label (§2.1 finding 2a). */
export function entityLabel(entity: WikidataEntity): string | null {
  return entity.labels?.en?.value ?? entity.labels?.mul?.value ?? null;
}

export function entityNames(entity: WikidataEntity): string[] {
  return [
    entity.labels?.en?.value,
    entity.labels?.mul?.value,
    ...(entity.aliases?.en ?? []).map((alias) => alias.value),
    ...(entity.aliases?.mul ?? []).map((alias) => alias.value),
  ].filter((name): name is string => typeof name === 'string' && name.length > 0);
}

export function sitelinkCount(entity: WikidataEntity): number {
  return Object.keys(entity.sitelinks ?? {}).length;
}

export function enwikiTitle(entity: WikidataEntity): string | null {
  return entity.sitelinks?.enwiki?.title ?? null;
}
