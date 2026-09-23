import { describe, test, expect } from 'vitest';
import { makeTestDb } from './helpers/pglite';
import { setupTestEnv } from './helpers/testEnv';
import { seedScreenLibrary } from './helpers/screenRecFixtures';
import { _setDbForTests, schema, type Db } from '../db';
import { SCREEN_REJECT_REASONS, titleRecOut } from '../screenRecs';
import { REJECT_REASONS } from '../recs';
import { POST as recommend } from '@/app/api/screen/recommend/route';
import { GET as latest } from '@/app/api/screen/recommendations/route';
import { freezeInsideRateWindow } from './helpers/rateWindow';

const runReq = (body?: unknown) =>
  new Request('http://test/api/screen/recommend', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
const latestReq = () => new Request('http://test/api/screen/recommendations');

async function withDb(fn: (db: Db) => Promise<void>, opts: { enabled?: boolean } = {}) {
  const { db, close } = await makeTestDb();
  try {
    await seedScreenLibrary(db, opts);
    _setDbForTests(db);
    await fn(db);
  } finally {
    _setDbForTests(null);
    await close();
  }
}

function rec(over: Partial<typeof schema.titleRecommendations.$inferInsert>) {
  return {
    userId: 'local',
    runId: 'run-a',
    rank: 1,
    mediaType: 'movie',
    mediaFilter: 'both',
    title: 'Moon',
    year: 2009,
    wikidataQid: 'Q11002',
    score: 0.9,
    rationale: 'Because.',
    groundedTraitIds: [1],
    groundedBookIds: [1],
    groundedTitleIds: [2],
    status: 'served',
    createdAt: '2026-09-20 10:00:00',
    ...over,
  };
}

describe('screen reject vocabulary', () => {
  test('is the book list without tried_author, in the book order', () => {
    expect([...SCREEN_REJECT_REASONS]).toEqual(REJECT_REASONS.filter((r) => r !== 'tried_author'));
  });
});

describe('POST /api/screen/recommend', () => {
  setupTestEnv();

  test('422 on malformed JSON, an unknown filter, or an out-of-range n', async () => {
    await withDb(async () => {
      expect((await recommend(runReq('{not json'))).status).toBe(422);
      expect((await recommend(runReq({ media_filter: 'books' }))).status).toBe(422);
      expect((await recommend(runReq({ n: 0 }))).status).toBe(422);
      expect((await recommend(runReq({ n: 21 }))).status).toBe(422);
    });
  });

  test('403 when ScreenSprite is disabled', async () => {
    await withDb(
      async () => {
        const res = await recommend(runReq());
        expect(res.status).toBe(403);
      },
      { enabled: false }
    );
  });

  test('an absent body takes the defaults and reaches the key check', async () => {
    await withDb(async () => {
      const res = await recommend(runReq());
      expect(res.status).toBe(400);
      expect((await res.json()).detail).toContain('No Anthropic API key configured');
    });
  });

  test('the fourth run in a minute answers 429 in the detail shape', async () => {
    freezeInsideRateWindow();
    await withDb(async () => {
      for (let i = 0; i < 3; i++) expect((await recommend(runReq({}))).status).toBe(400);
      const res = await recommend(runReq({}));
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({
        detail: 'Too many recommendation runs. Try again in a minute.',
      });
    });
  });
});

describe('GET /api/screen/recommendations', () => {
  setupTestEnv();

  test('[] before any run', async () => {
    await withDb(async () => {
      const res = await latest(latestReq());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });
  });

  test('returns the latest run across filters, in rank order, for this user only', async () => {
    await withDb(async (db) => {
      await db.insert(schema.titleRecommendations).values([
        rec({ runId: 'run-a', mediaFilter: 'movie', createdAt: '2026-09-20 10:00:00' }),
        rec({
          runId: 'run-b',
          mediaFilter: 'tv',
          rank: 2,
          title: 'Murderbot',
          mediaType: 'tv',
          wikidataQid: 'Q8004',
          tvmazeId: 60000,
          createdAt: '2026-09-21 10:00:00',
        }),
        rec({
          runId: 'run-b',
          mediaFilter: 'tv',
          rank: 1,
          title: 'The Expanse',
          mediaType: 'tv',
          wikidataQid: 'Q12001',
          tvmazeId: 1825,
          createdAt: '2026-09-21 10:00:00',
        }),
        rec({ userId: 'other', runId: 'run-z', createdAt: '2026-09-22 10:00:00' }),
      ]);
      const body = await (await latest(latestReq())).json();
      expect(
        body.map((r: { run_id: string; rank: number; title: string }) => [
          r.run_id,
          r.rank,
          r.title,
        ])
      ).toEqual([
        ['run-b', 1, 'The Expanse'],
        ['run-b', 2, 'Murderbot'],
      ]);
      expect(body[0]).toMatchObject({
        media_type: 'tv',
        media_filter: 'tv',
        tvmaze_id: 1825,
        genres: [],
        status: 'served',
        reject_reasons: null,
      });
    });
  });

  test('403 when ScreenSprite is disabled', async () => {
    await withDb(async () => expect((await latest(latestReq())).status).toBe(403), {
      enabled: false,
    });
  });
});

describe('titleRecOut', () => {
  test('defaults null JSON lists to [] and serializes created_at', () => {
    const out = titleRecOut({
      ...rec({}),
      id: 7,
      tvmazeId: null,
      imageUrl: null,
      genres: null,
      description: null,
      retrievalPool: 'metadata',
      seedReason: 'shares a director',
      groundedTraitIds: null,
      groundedBookIds: null,
      groundedTitleIds: null,
      userNote: null,
      rejectReasons: null,
    } as never);
    expect(out).toMatchObject({
      id: 7,
      genres: [],
      grounded_trait_ids: [],
      grounded_book_ids: [],
      grounded_title_ids: [],
    });
    expect(out.created_at).toBe('2026-09-20T10:00:00');
  });
});
