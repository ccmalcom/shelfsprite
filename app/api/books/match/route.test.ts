import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTestDb } from '@/lib/server/__tests__/helpers/pglite';
import { setupJwtAuth } from '@/lib/server/__tests__/helpers/jwtAuth';
import { freezeInsideRateWindow } from '@/lib/server/__tests__/helpers/rateWindow';
import { _setDbForTests, schema, type Db } from '@/lib/server/db';
import { RATE_LIMITS } from '@/lib/server/ratelimit';
import type { Candidate } from '@/lib/server/catalog';

// The catalog is faked: no network. Each query answers from this table.
const catalog = vi.hoisted(() => ({
  table: {} as Record<string, unknown[]>,
  asked: [] as string[],
}));
vi.mock('@/lib/server/catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/catalog')>()),
  searchBooks: vi.fn(async (_db: unknown, q: string) => {
    catalog.asked.push(q);
    return catalog.table[q] ?? [];
  }),
}));

import { POST } from './route';

const { authHeaders } = setupJwtAuth();

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await makeTestDb());
  _setDbForTests(db);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  catalog.table = {};
  catalog.asked = [];
});

afterEach(async () => {
  _setDbForTests(null);
  vi.restoreAllMocks();
  await close();
});

function cand(title: string, author: string): Candidate {
  return {
    source: 'googlebooks',
    resolved_id: title,
    title,
    author,
    subjects: ['Fiction'],
    cover_url: null,
    year: 2010,
    language: 'en',
    raw: {},
  };
}

async function match(body: unknown, userId = 'user-a'): Promise<Response> {
  return POST(
    new Request('http://test/api/books/match', {
      method: 'POST',
      headers: await authHeaders(userId),
      body: JSON.stringify(body),
    })
  );
}

describe('POST /api/books/match', () => {
  it('requires a signed-in reader and never searches without one', async () => {
    const res = await POST(
      new Request('http://test/api/books/match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ title: 'Dune' }] }),
      })
    );
    expect(res.status).toBe(401);
    expect(catalog.asked).toEqual([]);
  });

  it('validates the batch', async () => {
    expect((await match({ items: [] })).status).toBe(422);
    expect((await match({ items: [{ title: '  ' }] })).status).toBe(422);
    const tooMany = Array.from({ length: 26 }, (_, i) => ({ title: `Book ${i}` }));
    expect((await match({ items: tooMany })).status).toBe(422);
    expect((await match({ items: [{ title: 'Dune' }], mode: 'loose' })).status).toBe(422);
  });

  it('returns one result per line, in order, in the catalog search shape', async () => {
    catalog.table = {
      'Dune Frank Herbert': [cand('Dune', 'Frank Herbert'), cand('Dune Messiah', 'Frank Herbert')],
    };
    const res = await match({
      items: [
        { title: 'Dune', author: 'Frank Herbert' },
        { title: 'Nothing like it', author: null },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: [
        {
          index: 0,
          status: 'matched',
          best: {
            source: 'googlebooks',
            catalog_id: 'Dune',
            title: 'Dune',
            author: 'Frank Herbert',
            year: 2010,
            year_kind: 'edition',
            isbn13: null,
            cover_url: null,
            subjects: ['Fiction'],
            description: null,
            in_library: false,
          },
          alternatives: [expect.objectContaining({ title: 'Dune Messiah', in_library: false })],
        },
        { index: 1, status: 'unmatched' },
      ],
    });
  });

  it("flags in_library against the caller's library only", async () => {
    const row = { goodreadsRating: 0, exclusiveShelf: 'read', source: 'manual' };
    await db.insert(schema.books).values([
      { ...row, userId: 'user-b', title: 'Circe', author: 'Madeline Miller' },
      { ...row, userId: 'user-a', title: 'Gilead', author: 'Marilynne Robinson' },
    ]);
    catalog.table = {
      Circe: [cand('Circe', 'Madeline Miller')],
      Gilead: [cand('Gilead', 'Marilynne Robinson')],
    };
    const body = { items: [{ title: 'Circe' }, { title: 'Gilead' }] };
    const flags = async (userId: string) =>
      (
        (await (await match(body, userId)).json()).results as { best: { in_library: boolean } }[]
      ).map((r) => r.best.in_library);
    expect(await flags('user-a')).toEqual([false, true]);
    expect(await flags('user-b')).toEqual([true, false]);
    // Matching never writes to the library.
    expect(await db.select().from(schema.books)).toHaveLength(2);
  });

  it('uses the strict title-and-author rule in strict mode', async () => {
    catalog.table = {
      'It Stephen King': [cand('It Ends with Us', 'Colleen Hoover'), cand('It', 'Stephen King')],
      'Circe Madeline Miller': [cand('Circe Study Guide', 'Course Hero')],
    };
    const res = await match({
      mode: 'strict',
      items: [
        { title: 'It', author: 'Stephen King' },
        { title: 'Circe', author: 'Madeline Miller' },
      ],
    });
    const { results } = await res.json();
    expect(results[0]).toMatchObject({
      status: 'matched',
      best: { title: 'It' },
      alternatives: [],
    });
    expect(results[1]).toEqual({ index: 1, status: 'unmatched' });
  });

  it('answers 429 with the normal detail shape once the per-reader limit is spent', async () => {
    freezeInsideRateWindow();
    const body = { items: [{ title: 'Dune' }] };
    for (let i = 0; i < RATE_LIMITS.bookMatch.limit; i++) {
      expect((await match(body)).status).toBe(200);
    }
    const blocked = await match(body);
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({
      detail: 'Too many lookups at once. Wait a minute and try again.',
    });
    // Another reader has their own bucket.
    expect((await match(body, 'user-b')).status).toBe(200);
  });
});
