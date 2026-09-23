import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTestDb } from '@/lib/server/__tests__/helpers/pglite';
import { _resetDebugCache } from '@/lib/server/config';
import { _setDbForTests, schema, type Db } from '@/lib/server/db';
import { SCREEN_DISABLED_MESSAGE } from '@/lib/server/screenSettings';

// Lets one test skip the pre-check so the insert meets the unique index (Review Focus 5).
const { race } = vi.hoisted(() => ({ race: { skipNextPrecheck: false } }));

vi.mock('@/lib/server/screenEnrichment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/screenEnrichment')>();
  return {
    ...actual,
    findIdentityClash: async (...args: Parameters<typeof actual.findIdentityClash>) => {
      if (race.skipNextPrecheck) {
        race.skipNextPrecheck = false;
        return null;
      }
      return actual.findIdentityClash(...args);
    },
  };
});

import { POST } from './route';

let db: Db;
let close: () => Promise<void>;

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    media_type: 'movie',
    title: 'Heat',
    year: 1995,
    wikidata_qid: 'Q1',
    tvmaze_id: null,
    image_url: 'https://upload.wikimedia.org/wikipedia/en/a/a1/Heat.jpg',
    description: 'A crime film.',
    description_source: 'wikipedia',
    description_url: 'https://en.wikipedia.org/wiki/Heat_(1995_film)',
    wikipedia_page: 'Heat (1995 film)',
    genres: ['crime film'],
    directors: ['A Director'],
    creators: [],
    writers: ['A Writer'],
    countries: ['United States'],
    original_language: 'en',
    based_on: [],
    main_subjects: [],
    series: [],
    production_companies: [{ qid: 'Q2', label: 'A Studio' }],
    sitelinks: 60,
    ...overrides,
  };
}

const show = (overrides: Record<string, unknown> = {}) =>
  candidate({
    media_type: 'tv',
    title: 'Severance',
    year: 2022,
    wikidata_qid: 'Q97',
    tvmaze_id: 44933,
    image_url: 'https://static.tvmaze.com/uploads/images/medium_portrait/1/1.jpg',
    description_source: 'tvmaze',
    description_url: 'https://www.tvmaze.com/shows/44933/severance',
    ...overrides,
  });

function add(body: unknown): Promise<Response> {
  return POST(
    new Request('http://test/api/screen/titles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

async function enable() {
  await db.insert(schema.userSettings).values({ userId: 'local', screenEnabled: true });
}

beforeEach(async () => {
  ({ db, close } = await makeTestDb());
  _setDbForTests(db);
  _resetDebugCache();
  race.skipNextPrecheck = false;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  _setDbForTests(null);
  vi.restoreAllMocks();
  await close();
});

describe('POST /api/screen/titles (manual add)', () => {
  it('answers 403 while ScreenSprite is off', async () => {
    const response = await add({ candidate: candidate(), status: 'watched' });
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 403,
      body: { detail: SCREEN_DISABLED_MESSAGE },
    });
  });

  it('adds a rated movie with a manual HIGH identity and the candidate metadata', async () => {
    await enable();
    const response = await add({ candidate: candidate(), status: 'watched', rating: 4.5 });
    const body = await response.json();
    expect(response.status).toBe(201);
    expect(body).toMatchObject({
      media_type: 'movie',
      title: 'Heat',
      year: 1995,
      status: 'watched',
      rating: 4.5,
      app_rating: 4.5,
      letterboxd_rating: null,
      wikidata_qid: 'Q1',
      tvmaze_id: null,
      enrichment: {
        confidence_label: 'HIGH',
        match_method: 'manual_add',
        identity_source: 'manual',
        genres: ['crime film'],
        directors: ['A Director'],
        duplicate_of_title_id: null,
      },
    });
    const [row] = await db.select().from(schema.titles);
    expect([row.userId, row.feedbackUpdatedAt === null]).toEqual(['local', false]);
    const [enr] = await db.select().from(schema.titleEnrichment);
    expect([enr.titleId, enr.writers, enr.productionCompanies]).toEqual([
      row.id,
      ['A Writer'],
      [{ qid: 'Q2', label: 'A Studio' }],
    ]);
  });

  it('adds a show by its TVmaze id and keeps its crosswalked QID', async () => {
    await enable();
    const body = await (await add({ candidate: show(), status: 'watching' })).json();
    expect([body.media_type, body.tvmaze_id, body.wikidata_qid]).toEqual(['tv', 44933, 'Q97']);
  });

  it('forces a movie tvmaze_id to null', async () => {
    await enable();
    const body = await (
      await add({ candidate: candidate({ tvmaze_id: 7 }), status: 'want' })
    ).json();
    expect(body.tvmaze_id).toBeNull();
    const [enr] = await db.select().from(schema.titleEnrichment);
    expect(enr.tvmazeId).toBeNull();
  });

  it('treats a missing or 0 rating as unrated, and rejects an off-grid rating', async () => {
    await enable();
    const unrated = await (await add({ candidate: candidate(), status: 'want', rating: 0 })).json();
    expect([unrated.rating, unrated.app_rating]).toEqual([null, null]);
    const [row] = await db.select().from(schema.titles);
    expect(row.feedbackUpdatedAt).toBeNull();
    const off = await add({
      candidate: candidate({ wikidata_qid: 'Q3' }),
      status: 'watched',
      rating: 4.3,
    });
    expect({ status: off.status, body: await off.json() }).toEqual({
      status: 422,
      body: { detail: 'rating must be 0.5 to 5 in half-star steps (or omitted/0 for unrated).' },
    });
  });

  it('requires a rating for a review, except on a dropped title', async () => {
    await enable();
    const rejected = await add({ candidate: candidate(), status: 'watched', review: 'Tense.' });
    expect({ status: rejected.status, body: await rejected.json() }).toEqual({
      status: 422,
      body: {
        detail: 'A review requires a rating (0.5 to 5). Rate the title, or omit the review.',
      },
    });
    const dropped = await add({ candidate: candidate(), status: 'dropped', review: 'Gave up.' });
    expect(dropped.status).toBe(201);
    expect((await dropped.json()).review).toBe('Gave up.');
  });

  it('rejects a candidate without its identity, or with an image off the allowed hosts', async () => {
    await enable();
    const noQid = await add({ candidate: candidate({ wikidata_qid: null }), status: 'watched' });
    expect({ status: noQid.status, body: await noQid.json() }).toEqual({
      status: 422,
      body: { detail: 'A movie needs its Wikidata id. Pick it from the search results.' },
    });
    const noTvmaze = await add({ candidate: show({ tvmaze_id: null }), status: 'watched' });
    expect({ status: noTvmaze.status, body: await noTvmaze.json() }).toEqual({
      status: 422,
      body: { detail: 'A show needs its TVmaze id. Pick it from the search results.' },
    });
    const badImage = await add({
      candidate: candidate({ image_url: 'https://evil.example/poster.jpg' }),
      status: 'watched',
    });
    expect(badImage.status).toBe(422);
    expect(await db.select().from(schema.titles)).toEqual([]);
  });

  it('answers 409 for a title already in the library, by QID or by TVmaze id', async () => {
    await enable();
    expect((await add({ candidate: candidate(), status: 'watched' })).status).toBe(201);
    const again = await add({ candidate: candidate({ title: 'Heat (1995)' }), status: 'want' });
    expect({ status: again.status, body: await again.json() }).toEqual({
      status: 409,
      body: { detail: '"Heat (1995)" is already in your ScreenSprite library.' },
    });
    expect((await add({ candidate: show(), status: 'watching' })).status).toBe(201);
    const sameShow = await add({ candidate: show({ wikidata_qid: null }), status: 'watched' });
    expect(sameShow.status).toBe(409);
  });

  it('answers 409 when the unique index catches a racing duplicate', async () => {
    await enable();
    expect((await add({ candidate: candidate(), status: 'watched' })).status).toBe(201);
    race.skipNextPrecheck = true; // as if the first request committed after this one checked
    const raced = await add({ candidate: candidate(), status: 'watched' });
    expect({ status: raced.status, body: await raced.json() }).toEqual({
      status: 409,
      body: { detail: '"Heat" is already in your ScreenSprite library.' },
    });
    expect(await db.select().from(schema.titles)).toHaveLength(1);
    expect(await db.select().from(schema.titleEnrichment)).toHaveLength(1);
  });

  it('stores an optional last_watched_on and returns it', async () => {
    await enable();
    const response = await add({
      candidate: candidate(),
      status: 'watched',
      last_watched_on: '2025-06-14',
    });
    expect(response.status).toBe(201);
    expect((await response.json()).last_watched_on).toBe('2025-06-14');
    const [row] = await db.select().from(schema.titles);
    expect(row.lastWatchedOn).toBe('2025-06-14');
  });

  it.each(['2025-02-29', '0000-01-01'])(
    'rejects an impossible last_watched_on %j before inserting anything',
    async (value) => {
      await enable();
      const response = await add({
        candidate: candidate(),
        status: 'watched',
        last_watched_on: value,
      });
      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 422,
        body: { detail: 'last_watched_on must be a real date as YYYY-MM-DD.' },
      });
      expect(await db.select().from(schema.titles)).toHaveLength(0);
    }
  );

  it("does not treat another user's copy of the film as a clash", async () => {
    await enable();
    await db.insert(schema.titles).values({
      userId: 'other',
      mediaType: 'movie',
      title: 'Heat',
      status: 'watched',
      wikidataQid: 'Q1',
    });
    expect((await add({ candidate: candidate(), status: 'watched' })).status).toBe(201);
    const [theirs] = await db.select().from(schema.titles).where(eq(schema.titles.userId, 'other'));
    expect(theirs.wikidataQid).toBe('Q1');
  });
});
