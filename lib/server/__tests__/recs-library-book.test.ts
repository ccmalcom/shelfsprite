import { describe, test, expect, afterEach, vi } from 'vitest';
import { makeTestDb } from './helpers/pglite';
import { schema } from '../db';
import { ensureLibraryBook } from '../recs';

describe('ensureLibraryBook', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // #138: a swiped book with no date added sank below every imported book in the
  // to-read shelf's "Date added" sort.
  test('a book landed from a recommendation is dated today', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-28T19:40:00Z'), toFake: ['Date'] });
    const { db, close } = await makeTestDb();
    try {
      const [rec] = await db
        .insert(schema.recommendations)
        .values({
          userId: 'local',
          runId: 'run-a',
          rank: 1,
          title: 'Insurrection',
          author: 'C. J. Korryn',
          score: 0.9,
          status: 'accepted',
        })
        .returning();
      const { book } = await ensureLibraryBook(db, rec, 'to-read', 'local');
      expect(book.dateAdded).toBe('2026-10-28');
      expect(book.exclusiveShelf).toBe('to-read');
    } finally {
      await close();
    }
  });
});
