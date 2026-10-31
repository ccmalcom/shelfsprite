import { describe, test, expect } from 'vitest';
import seedJson from './fixtures/seed.json';
import httpFixtures from './fixtures/claude/recommend-http.json';
import { makeTestDb, loadSeed } from './helpers/pglite';
import { setupTestEnv } from './helpers/testEnv';
import { installHttpReplay } from './helpers/httpReplay';
import { schema } from '../db';
import { parseReferenceBooks, runDiscover } from '../recDiscoverRun';
import type { ClaudeClient } from '../claude';

const DISCOVER_QUERY = 'something like The Fifth Season but gentler';
const CANNED_INTERPRETATION = 'Epic fantasy with a broken world, but warmer in tone.';

const INTERP_INPUT = {
  interpretation: CANNED_INTERPRETATION,
  queries: [
    { query: 'literary fantasy found family', rationale: 'f' },
    { query: 'gentle epic fantasy hopeful tone', rationale: 'f' },
    { query: '   ', rationale: 'blank is dropped' },
  ],
  constraints: {
    languages: ['ENG', ' fr ', ''],
    min_year: '1990',
    max_year: 2020,
    exclude_subjects: [' War ', 'grief', ''],
    page_count_max: 400,
    standalone: true,
  },
};

/** A ClaudeClient that answers stage A then stage B, in order. */
function fakeClient(
  interpInput: unknown,
  rankedPayload?: unknown[]
): ClaudeClient & { calls: any[] } {
  const calls: any[] = [];
  let n = 0;
  return {
    calls,
    messages: {
      create: async (kwargs: any) => {
        calls.push(kwargs);
        n++;
        if (n === 1) {
          return {
            content: [{ type: 'tool_use', name: 'interpret_request', input: interpInput }],
            usage: null,
          };
        }
        return {
          content: [
            {
              type: 'tool_use',
              name: 'rank_discovery',
              input: { recommendations: rankedPayload ?? [] },
            },
          ],
          usage: null,
        };
      },
    },
  } as any;
}

describe('runDiscover', () => {
  setupTestEnv();

  test('runs both stages, drops bad indices, rounds scores and does not persist', async () => {
    const { db, close } = await makeTestDb();
    const restore = installHttpReplay(httpFixtures as any);
    try {
      await loadSeed(db, seedJson as any);
      const client = fakeClient(INTERP_INPUT, [
        { candidate_index: 0, score: 0.875, rationale: '  padded  ' },
        { candidate_index: 1, score: 0.5, rationale: 'second' },
        { candidate_index: 4242, score: 0.99, rationale: 'hallucinated' },
        { candidate_index: 0, score: 0.99, rationale: 'duplicate' },
        { candidate_index: -1, score: 0.99, rationale: 'negative' },
      ]);
      const out: any = await runDiscover(db, client, 'local', DISCOVER_QUERY, 10);

      expect(out.query).toBe(DISCOVER_QUERY);
      expect(out.interpretation).toBe(CANNED_INTERPRETATION);
      expect(out.model).toBe('claude-sonnet-5-5');
      // The blank query is dropped before retrieval.
      expect(out.queries).toEqual([
        'literary fantasy found family',
        'gentle epic fantasy hopeful tone',
      ]);
      expect(out.count).toBe(2);
      expect(out.recommendations).toHaveLength(2);
      expect(out.recommendations[0].rank).toBe(1);
      // round(0.875, 2) is a banker's-rounding tie: 87 is odd, so it goes to 0.88.
      expect(out.recommendations[0].score).toBe(0.88);
      expect(out.recommendations[0].rationale).toBe('padded');
      // Discovery passes an empty metadata pool, so everything is claude_seed.
      expect(out.recommendations.every((r: any) => r.retrieval_pool === 'claude_seed')).toBe(true);

      // Ephemeral: nothing may reach the recommendations table.
      const rows = await db.select().from(schema.recommendations);
      expect(rows).toHaveLength((seedJson as any).recommendations.length);

      expect(client.calls[0].model).toBe('claude-haiku-5-5');
      expect(client.calls[1].model).toBe('claude-sonnet-5-5');
    } finally {
      restore();
      await close();
    }
  });

  test('a request for an author fetches their books directly and drops junk editions', async () => {
    // #52: "my next John Scalzi read" used to become "books like Scalzi", so no query
    // ever fetched his books, and the per-author cap would have kept at most two anyway.
    const OL_FIELDS =
      'fields=key%2Ctitle%2Cauthor_name%2Cfirst_publish_year%2Cpublish_year%2Ccover_i%2Cisbn%2Csubject%2Clanguage';
    const restore = installHttpReplay({
      [`https://openlibrary.org/search.json?author=John+Scalzi&limit=20&${OL_FIELDS}`]: {
        status: 200,
        body: {
          docs: [
            { title: "Old Man's War", author_name: ['John Scalzi'] }, // already read
            { title: 'Redshirts', author_name: ['John Scalzi'] },
            { title: "The Android's Dream", author_name: ['John Scalzi'] },
            { title: 'Lock In', author_name: ['John Scalzi'] },
            { title: 'Starter Villain', author_name: ['John Scalzi'] },
            { title: 'The Interdependency Boxed Set', author_name: ['John Scalzi'] },
          ],
        },
      },
      'https://www.googleapis.com/books/v1/volumes?q=witty+military+science+fiction&maxResults=8': {
        status: 200,
        body: {
          items: [
            { id: 'g1', volumeInfo: { title: 'Library Journal' } }, // a periodical: no author
            {
              id: 'g2',
              volumeInfo: { title: 'Deathworld (Book 1&2)', authors: ['Harry Harrison'] },
            },
            { id: 'g3', volumeInfo: { title: "Ocean's Echo", authors: ['Everina Maxwell'] } },
            { id: 'g4', volumeInfo: { title: 'Redshirts', authors: ['John Scalzi'] } },
          ],
        },
      },
      [`https://openlibrary.org/search.json?q=witty+military+science+fiction&limit=8&${OL_FIELDS}`]:
        { status: 200, body: { docs: [] } },
    });
    const { db, close } = await makeTestDb();
    try {
      const seed = seedJson as any;
      await loadSeed(db, {
        ...seed,
        books: [
          ...seed.books,
          {
            ...seed.books[0],
            id: 901,
            title: "Old Man's War",
            author: 'John Scalzi',
            isbn13: null,
            goodreads_book_id: 'gr-901',
          },
        ],
      });
      const client = fakeClient(
        {
          interpretation: 'Books by John Scalzi the reader has not read yet.',
          authors: ['John Scalzi'],
          queries: [{ query: 'witty military science fiction', rationale: 'backup' }],
        },
        [0, 1, 2, 3, 4].map((i) => ({ candidate_index: i, score: 0.9 - i / 10, rationale: 'r' }))
      );
      const out: any = await runDiscover(db, client, 'local', 'my next John Scalzi read', 5);

      const text = client.calls[1].messages[0].content[1].text as string;
      const seen = JSON.parse(text.slice(text.indexOf('CANDIDATES (JSON):') + 19)) as any[];
      expect(seen.map((c) => c.title).sort()).toEqual([
        'Lock In',
        "Ocean's Echo",
        'Redshirts',
        'Starter Villain',
        "The Android's Dream",
      ]);
      const pools = Object.fromEntries(
        out.recommendations.map((r: any) => [r.title, r.retrieval_pool])
      );
      // Requested-author books are a deterministic pool; one the queries also found is 'both'.
      expect(pools).toEqual({
        Redshirts: 'both',
        "The Android's Dream": 'metadata',
        'Lock In': 'metadata',
        'Starter Villain': 'metadata',
        "Ocean's Echo": 'claude_seed',
      });
    } finally {
      restore();
      await close();
    }
  });

  test('an author request with no facet queries still retrieves', async () => {
    const restore = installHttpReplay({
      'https://openlibrary.org/search.json?author=John+Scalzi&limit=20&fields=key%2Ctitle%2Cauthor_name%2Cfirst_publish_year%2Cpublish_year%2Ccover_i%2Cisbn%2Csubject%2Clanguage':
        { status: 200, body: { docs: [{ title: 'Redshirts', author_name: ['John Scalzi'] }] } },
    });
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      const client = fakeClient(
        { interpretation: 'By Scalzi.', authors: ['John Scalzi'], queries: [] },
        [{ candidate_index: 0, score: 0.9, rationale: 'r' }]
      );
      const out: any = await runDiscover(db, client, 'local', 'more Scalzi', 5);
      expect(out.recommendations.map((r: any) => r.title)).toEqual(['Redshirts']);
      expect(client.calls).toHaveLength(2);
    } finally {
      restore();
      await close();
    }
  });

  test('400s on an empty or whitespace-only query, before any Claude call', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      const client = fakeClient(INTERP_INPUT);
      for (const q of ['', '   ']) {
        await expect(runDiscover(db, client, 'local', q, 10)).rejects.toMatchObject({
          status: 400,
          detail: 'Enter something to search for.',
        });
      }
      expect(client.calls).toHaveLength(0);
    } finally {
      await close();
    }
  });

  test('400s with the no-key message BEFORE any catalog request', async () => {
    // Discovery has no metadata pool, so _client() raises inside stage A before a
    // single catalog fetch. An empty replay map proves it: any request would throw
    // HttpReplayMissError instead of the 400 asserted here.
    const { db, close } = await makeTestDb();
    const seen: string[] = [];
    const restore = installHttpReplay({}, (u) => seen.push(u));
    try {
      await loadSeed(db, seedJson as any);
      await expect(runDiscover(db, null, 'local', DISCOVER_QUERY, 10)).rejects.toMatchObject({
        status: 400,
        detail: expect.stringContaining('No Anthropic API key configured'),
      });
      expect(seen).toEqual([]);
    } finally {
      restore();
      await close();
    }
  });

  test('returns early with queries: [] when stage A proposes nothing', async () => {
    const { db, close } = await makeTestDb();
    const seen: string[] = [];
    const restore = installHttpReplay({}, (u) => seen.push(u));
    try {
      await loadSeed(db, seedJson as any);
      const client = fakeClient({ interpretation: 'nothing', queries: [] });
      const out: any = await runDiscover(db, client, 'local', 'gibberish', 10);
      expect(out).toEqual({
        query: 'gibberish',
        interpretation: 'nothing',
        count: 0,
        model: 'claude-sonnet-5-5',
        queries: [],
        recommendations: [],
      });
      // No retrieval, and no second Claude call.
      expect(seen).toEqual([]);
      expect(client.calls).toHaveLength(1);
    } finally {
      restore();
      await close();
    }
  });

  test('returns early WITH the queries when retrieval surfaces no candidates', async () => {
    const { db, close } = await makeTestDb();
    // Both sources answer 404 -> empty pool -> empty candidate list. They must be
    // PRESENT in the fixture map as 404s: a URL that is simply absent throws
    // HttpReplayMissError, which catalog.ts propagates rather than swallowing.
    const restore = installHttpReplay({
      'https://www.googleapis.com/books/v1/volumes?q=zzzz+nothing&maxResults=8': { status: 404 },
      'https://openlibrary.org/search.json?q=zzzz+nothing&limit=8&fields=key%2Ctitle%2Cauthor_name%2Cfirst_publish_year%2Cpublish_year%2Ccover_i%2Cisbn%2Csubject%2Clanguage':
        { status: 404 },
    });
    try {
      await loadSeed(db, seedJson as any);
      const client = fakeClient({
        interpretation: 'nothing findable',
        queries: [{ query: 'zzzz nothing', rationale: 'f' }],
      });
      const out: any = await runDiscover(db, client, 'local', 'zzzz', 10);
      expect(out.count).toBe(0);
      // Unlike the no-queries early return above, this one carries the queries.
      expect(out.queries).toEqual(['zzzz nothing']);
      expect(out.recommendations).toEqual([]);
      expect(client.calls).toHaveLength(1); // no rerank call
    } finally {
      restore();
      await close();
    }
  });

  test('"like Gilead" resolves Gilead first and seeds retrieval with its author and subjects', async () => {
    // QA 2026-10-30: "a quiet novel like Gilead but not about religion" returned three
    // omnibuses, because the facet queries went to the catalog as free text and the named
    // book was never looked up.
    const requested: string[] = [];
    const gilead = {
      title: 'Gilead',
      author: 'Marilynne Robinson',
      subjects: [
        'Fiction',
        'Clergy',
        'Fathers and sons',
        'Religious fiction',
        'Epistolary fiction',
        'Domestic fiction',
      ],
    };
    const olDoc = (b: { title: string; author: string; subjects?: string[] }, i: number) => ({
      key: `/works/OLG${i}W`,
      title: b.title,
      author_name: [b.author],
      subject: b.subjects ?? ['Fiction'],
      first_publish_year: 2000,
      language: ['eng'],
    });
    const router = (url: URL): unknown => {
      const q = (
        url.searchParams.get('q') ??
        url.searchParams.get('title') ??
        url.searchParams.get('author') ??
        ''
      ).toLowerCase();
      if (url.host === 'www.googleapis.com') {
        if (q.includes('quiet introspective')) {
          return {
            items: [
              'J. M. Barrie Complete Novels',
              'A Literary Cavalcade-V',
              'Illustrated literature of all nations [8 novels]',
              'Stoner',
            ].map((title, i) => ({
              id: `gq${i}`,
              volumeInfo: {
                title,
                authors: [title === 'Stoner' ? 'John Williams' : 'Various'],
                categories: ['Fiction'],
                description: `${title}, described.`,
              },
            })),
          };
        }
        if (q.includes('gilead')) {
          return {
            items: [
              {
                id: 'ggilead',
                volumeInfo: {
                  title: 'Gilead',
                  authors: ['Marilynne Robinson'],
                  categories: ['Fiction'],
                  description: 'A letter from an old preacher.',
                },
              },
            ],
          };
        }
        return {};
      }
      if (url.pathname === '/search.json') {
        if (url.searchParams.get('author') === 'Marilynne Robinson') {
          return {
            docs: [
              gilead,
              { title: 'Housekeeping', author: 'Marilynne Robinson' },
              { title: 'Home', author: 'Marilynne Robinson' },
              { title: 'Lila', author: 'Marilynne Robinson', subjects: ['Fiction', 'Religion'] },
              { title: 'Jack', author: 'Marilynne Robinson' },
            ].map(olDoc),
          };
        }
        if (q.includes('gilead')) return { docs: [olDoc(gilead, 9)] };
        return {};
      }
      const subject = /^\/subjects\/(.+)\.json$/.exec(url.pathname)?.[1];
      const bySubject: Record<string, [string, string]> = {
        epistolary_fiction: ['84, Charing Cross Road', 'Helene Hanff'],
        domestic_fiction: ['Plainsong', 'Kent Haruf'],
      };
      if (subject && bySubject[subject]) {
        const [title, name] = bySubject[subject];
        return { works: [{ key: `/works/OLS${subject}W`, title, authors: [{ name }] }] };
      }
      return {};
    };
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      requested.push(url);
      return new Response(JSON.stringify(router(new URL(url))), { status: 200 });
    }) as typeof fetch;
    const savedRps = process.env.MYLIBRARY_REQ_PER_SEC;
    process.env.MYLIBRARY_REQ_PER_SEC = '1000000';
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      const client = fakeClient(
        {
          interpretation: 'A quiet, interior literary novel like Gilead, without religion.',
          queries: [{ query: 'quiet introspective literary novel', rationale: 'mood' }],
          reference_books: [
            { title: 'Gilead', author: 'Marilynne Robinson' },
            { title: '   ' },
            { title: 'Gilead', author: 'Marilynne Robinson' },
          ],
          constraints: { exclude_subjects: ['religion'] },
        },
        [0, 1, 2, 3, 4, 5].map((i) => ({ candidate_index: i, score: 0.9 - i / 20, rationale: 'r' }))
      );
      const out: any = await runDiscover(
        db,
        client,
        'local',
        'a quiet novel like Gilead but not about religion',
        10
      );

      expect(out.reference_books).toEqual(['Gilead by Marilynne Robinson']);
      const text = client.calls[1].messages[0].content[1].text as string;
      const seen = (JSON.parse(text.slice(text.indexOf('CANDIDATES (JSON):') + 19)) as any[]).map(
        (c) => c.title
      );
      // The named book's author (two at most, Lila dropped by the stated exclusion) and its
      // genre subjects reach the reranker, beside the free-text hit that was a real novel.
      expect(seen.sort()).toEqual(
        ['84, Charing Cross Road', 'Home', 'Housekeeping', 'Plainsong', 'Stoner'].sort()
      );
      // Gilead itself is the reference, never a candidate; the omnibuses never pass assembly.
      // "Religious fiction" is never searched, since the reader ruled religion out.
      expect(requested.some((u) => u.includes('/subjects/religious_fiction'))).toBe(false);
      expect(requested.some((u) => u.includes('/subjects/epistolary_fiction'))).toBe(true);
    } finally {
      globalThis.fetch = original;
      if (savedRps === undefined) delete process.env.MYLIBRARY_REQ_PER_SEC;
      else process.env.MYLIBRARY_REQ_PER_SEC = savedRps;
      await close();
    }
  });

  test('parseReferenceBooks keeps titled, distinct entries, two at most', () => {
    expect(
      parseReferenceBooks([
        { title: ' Piranesi ', author: 'Susanna Clarke' },
        { title: 'Piranesi', author: 'Susanna Clarke' },
        { author: 'No Title' },
        { title: 'Gilead' },
        { title: 'Third', author: 'X Y' },
      ])
    ).toEqual([
      { title: 'Piranesi', author: 'Susanna Clarke' },
      { title: 'Gilead', author: null },
    ]);
    expect(parseReferenceBooks(undefined)).toEqual([]);
  });

  test('sends the seed override to interpretation and the rerank override to ranking', async () => {
    process.env.MYLIBRARY_MODEL_SEED = 'model-seed';
    process.env.MYLIBRARY_MODEL_RERANK = 'model-rerank';
    const { db, close } = await makeTestDb();
    const restore = installHttpReplay(httpFixtures as any);
    try {
      await loadSeed(db, seedJson as any);
      const client = fakeClient(INTERP_INPUT, [{ candidate_index: 0, score: 0.5, rationale: 'r' }]);
      const out: any = await runDiscover(db, client, 'local', DISCOVER_QUERY, 10);
      expect(client.calls[0].model).toBe('model-seed');
      expect(client.calls[1].model).toBe('model-rerank');
      expect(out.model).toBe('model-rerank');
    } finally {
      restore();
      await close();
    }
  });
});
