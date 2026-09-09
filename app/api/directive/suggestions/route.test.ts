import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeTestDb } from '@/lib/server/__tests__/helpers/pglite';
import { setupTestEnv } from '@/lib/server/__tests__/helpers/testEnv';
import { _setDbForTests, schema, type Db } from '@/lib/server/db';
import { GET } from './route';

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

const req = () => new Request('http://test/api/directive/suggestions');

async function addLoved(db: Db, userId: string, author: string, subject: string): Promise<void> {
  const [row] = await db
    .insert(schema.books)
    .values({
      userId,
      title: `${author} / ${subject}`,
      author,
      goodreadsRating: 5,
      source: 'test',
    })
    .returning({ id: schema.books.id });
  await db
    .insert(schema.enrichment)
    .values({ bookId: row.id, subjects: [subject], resolutionConfidence: 1 });
}

describe('GET /api/directive/suggestions', () => {
  it('returns empty arrays for a reader with no loved books', async () => {
    await withDb(async () => {
      const res = await GET(req());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ subjects: [], authors: [] });
    });
  });

  it('is tenant-scoped and subtracts the caller’s stored lists', async () => {
    await withDb(async (db) => {
      await addLoved(db, 'local', 'Mine', 'mine');
      await addLoved(db, 'local', 'Already Favorited', 'already');
      await addLoved(db, 'other', 'Theirs', 'theirs');
      await db.insert(schema.userDirective).values({
        userId: 'local',
        constraints: { prefer_authors: ['already favorited'], exclude_subjects: ['already'] },
      });

      const body = await (await GET(req())).json();
      expect(body.authors).toEqual([{ value: 'Mine', count: 1 }]);
      expect(body.subjects).toEqual([{ value: 'mine', count: 1 }]);
    });
  });
});
