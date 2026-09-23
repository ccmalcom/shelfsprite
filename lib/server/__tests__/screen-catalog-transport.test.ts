import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheGet } from '../catalogCache';
import type { Db } from '../db';
import {
  MAX_ATTEMPTS,
  RETRY_AFTER_CAP_MS,
  SCREEN_SOURCES,
  SCREEN_USER_AGENT,
  _setScreenCatalogHooksForTests,
  requestIdentity,
  screenFetchJson,
  type Deadline,
} from '../screenCatalog';
import { installHttpReplay } from './helpers/httpReplay';
import { replayKey } from './helpers/replayKey';
import { makeTestDb } from './helpers/pglite';

const WD = 'https://www.wikidata.org/w/api.php?action=wbgetentities&ids=Q1&format=json';
const WDQS = 'https://query.wikidata.org/sparql';
const TVMAZE = 'https://api.tvmaze.com/shows/1';

let db: Db;
let close: () => Promise<void>;
let sleeps: number[];
let calls: Array<{ url: string; init?: RequestInit }>;

const plenty: Deadline = { remainingMs: () => 600_000 };
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

function stubFetch(queue: Array<Response | Error>): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = queue.shift();
    if (!next) throw new Error('stubFetch: queue exhausted');
    if (next instanceof Error) throw next;
    return next;
  });
}

beforeEach(async () => {
  ({ db, close } = await makeTestDb());
  sleeps = [];
  calls = [];
  _setScreenCatalogHooksForTests({
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => 1_000_000,
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  _setScreenCatalogHooksForTests(null);
  await close();
});

describe('screenFetchJson', () => {
  it('returns ok, caches the payload under a screen source, and serves the cache next time', async () => {
    stubFetch([json(200, { entities: {} })]);
    const req = { url: WD, source: SCREEN_SOURCES.wikidata };
    expect(await screenFetchJson(db, req, plenty)).toEqual({ kind: 'ok', value: { entities: {} } });
    expect(await screenFetchJson(db, req, plenty)).toEqual({ kind: 'ok', value: { entities: {} } });
    expect(calls).toHaveLength(1);
    const rows = await (db as any).$client.query('select source from catalog_cache');
    expect(rows.rows).toEqual([{ source: 'screen:wikidata' }]);
  });

  it('sends the screen User-Agent, which carries no email address', async () => {
    stubFetch([json(200, {})]);
    await screenFetchJson(db, { url: TVMAZE, source: SCREEN_SOURCES.tvmaze }, plenty);
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe(SCREEN_USER_AGENT);
    expect(SCREEN_USER_AGENT).toBe('ShelfSprite/0.1 (https://shelfsprite.app)');
    expect(SCREEN_USER_AGENT).not.toMatch(/@/);
  });

  it('answers empty for a 404 and caches it negatively', async () => {
    stubFetch([json(404, { error: 'not found' })]);
    const req = { url: TVMAZE, source: SCREEN_SOURCES.tvmaze };
    expect(await screenFetchJson(db, req, plenty)).toEqual({ kind: 'empty' });
    expect(await screenFetchJson(db, req, plenty)).toEqual({ kind: 'empty' });
    expect(calls).toHaveLength(1);
  });

  it('answers retryable, never empty, after MAX_ATTEMPTS server errors, and caches nothing', async () => {
    stubFetch([json(503, {}), json(503, {}), json(503, {})]);
    const req = { url: WD, source: SCREEN_SOURCES.wikidata };
    const out = await screenFetchJson(db, req, plenty);
    expect(out).toEqual({ kind: 'retryable', reason: 'HTTP 503' });
    expect(calls).toHaveLength(MAX_ATTEMPTS);
    expect(await cacheGet(db, requestIdentity(req))).toEqual({ hit: false, payload: null });
  });

  it('caps Retry-After at ten seconds', async () => {
    stubFetch([json(429, {}, { 'Retry-After': '120' }), json(200, { ok: 1 })]);
    const out = await screenFetchJson(db, { url: WD, source: SCREEN_SOURCES.wikidata }, plenty);
    expect(out).toEqual({ kind: 'ok', value: { ok: 1 } });
    expect(sleeps).toContain(RETRY_AFTER_CAP_MS);
    expect(Math.max(...sleeps)).toBe(RETRY_AFTER_CAP_MS);
  });

  it('defers rather than sleeping past the deadline', async () => {
    stubFetch([json(429, {}, { 'Retry-After': '5' })]);
    const tight: Deadline = { remainingMs: () => 6_000 };
    const out = await screenFetchJson(db, { url: WD, source: SCREEN_SOURCES.wikidata }, tight);
    expect(out).toEqual({ kind: 'retryable', reason: 'deadline after HTTP 429' });
    expect(calls).toHaveLength(1);
  });

  it('does not start a request when less than three seconds remain', async () => {
    stubFetch([]);
    const spent: Deadline = { remainingMs: () => 2_000 };
    const out = await screenFetchJson(db, { url: WD, source: SCREEN_SOURCES.wikidata }, spent);
    expect(out.kind).toBe('retryable');
    expect(calls).toHaveLength(0);
  });

  it('still serves a cache hit when the deadline is spent', async () => {
    stubFetch([json(200, { cached: true })]);
    const req = { url: WD, source: SCREEN_SOURCES.wikidata };
    await screenFetchJson(db, req, plenty);
    const out = await screenFetchJson(db, req, { remainingMs: () => 0 });
    expect(out).toEqual({ kind: 'ok', value: { cached: true } });
  });

  it('treats a non-404 client error as retryable without retrying it', async () => {
    stubFetch([json(400, { error: 'bad query' })]);
    const out = await screenFetchJson(db, { url: WD, source: SCREEN_SOURCES.wikidata }, plenty);
    expect(out).toEqual({ kind: 'retryable', reason: 'HTTP 400' });
    expect(calls).toHaveLength(1);
  });

  it('retries a network error and then answers retryable', async () => {
    stubFetch([
      new TypeError('fetch failed'),
      new TypeError('fetch failed'),
      new TypeError('fetch failed'),
    ]);
    const out = await screenFetchJson(db, { url: WD, source: SCREEN_SOURCES.wikidata }, plenty);
    expect(out).toEqual({ kind: 'retryable', reason: 'network error: fetch failed' });
    expect(calls).toHaveLength(MAX_ATTEMPTS);
  });

  it('treats an unparseable body as retryable', async () => {
    stubFetch([new Response('<html>oops</html>', { status: 200 })]);
    const out = await screenFetchJson(db, { url: WD, source: SCREEN_SOURCES.wikidata }, plenty);
    expect(out).toEqual({ kind: 'retryable', reason: 'unparseable response body' });
  });

  it('keys a POST by its body, so two SPARQL queries are cached separately', async () => {
    stubFetch([
      json(200, { results: { bindings: [] } }),
      json(200, { results: { bindings: [1] } }),
    ]);
    const a = { url: WDQS, source: SCREEN_SOURCES.wdqs, body: 'query=A' };
    const b = { url: WDQS, source: SCREEN_SOURCES.wdqs, body: 'query=B' };
    await screenFetchJson(db, a, plenty);
    const out = await screenFetchJson(db, b, plenty);
    expect(out).toEqual({ kind: 'ok', value: { results: { bindings: [1] } } });
    expect(calls.map((c) => c.init?.method)).toEqual(['POST', 'POST']);
    expect(requestIdentity(a)).toBe('POST https://query.wikidata.org/sparql\nquery=A');
  });

  it('spaces two requests to the same host by the host minimum interval', async () => {
    stubFetch([json(200, {}), json(200, {})]);
    await screenFetchJson(db, { url: TVMAZE, source: SCREEN_SOURCES.tvmaze }, plenty);
    await screenFetchJson(db, { url: `${TVMAZE}0`, source: SCREEN_SOURCES.tvmaze }, plenty);
    expect(sleeps).toEqual([550]);
  });

  it('rethrows a replay-harness miss instead of retrying it', async () => {
    const restore = installHttpReplay({});
    try {
      await expect(
        screenFetchJson(db, { url: WD, source: SCREEN_SOURCES.wikidata }, plenty)
      ).rejects.toThrow(/no fixture/);
    } finally {
      restore();
    }
  });
});

describe('POST-aware replay', () => {
  it('replays a POST fixture keyed by URL and body, and leaves GET keys as bare URLs', async () => {
    expect(replayKey(TVMAZE)).toBe(TVMAZE);
    expect(replayKey(WDQS, { method: 'POST', body: 'query=A' })).toBe(
      'POST https://query.wikidata.org/sparql\nquery=A'
    );
    const restore = installHttpReplay({
      [replayKey(WDQS, { method: 'POST', body: 'query=A' })]: {
        status: 200,
        body: { results: { bindings: ['a'] } },
      },
    });
    try {
      const out = await screenFetchJson(
        db,
        { url: WDQS, source: SCREEN_SOURCES.wdqs, body: 'query=A' },
        plenty
      );
      expect(out).toEqual({ kind: 'ok', value: { results: { bindings: ['a'] } } });
    } finally {
      restore();
    }
  });
});
