import { describe, test, expect, vi } from 'vitest';
import { makeTestDb } from './helpers/pglite';
import { setupTestEnv } from './helpers/testEnv';
import { schema, type Db } from '../db';
import { suggestPreferences } from '../preferenceSuggest';

setupTestEnv();

async function withDb(fn: (db: Db) => Promise<void>): Promise<void> {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const { db, close } = await makeTestDb();
  try {
    await fn(db);
  } finally {
    await close();
  }
}

/** Insert one book + its enrichment row. goodreadsRating 0 means unrated. */
async function addBook(
  db: Db,
  over: {
    author: string;
    rating?: number;
    appRating?: number;
    subjects?: string[];
    userId?: string;
  }
): Promise<void> {
  const [row] = await db
    .insert(schema.books)
    .values({
      userId: over.userId ?? 'local',
      title: `Book by ${over.author} ${Math.random()}`,
      author: over.author,
      goodreadsRating: over.rating ?? 0,
      appRating: over.appRating ?? null,
      source: 'test',
    })
    .returning({ id: schema.books.id });
  await db.insert(schema.enrichment).values({
    bookId: row.id,
    subjects: over.subjects ?? [],
    resolutionConfidence: 1,
  });
}

describe('suggestPreferences', () => {
  test('counts loved books only, ignoring unrated and low-rated ones', async () => {
    await withDb(async (db) => {
      await addBook(db, { author: 'Loved Author', rating: 5, subjects: ['space opera'] });
      await addBook(db, { author: 'Loved Author', rating: 4, subjects: ['space opera'] });
      await addBook(db, { author: 'Meh Author', rating: 3, subjects: ['grimdark'] });
      await addBook(db, { author: 'Unrated Author', rating: 0, subjects: ['grimdark'] });

      const out = await suggestPreferences(db, 'local', {});
      expect(out.authors).toEqual([{ value: 'Loved Author', count: 2 }]);
      expect(out.subjects).toEqual([{ value: 'space opera', count: 2 }]);
    });
  });

  test('an app_rating override decides lovedness', async () => {
    await withDb(async (db) => {
      // Goodreads says 2, the reader re-rated it 5 in-app: it counts as loved.
      await addBook(db, { author: 'Rerated', rating: 2, appRating: 5, subjects: ['x'] });
      const out = await suggestPreferences(db, 'local', {});
      expect(out.authors).toEqual([{ value: 'Rerated', count: 1 }]);
    });
  });

  test('is tenant-scoped', async () => {
    await withDb(async (db) => {
      await addBook(db, { author: 'Mine', rating: 5, subjects: ['mine'] });
      await addBook(db, { author: 'Theirs', rating: 5, subjects: ['theirs'], userId: 'other' });
      const out = await suggestPreferences(db, 'local', {});
      expect(out.authors.map((a) => a.value)).toEqual(['Mine']);
      expect(out.subjects.map((s) => s.value)).toEqual(['mine']);
    });
  });

  test('excludes values already in any of the four lists, before truncation', async () => {
    await withDb(async (db) => {
      // 14 distinct authors so the top-12 truncation is live.
      for (let i = 0; i < 14; i++) {
        for (let n = 0; n <= 14 - i; n++) {
          await addBook(db, { author: `Author ${i}`, rating: 5, subjects: [`subject ${i}`] });
        }
      }
      const out = await suggestPreferences(db, 'local', {
        prefer_authors: ['Author 0'],
        // exclude_authors holds SURNAMES, and surname('Author 1') is its trailing
        // token, '1'. Spelling the full name here would correctly filter nothing,
        // because applyDirectiveConstraints would not filter it downstream either.
        exclude_authors: ['1'],
        prefer_subjects: ['subject 0'],
        exclude_subjects: ['subject 1'],
      });
      expect(out.authors).toHaveLength(12);
      expect(out.authors.map((a) => a.value)).not.toContain('Author 0');
      expect(out.authors.map((a) => a.value)).not.toContain('Author 1');
      // Filtering happened BEFORE the cut, so the list is still full and reaches
      // deeper into the tail than an unfiltered top-12 would.
      expect(out.authors.map((a) => a.value)).toContain('Author 13');
      expect(out.subjects.map((s) => s.value)).not.toContain('subject 0');
      expect(out.subjects.map((s) => s.value)).not.toContain('subject 1');
    });
  });

  // A suggestion carries the library's VERBATIM value, while exclusions are surnames and
  // whole-word subject terms. Comparing folded strings offered the reader a favorite that
  // applyDirectiveConstraints would delete the instant they accepted it.
  test('withholds a suggestion the exclusions would filter out downstream', async () => {
    await withDb(async (db) => {
      await addBook(db, { author: 'Frank Herbert', rating: 5, subjects: ['Space Opera'] });
      await addBook(db, { author: 'Gene Wolfe', rating: 5, subjects: ['New Sun'] });
      const out = await suggestPreferences(db, 'local', {
        exclude_authors: ['herbert'],
        exclude_subjects: ['opera'],
      });
      expect(out.authors.map((a) => a.value)).toEqual(['Gene Wolfe']);
      expect(out.subjects.map((s) => s.value)).toEqual(['New Sun']);
    });
  });

  test('breaks count ties by first appearance, like mostCommon', async () => {
    await withDb(async (db) => {
      await addBook(db, { author: 'First Seen', rating: 5, subjects: ['alpha'] });
      await addBook(db, { author: 'Second Seen', rating: 5, subjects: ['beta'] });
      const out = await suggestPreferences(db, 'local', {});
      expect(out.authors.map((a) => a.value)).toEqual(['First Seen', 'Second Seen']);
      expect(out.subjects.map((s) => s.value)).toEqual(['alpha', 'beta']);
    });
  });

  test('a reader with no loved books gets two empty arrays, not an error', async () => {
    await withDb(async (db) => {
      await addBook(db, { author: 'Meh', rating: 2, subjects: ['x'] });
      expect(await suggestPreferences(db, 'local', {})).toEqual({ subjects: [], authors: [] });
    });
  });
});
