import { describe, test, expect, vi, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeTestDb } from './helpers/pglite';
import { setupTestEnv } from './helpers/testEnv';
import { candidate, seedScreenLibrary } from './helpers/screenRecFixtures';
import { _setDbForTests, schema, type Db } from '../db';
import { _setRecCandidateFetchForTests } from '../screenRecs';

const race = vi.hoisted(() => ({ failNext: false }));

vi.mock('../screenRecs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../screenRecs')>();
  return {
    ...actual,
    ensureScreenTitle: async (...args: Parameters<typeof actual.ensureScreenTitle>) => {
      if (race.failNext) {
        race.failNext = false;
        throw new Error(
          'duplicate key value violates unique constraint "uq_titles_user_wikidata_qid"'
        );
      }
      return actual.ensureScreenTitle(...args);
    },
  };
});

// vi.mock is hoisted above every import, so the route sees the wrapped ensureScreenTitle.
import { POST } from '@/app/api/screen/recommendations/[id]/feedback/route';

const call = (id: number | string, body: unknown) =>
  POST(
    new Request(`http://test/api/screen/recommendations/${id}/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: { id: String(id) } }
  );

/** Recs for 'local' (ids 1-5) and one for 'other' (id 6). */
async function seedRecs(db: Db): Promise<void> {
  const base = {
    userId: 'local',
    runId: 'run-a',
    mediaFilter: 'both',
    score: 0.9,
    rationale: 'Because.',
    status: 'served',
    createdAt: '2026-09-20 10:00:00',
  };
  await db.insert(schema.titleRecommendations).values([
    {
      ...base,
      rank: 1,
      mediaType: 'movie',
      title: 'Moon',
      year: 2009,
      wikidataQid: 'Q11002',
      genres: ['science fiction film'],
      description: 'Stored description.',
      imageUrl: 'https://upload.wikimedia.org/m.jpg',
    },
    {
      ...base,
      rank: 2,
      mediaType: 'tv',
      title: 'The Expanse',
      year: 2015,
      wikidataQid: 'Q12001',
      tvmazeId: 1825,
    },
    {
      ...base,
      rank: 3,
      mediaType: 'movie',
      title: 'Forrest Gump',
      year: 1994,
      wikidataQid: 'Q134773',
    },
    {
      ...base,
      rank: 4,
      mediaType: 'movie',
      title: 'Arrival',
      year: 2016,
      wikidataQid: 'Q20000001',
    },
    {
      ...base,
      rank: 5,
      mediaType: 'tv',
      title: 'Severance',
      year: 2022,
      wikidataQid: 'Q20000002',
      tvmazeId: 44933,
    },
    {
      ...base,
      userId: 'other',
      rank: 1,
      mediaType: 'movie',
      title: 'Their Rec',
      year: 2001,
      wikidataQid: 'Q30000001',
    },
  ]);
}

const MOON = candidate({
  title: 'Moon',
  wikidata_qid: 'Q11002',
  year: 2009,
  directors: ['Duncan Jones'],
  genres: ['science fiction film', 'drama film'],
  description: 'Fetched description.',
  description_source: 'wikipedia',
  description_url: 'https://en.wikipedia.org/wiki/Moon_(2009_film)',
});

async function withDb(fn: (db: Db) => Promise<void>, opts: { enabled?: boolean } = {}) {
  const { db, close } = await makeTestDb();
  try {
    await seedScreenLibrary(db, opts);
    await seedRecs(db);
    _setDbForTests(db);
    await fn(db);
  } finally {
    _setDbForTests(null);
    _setRecCandidateFetchForTests(null);
    await close();
  }
}

async function titleCount(db: Db): Promise<number> {
  return (await db.select().from(schema.titles).where(eq(schema.titles.userId, 'local'))).length;
}

describe('POST /api/screen/recommendations/[id]/feedback', () => {
  setupTestEnv();
  beforeEach(() => {
    race.failNext = false;
    _setRecCandidateFetchForTests(async (rec) => (rec.wikidataQid === 'Q11002' ? MOON : null));
  });

  test('accepted lands a new want title with fetched metadata and stamps rec feedback', async () => {
    await withDb(async (db) => {
      const res = await call(1, { status: 'accepted' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        id: 1,
        status: 'accepted',
        user_note: null,
        reject_reasons: null,
      });
      expect(body.title).toMatchObject({
        title: 'Moon',
        year: 2009,
        status: 'want',
        media_type: 'movie',
      });
      expect(body.title.enrichment).toMatchObject({
        identity_source: 'auto',
        confidence_label: 'HIGH',
        match_method: 'recommendation',
        directors: ['Duncan Jones'],
        description_source: 'wikipedia',
      });

      const [t] = await db.select().from(schema.titles).where(eq(schema.titles.id, body.title.id));
      expect(t).toMatchObject({ wikidataQid: 'Q11002', tvmazeId: null, feedbackUpdatedAt: null });
      const [meta] = await db
        .select()
        .from(schema.profileMeta)
        .where(eq(schema.profileMeta.userId, 'local'));
      expect(meta.recFeedbackUpdatedAt).not.toBeNull();
      const [r] = await db
        .select()
        .from(schema.titleRecommendations)
        .where(eq(schema.titleRecommendations.id, 1));
      expect(r.status).toBe('accepted');
    });
  });

  test('already_watched lands a show as watched with its TVmaze id, from stored fields when the fetch fails', async () => {
    await withDb(async (db) => {
      const body = await (await call(2, { status: 'already_watched' })).json();
      expect(body.title).toMatchObject({
        title: 'The Expanse',
        status: 'watched',
        media_type: 'tv',
      });
      const [t] = await db.select().from(schema.titles).where(eq(schema.titles.id, body.title.id));
      expect(t).toMatchObject({ wikidataQid: 'Q12001', tvmazeId: 1825 });
      expect(body.title.enrichment).toMatchObject({ identity_source: 'auto', directors: [] });
    });
  });

  test('accepting twice is idempotent', async () => {
    await withDb(async (db) => {
      const first = await (await call(1, { status: 'accepted' })).json();
      const before = await titleCount(db);
      const second = await (await call(1, { status: 'accepted' })).json();
      expect(second.title.id).toBe(first.title.id);
      expect(await titleCount(db)).toBe(before);
    });
  });

  test('an existing rated title is returned unchanged', async () => {
    await withDb(async (db) => {
      const [before] = await db.select().from(schema.titles).where(eq(schema.titles.id, 1));
      const body = await (await call(3, { status: 'accepted' })).json();
      expect(body.title.id).toBe(1);
      const [after] = await db.select().from(schema.titles).where(eq(schema.titles.id, 1));
      expect(after).toEqual(before); // still watched, still 4.5, never demoted to want
    });
  });

  test('matches an owned title by title and year when the ids differ', async () => {
    await withDb(async (db) => {
      const count = await titleCount(db);
      const body = await (await call(4, { status: 'already_watched' })).json();
      expect(body.title).toMatchObject({ id: 3, title: 'Arrival', status: 'want' });
      expect(await titleCount(db)).toBe(count);
    });
  });

  test('matches an owned show by TVmaze id', async () => {
    await withDb(async () => {
      const body = await (await call(5, { status: 'accepted' })).json();
      expect(body.title.id).toBe(4);
    });
  });

  test('retries once when a racing request wins the unique index', async () => {
    await withDb(async (db) => {
      race.failNext = true;
      const res = await call(1, { status: 'accepted' });
      expect(res.status).toBe(200);
      expect((await res.json()).title.title).toBe('Moon');
      expect(race.failNext).toBe(false);
      expect(
        (await db.select().from(schema.titles).where(eq(schema.titles.wikidataQid, 'Q11002')))
          .length
      ).toBe(1);
    });
  });

  test('rejected stores reasons and a note, and lands nothing', async () => {
    await withDb(async (db) => {
      const count = await titleCount(db);
      const body = await (
        await call(1, {
          status: 'rejected',
          reject_reasons: ['too_long', 'not_now'],
          user_note: 'Maybe later',
        })
      ).json();
      expect(body).toEqual({
        id: 1,
        status: 'rejected',
        user_note: 'Maybe later',
        reject_reasons: ['too_long', 'not_now'],
        title: null,
      });
      expect(await titleCount(db)).toBe(count);
    });
  });

  test('422 on a bad status, unknown or empty reasons, or reasons without a rejection', async () => {
    await withDb(async () => {
      const detail = async (body: unknown) => {
        const res = await call(1, body);
        expect(res.status).toBe(422);
        return (await res.json()).detail as string;
      };
      expect(await detail({ status: 'already_read' })).toBe(
        "status must be one of 'accepted', 'already_watched', 'rejected'"
      );
      expect(await detail({ status: 'rejected', reject_reasons: ['tried_author'] })).toBe(
        "Unknown reject_reasons: ['tried_author']. Valid codes: ['wrong_genre', 'too_dark', 'too_long', 'not_now', 'overhyped', 'wrong_vibe']"
      );
      expect(await detail({ status: 'rejected', reject_reasons: [] })).toContain('non-empty list');
      expect(await detail({ status: 'accepted', reject_reasons: ['too_long'] })).toBe(
        "reject_reasons may only be provided when status is 'rejected'"
      );
      expect((await call('abc', { status: 'accepted' })).status).toBe(422);
    });
  });

  test("404 for another user's recommendation and for a missing one", async () => {
    await withDb(async () => {
      expect((await call(6, { status: 'accepted' })).status).toBe(404);
      expect((await call(999, { status: 'accepted' })).status).toBe(404);
    });
  });

  test('403 when ScreenSprite is disabled', async () => {
    await withDb(async () => expect((await call(1, { status: 'accepted' })).status).toBe(403), {
      enabled: false,
    });
  });
});
