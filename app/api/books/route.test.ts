import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeTestDb } from '@/lib/server/__tests__/helpers/pglite';
import { setupTestEnv } from '@/lib/server/__tests__/helpers/testEnv';
import { _setDbForTests, type Db } from '@/lib/server/db';
import { GET, POST } from './route';

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

const addReq = (body: Record<string, unknown>) =>
  new Request('http://test/api/books', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

// A to-read book only ever arrives through a catalog-backed add (Discover, Similar
// books, or + Add book). Each of those already holds the catalog description, so the
// add has to persist it: an unrated to-read book is excluded from every background
// enrichment run, which means nothing will ever backfill it later.
describe('POST /api/books — catalog description on add', () => {
  it('persists the description onto the enrichment row', async () => {
    await withDb(async () => {
      const created = await (
        await POST(
          addReq({
            title: 'Old "Mans" War',
            author: 'John Scalzi',
            shelf: 'to-read',
            cover_url: 'https://covers.test/1.jpg',
            subjects: ['Science fiction'],
            description: 'A seventy-five-year-old man enlists.',
            catalog_source: 'openlibrary',
            catalog_id: '/works/OL1W',
          })
        )
      ).json();
      expect(created.description).toBe('A seventy-five-year-old man enlists.');
    });
  });

  it('returns the description when the to-read shelf is listed', async () => {
    await withDb(async () => {
      await POST(
        addReq({
          title: 'The Ghost Brigades',
          author: 'John Scalzi',
          shelf: 'to-read',
          cover_url: 'https://covers.test/2.jpg',
          description: 'A soldier is rebuilt from a traitor.',
          catalog_source: 'openlibrary',
          catalog_id: '/works/OL2W',
        })
      );
      const listed = await (await GET(new Request('http://test/api/books?shelf=to-read'))).json();
      expect(listed).toHaveLength(1);
      expect(listed[0].description).toBe('A soldier is rebuilt from a traitor.');
    });
  });

  it('creates an enrichment row for a description-only catalog add', async () => {
    await withDb(async () => {
      const created = await (
        await POST(
          addReq({
            title: 'Zoe’s Tale',
            shelf: 'to-read',
            description: 'The same war, told by the daughter.',
          })
        )
      ).json();
      expect(created.description).toBe('The same war, told by the daughter.');
    });
  });

  it('leaves the description null when the catalog had none', async () => {
    await withDb(async () => {
      const created = await (
        await POST(
          addReq({ title: 'The Last Colony', shelf: 'to-read', cover_url: 'https://c/3.jpg' })
        )
      ).json();
      expect(created.description).toBeNull();
    });
  });
});
