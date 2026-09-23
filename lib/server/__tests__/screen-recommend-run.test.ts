import { describe, test, expect } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { makeTestDb } from './helpers/pglite';
import { setupTestEnv } from './helpers/testEnv';
import { fakeClaude } from './helpers/fakeClaude';
import {
  AFTER,
  candidate,
  fakeScreenPort,
  lit,
  seedScreenLibrary,
  wd,
  type FakePort,
} from './helpers/screenRecFixtures';
import { schema, type Db } from '../db';
import type { ClaudeClient } from '../claude';
import { modelFor } from '../models';
import { setRebuildReason } from '../profileMeta';
import {
  parseSeedProposals,
  runScreenRecommend,
  SEED_BUDGET_MS,
  type ScreenRecommendDeps,
} from '../screenRecommendRun';

const seedResponse = {
  content: [
    {
      type: 'tool_use',
      name: 'propose_screen_comparables',
      input: {
        comparables: [
          { title: 'Moon', media_type: 'movie', year: 2009, reason: 'quiet isolation sci-fi' },
          { title: 'The Expanse', media_type: 'tv', year: 2015, reason: 'loved the books' },
        ],
      },
    },
  ],
  usage: { input_tokens: 100, output_tokens: 50 },
};

function rankResponse(
  picks: Array<{
    idx: number;
    score: number;
    traits?: number[];
    books?: number[];
    titles?: number[];
  }>
) {
  return {
    content: [
      {
        type: 'tool_use',
        name: 'rank_screen_recommendations',
        input: {
          recommendations: picks.map((p) => ({
            candidate_index: p.idx,
            score: p.score,
            rationale: `  Because ${p.idx}.  `,
            grounded_trait_ids: p.traits ?? [],
            grounded_book_ids: p.books ?? [],
            grounded_title_ids: p.titles ?? [],
          })),
        },
      },
    ],
    usage: { input_tokens: 200, output_tokens: 80 },
  };
}

/** Candidates after assembly, in order: 0 The Expanse (multiple), 1 Murderbot, 2 Film A, 3 Moon. */
function scriptedPort(): FakePort {
  return fakeScreenPort({
    sparql: {
      'seed-movie': [
        { name: lit('Moon'), y: lit(2009), q: wd('Q11002'), sl: lit(70), len: lit('Moon') },
      ],
      'tv-crosswalk': [{ s: wd('Q12001'), tvm: lit(1825), sl: lit(60), len: lit('The Expanse') }],
      adaptation: [
        {
          title: lit('Leviathan Wakes'),
          an: lit('James S. A. Corey'),
          via: lit('series'),
          src: wd('Q7001'),
          adapt: wd('Q12001'),
          kind: lit('tv'),
          tvm: lit(1825),
          sl: lit(60),
          len: lit('The Expanse'),
          yr: lit(2015),
        },
        {
          title: lit('All Systems Red'),
          an: lit('Martha Wells'),
          via: lit('series'),
          src: wd('Q7002'),
          adapt: wd('Q8004'),
          kind: lit('tv'),
          tvm: lit(60000),
          sl: lit(30),
          len: lit('Murderbot'),
          yr: lit(2025),
        },
      ],
      'loved-people': [{ p: wd('Q10'), n: lit(1) }],
      'loved-genres': [{ g: wd('Q20'), n: lit(1) }],
      'metadata-movie': [
        { f: wd('Q5001'), np: lit(1), ng: lit(1), nsl: lit(25), len: lit('Film A'), yr: lit(2001) },
        {
          f: wd('Q134773'),
          np: lit(3),
          ng: lit(3),
          nsl: lit(99),
          len: lit('Forrest Gump'),
          yr: lit(1994),
        },
      ],
      'metadata-tv': [
        {
          f: wd('Q6001'),
          np: lit(1),
          ng: lit(1),
          nsl: lit(25),
          tvm: lit(44933),
          len: lit('Severance'),
          yr: lit(2022),
        },
      ],
    },
    tvmaze: { 'The Expanse': { id: 1825, name: 'The Expanse', premiered: '2015-12-14' } },
    metadata: {
      Q12001: candidate({
        title: 'The Expanse',
        wikidata_qid: 'Q12001',
        media_type: 'tv',
        tvmaze_id: 1825,
        year: 2015,
        creators: ['Mark Fergus'],
        description: 'A series.',
        description_source: 'tvmaze',
        image_url: 'https://static.tvmaze.com/e.jpg',
      }),
      Q8004: candidate({
        title: 'Murderbot',
        wikidata_qid: 'Q8004',
        media_type: 'tv',
        tvmaze_id: 60000,
        year: 2025,
      }),
      Q5001: candidate({
        title: 'Film A',
        wikidata_qid: 'Q5001',
        year: 2001,
        directors: ['Someone'],
      }),
      Q11002: candidate({
        title: 'Moon',
        wikidata_qid: 'Q11002',
        year: 2009,
        directors: ['Duncan Jones'],
        description: 'A film.',
        description_source: 'wikipedia',
        image_url: 'https://upload.wikimedia.org/m.jpg',
      }),
    },
  });
}

function deps(
  port: FakePort,
  over: Partial<ScreenRecommendDeps> = {}
): ScreenRecommendDeps & { aborts: number[] } {
  const aborts: number[] = [];
  return {
    aborts,
    nowMs: () => 1_000_000,
    abortAfter: (ms) => {
      aborts.push(ms);
      return new AbortController().signal;
    },
    catalog: () => port,
    ...over,
  };
}

async function seeded(
  opts: { enabled?: boolean } = {}
): Promise<{ db: Db; close: () => Promise<void> }> {
  const { db, close } = await makeTestDb();
  await seedScreenLibrary(db, opts);
  return { db, close };
}

async function usageOps(db: Db): Promise<Array<{ operation: string; model: string }>> {
  const result = await db.execute('select operation, model from usage_events order by id' as never);
  return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as Array<{
    operation: string;
    model: string;
  }>;
}

describe('runScreenRecommend gates', () => {
  setupTestEnv();

  test('403 when ScreenSprite is disabled', async () => {
    const { db, close } = await seeded({ enabled: false });
    try {
      await expect(
        runScreenRecommend(db, null, 'local', { mediaFilter: 'both' }, deps(scriptedPort()))
      ).rejects.toMatchObject({ status: 403 });
    } finally {
      await close();
    }
  });

  test('400 with no profile, and while a rebuild reason is set', async () => {
    const { db, close } = await seeded();
    try {
      await setRebuildReason(db, 'local', 'title_deleted');
      await expect(
        runScreenRecommend(db, null, 'local', { mediaFilter: 'both' }, deps(scriptedPort()))
      ).rejects.toMatchObject({
        status: 400,
        detail: expect.stringContaining('needs a full rebuild'),
      });
      await db.update(schema.profileMeta).set({ lastProfiledAt: null });
      await expect(
        runScreenRecommend(db, null, 'local', { mediaFilter: 'both' }, deps(scriptedPort()))
      ).rejects.toMatchObject({
        status: 400,
        detail: expect.stringContaining('No taste profile found'),
      });
    } finally {
      await close();
    }
  });

  test('400 when a book or a rated title changed since the build', async () => {
    const { db, close } = await seeded();
    try {
      await db.update(schema.books).set({ feedbackUpdatedAt: AFTER }).where(eq(schema.books.id, 1));
      await expect(
        runScreenRecommend(db, null, 'local', { mediaFilter: 'both' }, deps(scriptedPort()))
      ).rejects.toMatchObject({
        status: 400,
        detail:
          '1 book(s) and 0 title(s) have changed since the last profile build. Re-profile first (POST /profile/update) so recommendations reflect your current taste.',
      });
      await db.update(schema.books).set({ feedbackUpdatedAt: null }).where(eq(schema.books.id, 1));
      await db
        .update(schema.titles)
        .set({ appRating: 3, feedbackUpdatedAt: AFTER })
        .where(eq(schema.titles.id, 1));
      await expect(
        runScreenRecommend(db, null, 'local', { mediaFilter: 'both' }, deps(scriptedPort()))
      ).rejects.toMatchObject({
        status: 400,
        detail: expect.stringContaining('0 book(s) and 1 title(s)'),
      });
    } finally {
      await close();
    }
  });

  test('a want-only change does not block (accepting a rec must not force a re-profile)', async () => {
    const { db, close } = await seeded();
    try {
      const [t] = await db
        .insert(schema.titles)
        .values({
          userId: 'local',
          mediaType: 'movie',
          title: 'Accepted Rec',
          year: 2012,
          status: 'want',
          wikidataQid: 'Q777',
        })
        .returning();
      await db.insert(schema.titleEnrichment).values({
        titleId: t.id,
        wikidataQid: 'Q777',
        resolutionConfidence: 1,
        confidenceLabel: 'HIGH',
        identitySource: 'auto',
        resolvedAt: AFTER,
      });
      // Past the gate, the next check is the API key: reaching it proves the gate passed.
      await expect(
        runScreenRecommend(db, null, 'local', { mediaFilter: 'both' }, deps(scriptedPort()))
      ).rejects.toMatchObject({
        status: 400,
        detail: expect.stringContaining('No Anthropic API key configured'),
      });
    } finally {
      await close();
    }
  });
});

describe('runScreenRecommend happy path', () => {
  setupTestEnv();

  test('retrieves from all three pools, validates citations, persists one run', async () => {
    const { db, close } = await seeded();
    const port = scriptedPort();
    const d = deps(port);
    const client = fakeClaude([
      seedResponse,
      rankResponse([
        { idx: 3, score: 0.9, traits: [1, 2, 3], books: [1, 4], titles: [4, 5, 3] },
        { idx: 0, score: 0.8, traits: [1], books: [1], titles: [] },
        { idx: 99, score: 0.99 },
        { idx: 0, score: 0.1 },
      ]),
    ] as never);
    try {
      const out = await runScreenRecommend(db, client, 'local', { mediaFilter: 'both' }, d);

      expect(out).toMatchObject({
        served: 2,
        candidates: 4,
        media_filter: 'both',
        pool_adaptation: 2,
        pool_metadata: 1,
        pool_seed: 2,
        seed_timed_out: false,
        seeds: ['Moon (2009)', 'The Expanse (2015)'],
        model: modelFor('rerank'),
      });
      expect(typeof out.run_id).toBe('string');

      // Claude call plumbing: seed first with a 45s abort, rerank with the remaining budget.
      expect(d.aborts).toEqual([SEED_BUDGET_MS, 280_000]);
      expect(client.calls).toHaveLength(2);
      expect(client.calls[0].params).toMatchObject({
        model: modelFor('seed'),
        tool_choice: { type: 'tool', name: 'propose_screen_comparables' },
      });
      expect(client.calls[0].options?.signal).toBeInstanceOf(AbortSignal);
      expect(client.calls[1].params).toMatchObject({
        model: modelFor('rerank'),
        tool_choice: { type: 'tool', name: 'rank_screen_recommendations' },
      });

      // Owned titles never reach the reranker; the adaptation carries its book.
      const rankText = (
        client.calls[1].params.messages as Array<{ content: Array<{ text: string }> }>
      )[0].content[1].text;
      expect(rankText).not.toContain('Forrest Gump');
      expect(rankText).not.toContain('Severance');
      expect(rankText).toContain(
        '"adaptation_of": {"book_id": 1, "title": "Leviathan Wakes (The Expanse, #1)"}'
      );

      const rows = await db
        .select()
        .from(schema.titleRecommendations)
        .orderBy(asc(schema.titleRecommendations.rank));
      expect(rows.map((r) => [r.rank, r.title, r.mediaType, r.mediaFilter, r.status])).toEqual([
        [1, 'Moon', 'movie', 'both', 'served'],
        [2, 'The Expanse', 'tv', 'both', 'served'],
      ]);
      expect(rows[0]).toMatchObject({
        userId: 'local',
        wikidataQid: 'Q11002',
        tvmazeId: null,
        retrievalPool: 'claude_seed',
        seedReason: 'seed:quiet isolation sci-fi',
        imageUrl: 'https://upload.wikimedia.org/m.jpg',
        rationale: 'Because 3.',
        groundedTraitIds: [1], // 2 is rejected, 3 belongs to another user
        groundedBookIds: [1], // 4 belongs to another user
        groundedTitleIds: [4], // 5 is another user's, 3 is a want title the prompt never carried
      });
      expect(rows[1]).toMatchObject({
        tvmazeId: 1825,
        retrievalPool: 'multiple',
        seedReason: 'adaptation:series=Q7001;book=1',
      });

      expect((await usageOps(db)).map((u) => u.operation)).toEqual([
        'screen_rec_seed',
        'screen_rec_rank',
      ]);
    } finally {
      await close();
    }
  });

  test('no surviving picks mints no run (issue #64)', async () => {
    const { db, close } = await seeded();
    const client = fakeClaude([
      seedResponse,
      rankResponse([
        { idx: 99, score: 0.9 },
        { idx: -1, score: 0.5 },
      ]),
    ] as never);
    try {
      const out = await runScreenRecommend(
        db,
        client,
        'local',
        { mediaFilter: 'both' },
        deps(scriptedPort())
      );
      expect(out).toMatchObject({ run_id: null, served: 0, candidates: 4 });
      expect(await db.select().from(schema.titleRecommendations)).toEqual([]);
    } finally {
      await close();
    }
  });

  test('the TV filter keeps only series, each with a TVmaze id', async () => {
    const { db, close } = await seeded();
    const client = fakeClaude([
      seedResponse,
      rankResponse([
        { idx: 0, score: 0.9 },
        { idx: 1, score: 0.8 },
      ]),
    ] as never);
    try {
      await runScreenRecommend(db, client, 'local', { mediaFilter: 'tv' }, deps(scriptedPort()));
      const rows = await db.select().from(schema.titleRecommendations);
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r.mediaType).toBe('tv');
        expect(r.tvmazeId).not.toBeNull();
        expect(r.mediaFilter).toBe('tv');
      }
      const seedText = (
        client.calls[0].params.messages as Array<{ content: Array<{ text: string }> }>
      )[0].content[1].text;
      expect(seedText).toContain('TV series only (no films)');
    } finally {
      await close();
    }
  });
});

describe('runScreenRecommend time budget', () => {
  setupTestEnv();

  test('seed timeout still serves a run from the other pools', async () => {
    const { db, close } = await seeded();
    const client = {
      calls: [] as unknown[],
      messages: {
        create: async (params: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
          const tool = (params.tools as Array<{ name: string }>)[0].name;
          if (tool === 'propose_screen_comparables') {
            return new Promise((_, reject) => {
              const s = options?.signal;
              if (s?.aborted) reject(new Error('Request was aborted.'));
              s?.addEventListener('abort', () => reject(new Error('Request was aborted.')));
            });
          }
          return rankResponse([{ idx: 0, score: 0.9 }]);
        },
      },
    } as unknown as ClaudeClient;
    const d = deps(scriptedPort(), {
      abortAfter: (ms) =>
        ms === SEED_BUDGET_MS ? AbortSignal.abort() : new AbortController().signal,
    });
    try {
      const out = await runScreenRecommend(db, client, 'local', { mediaFilter: 'both' }, d);
      expect(out).toMatchObject({ seed_timed_out: true, pool_seed: 0, served: 1, seeds: [] });
      expect(out.pool_adaptation).toBeGreaterThan(0);
    } finally {
      await close();
    }
  });

  test('a seed error that is NOT a timeout still fails the run', async () => {
    const { db, close } = await seeded();
    const client = {
      messages: {
        create: async () => {
          throw new Error('upstream 500');
        },
      },
    } as unknown as ClaudeClient;
    try {
      await expect(
        runScreenRecommend(db, client, 'local', { mediaFilter: 'both' }, deps(scriptedPort()))
      ).rejects.toThrow('upstream 500');
    } finally {
      await close();
    }
  });

  test('504 when retrieval leaves less than the minimum rerank window', async () => {
    const { db, close } = await seeded();
    let now = 0;
    const inner = scriptedPort();
    const port: FakePort = {
      ...inner,
      fetchMetadata: async (qids) => {
        const r = await inner.fetchMetadata(qids);
        now = 275_000; // hydration was the last retrieval step; 300 - 20 - 275 = 5s left
        return r;
      },
    };
    const client = fakeClaude([seedResponse] as never);
    try {
      await expect(
        runScreenRecommend(
          db,
          client,
          'local',
          { mediaFilter: 'both' },
          deps(port, { nowMs: () => now })
        )
      ).rejects.toMatchObject({ status: 504 });
      expect(client.calls).toHaveLength(1); // the rerank was never started
    } finally {
      await close();
    }
  });

  test('504 when the rerank request itself is aborted', async () => {
    const { db, close } = await seeded();
    const client = {
      messages: {
        create: async (params: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
          const tool = (params.tools as Array<{ name: string }>)[0].name;
          if (tool === 'propose_screen_comparables') return seedResponse;
          if (options?.signal?.aborted) throw new Error('Request was aborted.');
          throw new Error('unreachable');
        },
      },
    } as unknown as ClaudeClient;
    const d = deps(scriptedPort(), {
      abortAfter: (ms) =>
        ms === SEED_BUDGET_MS ? new AbortController().signal : AbortSignal.abort(),
    });
    try {
      await expect(
        runScreenRecommend(db, client, 'local', { mediaFilter: 'both' }, d)
      ).rejects.toMatchObject({ status: 504 });
    } finally {
      await close();
    }
  });
});

describe('parseSeedProposals', () => {
  test('keeps well-formed titles in range, honors the filter, dedupes', () => {
    const input = {
      comparables: [
        { title: ' Moon ', media_type: 'movie', year: 2009, reason: 'x' },
        { title: 'Moon', media_type: 'movie', year: 2009, reason: 'dup' },
        { title: 'Show', media_type: 'tv', year: 2020, reason: 'y' },
        { title: '', media_type: 'movie', year: 2000 },
        { title: 'Future', media_type: 'movie', year: 2099 },
        { title: 'Float', media_type: 'movie', year: 2001.5 },
        { title: 'Theme', media_type: 'theme', year: 2001 },
      ],
    };
    expect(parseSeedProposals(input, 'both', 2026)).toEqual([
      { title: 'Moon', media_type: 'movie', year: 2009, reason: 'x' },
      { title: 'Show', media_type: 'tv', year: 2020, reason: 'y' },
    ]);
    expect(parseSeedProposals(input, 'tv', 2026).map((s) => s.title)).toEqual(['Show']);
    expect(parseSeedProposals(null, 'both', 2026)).toEqual([]);
  });
});
