import { describe, it, expect, vi, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeTestDb, loadSeed, type Seed } from '@/lib/server/__tests__/helpers/pglite';
import { setupTestEnv } from '@/lib/server/__tests__/helpers/testEnv';
import seedJson from '@/lib/server/__tests__/fixtures/seed.json';
import { _setDbForTests, schema, type Db } from '@/lib/server/db';
import {
  insertTitle,
  insertTitleEnrichment,
  setLastProfiledAt,
  setScreen,
} from '@/lib/server/__tests__/helpers/screenProfileFixtures';

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

async function getStatus() {
  const { GET } = await import('./route');
  const res = await GET(new Request('http://test/api/profile/status'));
  expect(res.status).toBe(200);
  return res.json();
}

describe('GET /api/profile/status', () => {
  it('is clean and reports a null rebuild_reason when nothing is pending', async () => {
    await withDb(async (db) => {
      await db
        .insert(schema.profileMeta)
        .values({ userId: 'local', lastProfiledAt: '2026-07-01 12:00:00' });
      const body = await getStatus();
      expect(body.dirty).toBe(false);
      expect(body.rebuild_reason).toBeNull();
    });
  });

  it('is dirty while a rebuild reason is pending, with nothing else changed', async () => {
    await withDb(async (db) => {
      await db.insert(schema.profileMeta).values({
        userId: 'local',
        lastProfiledAt: '2026-07-01 12:00:00',
        rebuildReason: 'title_deleted',
      });
      const body = await getStatus();
      expect(body.dirty).toBe(true);
      expect(body.rebuild_reason).toBe('title_deleted');
      expect(body.changed_books).toBe(0);
    });
  });

  it("ignores another user's rebuild reason and creates no row", async () => {
    await withDb(async (db) => {
      await db.insert(schema.profileMeta).values({
        userId: 'other',
        lastProfiledAt: '2026-07-01 12:00:00',
        rebuildReason: 'screen_enabled',
      });
      const body = await getStatus();
      expect(body.dirty).toBe(false);
      expect(body.rebuild_reason).toBeNull();
      const localRows = await db
        .select()
        .from(schema.profileMeta)
        .where(eq(schema.profileMeta.userId, 'local'));
      expect(localRows).toHaveLength(0);
    });
  });
});

// Wave 6 (spec 2026-09-22 §5.5): title changes. Seeded baseline, profiled after every seeded change.
async function withSeededDb(fn: (db: Db) => Promise<void>): Promise<void> {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const { db, close } = await makeTestDb();
  try {
    await loadSeed(db, seedJson as Seed);
    // After every seeded book change, verdict and rec feedback: a clean baseline.
    await setLastProfiledAt(db, '2026-08-01 00:00:00');
    _setDbForTests(db);
    await fn(db);
  } finally {
    _setDbForTests(null);
    await close();
  }
}

async function status() {
  const { GET } = await import('./route');
  const res = await GET(new Request('http://test/api/profile/status'));
  expect(res.status).toBe(200);
  return res.json();
}

describe('GET /api/profile/status with titles', () => {
  it('is clean when nothing changed', async () => {
    await withSeededDb(async () => {
      const body = await status();
      expect(body.dirty).toBe(false);
      expect(body.changed_titles).toBe(0);
      expect(body.changed_title_ids).toEqual([]);
    });
  });

  it('reports titles changed since the last build while ScreenSprite is enabled', async () => {
    await withSeededDb(async (db) => {
      await setScreen(db, true);
      const want = await insertTitle(db, {
        title: 'Tenet',
        status: 'want',
        feedbackUpdatedAt: '2026-08-02 00:00:00',
      });
      await insertTitle(db, {
        userId: 'other',
        title: 'Theirs',
        feedbackUpdatedAt: '2026-08-02 00:00:00',
      });
      const body = await status();
      expect(body.dirty).toBe(true);
      expect(body.changed_titles).toBe(1);
      expect(body.changed_title_ids).toEqual([want]);
    });
  });

  // Review finding: accepting a screen recommendation creates an unrated `want` title with a
  // fresh enrichment row and no feedback stamp. That is not profile evidence, so status must
  // agree with the recommend gate (blocksScreenRecs) and stay clean, or /screen stays blocked.
  it('stays clean for an enrichment-only change to a title that is not evidence', async () => {
    await withSeededDb(async (db) => {
      await setScreen(db, true);
      const want = await insertTitle(db, { title: 'Tenet', status: 'want' });
      await insertTitleEnrichment(db, want, { resolvedAt: '2026-08-02 00:00:00' });
      const body = await status();
      expect(body.dirty).toBe(false);
      expect(body.changed_titles).toBe(0);
    });
  });

  it('reports an enrichment-only change to a rated title', async () => {
    await withSeededDb(async (db) => {
      await setScreen(db, true);
      const rated = await insertTitle(db, { title: 'Heat', appRating: 4 });
      await insertTitleEnrichment(db, rated, { resolvedAt: '2026-08-02 00:00:00' });
      const body = await status();
      expect(body.dirty).toBe(true);
      expect(body.changed_title_ids).toEqual([rated]);
    });
  });

  it('ignores titles while ScreenSprite is disabled', async () => {
    await withSeededDb(async (db) => {
      await setScreen(db, false);
      await insertTitle(db, { title: 'Arrival', feedbackUpdatedAt: '2026-08-02 00:00:00' });
      const body = await status();
      expect(body.dirty).toBe(false);
      expect(body.changed_titles).toBe(0);
    });
  });
});
