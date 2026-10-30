import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeTestDb } from '@/lib/server/__tests__/helpers/pglite';
import { setupTestEnv } from '@/lib/server/__tests__/helpers/testEnv';
import { _setDbForTests, type Db } from '@/lib/server/db';

setupTestEnv();
afterEach(() => vi.restoreAllMocks());

async function withDb(fn: (db: Db) => Promise<void>): Promise<void> {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const { db, close } = await makeTestDb();
  try {
    _setDbForTests(db);
    await fn(db);
  } finally {
    _setDbForTests(null);
    await close();
  }
}

function post(): Request {
  return new Request('http://test/api/profile/update', { method: 'POST' });
}

vi.mock('@/lib/server/claude', () => ({
  resolveAnthropicKey: vi.fn(async () => 'test-key'),
  makeAnthropicClient: vi.fn(() => ({})),
}));

const updateTasteProfile = vi.hoisted(() => vi.fn());
vi.mock('@/lib/server/profileUpdate', () => ({ updateTasteProfile }));

describe('POST /api/profile/update', () => {
  it('reports the traits that changed across the refresh', async () => {
    await withDb(async (db) => {
      const { POST } = await import('./route');
      const trait = (claim: string, polarity: string) => ({
        userId: 'local',
        claim,
        polarity,
        inferenceConfidence: 0.8,
        status: 'proposed',
      });

      // Seed the "before" state, then have the mocked build swap one claim for a reword
      // and add a second, so the response has one of each category to assert on.
      const schema = await import('@/lib/server/schema');
      await db
        .insert(schema.tasteTraits)
        .values([trait('Avoids military SF', 'aversion'), trait('Rewards dense prose', 'reward')]);

      updateTasteProfile.mockImplementation(async () => {
        await db.delete(schema.tasteTraits);
        await db
          .insert(schema.tasteTraits)
          .values([
            trait("Avoids military SF unless it's satirical", 'aversion'),
            trait('Rewards novellas', 'reward'),
          ]);
        return { mode: 'update', traits_after: 2 };
      });

      const res = await POST(post());
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.mode).toBe('update');
      expect(body.changes.reworded).toEqual([
        { from: 'Avoids military SF', to: "Avoids military SF unless it's satirical" },
      ]);
      expect(body.changes.added).toEqual(['Rewards novellas']);
      expect(body.changes.dropped).toEqual(['Rewards dense prose']);
      expect(body.changes.unchanged).toBe(0);
    });
  });

  it('reports empty changes when the refresh moved nothing', async () => {
    await withDb(async (db) => {
      const { POST } = await import('./route');
      const schema = await import('@/lib/server/schema');
      await db.insert(schema.tasteTraits).values([
        {
          userId: 'local',
          claim: 'Rewards dense prose',
          polarity: 'reward',
          inferenceConfidence: 0.8,
          status: 'proposed',
        },
      ]);

      updateTasteProfile.mockImplementation(async () => ({
        mode: 'update',
        note: 'Profile already up to date — no rating/review changes since last build.',
      }));

      const res = await POST(post());
      const body = await res.json();
      expect(body.changes).toEqual({ added: [], dropped: [], reworded: [], unchanged: 1 });
    });
  });

  describe('archetype freshness', () => {
    const archetypeRow = (derivedAt: string) => ({
      userId: 'local',
      code: 'RCBM',
      archetypeName: 'The Cerebral Explorer',
      archetypeTagline: 't',
      axisLens: 0.5,
      axisEngine: 0.5,
      axisRange: -0.5,
      axisResonance: 0.5,
      derivedAt,
    });

    // The mocked refresh stamps last_profiled_at the way persistProposedTraits does.
    async function refreshThatStamps(db: Db, claims: string[]) {
      const schema = await import('@/lib/server/schema');
      updateTasteProfile.mockImplementation(async () => {
        await db.delete(schema.tasteTraits);
        await db.insert(schema.tasteTraits).values(
          claims.map((claim) => ({
            userId: 'local',
            claim,
            polarity: 'reward',
            inferenceConfidence: 0.8,
            status: 'proposed',
          }))
        );
        await db.update(schema.profileMeta).set({ lastProfiledAt: '2020-01-01 12:30:00' });
        return { mode: 'update' };
      });
    }

    async function seed(db: Db, derivedAt: string) {
      const schema = await import('@/lib/server/schema');
      await db.insert(schema.profileMeta).values({
        userId: 'local',
        lastProfiledAt: '2020-01-01 12:00:00',
      });
      await db.insert(schema.tasteTraits).values({
        userId: 'local',
        claim: 'Rewards dense prose',
        polarity: 'reward',
        inferenceConfidence: 0.8,
        status: 'proposed',
      });
      await db.insert(schema.readerArchetypes).values(archetypeRow(derivedAt));
    }

    async function derivedAt(db: Db): Promise<string> {
      const schema = await import('@/lib/server/schema');
      const rows = await db.select().from(schema.readerArchetypes);
      return rows[0].derivedAt;
    }

    it('keeps a current archetype current when the refresh changed no trait', async () => {
      await withDb(async (db) => {
        const { POST } = await import('./route');
        await seed(db, '2020-01-01 12:05:00');
        await refreshThatStamps(db, ['Rewards dense prose']);
        await POST(post());
        expect((await derivedAt(db)) >= '2020-01-01 12:30:00').toBe(true);
      });
    });

    it('leaves the archetype stale when the traits changed', async () => {
      await withDb(async (db) => {
        const { POST } = await import('./route');
        await seed(db, '2020-01-01 12:05:00');
        await refreshThatStamps(db, ['Rewards novellas']);
        await POST(post());
        expect(await derivedAt(db)).toBe('2020-01-01 12:05:00');
      });
    });

    it('does not freshen an archetype that was already stale', async () => {
      await withDb(async (db) => {
        const { POST } = await import('./route');
        await seed(db, '2020-01-01 11:00:00');
        await refreshThatStamps(db, ['Rewards dense prose']);
        await POST(post());
        expect(await derivedAt(db)).toBe('2020-01-01 11:00:00');
      });
    });
  });
});
