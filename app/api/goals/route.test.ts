import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeTestDb, loadSeed } from '@/lib/server/__tests__/helpers/pglite';
import { setupTestEnv } from '@/lib/server/__tests__/helpers/testEnv';
import { _setDbForTests, type Db } from '@/lib/server/db';
import { currentYear } from '@/lib/server/goals';
import { GET } from './route';

setupTestEnv();
afterEach(() => vi.restoreAllMocks());

function req(qs = ''): Request {
  return new Request(`http://test/api/goals${qs}`);
}

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

const book = (over: Record<string, unknown>) => ({
  user_id: 'local',
  title: 'A Book',
  author: 'Le Guin',
  exclusive_shelf: 'read',
  goodreads_rating: 0,
  source: 'test',
  page_count: 300,
  ...over,
});

describe('GET /api/goals', () => {
  it('defaults to the current year and reports zeroes for an empty library', async () => {
    await withDb(async () => {
      const res = await GET(req());
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.year).toBe(currentYear());
      expect(body.goals).toEqual([]);
      expect(body.subjects).toEqual([]);
      expect(body.stats.books).toBe(0);
      expect(body.stats.undated).toBe(0);
    });
  });

  it('computes progress and stats for the requested year', async () => {
    await withDb(async (db) => {
      await loadSeed(db, {
        books: [
          book({ id: 1, date_read: '2026-01-05' }),
          book({ id: 2, date_read: '2026-02-05', author: 'Chiang', page_count: null }),
          book({ id: 3, date_read: '2025-02-05' }),
          book({ id: 4, date_read: null }),
        ],
        enrichment: [
          { id: 1, book_id: 1, resolution_confidence: 1, subjects: ['History'] },
          { id: 2, book_id: 2, resolution_confidence: 1, subjects: ['Fiction'] },
        ],
        reading_goals: [
          { id: 1, user_id: 'local', year: 2026, kind: 'books', target: 10 },
          { id: 2, user_id: 'local', year: 2026, kind: 'genre', subject: 'History', target: 5 },
        ],
      });

      const body = await (await GET(req('?year=2026'))).json();
      expect(body.year).toBe(2026);
      expect(body.stats).toMatchObject({
        books: 2,
        pages: 300,
        unknown_pages: 1,
        authors: 2,
        undated: 1,
      });
      expect(
        body.goals.map((g: { kind: string; progress: number }) => [g.kind, g.progress])
      ).toEqual([
        ['books', 2],
        ['genre', 1],
      ]);
      expect(body.subjects).toContain('History');
    });
  });

  it('returns stats even when the user has no goals', async () => {
    await withDb(async (db) => {
      await loadSeed(db, { books: [book({ id: 1, date_read: '2026-01-05' })] });
      const body = await (await GET(req('?year=2026'))).json();
      expect(body.goals).toEqual([]);
      expect(body.stats.books).toBe(1);
    });
  });

  it('never counts another user rows or lists their goals', async () => {
    await withDb(async (db) => {
      await loadSeed(db, {
        books: [book({ id: 1, user_id: 'someone-else', date_read: '2026-01-05' })],
        reading_goals: [{ id: 1, user_id: 'someone-else', year: 2026, kind: 'books', target: 10 }],
      });
      const body = await (await GET(req('?year=2026'))).json();
      expect(body.goals).toEqual([]);
      expect(body.stats.books).toBe(0);
    });
  });

  it('rejects a non-numeric year with 422', async () => {
    await withDb(async () => {
      expect((await GET(req('?year=banana'))).status).toBe(422);
    });
  });
});
