import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers/pglite';
import { schema } from '../db';
import {
  normalizeEmail,
  inviteRequestRateKey,
  submitInviteRequest,
  listInviteRequests,
  getInviteRequest,
  markReviewed,
  isInviteRequestStatus,
} from '../inviteRequests';

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

describe('inviteRequests domain', () => {
  it('normalizes an email by trimming and lowercasing', () => {
    expect(normalizeEmail('  ChAsE@Example.COM ')).toBe('chase@example.com');
  });

  it('stores the normalized email', async () => {
    const { db, close } = await makeTestDb();
    try {
      await submitInviteRequest(db, '  Reader@Example.COM ');
      const rows = await listInviteRequests(db);
      expect(rows).toHaveLength(1);
      expect(rows[0].email).toBe('reader@example.com');
      expect(rows[0].status).toBe('pending');
      expect(rows[0].reviewed_at).toBeNull();
      expect(rows[0].reviewed_by).toBeNull();
    } finally {
      await close();
    }
  });

  it('treats a second submission of the same email as a no-op', async () => {
    const { db, close } = await makeTestDb();
    try {
      await submitInviteRequest(db, 'reader@example.com');
      await submitInviteRequest(db, 'reader@example.com');
      expect(await listInviteRequests(db)).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it('treats a differently-cased duplicate as a duplicate', async () => {
    const { db, close } = await makeTestDb();
    try {
      await submitInviteRequest(db, 'reader@example.com');
      await submitInviteRequest(db, '  READER@EXAMPLE.com');
      expect(await listInviteRequests(db)).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it('leaves an already-reviewed row untouched on resubmission', async () => {
    const { db, close } = await makeTestDb();
    try {
      await submitInviteRequest(db, 'reader@example.com');
      const [row] = await listInviteRequests(db);
      await markReviewed(db, row.id, 'declined', 'admin-sub');
      await submitInviteRequest(db, 'reader@example.com');
      const after = await listInviteRequests(db);
      expect(after).toHaveLength(1);
      expect(after[0].status).toBe('declined');
      expect(after[0].reviewed_by).toBe('admin-sub');
    } finally {
      await close();
    }
  });

  it('lists newest first and filters by status', async () => {
    const { db, close } = await makeTestDb();
    try {
      await submitInviteRequest(db, 'one@example.com');
      await submitInviteRequest(db, 'two@example.com');
      const all = await listInviteRequests(db);
      expect(all.map((r) => r.email)).toEqual(['two@example.com', 'one@example.com']);

      await markReviewed(db, all[0].id, 'approved', 'admin-sub');
      expect((await listInviteRequests(db, 'pending')).map((r) => r.email)).toEqual([
        'one@example.com',
      ]);
      expect((await listInviteRequests(db, 'approved')).map((r) => r.email)).toEqual([
        'two@example.com',
      ]);
    } finally {
      await close();
    }
  });

  it('markReviewed stamps status, reviewer and timestamp; returns null for a missing id', async () => {
    const { db, close } = await makeTestDb();
    try {
      await submitInviteRequest(db, 'reader@example.com');
      const [row] = await listInviteRequests(db);
      const updated = await markReviewed(db, row.id, 'approved', 'admin-sub');
      expect(updated).toMatchObject({ status: 'approved', reviewed_by: 'admin-sub' });
      expect(typeof updated!.reviewed_at).toBe('string');
      expect(await markReviewed(db, 9999, 'declined', 'admin-sub')).toBeNull();
    } finally {
      await close();
    }
  });

  it('getInviteRequest returns the row or null', async () => {
    const { db, close } = await makeTestDb();
    try {
      await submitInviteRequest(db, 'reader@example.com');
      const [row] = await listInviteRequests(db);
      expect((await getInviteRequest(db, row.id))?.email).toBe('reader@example.com');
      expect(await getInviteRequest(db, 9999)).toBeNull();
    } finally {
      await close();
    }
  });

  it('isInviteRequestStatus guards the vocabulary', () => {
    expect(isInviteRequestStatus('pending')).toBe(true);
    expect(isInviteRequestStatus('spam')).toBe(false);
  });
});

describe('inviteRequestRateKey', () => {
  function req(headers: Record<string, string> = {}): Request {
    return new Request('http://test/api/invite-requests', { method: 'POST', headers });
  }

  it('uses the first x-forwarded-for entry, trimmed', () => {
    expect(inviteRequestRateKey(req({ 'x-forwarded-for': '203.0.113.5, 70.41.3.18' }))).toBe(
      'invite_request:203.0.113.5'
    );
    expect(inviteRequestRateKey(req({ 'x-forwarded-for': '  203.0.113.9  ' }))).toBe(
      'invite_request:203.0.113.9'
    );
  });

  it('falls back to one shared bucket when the header is absent or empty', () => {
    expect(inviteRequestRateKey(req())).toBe('invite_request:unknown');
    expect(inviteRequestRateKey(req({ 'x-forwarded-for': '   ' }))).toBe('invite_request:unknown');
  });

  it('gives different IPs different buckets', () => {
    expect(inviteRequestRateKey(req({ 'x-forwarded-for': '1.1.1.1' }))).not.toBe(
      inviteRequestRateKey(req({ 'x-forwarded-for': '2.2.2.2' }))
    );
  });
});
