import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { GET as exportRoute } from '../../../app/api/export/route';
import { _setDbForTests, schema, type Db } from '../db';
import { exportJsonText } from '../export';
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

const jsonExport = async () =>
  (await exportRoute(new Request('http://test/api/export?format=json'))).text();

describe('JSON export — screen section', () => {
  test('book-only export has no screen key', async () => {
    await db
      .insert(schema.books)
      .values({ userId: 'local', title: 'Dune', goodreadsRating: 5, source: 'goodreads' });
    const text = await jsonExport();
    expect(text).not.toContain('"screen"');
    const books = await db.select().from(schema.books);
    // Same bytes as the pre-screen three-argument call.
    expect(exportJsonText(books, [], new Date('2026-08-10T12:34:56.123Z'))).toBe(
      exportJsonText(books, [], new Date('2026-08-10T12:34:56.123Z'), null)
    );
  });

  test('an enabled user with no titles gets an empty versioned section', async () => {
    await db.insert(schema.userSettings).values({ userId: 'local', screenEnabled: true });
    const parsed = JSON.parse(await jsonExport());
    expect(Object.keys(parsed)).toEqual([
      'version',
      'exported_at',
      'books',
      'taste_signals',
      'screen',
    ]);
    expect(parsed.screen).toEqual({
      version: 1,
      titles: [],
      title_recommendations: [],
      taste_signals: [],
    });
  });

  test('exports titles with enrichment, title recommendations and title signals', async () => {
    await db.insert(schema.userSettings).values({ userId: 'local', screenEnabled: true });
    const [t] = await db
      .insert(schema.titles)
      .values({
        userId: 'local',
        mediaType: 'movie',
        title: '夜の図書館',
        year: 2016,
        status: 'watched',
        letterboxdRating: 4,
        appRating: 4.5,
        letterboxdReview: 'lb',
        letterboxdUri: 'https://boxd.it/aaa4',
        isFavorite: true,
        createdAt: '2026-09-01 10:00:00',
      })
      .returning();
    await db.insert(schema.titleEnrichment).values({
      titleId: t.id,
      wikidataQid: 'Q1',
      genres: ['drama film'],
      series: [{ qid: 'Q2', label: 'S' }],
      resolutionConfidence: 0.95,
      confidenceLabel: 'HIGH',
      matchMethod: 'exact',
      rawResponse: { big: true },
      resolvedAt: '2026-09-02 10:00:00',
    });
    await db.insert(schema.titleRecommendations).values({
      userId: 'local',
      runId: 'r1',
      rank: 1,
      mediaType: 'tv',
      mediaFilter: 'both',
      title: 'Glass Orchard',
      score: 0.8,
      status: 'rejected',
      rejectReasons: ['not_my_genre'],
      groundedTitleIds: [t.id],
      createdAt: '2026-09-03 10:00:00',
    });
    await db.insert(schema.tasteSignal).values([
      {
        userId: 'local',
        direction: 'more',
        targetKind: 'book',
        targetBookId: 7,
        createdAt: '2026-09-04 10:00:00',
      },
      {
        userId: 'local',
        direction: 'less',
        targetKind: 'title',
        targetTitleId: t.id,
        createdAt: '2026-09-05 10:00:00',
      },
    ]);
    await db
      .insert(schema.titles)
      .values({ userId: 'other', mediaType: 'movie', title: 'Secret', status: 'want' });

    const text = await jsonExport();
    expect(text).not.toContain('Secret');
    expect(text).not.toContain('"big"'); // raw_response is not exported
    expect(text).toContain('\\u591c'); // ensure_ascii escaping still applies
    const parsed = JSON.parse(text);
    expect(parsed.taste_signals.map((s: { target_kind: string }) => s.target_kind)).toEqual([
      'book',
    ]);
    expect(parsed.screen.taste_signals).toEqual([
      {
        direction: 'less',
        target_kind: 'title',
        target_title_id: t.id,
        snapshot: null,
        created_at: '2026-09-05T10:00:00',
      },
    ]);
    const [title] = parsed.screen.titles;
    expect(Object.keys(title)).toEqual([
      'id',
      'media_type',
      'title',
      'year',
      'status',
      'letterboxd_rating',
      'app_rating',
      'effective_rating',
      'letterboxd_review',
      'app_review',
      'last_watched_on',
      'letterboxd_uri',
      'wikidata_qid',
      'tvmaze_id',
      'is_favorite',
      'exclude_from_profile',
      'created_at',
      'enrichment',
    ]);
    expect(title).toMatchObject({
      title: '夜の図書館',
      effective_rating: 4.5,
      is_favorite: true,
      created_at: '2026-09-01T10:00:00',
    });
    expect(title.enrichment).toMatchObject({
      wikidata_qid: 'Q1',
      genres: ['drama film'],
      series: [{ qid: 'Q2', label: 'S' }],
      confidence_label: 'HIGH',
      resolved_at: '2026-09-02T10:00:00',
    });
    expect(parsed.screen.title_recommendations).toEqual([
      expect.objectContaining({
        run_id: 'r1',
        title: 'Glass Orchard',
        status: 'rejected',
        reject_reasons: ['not_my_genre'],
        grounded_title_ids: [t.id],
      }),
    ]);
  });

  test('CSV export stays book-only', async () => {
    await db.insert(schema.userSettings).values({ userId: 'local', screenEnabled: true });
    await db
      .insert(schema.titles)
      .values({ userId: 'local', mediaType: 'movie', title: 'Film', status: 'want' });
    const csv = await (await exportRoute(new Request('http://test/api/export?format=csv'))).text();
    expect(csv).not.toContain('Film');
  });
});
