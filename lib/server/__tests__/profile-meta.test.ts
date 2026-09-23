import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeTestDb } from './helpers/pglite';
import { schema } from '../db';
import { readRebuildReason, setRebuildReason } from '../profileMeta';

async function metaRows(db: any, userId: string) {
  return db.select().from(schema.profileMeta).where(eq(schema.profileMeta.userId, userId));
}

describe('setRebuildReason', () => {
  it('creates the profile_meta row when the user has none', async () => {
    const { db, close } = await makeTestDb();
    try {
      await setRebuildReason(db, 'u1', 'screen_enabled');
      const rows = await metaRows(db, 'u1');
      expect(rows).toHaveLength(1);
      expect(rows[0].rebuildReason).toBe('screen_enabled');
      expect(rows[0].lastProfiledAt).toBeNull();
    } finally {
      await close();
    }
  });

  it('sets the reason on an existing row without touching its timestamps', async () => {
    const { db, close } = await makeTestDb();
    try {
      await db.insert(schema.profileMeta).values({
        userId: 'u1',
        lastProfiledAt: '2026-07-01 12:00:00',
        lastProfileKind: 'full',
      });
      await setRebuildReason(db, 'u1', 'title_deleted');
      const [row] = await metaRows(db, 'u1');
      expect(row.rebuildReason).toBe('title_deleted');
      expect(row.lastProfiledAt).toBe('2026-07-01 12:00:00');
      expect(row.lastProfileKind).toBe('full');
    } finally {
      await close();
    }
  });

  it('keeps the first reason until a full rebuild clears it', async () => {
    const { db, close } = await makeTestDb();
    try {
      await setRebuildReason(db, 'u1', 'screen_enabled');
      await setRebuildReason(db, 'u1', 'title_deleted');
      expect(await readRebuildReason(db, 'u1')).toBe('screen_enabled');
      expect(await metaRows(db, 'u1')).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it('stamps rebuild_requested_at on every call, even when a reason is already pending', async () => {
    const { db, close } = await makeTestDb();
    try {
      await setRebuildReason(db, 'u1', 'screen_enabled');
      const [first] = await metaRows(db, 'u1');
      expect(first.rebuildRequestedAt).not.toBeNull();
      await new Promise((r) => setTimeout(r, 5));
      await setRebuildReason(db, 'u1', 'title_deleted');
      const [second] = await metaRows(db, 'u1');
      expect(second.rebuildReason).toBe('screen_enabled');
      expect(second.rebuildRequestedAt > first.rebuildRequestedAt).toBe(true);
    } finally {
      await close();
    }
  });

  it('works inside a transaction', async () => {
    const { db, close } = await makeTestDb();
    try {
      await db.transaction(async (tx) => {
        await setRebuildReason(tx as any, 'u1', 'screen_disabled');
      });
      expect(await readRebuildReason(db, 'u1')).toBe('screen_disabled');
    } finally {
      await close();
    }
  });

  it("never touches another user's row", async () => {
    const { db, close } = await makeTestDb();
    try {
      await db.insert(schema.profileMeta).values({ userId: 'other' });
      await setRebuildReason(db, 'u1', 'title_deleted');
      expect(await readRebuildReason(db, 'other')).toBeNull();
    } finally {
      await close();
    }
  });
});

describe('readRebuildReason', () => {
  it('returns null and creates nothing for a user with no row', async () => {
    const { db, close } = await makeTestDb();
    try {
      expect(await readRebuildReason(db, 'nobody')).toBeNull();
      expect(await metaRows(db, 'nobody')).toHaveLength(0);
    } finally {
      await close();
    }
  });
});
