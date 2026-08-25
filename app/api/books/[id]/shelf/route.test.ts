import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeTestDb, loadSeed } from '@/lib/server/__tests__/helpers/pglite';
import { setupTestEnv } from '@/lib/server/__tests__/helpers/testEnv';
import { _setDbForTests, type Db } from '@/lib/server/db';
import { todayIsoDate } from '@/lib/server/serialize';
import { PATCH } from './route';

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

const shelfReq = (shelf: string) =>
  new Request('http://test/api/books/1/shelf', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shelf }),
  });

const seedBook = (db: Db, over: Record<string, unknown>) =>
  loadSeed(db, {
    books: [
      {
        id: 1,
        user_id: 'local',
        title: 'A Book',
        exclusive_shelf: 'to-read',
        goodreads_rating: 0,
        source: 'test',
        ...over,
      },
    ],
  });

describe('PATCH /api/books/[id]/shelf — date_read stamping', () => {
  it('stamps today when an undated book moves to read', async () => {
    await withDb(async (db) => {
      await seedBook(db, { date_read: null });
      const body = await (await PATCH(shelfReq('read'), { params: { id: '1' } })).json();
      expect(body.date_read).toBe(todayIsoDate());
    });
  });

  it('never overwrites an existing date_read', async () => {
    await withDb(async (db) => {
      await seedBook(db, { date_read: '2019-04-04' });
      const body = await (await PATCH(shelfReq('read'), { params: { id: '1' } })).json();
      expect(body.date_read).toBe('2019-04-04');
    });
  });

  it('does not stamp a move to a shelf other than read', async () => {
    await withDb(async (db) => {
      await seedBook(db, { date_read: null });
      const body = await (await PATCH(shelfReq('to-read'), { params: { id: '1' } })).json();
      expect(body.date_read).toBeNull();
    });
  });
});
