import { describe, it, expect, vi, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeTestDb, loadSeed, type Seed } from '@/lib/server/__tests__/helpers/pglite';
import { setupTestEnv } from '@/lib/server/__tests__/helpers/testEnv';
import seedJson from '@/lib/server/__tests__/fixtures/seed.json';
import { _setDbForTests, schema, type Db } from '@/lib/server/db';
import { insertTitle, setScreen } from '@/lib/server/__tests__/helpers/screenProfileFixtures';

setupTestEnv();
afterEach(() => vi.restoreAllMocks());

async function withDb(fn: (db: Db) => Promise<void>): Promise<void> {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const { db, close } = await makeTestDb();
  try {
    await loadSeed(db, seedJson as Seed);
    _setDbForTests(db);
    await fn(db);
  } finally {
    _setDbForTests(null);
    await close();
  }
}

async function post(body: unknown): Promise<Response> {
  const { POST } = await import('./route');
  return POST(
    new Request('http://test/api/taste-signal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

describe('POST /api/taste-signal, title kind', () => {
  it('records a title signal and dirties the profile', async () => {
    await withDb(async (db) => {
      await setScreen(db, true);
      const arrival = await insertTitle(db, { title: 'Arrival', letterboxdRating: 5 });
      const res = await post({ direction: 'more', target_kind: 'title', target_title_id: arrival });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body).toMatchObject({
        direction: 'more',
        target_kind: 'title',
        target_title_id: arrival,
        target_book_id: null,
      });
      const [meta] = await db
        .select()
        .from(schema.profileMeta)
        .where(eq(schema.profileMeta.userId, 'local'));
      expect(meta.recFeedbackUpdatedAt).not.toBe('2026-07-10 12:00:00');
    });
  });

  it("answers 404 for another user's title and for a missing one", async () => {
    await withDb(async (db) => {
      await setScreen(db, true);
      const theirs = await insertTitle(db, { userId: 'other', title: 'Theirs' });
      expect(
        (await post({ direction: 'more', target_kind: 'title', target_title_id: theirs })).status
      ).toBe(404);
      expect(
        (await post({ direction: 'more', target_kind: 'title', target_title_id: 99999 })).status
      ).toBe(404);
    });
  });

  it('answers 403 while ScreenSprite is disabled', async () => {
    await withDb(async (db) => {
      await setScreen(db, false);
      const arrival = await insertTitle(db, { title: 'Arrival' });
      expect(
        (await post({ direction: 'more', target_kind: 'title', target_title_id: arrival })).status
      ).toBe(403);
    });
  });

  it('rejects mismatched target fields with 422', async () => {
    await withDb(async (db) => {
      await setScreen(db, true);
      const arrival = await insertTitle(db, { title: 'Arrival' });
      expect((await post({ direction: 'more', target_kind: 'title' })).status).toBe(422);
      expect(
        (
          await post({
            direction: 'more',
            target_kind: 'title',
            target_title_id: arrival,
            target_book_id: 1,
          })
        ).status
      ).toBe(422);
      expect(
        (
          await post({
            direction: 'more',
            target_kind: 'book',
            target_book_id: 1,
            target_title_id: arrival,
          })
        ).status
      ).toBe(422);
    });
  });

  it('leaves book signals as they were, with target_title_id null in the response', async () => {
    await withDb(async () => {
      const res = await post({ direction: 'less', target_kind: 'book', target_book_id: 1 });
      expect(res.status).toBe(201);
      expect((await res.json()).target_title_id).toBeNull();
    });
  });
});
