import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeTestDb } from './helpers/pglite';
import { setupTestEnv } from './helpers/testEnv';
import { _setDbForTests, type Db } from '../db';
import { invites } from '../schema';
import { SupabaseAdminError } from '../supabaseAdmin';
import { listInviteRequests, submitInviteRequest } from '../inviteRequests';
import { _setInviteUserForTests } from '../invites';
import { GET as listRoute } from '../../../app/api/admin/invite-requests/route';
import { POST as approveRoute } from '../../../app/api/admin/invite-requests/[id]/approve/route';
import { POST as declineRoute } from '../../../app/api/admin/invite-requests/[id]/decline/route';

setupTestEnv();
afterEach(() => {
  _setInviteUserForTests(null);
  vi.restoreAllMocks();
});

function silenceLogs() {
  vi.spyOn(console, 'log').mockImplementation(() => {});
}

async function withDb(fn: (db: Db) => Promise<void>): Promise<void> {
  silenceLogs();
  const { db, close } = await makeTestDb();
  try {
    _setDbForTests(db);
    await fn(db);
  } finally {
    _setDbForTests(null);
    await close();
  }
}

const listReq = (qs = '') => new Request(`http://test/api/admin/invite-requests${qs}`);
const actionReq = () =>
  new Request('http://test/api/admin/invite-requests/1/approve', { method: 'POST' });

describe('GET /api/admin/invite-requests', () => {
  it('lists every request newest first', async () => {
    await withDb(async (db) => {
      await submitInviteRequest(db, 'one@example.com');
      await submitInviteRequest(db, 'two@example.com');
      const res = await listRoute(listReq());
      expect(res.status).toBe(200);
      const body = (await res.json()) as { email: string }[];
      expect(body.map((r) => r.email)).toEqual(['two@example.com', 'one@example.com']);
    });
  });

  it('filters by status', async () => {
    await withDb(async (db) => {
      await submitInviteRequest(db, 'one@example.com');
      await submitInviteRequest(db, 'two@example.com');
      const [newest] = await listInviteRequests(db);
      await declineRoute(actionReq(), { params: { id: String(newest.id) } });

      const pending = (await (await listRoute(listReq('?status=pending'))).json()) as {
        email: string;
      }[];
      expect(pending.map((r) => r.email)).toEqual(['one@example.com']);

      const declined = (await (await listRoute(listReq('?status=declined'))).json()) as {
        email: string;
      }[];
      expect(declined.map((r) => r.email)).toEqual(['two@example.com']);
    });
  });

  it('rejects an unknown status with 422', async () => {
    await withDb(async () => {
      const res = await listRoute(listReq('?status=spam'));
      expect(res.status).toBe(422);
      expect(typeof (await res.json()).detail).toBe('string');
    });
  });
});

describe('POST /api/admin/invite-requests/[id]/approve', () => {
  it('calls createInvite once with the row email and caller userId, then marks approved', async () => {
    await withDb(async (db) => {
      const calls: string[] = [];
      _setInviteUserForTests(async (email: string) => {
        calls.push(email);
        return { id: 'sb-user-1', email };
      });
      await submitInviteRequest(db, 'reader@example.com');
      const [row] = await listInviteRequests(db);

      const res = await approveRoute(actionReq(), { params: { id: String(row.id) } });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ status: 'approved', reviewed_by: 'local' });
      expect(typeof body.reviewed_at).toBe('string');
      expect(calls).toEqual(['reader@example.com']);

      const roster = await db.select().from(invites);
      expect(roster.map((i) => i.email)).toEqual(['reader@example.com']);
      expect(roster[0].invitedBy).toBe('local');
    });
  });

  it('leaves the row pending and errors when createInvite throws', async () => {
    await withDb(async (db) => {
      _setInviteUserForTests(async () => {
        throw new SupabaseAdminError('GoTrue is down');
      });
      await submitInviteRequest(db, 'reader@example.com');
      const [row] = await listInviteRequests(db);

      const res = await approveRoute(actionReq(), { params: { id: String(row.id) } });
      expect(res.status).toBe(502);
      expect(typeof (await res.json()).detail).toBe('string');

      const [after] = await listInviteRequests(db);
      expect(after.status).toBe('pending');
      expect(after.reviewed_by).toBeNull();
    });
  });

  it('404s an unknown id without calling createInvite', async () => {
    await withDb(async () => {
      let called = false;
      _setInviteUserForTests(async (email: string) => {
        called = true;
        return { id: 'sb', email };
      });
      const res = await approveRoute(actionReq(), { params: { id: '9999' } });
      expect(res.status).toBe(404);
      expect(called).toBe(false);
    });
  });
});

describe('POST /api/admin/invite-requests/[id]/decline', () => {
  it('marks declined without calling createInvite', async () => {
    await withDb(async (db) => {
      let called = false;
      _setInviteUserForTests(async (email: string) => {
        called = true;
        return { id: 'sb', email };
      });
      await submitInviteRequest(db, 'reader@example.com');
      const [row] = await listInviteRequests(db);

      const res = await declineRoute(actionReq(), { params: { id: String(row.id) } });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: 'declined', reviewed_by: 'local' });
      expect(called).toBe(false);
    });
  });

  it('404s an unknown id', async () => {
    await withDb(async () => {
      const res = await declineRoute(actionReq(), { params: { id: '9999' } });
      expect(res.status).toBe(404);
    });
  });
});

/**
 * Auth gating. setupTestEnv() deletes every SUPABASE_* variable, which puts verifyRequestUser in
 * local mode where the caller is an implicit admin — that is why every test above passes with no
 * Authorization header. Setting SUPABASE_JWKS_URL flips auth on; with no bearer token
 * verifyRequestUser throws AuthError before any network call, so no JWKS fetch happens.
 *
 * The authenticated-non-admin 403 case is NOT covered here on purpose. withApi calls
 * verifyRequestUser with no injectable JWKS, so reaching that branch from a route test would mean
 * mocking `jose` wholesale. lib/server/__tests__/http.test.ts already owns withApi's admin gate
 * directly, and these three routes pass { requireAdmin: true } verbatim — three lines a reviewer
 * can read. Mocking the crypto library to re-test a wrapper's own behavior buys nothing.
 */
describe('admin gating', () => {
  it('401s an unauthenticated caller once auth is enabled', async () => {
    await withDb(async () => {
      process.env.SUPABASE_JWKS_URL = 'https://example.test/jwks.json';
      const res = await listRoute(listReq());
      expect(res.status).toBe(401);
      expect(typeof (await res.json()).detail).toBe('string');
    });
  });
});
