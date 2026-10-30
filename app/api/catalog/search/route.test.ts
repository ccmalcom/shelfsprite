import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeTestDb } from '@/lib/server/__tests__/helpers/pglite';
import { setupTestEnv } from '@/lib/server/__tests__/helpers/testEnv';
import { _setDbForTests } from '@/lib/server/db';
import type { Candidate } from '@/lib/server/catalog';

const hits: Candidate[] = [];
vi.mock('@/lib/server/catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/catalog')>()),
  searchBooks: vi.fn(async () => hits),
}));

import { GET } from './route';

setupTestEnv();
afterEach(() => vi.restoreAllMocks());

function hit(over: Partial<Candidate>): Candidate {
  return {
    source: 'googlebooks',
    resolved_id: 'id',
    title: 'Beloved',
    author: 'Toni Morrison',
    subjects: [],
    cover_url: null,
    year: null,
    language: 'en',
    raw: {},
    ...over,
  };
}

async function search(): Promise<Array<{ year: number | null; year_kind: string | null }>> {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const { db, close } = await makeTestDb();
  try {
    _setDbForTests(db);
    return await (await GET(new Request('http://test/api/catalog/search?q=beloved'))).json();
  } finally {
    _setDbForTests(null);
    await close();
  }
}

// Readers judge "is this the right book?" by the year, and an edition year (The Remains of
// the Day, 2009) made them doubt a correct pick.
describe('GET /api/catalog/search — publication year', () => {
  it('shows the original year when the catalog gave one, over the edition year', async () => {
    hits.splice(0, hits.length, hit({ year: 2004, first_publish_year: 1987 }));
    expect(await search()).toMatchObject([{ year: 1987, year_kind: 'first_published' }]);
  });

  it('labels an edition-only year as an edition', async () => {
    hits.splice(0, hits.length, hit({ year: 2009 }));
    expect(await search()).toMatchObject([{ year: 2009, year_kind: 'edition' }]);
  });

  it('drops an absurd year instead of showing it', async () => {
    hits.splice(0, hits.length, hit({ year: 1207, first_publish_year: 3001 }));
    expect(await search()).toMatchObject([{ year: null, year_kind: null }]);
  });
});
