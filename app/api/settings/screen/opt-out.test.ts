import { describe, it, expect, vi, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeTestDb, loadSeed, type Seed } from '@/lib/server/__tests__/helpers/pglite';
import { setupTestEnv } from '@/lib/server/__tests__/helpers/testEnv';
import seedJson from '@/lib/server/__tests__/fixtures/seed.json';
import { _setDbForTests, schema, type Db } from '@/lib/server/db';
import { setScreen } from '@/lib/server/__tests__/helpers/screenProfileFixtures';

setupTestEnv();
afterEach(() => vi.restoreAllMocks());

async function withDb(fn: (db: Db) => Promise<void>): Promise<void> {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const { db, close } = await makeTestDb();
  try {
    await loadSeed(db, seedJson as Seed);
    await setScreen(db, true);
    await db.insert(schema.tasteTraits).values({
      userId: 'local',
      claim: 'Cites a film',
      polarity: 'reward',
      inferenceConfidence: 0.5,
      status: 'confirmed',
      exhibitTitleIds: [7],
    });
    _setDbForTests(db);
    await fn(db);
  } finally {
    _setDbForTests(null);
    await close();
  }
}

describe('ScreenSprite opt-out routes', () => {
  it('GET /api/settings/screen/opt-out-preview counts what will be removed', async () => {
    await withDb(async () => {
      const { GET } = await import('./opt-out-preview/route');
      const res = await GET(new Request('http://test/api/settings/screen/opt-out-preview'));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ traits: 1, confirmed: 1 });
    });
  });

  it('PUT {enabled:false} runs the opt-out and reports traits_removed', async () => {
    await withDb(async (db) => {
      const { PUT } = await import('./route');
      const res = await PUT(
        new Request('http://test/api/settings/screen', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: false }),
        })
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.enabled).toBe(false);
      expect(body.traits_removed).toBe(1);
      const left = await db
        .select()
        .from(schema.tasteTraits)
        .where(eq(schema.tasteTraits.claim, 'Cites a film'));
      expect(left).toEqual([]);
    });
  });
});
