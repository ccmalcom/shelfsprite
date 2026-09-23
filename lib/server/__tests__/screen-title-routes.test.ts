import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { GET as listTitles } from '../../../app/api/screen/titles/route';
import {
  DELETE as deleteTitle,
  GET as getTitle,
  PATCH as patchTitle,
} from '../../../app/api/screen/titles/[id]/route';
import { _setDbForTests, schema, type Db } from '../db';
import { makeTestDb } from './helpers/pglite';

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await makeTestDb());
  _setDbForTests(db);
});
afterEach(async () => {
  vi.restoreAllMocks();
  _setDbForTests(null);
  await close();
});

async function enable(userId = 'local') {
  await db.insert(schema.userSettings).values({ userId, screenEnabled: true });
}

async function title(values: Partial<typeof schema.titles.$inferInsert> = {}) {
  const [row] = await db
    .insert(schema.titles)
    .values({
      userId: 'local',
      mediaType: 'movie',
      title: 'The Lantern Keeper',
      year: 2019,
      status: 'watched',
      ...values,
    })
    .returning();
  return row;
}

const params = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });
const patch = (id: number, body: unknown) =>
  patchTitle(
    new Request(`http://test/api/screen/titles/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    params(id)
  );
const del = (id: number) =>
  deleteTitle(new Request(`http://test/api/screen/titles/${id}`, { method: 'DELETE' }), params(id));

async function reason(): Promise<string | null> {
  const rows = await db
    .select()
    .from(schema.profileMeta)
    .where(eq(schema.profileMeta.userId, 'local'));
  return rows[0]?.rebuildReason ?? null;
}

describe('GET /api/screen/titles', () => {
  test('is 403 while screen is disabled', async () => {
    const res = await listTitles(new Request('http://test/api/screen/titles'));
    expect({ status: res.status, body: await res.json() }).toEqual({
      status: 403,
      body: { detail: 'ScreenSprite is not enabled for this account.' },
    });
  });

  test("lists only the caller's titles, filtered, in id order, with enrichment", async () => {
    await enable();
    const a = await title({ title: 'A', status: 'want' });
    const b = await title({ title: 'B', mediaType: 'tv', status: 'watching', letterboxdRating: 4 });
    await title({ userId: 'other', title: 'Secret' });
    await db.insert(schema.titleEnrichment).values({
      titleId: b.id,
      resolutionConfidence: 0.95,
      confidenceLabel: 'HIGH',
      genres: ['drama'],
    });
    const all = await (await listTitles(new Request('http://test/api/screen/titles'))).json();
    expect(all.map((t: { title: string }) => t.title)).toEqual(['A', 'B']);
    expect(all[0].enrichment).toBeNull();
    expect(all[1].enrichment).toMatchObject({ confidence_label: 'HIGH', genres: ['drama'] });
    const tv = await (
      await listTitles(new Request('http://test/api/screen/titles?type=tv'))
    ).json();
    expect(tv.map((t: { id: number }) => t.id)).toEqual([b.id]);
    const want = await (
      await listTitles(new Request('http://test/api/screen/titles?status=want'))
    ).json();
    expect(want.map((t: { id: number }) => t.id)).toEqual([a.id]);
    const bad = await listTitles(new Request('http://test/api/screen/titles?type=book'));
    expect(bad.status).toBe(422);
  });
});

describe('GET /api/screen/titles/[id]', () => {
  test("returns the caller's title and 404s another user's", async () => {
    await enable();
    const mine = await title();
    const theirs = await title({ userId: 'other' });
    const ok = await getTitle(new Request('http://test'), params(mine.id));
    expect((await ok.json()).title).toBe('The Lantern Keeper');
    const other = await getTitle(new Request('http://test'), params(theirs.id));
    expect({ status: other.status, body: await other.json() }).toEqual({
      status: 404,
      body: { detail: `Title ${theirs.id} not found.` },
    });
    expect((await getTitle(new Request('http://test'), params('abc'))).status).toBe(422);
  });
});

describe('PATCH /api/screen/titles/[id]', () => {
  test('rating 4.5 sets app_rating; 0 clears it back to the Letterboxd rating', async () => {
    await enable();
    const t = await title({ letterboxdRating: 3 });
    const set = await (await patch(t.id, { rating: 4.5 })).json();
    expect([set.rating, set.app_rating, set.letterboxd_rating]).toEqual([4.5, 4.5, 3]);
    const cleared = await (await patch(t.id, { rating: 0 })).json();
    expect([cleared.rating, cleared.app_rating]).toEqual([3, null]);
    const [row] = await db.select().from(schema.titles).where(eq(schema.titles.id, t.id));
    expect(row.feedbackUpdatedAt).not.toBeNull();
    expect(row.updatedAt).not.toBeNull();
  });

  test('rejects off-grid ratings and empty bodies with the stable messages', async () => {
    await enable();
    const t = await title();
    const bad = await patch(t.id, { rating: 4.3 });
    expect({ status: bad.status, body: await bad.json() }).toEqual({
      status: 422,
      body: { detail: 'rating must be 0.5 to 5 in half-star steps (or 0 to clear).' },
    });
    const empty = await patch(t.id, {});
    expect({ status: empty.status, body: await empty.json() }).toEqual({
      status: 422,
      body: {
        detail:
          'Nothing to update: pass a rating, review, status, favorite, exclude flag, and/or watch date.',
      },
    });
    const status = await patch(t.id, { status: 'read' });
    expect(status.status).toBe(422);
  });

  test('PATCH enforces review-requires-rating after applying the change', async () => {
    await enable();
    const unrated = await title();
    const res = await patch(unrated.id, { review: 'great' });
    expect({ status: res.status, body: await res.json() }).toEqual({
      status: 422,
      body: {
        detail:
          'A review requires a rating. Rate the title 0.5 to 5 (same update is fine) before saving a review.',
      },
    });
    expect((await patch(unrated.id, { review: 'great', rating: 4 })).status).toBe(200);
    // Clearing the only rating while an app review exists is rejected...
    expect((await patch(unrated.id, { rating: 0 })).status).toBe(422);
    // ...unless the title is dropped (DNF semantics, spec §3.2).
    const dropped = await title({ title: 'Dropped', status: 'dropped' });
    expect((await patch(dropped.id, { review: 'gave up' })).status).toBe(200);
    // Leaving dropped with an unrated review is rejected.
    expect((await patch(dropped.id, { status: 'watched' })).status).toBe(422);
  });

  test('PATCH review "" clears app_review and reveals the Letterboxd review', async () => {
    await enable();
    const t = await title({
      letterboxdRating: 4,
      letterboxdReview: 'lb words',
      appReview: 'app words',
    });
    const body = await (await patch(t.id, { review: '' })).json();
    expect([body.review, body.app_review, body.letterboxd_review]).toEqual([
      'lb words',
      null,
      'lb words',
    ]);
  });

  test('sets status, favorite and exclusion', async () => {
    await enable();
    const t = await title({ status: 'want' });
    const body = await (
      await patch(t.id, { status: 'watching', is_favorite: true, exclude_from_profile: true })
    ).json();
    expect([body.status, body.is_favorite, body.exclude_from_profile]).toEqual([
      'watching',
      true,
      true,
    ]);
  });

  test('last_watched_on alone sets the watch date and keeps every other field', async () => {
    await enable();
    const t = await title({
      lastWatchedOn: '2024-03-01',
      appRating: 4,
      appReview: 'Quiet and exact.',
      status: 'dropped',
      isFavorite: true,
      excludeFromProfile: true,
    });
    const res = await patch(t.id, { last_watched_on: '2025-11-30' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      last_watched_on: '2025-11-30',
      app_rating: 4,
      app_review: 'Quiet and exact.',
      status: 'dropped',
      is_favorite: true,
      exclude_from_profile: true,
    });
    const [row] = await db.select().from(schema.titles).where(eq(schema.titles.id, t.id));
    const { updatedAt: _u, feedbackUpdatedAt: _f, ...rest } = row;
    const { updatedAt: _u0, feedbackUpdatedAt: _f0, ...before } = t;
    expect(rest).toEqual({ ...before, lastWatchedOn: '2025-11-30' });
  });

  test('a PATCH without last_watched_on does not write the date it read', async () => {
    await enable();
    const t = await title({ lastWatchedOn: '2024-03-01' });
    // The race (a Letterboxd re-import moving the date between this PATCH's read and its write)
    // cannot be staged in one connection, so check the write itself: the date is not in it.
    const realUpdate = db.update.bind(db);
    const written: Record<string, unknown>[] = [];
    vi.spyOn(db, 'update').mockImplementation(((table: typeof schema.titles) => {
      const builder = realUpdate(table);
      const realSet = builder.set.bind(builder);
      builder.set = ((values: Record<string, unknown>) => {
        written.push(values);
        return realSet(values);
      }) as typeof builder.set;
      return builder;
    }) as typeof db.update);
    expect((await patch(t.id, { is_favorite: true })).status).toBe(200);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ isFavorite: true });
    expect(written[0]).not.toHaveProperty('lastWatchedOn');
  });

  test.each(['2025-02-30', '2025-13-01', '0000-01-01', '25-01-01', 'yesterday', ''])(
    'rejects last_watched_on %j with the stable message and writes nothing',
    async (value) => {
      await enable();
      const t = await title({ lastWatchedOn: '2024-03-01' });
      const res = await patch(t.id, { last_watched_on: value });
      expect({ status: res.status, body: await res.json() }).toEqual({
        status: 422,
        body: { detail: 'last_watched_on must be a real date as YYYY-MM-DD.' },
      });
      const [row] = await db.select().from(schema.titles).where(eq(schema.titles.id, t.id));
      expect(row.lastWatchedOn).toBe('2024-03-01');
    }
  );

  test("404s another user's title and leaves it unchanged; 403 while disabled", async () => {
    await enable();
    const theirs = await title({ userId: 'other' });
    const res = await patch(theirs.id, { rating: 5 });
    expect(res.status).toBe(404);
    const [row] = await db.select().from(schema.titles).where(eq(schema.titles.id, theirs.id));
    expect(row.appRating).toBeNull();
    await db.update(schema.userSettings).set({ screenEnabled: false });
    expect((await patch((await title()).id, { rating: 5 })).status).toBe(403);
  });
});

describe('DELETE /api/screen/titles/[id]', () => {
  test('removes an evidence title and its enrichment, sets the rebuild reason', async () => {
    await enable();
    const t = await title({ letterboxdRating: 4 });
    await db.insert(schema.titleEnrichment).values({ titleId: t.id, resolutionConfidence: 0.95 });
    const other = await title({ title: 'Twin' });
    await db
      .insert(schema.titleEnrichment)
      .values({ titleId: other.id, resolutionConfidence: 0.3, duplicateOfTitleId: t.id });
    const res = await del(t.id);
    expect(await res.json()).toEqual({ id: t.id, title: 'The Lantern Keeper', removed: true });
    expect(await db.select().from(schema.titles).where(eq(schema.titles.id, t.id))).toEqual([]);
    expect(
      await db.select().from(schema.titleEnrichment).where(eq(schema.titleEnrichment.titleId, t.id))
    ).toEqual([]);
    const [twin] = await db
      .select()
      .from(schema.titleEnrichment)
      .where(eq(schema.titleEnrichment.titleId, other.id));
    expect(twin.duplicateOfTitleId).toBeNull();
    expect(await reason()).toBe('title_deleted');
  });

  test('deleting a watchlist title does not force a rebuild unless a trait cites it', async () => {
    await enable();
    const want = await title({ status: 'want' });
    await del(want.id);
    expect(await reason()).toBeNull();
    const cited = await title({ status: 'want', title: 'Cited' });
    await db.insert(schema.tasteTraits).values({
      userId: 'local',
      claim: 'c',
      polarity: 'reward',
      inferenceConfidence: 1,
      status: 'proposed',
      exhibitTitleIds: [cited.id],
    });
    await del(cited.id);
    expect(await reason()).toBe('title_deleted');
  });

  test("404s another user's title", async () => {
    await enable();
    const theirs = await title({ userId: 'other' });
    expect((await del(theirs.id)).status).toBe(404);
    expect(
      await db.select().from(schema.titles).where(eq(schema.titles.id, theirs.id))
    ).toHaveLength(1);
  });
});
