import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers/pglite';
import { schema } from '../db';

describe('invite_requests table', () => {
  it('round-trips a row through the drizzle schema', async () => {
    const { db, close } = await makeTestDb();
    try {
      await db.insert(schema.inviteRequests).values({
        email: 'reader@example.com',
        status: 'pending',
      });
      const rows = await db.select().from(schema.inviteRequests);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: 1,
        email: 'reader@example.com',
        status: 'pending',
        reviewedAt: null,
        reviewedBy: null,
      });
      expect(typeof rows[0].createdAt).toBe('string');
    } finally {
      await close();
    }
  });

  it('rejects a duplicate email at the database level', async () => {
    const { db, close } = await makeTestDb();
    try {
      await db
        .insert(schema.inviteRequests)
        .values({ email: 'dupe@example.com', status: 'pending' });
      await expect(
        db.insert(schema.inviteRequests).values({ email: 'dupe@example.com', status: 'declined' })
      ).rejects.toThrow();
    } finally {
      await close();
    }
  });
});
