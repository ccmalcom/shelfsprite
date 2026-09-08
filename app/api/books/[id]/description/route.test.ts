import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeTestDb, loadSeed } from '@/lib/server/__tests__/helpers/pglite';
import { setupTestEnv } from '@/lib/server/__tests__/helpers/testEnv';
import { installHttpReplay } from '@/lib/server/__tests__/helpers/httpReplay';
import { _setDbForTests, getDb, schema } from '@/lib/server/db';
import type { Db } from '@/lib/server/db';
import { eq } from 'drizzle-orm';
import { setRate } from '@/lib/server/catalog';
import { GET } from './route';

setupTestEnv();
afterEach(() => vi.restoreAllMocks());

async function withDb(fn: (db: Db) => Promise<void>): Promise<void> {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  setRate(1000); // no throttle in tests
  const { db, close } = await makeTestDb();
  try {
    _setDbForTests(db);
    await fn(db);
  } finally {
    _setDbForTests(null);
    await close();
  }
}

const req = () => new Request('http://test/api/books/1/description');
const call = (id = '1') => GET(req(), { params: { id } });

/** A to-read book: unrated, so no background enrichment run will ever reach it. */
async function seed(db: Db, enrichment?: Record<string, unknown>) {
  await loadSeed(db, {
    books: [
      {
        id: 1,
        user_id: 'local',
        title: "Old Man's War",
        author: 'John Scalzi',
        exclusive_shelf: 'to-read',
        goodreads_rating: 0,
        source: 'test',
      },
    ],
    ...(enrichment
      ? {
          enrichment: [
            { book_id: 1, resolution_confidence: 0.9, confidence_label: 'HIGH', ...enrichment },
          ],
        }
      : {}),
  });
}

describe('GET /api/books/[id]/description — lazy backfill', () => {
  it('fetches and persists a missing Open Library description', async () => {
    await withDb(async (db) => {
      await seed(db, {
        resolved_source: 'openlibrary',
        resolved_id: '/works/OL1W',
        description: null,
      });
      const restore = installHttpReplay({
        'https://openlibrary.org/works/OL1W.json': {
          status: 200,
          body: { description: 'A seventy-five-year-old man enlists.' },
        },
      });
      try {
        const body = await (await call()).json();
        expect(body.description).toBe('A seventy-five-year-old man enlists.');
        const [row] = await db
          .select()
          .from(schema.enrichment)
          .where(eq(schema.enrichment.bookId, 1));
        expect(row.description).toBe('A seventy-five-year-old man enlists.');
      } finally {
        restore();
      }
    });
  });

  it('fetches and persists a missing Google Books description', async () => {
    await withDb(async (db) => {
      await seed(db, {
        resolved_source: 'googlebooks',
        resolved_id: 'vol123',
        description: null,
      });
      const restore = installHttpReplay({
        'https://www.googleapis.com/books/v1/volumes/vol123': {
          status: 200,
          body: { volumeInfo: { description: 'The universe is a dangerous place.' } },
        },
      });
      try {
        const body = await (await call()).json();
        expect(body.description).toBe('The universe is a dangerous place.');
      } finally {
        restore();
      }
    });
  });

  it('returns the stored description without any network call', async () => {
    await withDb(async (db) => {
      await seed(db, {
        resolved_source: 'openlibrary',
        resolved_id: '/works/OL1W',
        description: 'Already on file.',
      });
      // An empty fixture map makes any fetch throw, so a network call fails the test.
      const restore = installHttpReplay({});
      try {
        const body = await (await call()).json();
        expect(body.description).toBe('Already on file.');
      } finally {
        restore();
      }
    });
  });

  it('returns null without a network call when there is no catalog match to ask', async () => {
    await withDb(async (db) => {
      await seed(db, { resolved_source: null, resolved_id: null, description: null });
      const restore = installHttpReplay({});
      try {
        const body = await (await call()).json();
        expect(body.description).toBeNull();
      } finally {
        restore();
      }
    });
  });

  it('returns null when the book has no enrichment row at all', async () => {
    await withDb(async (db) => {
      await seed(db);
      const restore = installHttpReplay({});
      try {
        const response = await call();
        expect(response.status).toBe(200);
        expect((await response.json()).description).toBeNull();
      } finally {
        restore();
      }
    });
  });

  it('leaves the row untouched when the catalog has no description', async () => {
    await withDb(async (db) => {
      await seed(db, {
        resolved_source: 'openlibrary',
        resolved_id: '/works/OL1W',
        description: null,
      });
      const restore = installHttpReplay({
        'https://openlibrary.org/works/OL1W.json': { status: 200, body: { title: 'No blurb' } },
      });
      try {
        const body = await (await call()).json();
        expect(body.description).toBeNull();
      } finally {
        restore();
      }
    });
  });

  it("404s rather than reaching into another user's book", async () => {
    await withDb(async (db) => {
      await loadSeed(db, {
        books: [
          {
            id: 2,
            user_id: 'someone-else',
            title: 'Not Yours',
            exclusive_shelf: 'to-read',
            goodreads_rating: 0,
            source: 'test',
          },
        ],
      });
      expect((await call('2')).status).toBe(404);
    });
  });
});
