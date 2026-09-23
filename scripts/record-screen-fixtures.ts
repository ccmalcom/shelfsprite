/**
 * Controller-run, needs the network: records the screen replay fixture.
 *
 *   npx tsx scripts/record-screen-fixtures.ts
 *   npx prettier --write lib/server/__tests__/fixtures/screen/resolve-films.json
 *
 * 1. Runs the replay set live against a fresh PGlite database, recording every final 200/404
 *    response under replayKey(url, init). 429s and 5xx are not recorded: the transport retries
 *    them itself, and the retry's answer is what gets recorded.
 * 2. Aborts if any title deferred or either search failed: a fixture must hold definite answers.
 * 3. Trims each response to the fields the resolver reads.
 * 4. Re-runs the set against only the trimmed fixtures (fresh database, sleeps disabled) and
 *    refuses to write unless the summaries are identical to the live run's.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  runReplaySet,
  type ReplayObserved,
} from '../lib/server/__tests__/fixtures/screen/replay-set';
import { makeTestDb } from '../lib/server/__tests__/helpers/pglite';
import { replayKey } from '../lib/server/__tests__/helpers/replayKey';
import { _setScreenCatalogHooksForTests, deadlineIn } from '../lib/server/screenCatalog';

interface Entry {
  status: number;
  body?: unknown;
}

const OUT = path.resolve(
  __dirname,
  '..',
  'lib/server/__tests__/fixtures/screen/resolve-films.json'
);

/** Every property screenEnrichment.ts reads (Tasks 5-7). */
const KEEP_CLAIMS = new Set([
  'P31',
  'P50',
  'P57',
  'P58',
  'P136',
  'P144',
  'P170',
  'P179',
  'P218',
  'P272',
  'P364',
  'P495',
  'P577',
  'P580',
  'P921',
  'P8600',
]);
const KEEP_LANGS = ['en', 'mul'];

type Json = Record<string, unknown>;

function pickLangs(record: unknown): Json | undefined {
  if (!record || typeof record !== 'object') return undefined;
  const out: Json = {};
  for (const lang of KEEP_LANGS) {
    if (lang in (record as Json)) out[lang] = (record as Json)[lang];
  }
  return out;
}

function trimEntity(entity: Json): Json {
  if ('missing' in entity) return entity;
  const claims: Json = {};
  for (const [prop, list] of Object.entries((entity.claims as Json | undefined) ?? {})) {
    if (!KEEP_CLAIMS.has(prop)) continue;
    claims[prop] = (
      list as Array<{ mainsnak?: { datavalue?: { value?: unknown } }; rank?: string }>
    ).map((claim) => ({
      mainsnak: { datavalue: { value: claim.mainsnak?.datavalue?.value } },
      rank: claim.rank,
    }));
  }
  const out: Json = { id: entity.id };
  if (entity.labels) out.labels = pickLangs(entity.labels);
  if (entity.aliases) out.aliases = pickLangs(entity.aliases);
  if (entity.claims) out.claims = claims;
  if (entity.sitelinks) {
    // The count is read (popularity), and enwiki's title; nothing else.
    const sitelinks: Json = {};
    for (const [site, link] of Object.entries(entity.sitelinks as Json)) {
      sitelinks[site] = site === 'enwiki' ? { title: (link as { title: string }).title } : {};
    }
    out.sitelinks = sitelinks;
  }
  return out;
}

function trimShow(show: Json): Json {
  const keep = ['id', 'name', 'url', 'premiered', 'summary', 'genres', 'language', 'image'];
  return Object.fromEntries(keep.filter((k) => k in show).map((k) => [k, show[k]]));
}

function trim(url: string, body: unknown): unknown {
  if (url.startsWith('https://www.wikidata.org/w/api.php')) {
    const action = new URL(url).searchParams.get('action');
    if (action === 'wbgetentities') {
      const entities = ((body as Json).entities as Json | undefined) ?? {};
      return {
        entities: Object.fromEntries(
          Object.entries(entities).map(([id, e]) => [id, trimEntity(e as Json)])
        ),
      };
    }
    if (action === 'wbsearchentities') {
      const hits = ((body as Json).search as Array<{ id: unknown }> | undefined) ?? [];
      return { search: hits.map((hit) => ({ id: hit.id })) };
    }
  }
  if (url.startsWith('https://en.wikipedia.org/')) {
    const s = body as Json;
    return {
      type: s.type,
      title: s.title,
      extract: s.extract,
      thumbnail: s.thumbnail ? { source: (s.thumbnail as Json).source } : undefined,
      content_urls: s.content_urls
        ? { desktop: { page: ((s.content_urls as Json).desktop as Json | undefined)?.page } }
        : undefined,
    };
  }
  if (url.startsWith('https://api.tvmaze.com/search/')) {
    return (body as Array<{ show: Json }>).map((hit) => ({ show: trimShow(hit.show) }));
  }
  if (url.startsWith('https://api.tvmaze.com/')) return trimShow(body as Json);
  return body; // SPARQL result sets are already small
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
}

async function runOnce(): Promise<ReplayObserved> {
  const { db, close } = await makeTestDb();
  try {
    return await runReplaySet(db, deadlineIn(900_000));
  } finally {
    await close();
  }
}

function incomplete(observed: ReplayObserved): string[] {
  const problems = [...observed.films, ...observed.shows]
    .filter((s) => s.kind === 'deferred')
    .map((s) => `title ${s.id} deferred: ${s.reason}`);
  if (observed.movieSearch === null) problems.push('movie search did not answer ok');
  if (observed.showSearch === null) problems.push('show search did not answer ok');
  return problems;
}

async function main(): Promise<void> {
  const realFetch = globalThis.fetch;
  const fixtures: Record<string, Entry> = {};

  // 1. Live run, recording.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    const response = await realFetch(input, init);
    if (response.status === 404) {
      fixtures[replayKey(url, init)] = { status: 404 };
    } else if (response.status === 200) {
      try {
        const body = JSON.parse(await response.clone().text());
        fixtures[replayKey(url, init)] = { status: 200, body: trim(url, body) };
      } catch {
        // Unparseable: the transport treats it as retryable, and step 2 aborts.
      }
    }
    return response;
  }) as typeof fetch;
  const live = await runOnce();
  globalThis.fetch = realFetch;

  // 2. Definite answers only.
  const problems = incomplete(live);
  if (problems.length > 0) {
    console.error('Not writing the fixture; the live run was incomplete:\n' + problems.join('\n'));
    process.exit(1);
  }

  // 4. Replay against the trimmed fixtures only.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = replayKey(urlOf(input), init);
    const entry = fixtures[key];
    if (!entry) {
      const miss = new Error(`no fixture for ${key}`);
      miss.name = 'HttpReplayMissError';
      throw miss;
    }
    return new Response(entry.body === undefined ? null : JSON.stringify(entry.body), {
      status: entry.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  _setScreenCatalogHooksForTests({ sleep: async () => undefined });
  const replayed = await runOnce();
  _setScreenCatalogHooksForTests(null);
  globalThis.fetch = realFetch;

  if (!isDeepStrictEqual(live, replayed)) {
    console.error('Not writing the fixture; the trimmed replay differs from the live run.');
    console.error(JSON.stringify({ live, replayed }, null, 2));
    process.exit(1);
  }

  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify({
      recorded_at: new Date().toISOString(),
      note: 'Recorded by scripts/record-screen-fixtures.ts; trimmed to what screenEnrichment.ts reads. Re-record, never hand-edit.',
      observed: live,
      fixtures,
    })
  );
  console.log(JSON.stringify(live, null, 2));
  console.log(`wrote ${Object.keys(fixtures).length} fixtures to ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
