import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTestDb } from '@/lib/server/__tests__/helpers/pglite';
import { _resetDebugCache } from '@/lib/server/config';
import { _setDbForTests, schema, type Db } from '@/lib/server/db';
import { SCREEN_DISABLED_MESSAGE } from '@/lib/server/screenSettings';

const { searchMoviesMock, searchShowsMock } = vi.hoisted(() => ({
  searchMoviesMock: vi.fn(),
  searchShowsMock: vi.fn(),
}));

vi.mock('@/lib/server/screenEnrichment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/screenEnrichment')>()),
  searchMovies: searchMoviesMock,
  searchShows: searchShowsMock,
}));

import { GET } from './route';

let db: Db;
let close: () => Promise<void>;
const search = (query: string) => GET(new Request(`http://test/api/screen/search?${query}`));
const HIT = { media_type: 'movie', title: 'Heat', year: 1995, wikidata_qid: 'Q1' };

beforeEach(async () => {
  ({ db, close } = await makeTestDb());
  _setDbForTests(db);
  _resetDebugCache();
  searchMoviesMock.mockReset().mockResolvedValue({ kind: 'ok', value: [HIT] });
  searchShowsMock.mockReset().mockResolvedValue({ kind: 'ok', value: [] });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  _setDbForTests(null);
  vi.restoreAllMocks();
  await close();
});

async function enable() {
  await db.insert(schema.userSettings).values({ userId: 'local', screenEnabled: true });
}

describe('GET /api/screen/search', () => {
  it('answers 403 while ScreenSprite is off', async () => {
    const response = await search('q=heat&type=movie');
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 403,
      body: { detail: SCREEN_DISABLED_MESSAGE },
    });
    expect(searchMoviesMock).not.toHaveBeenCalled();
  });

  it.each([
    'type=movie',
    'q=%20%20&type=movie',
    `q=${'x'.repeat(201)}&type=movie`,
    'q=heat&type=book',
  ])('rejects %s with 422', async (query) => {
    await enable();
    const response = await search(query);
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 422,
      body: { detail: "q must be 1 to 200 characters; type must be 'movie' or 'tv'." },
    });
  });

  it('routes movies and shows to their searches with a trimmed query and a deadline', async () => {
    await enable();
    const movies = await search('q=%20Heat%201995%20&type=movie');
    expect(await movies.json()).toEqual([HIT]);
    expect(searchMoviesMock.mock.calls[0][1]).toBe('Heat 1995');
    expect(searchMoviesMock.mock.calls[0][2].remainingMs()).toBeGreaterThan(20_000);
    await search('q=severance&type=tv');
    expect(searchShowsMock.mock.calls[0][1]).toBe('severance');
  });

  it('answers 503, never an empty list, when the catalog cannot be asked', async () => {
    await enable();
    searchMoviesMock.mockResolvedValue({ kind: 'retryable', reason: 'HTTP 503' });
    const response = await search('q=heat&type=movie');
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 503,
      body: { detail: 'The catalog did not answer in time. Try the search again.' },
    });
  });

  it('is rate limited per user', async () => {
    await enable();
    const statuses: number[] = [];
    for (let i = 0; i < 31; i += 1) statuses.push((await search('q=heat&type=movie')).status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(30);
    expect(statuses[30]).toBe(429);
  });
});
