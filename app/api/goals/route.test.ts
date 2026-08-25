import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeTestDb, loadSeed } from '@/lib/server/__tests__/helpers/pglite';
import { setupTestEnv } from '@/lib/server/__tests__/helpers/testEnv';
import { _setDbForTests, type Db } from '@/lib/server/db';
import { currentYear } from '@/lib/server/goals';
import { GET, POST } from './route';

setupTestEnv();
afterEach(() => vi.restoreAllMocks());

function req(qs = ''): Request {
  return new Request(`http://test/api/goals${qs}`);
}

function post(body: unknown): Request {
  return new Request('http://test/api/goals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
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

describe('POST /api/goals', () => {
  it('creates a goal, defaulting the year, and returns computed progress', async () => {
    await withDb(async (db) => {
      await loadSeed(db, { books: [book({ id: 1, date_read: `${currentYear()}-01-05` })] });
      const res = await POST(post({ kind: 'books', target: 12 }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        year: currentYear(),
        kind: 'books',
        subject: null,
        target: 12,
        progress: 1,
        done: false,
      });
    });
  });

  it('normalizes a genre subject to title case', async () => {
    await withDb(async () => {
      const body = await (
        await POST(post({ year: 2026, kind: 'genre', subject: ' history ', target: 5 }))
      ).json();
      expect(body.subject).toBe('History');
    });
  });

  it('rejects an unknown kind with 422 naming the valid kinds', async () => {
    await withDb(async () => {
      const res = await POST(post({ kind: 'sandwiches', target: 5 }));
      expect(res.status).toBe(422);
      expect((await res.json()).detail).toContain("'books'");
    });
  });

  it('rejects a non-positive target with 422', async () => {
    await withDb(async () => {
      expect((await POST(post({ kind: 'books', target: 0 }))).status).toBe(422);
      expect((await POST(post({ kind: 'books', target: -3 }))).status).toBe(422);
    });
  });

  it('rejects a genre goal with no subject, and a non-genre goal with one', async () => {
    await withDb(async () => {
      expect((await POST(post({ kind: 'genre', target: 5 }))).status).toBe(422);
      expect((await POST(post({ kind: 'genre', subject: '   ', target: 5 }))).status).toBe(422);
      expect((await POST(post({ kind: 'books', subject: 'History', target: 5 }))).status).toBe(422);
    });
  });

  it('rejects a duplicate books goal with 409 (the NULL-subject case)', async () => {
    await withDb(async () => {
      expect((await POST(post({ year: 2026, kind: 'books', target: 10 }))).status).toBe(200);
      expect((await POST(post({ year: 2026, kind: 'books', target: 50 }))).status).toBe(409);
    });
  });

  it('rejects a duplicate genre goal with 409, case-insensitively', async () => {
    await withDb(async () => {
      expect(
        (await POST(post({ year: 2026, kind: 'genre', subject: 'History', target: 10 }))).status
      ).toBe(200);
      expect(
        (await POST(post({ year: 2026, kind: 'genre', subject: 'history', target: 4 }))).status
      ).toBe(409);
    });
  });

  it('allows the same kind in a different year', async () => {
    await withDb(async () => {
      expect((await POST(post({ year: 2026, kind: 'books', target: 10 }))).status).toBe(200);
      expect((await POST(post({ year: 2027, kind: 'books', target: 10 }))).status).toBe(200);
    });
  });
});
