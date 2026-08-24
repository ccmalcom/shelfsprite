import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeTestDb } from '@/lib/server/__tests__/helpers/pglite';
import { setupTestEnv } from '@/lib/server/__tests__/helpers/testEnv';
import { _setDbForTests, type Db } from '@/lib/server/db';
import { listInviteRequests } from '@/lib/server/inviteRequests';
import { RATE_LIMITS } from '@/lib/server/ratelimit';
import { POST } from './route';

setupTestEnv();
afterEach(() => vi.restoreAllMocks());

function silenceLogs() {
  vi.spyOn(console, 'log').mockImplementation(() => {});
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://test/api/invite-requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
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

describe('POST /api/invite-requests', () => {
  it('exposes a 5-per-hour limit', () => {
    expect(RATE_LIMITS.inviteRequest).toEqual({ limit: 5, windowSeconds: 3600 });
  });

  it('accepts a new email, returns {ok:true}, writes exactly one row', async () => {
    await withDb(async (db) => {
      const res = await POST(post({ email: '  Reader@Example.COM ' }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      const rows = await listInviteRequests(db);
      expect(rows).toHaveLength(1);
      expect(rows[0].email).toBe('reader@example.com');
      expect(rows[0].status).toBe('pending');
    });
  });

  it('returns the identical body for a duplicate and writes no second row', async () => {
    await withDb(async (db) => {
      const first = await POST(post({ email: 'reader@example.com' }));
      const second = await POST(post({ email: 'READER@example.com' }));
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual({ ok: true });
      expect(await listInviteRequests(db)).toHaveLength(1);
    });
  });

  it('silently swallows a filled honeypot: same body, nothing written', async () => {
    await withDb(async (db) => {
      const res = await POST(post({ email: 'bot@example.com', website: 'http://spam.example' }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(await listInviteRequests(db)).toHaveLength(0);
    });
  });

  it('does not consume the rate limit when the honeypot is filled', async () => {
    await withDb(async (db) => {
      const h = { 'x-forwarded-for': '203.0.113.7' };
      for (let i = 0; i < 20; i++) {
        await POST(post({ email: `bot${i}@example.com`, website: 'x' }, h));
      }
      const res = await POST(post({ email: 'human@example.com' }, h));
      expect(res.status).toBe(200);
      expect(await listInviteRequests(db)).toHaveLength(1);
    });
  });

  it('rejects a malformed email with 422 and a {detail} body', async () => {
    await withDb(async () => {
      const res = await POST(post({ email: 'not-an-email' }));
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(typeof body.detail).toBe('string');
    });
  });

  it('rejects a non-JSON body with 422', async () => {
    await withDb(async () => {
      const res = await POST(
        new Request('http://test/api/invite-requests', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'not json',
        })
      );
      expect(res.status).toBe(422);
    });
  });

  it('allows the 5th request and 429s the 6th, with the {detail} shape not {error}', async () => {
    await withDb(async () => {
      const h = { 'x-forwarded-for': '198.51.100.4' };
      for (let i = 0; i < 5; i++) {
        const ok = await POST(post({ email: `person${i}@example.com` }, h));
        expect(ok.status).toBe(200);
      }
      const blocked = await POST(post({ email: 'person5@example.com' }, h));
      expect(blocked.status).toBe(429);
      const body = await blocked.json();
      expect(typeof body.detail).toBe('string');
      expect(body).not.toHaveProperty('error');
    });
  });

  it('does not share a bucket between two x-forwarded-for values', async () => {
    await withDb(async () => {
      for (let i = 0; i < 5; i++) {
        await POST(post({ email: `a${i}@example.com` }, { 'x-forwarded-for': '198.51.100.10' }));
      }
      const blocked = await POST(
        post({ email: 'a5@example.com' }, { 'x-forwarded-for': '198.51.100.10' })
      );
      expect(blocked.status).toBe(429);

      const other = await POST(
        post({ email: 'b0@example.com' }, { 'x-forwarded-for': '198.51.100.11' })
      );
      expect(other.status).toBe(200);
    });
  });

  it('still consumes a limit when x-forwarded-for is absent', async () => {
    await withDb(async () => {
      for (let i = 0; i < 5; i++) {
        const ok = await POST(post({ email: `c${i}@example.com` }));
        expect(ok.status).toBe(200);
      }
      const blocked = await POST(post({ email: 'c5@example.com' }));
      expect(blocked.status).toBe(429);
    });
  });
});
