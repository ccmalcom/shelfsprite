import { describe, it, expect, vi, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeTestDb } from '@/lib/server/__tests__/helpers/pglite';
import { setupTestEnv } from '@/lib/server/__tests__/helpers/testEnv';
import { _setDbForTests, schema, type Db } from '@/lib/server/db';

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
