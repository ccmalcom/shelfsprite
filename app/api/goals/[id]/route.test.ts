import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeTestDb, loadSeed } from '@/lib/server/__tests__/helpers/pglite';
import { setupTestEnv } from '@/lib/server/__tests__/helpers/testEnv';
import { _setDbForTests, type Db } from '@/lib/server/db';
import { PATCH, DELETE } from './route';

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

const ctxFor = (id: string) => ({ params: { id } });

function patchReq(body: unknown): Request {
  return new Request('http://test/api/goals/1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const seedGoals = (db: Db) =>
  loadSeed(db, {
    reading_goals: [
      { id: 1, user_id: 'local', year: 2026, kind: 'books', target: 10 },
      { id: 2, user_id: 'someone-else', year: 2026, kind: 'books', target: 10 },
    ],
  });

describe('PATCH /api/goals/[id]', () => {
  it('updates the target and returns the recomputed goal', async () => {
    await withDb(async (db) => {
      await seedGoals(db);
      const res = await PATCH(patchReq({ target: 25 }), ctxFor('1'));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id: 1, target: 25, progress: 0, done: false });
    });
  });

  it('rejects a non-positive target with 422', async () => {
    await withDb(async (db) => {
      await seedGoals(db);
      expect((await PATCH(patchReq({ target: 0 }), ctxFor('1'))).status).toBe(422);
    });
  });

  it('returns 404 -- not 403 -- for another user goal', async () => {
    await withDb(async (db) => {
      await seedGoals(db);
      expect((await PATCH(patchReq({ target: 25 }), ctxFor('2'))).status).toBe(404);
    });
  });

  it('returns 404 for a goal that does not exist', async () => {
    await withDb(async (db) => {
      await seedGoals(db);
      expect((await PATCH(patchReq({ target: 25 }), ctxFor('999'))).status).toBe(404);
    });
  });
});

describe('DELETE /api/goals/[id]', () => {
  it('deletes the goal', async () => {
    await withDb(async (db) => {
      await seedGoals(db);
      const res = await DELETE(
        new Request('http://test/api/goals/1', { method: 'DELETE' }),
        ctxFor('1')
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect((await PATCH(patchReq({ target: 5 }), ctxFor('1'))).status).toBe(404);
    });
  });

  it('will not delete another user goal', async () => {
    await withDb(async (db) => {
      await seedGoals(db);
      const res = await DELETE(
        new Request('http://test/api/goals/2', { method: 'DELETE' }),
        ctxFor('2')
      );
      expect(res.status).toBe(404);
    });
  });
});
