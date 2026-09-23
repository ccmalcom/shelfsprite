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
