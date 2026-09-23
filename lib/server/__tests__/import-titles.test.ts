import { and, asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { schema, type Db } from '../db';
import { importLetterboxdFilms, letterboxdChanges } from '../importTitles';
import type { LetterboxdFilm } from '../letterboxd';
import { readLetterboxdZip } from '../letterboxd';
import { isScreenEnabled, readScreenToggledAt } from '../screenSettings';
import type { TitleRow } from '../titles';
import { letterboxdZip } from './fixtures/letterboxd';
import { makeTestDb } from './helpers/pglite';

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await makeTestDb());
});
afterEach(async () => {
  await close();
});

function film(overrides: Partial<LetterboxdFilm> = {}): LetterboxdFilm {
  return {
    uri: 'https://boxd.it/aaa1',
    name: 'The Lantern Keeper',
    year: 2019,
    status: 'watched',
    rating: null,
    review: null,
    lastWatchedOn: null,
    favorite: false,
    ...overrides,
  };
}

async function titlesOf(userId = 'local'): Promise<TitleRow[]> {
  return db
    .select()
    .from(schema.titles)
    .where(eq(schema.titles.userId, userId))
    .orderBy(asc(schema.titles.id));
}

describe('importLetterboxdFilms — first import', () => {
  test('inserts every film as a movie, enables screen, and drops an unrated review', async () => {
    const { films } = readLetterboxdZip(letterboxdZip());
    expect(await importLetterboxdFilms(db, 'local', films)).toEqual({
      inserted: 6,
      updated: 0,
      unchanged: 0,
    });
    const rows = await titlesOf();
    expect(
      rows.map((r) => [r.title, r.mediaType, r.status, r.letterboxdRating, r.isFavorite])
    ).toEqual([
      ['The Lantern Keeper', 'movie', 'watched', 4.5, false],
      ['Salt & Static', 'movie', 'watched', 2, true],
      ['Quiet Harbor, Loud Sea', 'movie', 'watched', null, false],
      ['夜の図書館', 'movie', 'watched', 5, true],
      ['Paper Moons', 'movie', 'watched', null, false],
      ['Glass Orchard', 'movie', 'want', null, false],
    ]);
    const paper = rows.find((r) => r.title === 'Paper Moons');
    expect(paper?.letterboxdReview).toBeNull(); // review requires a rating
    expect(rows.find((r) => r.title === 'The Lantern Keeper')?.letterboxdReview).toBe(
      'Second take wins.'
    );
    expect(rows.every((r) => r.appRating === null && r.appReview === null)).toBe(true);
    expect(await isScreenEnabled(db, 'local')).toBe(true);
    const [meta] = await db
      .select()
      .from(schema.profileMeta)
      .where(eq(schema.profileMeta.userId, 'local'));
    expect(meta.rebuildReason).toBe('screen_enabled');
  });

  test('stamps feedback_updated_at only for rated or favorite inserts', async () => {
    await importLetterboxdFilms(db, 'local', [
      film({ uri: 'https://boxd.it/1', rating: 4 }),
      film({ uri: 'https://boxd.it/2', name: 'B', favorite: true }),
      film({ uri: 'https://boxd.it/3', name: 'C' }),
    ]);
    expect((await titlesOf()).map((r) => r.feedbackUpdatedAt !== null)).toEqual([
      true,
      true,
      false,
    ]);
  });
});

describe('importLetterboxdFilms — re-import', () => {
  test('an identical re-import changes nothing and does not restamp the toggle', async () => {
    const { films } = readLetterboxdZip(letterboxdZip());
    await importLetterboxdFilms(db, 'local', films);
    const toggled = await readScreenToggledAt(db, 'local');
    const before = await titlesOf();
    expect(await importLetterboxdFilms(db, 'local', films)).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 6,
    });
    expect(await titlesOf()).toEqual(before);
    expect(await readScreenToggledAt(db, 'local')).toBe(toggled);
  });

  test('re-import honours the Letterboxd ownership allowlist', async () => {
    await db.insert(schema.titles).values({
      userId: 'local',
      mediaType: 'tv', // enrichment converted it; import must not flip it back
      title: 'The Lantern Keeper (edited)',
      year: 2018,
      status: 'dropped',
      letterboxdRating: 3,
      appRating: 2.5,
      appReview: 'my own words',
      letterboxdReview: 'old lb review',
      isFavorite: true,
      lastWatchedOn: '2025-01-01',
      letterboxdUri: 'https://boxd.it/aaa1',
      wikidataQid: 'Q42',
    });
    const counts = await importLetterboxdFilms(db, 'local', [
      film({ rating: 4.5, review: 'new lb review', favorite: false, lastWatchedOn: '2024-06-30' }),
    ]);
    expect(counts).toEqual({ inserted: 0, updated: 1, unchanged: 0 });
    const [row] = await titlesOf();
    expect(row).toMatchObject({
      mediaType: 'tv',
      title: 'The Lantern Keeper (edited)',
      year: 2018,
      status: 'dropped', // never demoted
      letterboxdRating: 4.5, // Letterboxd-owned
      letterboxdReview: 'new lb review', // Letterboxd-owned
      appRating: 2.5, // never touched
      appReview: 'my own words', // never touched
      isFavorite: true, // never cleared
      lastWatchedOn: '2025-01-01', // later of stored and imported
      wikidataQid: 'Q42',
    });
  });

  test('status is promoted want -> watched only, never demoted', async () => {
    await importLetterboxdFilms(db, 'local', [
      film({ uri: 'https://boxd.it/w', name: 'W', status: 'want' }),
      film({ uri: 'https://boxd.it/x', name: 'X', status: 'watched' }),
    ]);
    await importLetterboxdFilms(db, 'local', [
      film({ uri: 'https://boxd.it/w', name: 'W', status: 'watched' }),
      film({ uri: 'https://boxd.it/x', name: 'X', status: 'want' }),
    ]);
    expect((await titlesOf()).map((r) => [r.title, r.status])).toEqual([
      ['W', 'watched'],
      ['X', 'watched'],
    ]);
  });

  test('values absent from the export never overwrite stored ones', async () => {
    await importLetterboxdFilms(db, 'local', [
      film({ rating: 4, review: 'kept', lastWatchedOn: '2024-01-01' }),
    ]);
    await importLetterboxdFilms(db, 'local', [film()]);
    expect((await titlesOf())[0]).toMatchObject({
      letterboxdRating: 4,
      letterboxdReview: 'kept',
      lastWatchedOn: '2024-01-01',
    });
  });

  test('rows missing from a re-import are never deleted', async () => {
    await importLetterboxdFilms(db, 'local', [
      film(),
      film({ uri: 'https://boxd.it/gone', name: 'Gone' }),
    ]);
    await importLetterboxdFilms(db, 'local', [film()]);
    expect((await titlesOf()).map((r) => r.title)).toEqual(['The Lantern Keeper', 'Gone']);
  });

  test('a later rating change bumps feedback_updated_at; a URI-only link does not', async () => {
    await db.insert(schema.titles).values({
      userId: 'local',
      mediaType: 'movie',
      title: 'The Lantern Keeper',
      year: 2019,
      status: 'watched',
    });
    expect(await importLetterboxdFilms(db, 'local', [film()])).toEqual({
      inserted: 0,
      updated: 1,
      unchanged: 0,
    });
    let [row] = await titlesOf();
    expect(row.letterboxdUri).toBe('https://boxd.it/aaa1');
    expect(row.feedbackUpdatedAt).toBeNull();
    await importLetterboxdFilms(db, 'local', [film({ rating: 3.5 })]);
    [row] = await titlesOf();
    expect(row.feedbackUpdatedAt).not.toBeNull();
  });
});

describe('importLetterboxdFilms — matching', () => {
  test('title+year fallback matches only a single non-empty candidate', async () => {
    await db.insert(schema.titles).values([
      { userId: 'local', mediaType: 'movie', title: '夜の図書館', year: 2016, status: 'want' },
      { userId: 'local', mediaType: 'movie', title: 'Twin', year: 2020, status: 'want' },
      { userId: 'local', mediaType: 'movie', title: 'twin!', year: 2020, status: 'want' },
      { userId: 'local', mediaType: 'movie', title: '!!!', year: 2021, status: 'want' },
      {
        userId: 'local',
        mediaType: 'movie',
        title: 'Linked',
        year: 2022,
        status: 'want',
        letterboxdUri: 'https://boxd.it/other',
      },
    ]);
    const counts = await importLetterboxdFilms(db, 'local', [
      film({ uri: 'https://boxd.it/cjk', name: '夜の図書館', year: 2016 }), // one candidate: match
      film({ uri: 'https://boxd.it/twin', name: 'Twin', year: 2020 }), // two candidates: insert
      film({ uri: 'https://boxd.it/qqq', name: '???', year: 2021 }), // empty key: insert
      film({ uri: 'https://boxd.it/linked', name: 'Linked', year: 2022 }), // candidate has a URI: insert
      film({ uri: 'https://boxd.it/yr', name: '夜の図書館', year: 2017 }), // different year: insert
    ]);
    expect(counts).toEqual({ inserted: 4, updated: 1, unchanged: 0 });
    const cjk = (await titlesOf()).filter((r) => r.title === '夜の図書館');
    expect(cjk.map((r) => [r.year, r.letterboxdUri, r.status])).toEqual([
      [2016, 'https://boxd.it/cjk', 'watched'],
      [2017, 'https://boxd.it/yr', 'watched'],
    ]);
  });

  test('two export films never both claim one manual title', async () => {
    await db.insert(schema.titles).values({
      userId: 'local',
      mediaType: 'movie',
      title: 'Salt Static',
      year: 2021,
      status: 'want',
    });
    const counts = await importLetterboxdFilms(db, 'local', [
      film({ uri: 'https://boxd.it/s1', name: 'Salt & Static', year: 2021 }),
      film({ uri: 'https://boxd.it/s2', name: 'Salt, Static', year: 2021 }),
    ]);
    expect(counts).toEqual({ inserted: 1, updated: 1, unchanged: 0 });
  });

  test("never matches or modifies another user's titles", async () => {
    await db.insert(schema.titles).values({
      userId: 'other',
      mediaType: 'movie',
      title: 'The Lantern Keeper',
      year: 2019,
      status: 'want',
      letterboxdUri: 'https://boxd.it/aaa1',
    });
    const before = await titlesOf('other');
    expect(await importLetterboxdFilms(db, 'local', [film({ rating: 5 })])).toEqual({
      inserted: 1,
      updated: 0,
      unchanged: 0,
    });
    expect(await titlesOf('other')).toEqual(before);
    expect(await isScreenEnabled(db, 'other')).toBe(false);
  });

  test('inserts in chunks without losing rows', async () => {
    const many = Array.from({ length: 450 }, (_, i) =>
      film({ uri: `https://boxd.it/n${i}`, name: `Film ${i}` })
    );
    expect(await importLetterboxdFilms(db, 'local', many)).toEqual({
      inserted: 450,
      updated: 0,
      unchanged: 0,
    });
    const n = await db
      .select()
      .from(schema.titles)
      .where(and(eq(schema.titles.userId, 'local')));
    expect(n).toHaveLength(450);
  });
});

describe('letterboxdChanges', () => {
  test('stores a Letterboxd review on an unrated dropped title', () => {
    const existing = {
      status: 'dropped',
      appRating: null,
      letterboxdRating: null,
      letterboxdReview: null,
      letterboxdUri: 'u',
      isFavorite: false,
      lastWatchedOn: null,
    } as unknown as TitleRow;
    expect(letterboxdChanges(existing, film({ uri: 'u', review: 'gave up' }))).toEqual({
      letterboxdReview: 'gave up',
    });
  });
});
