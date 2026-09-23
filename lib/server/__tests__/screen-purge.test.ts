import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { DELETE as deleteAccount } from '../../../app/api/account/route';
import { DELETE as deleteLibrary } from '../../../app/api/library/route';
import { DELETE as deleteProfile } from '../../../app/api/profile/route';
import { DELETE as deleteScreenLibrary } from '../../../app/api/screen/library/route';
import { _setDbForTests, schema, type Db } from '../db';
import { deleteScreenLibraryRows } from '../screenPurge';
import { makeTestDb } from './helpers/pglite';

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await makeTestDb());
  _setDbForTests(db);
});
afterEach(async () => {
  _setDbForTests(null);
  await close();
});

async function seed(userId: string) {
  await db.insert(schema.userSettings).values({ userId, screenEnabled: true });
  const [book] = await db
    .insert(schema.books)
    .values({ userId, title: 'Dune', goodreadsRating: 5, source: 'test' })
    .returning();
  const titles = await db
    .insert(schema.titles)
    .values([
      { userId, mediaType: 'movie', title: 'A', status: 'watched', letterboxdRating: 4 },
      { userId, mediaType: 'tv', title: 'B', status: 'want' },
    ])
    .returning();
  await db
    .insert(schema.titleEnrichment)
    .values(titles.map((t) => ({ titleId: t.id, resolutionConfidence: 0.95 })));
  await db.insert(schema.titleRecommendations).values({
    userId,
    runId: 'r',
    rank: 1,
    mediaType: 'movie',
    mediaFilter: 'both',
    title: 'C',
    score: 1,
    status: 'served',
  });
  await db
    .insert(schema.recommendations)
    .values({ userId, runId: 'b', rank: 1, title: 'Book rec', score: 1, status: 'served' });
  await db
    .insert(schema.tasteTraits)
    .values({ userId, claim: 'c', polarity: 'reward', inferenceConfidence: 1, status: 'proposed' });
  await db
    .insert(schema.profileMeta)
    .values({ userId, lastProfileKind: 'full', lastProfiledAt: '2026-09-01 00:00:00' });
  await db.insert(schema.tasteSignal).values([
    { userId, direction: 'more', targetKind: 'book', targetBookId: book.id },
    { userId, direction: 'more', targetKind: 'title', targetTitleId: titles[0].id },
  ]);
}

async function counts(userId: string) {
  const n = async (table: any, col: any) =>
    (await db.select().from(table).where(eq(col, userId))).length;
  const titleIds = (
    await db.select().from(schema.titles).where(eq(schema.titles.userId, userId))
  ).map((t) => t.id);
  const enrichment = (await db.select().from(schema.titleEnrichment)).filter((e) =>
    titleIds.includes(e.titleId)
  ).length;
  const signals = await db
    .select()
    .from(schema.tasteSignal)
    .where(eq(schema.tasteSignal.userId, userId));
  return {
    books: await n(schema.books, schema.books.userId),
    titles: titleIds.length,
    titleEnrichment: enrichment,
    titleRecs: await n(schema.titleRecommendations, schema.titleRecommendations.userId),
    bookRecs: await n(schema.recommendations, schema.recommendations.userId),
    traits: await n(schema.tasteTraits, schema.tasteTraits.userId),
    bookSignals: signals.filter((s) => s.targetTitleId === null).length,
    titleSignals: signals.filter((s) => s.targetTitleId !== null).length,
    settings: await n(schema.userSettings, schema.userSettings.userId),
  };
}

const full = {
  books: 1,
  titles: 2,
  titleEnrichment: 2,
  titleRecs: 1,
  bookRecs: 1,
  traits: 1,
  bookSignals: 1,
  titleSignals: 1,
  settings: 1,
};

describe('spec §7.6 purge scope', () => {
  test('DELETE /api/screen/library deletes the screen library and the shared profile, keeps books', async () => {
    await seed('local');
    await seed('other');
    const res = await deleteScreenLibrary(
      new Request('http://test/api/screen/library', { method: 'DELETE' })
    );
    expect(await res.json()).toEqual({
      titles_removed: 2,
      title_recommendations_removed: 1,
      title_signals_removed: 1,
      traits_removed: 1,
      recommendations_removed: 1,
      profile_reset: true,
    });
    expect(await counts('local')).toEqual({
      ...full,
      titles: 0,
      titleEnrichment: 0,
      titleRecs: 0,
      bookRecs: 0,
      traits: 0,
      titleSignals: 0,
    });
    expect(await counts('other')).toEqual(full);
    const [meta] = await db
      .select()
      .from(schema.profileMeta)
      .where(eq(schema.profileMeta.userId, 'local'));
    expect(meta.rebuildReason).toBe('screen_library_deleted');
    expect(meta.lastProfiledAt).toBeNull();
  });

  test('DELETE /api/screen/library works while screen is disabled', async () => {
    await seed('local');
    await db.update(schema.userSettings).set({ screenEnabled: false });
    expect(
      (
        await deleteScreenLibrary(
          new Request('http://test/api/screen/library', { method: 'DELETE' })
        )
      ).status
    ).toBe(200);
    expect((await counts('local')).titles).toBe(0);
  });

  test('book library reset keeps titles', async () => {
    await seed('local');
    const res = await deleteLibrary(new Request('http://test/api/library', { method: 'DELETE' }));
    expect(await res.json()).toEqual({
      books_removed: 1,
      traits_removed: 1,
      recommendations_removed: 1,
      profile_reset: true,
    });
    expect(await counts('local')).toEqual({
      ...full,
      books: 0,
      titleRecs: 0,
      bookRecs: 0,
      traits: 0,
    });
  });

  test('profile reset deletes both recommendation tables and keeps both libraries', async () => {
    await seed('local');
    const res = await deleteProfile(new Request('http://test/api/profile', { method: 'DELETE' }));
    expect(await res.json()).toEqual({
      traits_removed: 1,
      recommendations_removed: 1,
      profile_reset: true,
    });
    expect(await counts('local')).toEqual({ ...full, titleRecs: 0, bookRecs: 0, traits: 0 });
  });

  test('account deletion removes every screen row and counts title signals as signals', async () => {
    await seed('local');
    await seed('other');
    const body = await (
      await deleteAccount(new Request('http://test/api/account', { method: 'DELETE' }))
    ).json();
    expect(body.signals_removed).toBe(2);
    expect(Object.keys(body)).not.toContain('titles_removed'); // shape pinned by purge-routes.test.ts
    expect(await counts('local')).toEqual({
      books: 0,
      titles: 0,
      titleEnrichment: 0,
      titleRecs: 0,
      bookRecs: 0,
      traits: 0,
      bookSignals: 0,
      titleSignals: 0,
      settings: 0,
    });
    expect(await counts('other')).toEqual(full);
  });

  test('deleteScreenLibraryRows deletes enrichment before titles (FK)', async () => {
    await seed('local');
    await expect(db.transaction((tx) => deleteScreenLibraryRows(tx, 'local'))).resolves.toEqual({
      titles_removed: 2,
      title_recommendations_removed: 1,
      title_signals_removed: 1,
    });
  });
});
