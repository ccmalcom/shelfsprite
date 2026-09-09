import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeTestDb } from '@/lib/server/__tests__/helpers/pglite';
import { setupTestEnv } from '@/lib/server/__tests__/helpers/testEnv';
import { _setDbForTests, type Db } from '@/lib/server/db';
import { GET, PUT } from './route';

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

const put = (body: unknown) =>
  new Request('http://test/api/directive', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('PUT /api/directive', () => {
  it('round-trips prefer_authors and prefer_subjects', async () => {
    await withDb(async () => {
      const res = await PUT(
        put({
          nl_text: 'More literary sci-fi.',
          constraints: {
            prefer_authors: ['Ursula K. Le Guin'],
            prefer_subjects: ['Space Opera'],
          },
        })
      );
      expect(res.status).toBe(200);
      expect((await res.json()).constraints).toEqual({
        prefer_authors: ['Ursula K. Le Guin'],
        prefer_subjects: ['space opera'],
      });

      const read = await GET(new Request('http://test/api/directive'));
      expect((await read.json()).constraints).toEqual({
        prefer_authors: ['Ursula K. Le Guin'],
        prefer_subjects: ['space opera'],
      });
    });
  });

  it('accepts a favorites-only record with no prose', async () => {
    await withDb(async () => {
      const res = await PUT(put({ nl_text: null, constraints: { prefer_authors: ['Gene Wolfe'] } }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.nl_text).toBeNull();
      expect(body.constraints).toEqual({ prefer_authors: ['Gene Wolfe'] });
    });
  });
});
