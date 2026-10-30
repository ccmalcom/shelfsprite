import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { makeTestDb } from '@/lib/server/__tests__/helpers/pglite';
import { setupJwtAuth } from '@/lib/server/__tests__/helpers/jwtAuth';
import { _setDbForTests, schema, type Db } from '@/lib/server/db';
import { todayIsoDate } from '@/lib/server/serialize';
import { POST } from './route';
import { POST as addOne } from '../route';

const { authHeaders } = setupJwtAuth();

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await makeTestDb());
  _setDbForTests(db);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  _setDbForTests(null);
  vi.restoreAllMocks();
  await close();
});

async function bulk(books: unknown[], userId = 'user-a'): Promise<Response> {
  return POST(
    new Request('http://test/api/books/bulk', {
      method: 'POST',
      headers: await authHeaders(userId),
      body: JSON.stringify({ books }),
    })
  );
}

const catalogFields = (n: number) => ({
  cover_url: `https://covers.test/${n}.jpg`,
  subjects: ['Fiction'],
  description: `Blurb ${n}.`,
  catalog_source: 'openlibrary',
  catalog_id: `/works/OL${n}W`,
});

describe('POST /api/books/bulk', () => {
  it('requires a signed-in reader', async () => {
    const res = await POST(
      new Request('http://test/api/books/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ books: [{ title: 'Dune' }] }),
      })
    );
    expect(res.status).toBe(401);
    expect(await db.select().from(schema.books)).toEqual([]);
  });

  it('rejects an empty or oversized request', async () => {
    expect((await bulk([])).status).toBe(422);
    const tooMany = Array.from({ length: 201 }, (_, i) => ({ title: `Book ${i}` }));
    expect((await bulk(tooMany)).status).toBe(422);
  });

  it('stores each book exactly as a single manual add does', async () => {
    const res = await bulk([
      { title: 'Circe', author: 'Madeline Miller', year: 2018, rating: 4.5, ...catalogFields(1) },
      { title: 'Gilead', author: 'Marilynne Robinson', ...catalogFields(2) },
    ]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.duplicates).toEqual([]);
    expect(body.errors).toEqual([]);
    expect(body.added.map((b: { title: string }) => b.title)).toEqual(['Circe', 'Gilead']);

    // The same book through POST /api/books, for a second reader, as the reference.
    await addOne(
      new Request('http://test/api/books', {
        method: 'POST',
        headers: await authHeaders('user-b'),
        body: JSON.stringify({
          title: 'Circe',
          author: 'Madeline Miller',
          year: 2018,
          rating: 4.5,
          ...catalogFields(1),
        }),
      })
    );
    const rows = await db
      .select()
      .from(schema.books)
      .leftJoin(schema.enrichment, eq(schema.enrichment.bookId, schema.books.id))
      .orderBy(asc(schema.books.id));
    const shape = (r: (typeof rows)[number]) => ({
      title: r.books.title,
      shelf: r.books.exclusiveShelf,
      source: r.books.source,
      appRating: r.books.appRating,
      goodreadsRating: r.books.goodreadsRating,
      dateAdded: r.books.dateAdded,
      dateRead: r.books.dateRead,
      feedbackStamped: r.books.feedbackUpdatedAt !== null,
      label: r.enrichment?.confidenceLabel,
      method: r.enrichment?.matchMethod,
      description: r.enrichment?.description,
    });
    const [circe, gilead, reference] = rows;
    expect(shape(circe)).toEqual(shape(reference));
    expect(shape(circe)).toEqual({
      title: 'Circe',
      shelf: 'read',
      source: 'manual',
      appRating: 4.5,
      goodreadsRating: 0,
      dateAdded: todayIsoDate(),
      dateRead: null,
      feedbackStamped: true,
      label: 'MANUAL',
      method: 'manual_add',
      description: 'Blurb 1.',
    });
    // Unrated is stored as no in-app rating, never as 0.
    expect(gilead.books.appRating).toBeNull();
    expect(gilead.books.feedbackUpdatedAt).toBeNull();
  });

  it('flags books already in the library, and repeats within the request, without adding them', async () => {
    await bulk([{ title: 'Beloved', author: 'Toni Morrison' }]);
    const res = await bulk([
      { title: 'Beloved: A Novel', author: 'Toni Morrison' },
      { title: 'Sula', author: 'Toni Morrison' },
      { title: 'Sula', author: 'Toni Morrison', rating: 5 },
    ]);
    const body = await res.json();
    expect(body.added.map((b: { title: string }) => b.title)).toEqual(['Sula']);
    expect(body.duplicates).toEqual([
      { index: 0, title: 'Beloved: A Novel' },
      { index: 2, title: 'Sula' },
    ]);
    const titles = (await db.select().from(schema.books)).map((b) => b.title).sort();
    expect(titles).toEqual(['Beloved', 'Sula']);
  });

  it('reports a bad entry by index with the single-add message and keeps the rest', async () => {
    const res = await bulk([
      { title: 'Off the grid', rating: 4.2 },
      { title: '   ' },
      { title: 'Unrated review', review: 'Loved it' },
      { title: 42 },
      { title: 'Fine', rating: 0 },
    ]);
    const body = await res.json();
    expect(body.errors).toEqual([
      {
        index: 0,
        title: 'Off the grid',
        detail: 'rating must be 0.5 to 5 in half-star steps (or omitted/0 for unrated).',
      },
      { index: 1, title: '   ', detail: 'title is required.' },
      {
        index: 2,
        title: 'Unrated review',
        detail: 'A review requires a rating (0.5 to 5). Rate the book, or omit the review.',
      },
      { index: 3, title: '', detail: expect.stringMatching(/^validation error: /) },
    ]);
    expect(
      body.added.map((b: { title: string; app_rating: number | null }) => b.app_rating)
    ).toEqual([null]);
  });

  it("checks duplicates only against the caller's own library and writes only to it", async () => {
    await bulk([{ title: 'Dune', author: 'Frank Herbert' }], 'user-b');
    const res = await bulk([{ title: 'Dune', author: 'Frank Herbert' }], 'user-a');
    const body = await res.json();
    expect(body.duplicates).toEqual([]);
    expect(body.added).toHaveLength(1);
    const owners = (await db.select().from(schema.books)).map((b) => b.userId).sort();
    expect(owners).toEqual(['user-a', 'user-b']);
  });
});
