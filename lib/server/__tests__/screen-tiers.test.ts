import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers/pglite';
import { schema, type Db } from '../db';
import {
  buildScreenTiers,
  buildScreenTiersWithCounts,
  SCREEN_TIER_KEYS,
  sentTitleIds,
} from '../screenTiers';
import { seedScreenLibrary } from './helpers/screenProfileFixtures';

async function withDb(fn: (db: Db) => Promise<void>): Promise<void> {
  const { db, close } = await makeTestDb();
  try {
    await fn(db);
  } finally {
    await close();
  }
}

function ids(list: Record<string, unknown>[]): unknown[] {
  return list.map((p) => p.id);
}

describe('buildScreenTiers', () => {
  it('emits both media, each with the eight tiers in prompt order', async () => {
    await withDb(async (db) => {
      const tiers = await buildScreenTiers(db, 'local');
      expect([...tiers.keys()]).toEqual(['movie', 'tv']);
      for (const medium of tiers.values()) {
        expect([...medium.keys()]).toEqual([...SCREEN_TIER_KEYS]);
      }
    });
  });

  it('places only eligible titles, per medium, and never another tenant', async () => {
    await withDb(async (db) => {
      const t = await seedScreenLibrary(db);
      const tiers = await buildScreenTiers(db, 'local');
      const movie = tiers.get('movie')!;
      const tv = tiers.get('tv')!;
      expect(ids(movie.get('5')!)).toEqual([t.arrival]);
      expect(ids(movie.get('4.5')!)).toEqual([t.dune]); // app_rating wins over letterboxd
      expect(ids(movie.get('dropped')!)).toEqual([t.cats]); // dropped: evidence even unrated
      expect(ids(tv.get('4')!)).toEqual([t.severance]);
      const all = [...movie.values(), ...tv.values()].flat().map((p) => p.id);
      expect(all).not.toContain(t.tenet); // want
      expect(all).not.toContain(t.old); // watched, unrated
      expect(all).not.toContain(t.excluded); // exclude_from_profile
      expect(all).not.toContain(t.otherUsers); // tenancy
      expect(sentTitleIds(tiers)).toEqual(new Set([t.arrival, t.dune, t.cats, t.severance]));
    });
  });

  it('carries the payload fields in the spec §5.2 key order', async () => {
    await withDb(async (db) => {
      const t = await seedScreenLibrary(db);
      const tiers = await buildScreenTiers(db, 'local');
      const arrival = tiers.get('movie')!.get('5')![0];
      expect(Object.keys(arrival)).toEqual([
        'id',
        'type',
        'title',
        'year',
        'genres',
        'directors',
        'based_on',
        'watched_year',
      ]);
      expect(arrival).toEqual({
        id: t.arrival,
        type: 'movie',
        title: 'Arrival',
        year: 2016,
        genres: ['science fiction film', 'drama film'],
        directors: ['Denis Villeneuve'],
        based_on: ['Story of Your Life by Ted Chiang'],
        watched_year: 2024,
      });

      // TV carries creators, not directors.
      const severance = tiers.get('tv')!.get('4')![0];
      expect(Object.keys(severance)).toEqual([
        'id',
        'type',
        'title',
        'year',
        'genres',
        'creators',
        'based_on',
        'watched_year',
      ]);
      expect(severance.creators).toEqual(['Dan Erickson']);

      // review is appended only when present; the app review wins over Letterboxd's.
      const dune = tiers.get('movie')!.get('4.5')![0];
      expect(Object.keys(dune).at(-1)).toBe('review');
      expect(dune.review).toBe('Loved the sound.');
      const cats = tiers.get('movie')!.get('dropped')![0];
      expect(cats.review).toBe('Walked out.');
      expect(cats.genres).toEqual([]); // no enrichment row
      expect(cats.directors).toEqual([]);
    });
  });

  it('trims a review to 1000 characters and caps genres at 8', async () => {
    await withDb(async (db) => {
      const [row] = await db
        .insert(schema.titles)
        .values({
          userId: 'local',
          mediaType: 'movie',
          status: 'watched',
          title: 'Long',
          year: 2000,
          letterboxdRating: 3,
          letterboxdReview: `  ${'x'.repeat(1200)}  `,
        })
        .returning({ id: schema.titles.id });
      await db.insert(schema.titleEnrichment).values({
        titleId: row.id,
        resolutionConfidence: 1,
        confidenceLabel: 'HIGH',
        identitySource: 'auto',
        genres: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
      });
      const payload = (await buildScreenTiers(db, 'local')).get('movie')!.get('3')![0];
      expect(String(payload.review)).toHaveLength(1000);
      expect(payload.genres).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    });
  });

  it('adds rejected screen recommendations that carry a note, per medium', async () => {
    await withDb(async (db) => {
      const rec = (over: Partial<typeof schema.titleRecommendations.$inferInsert>) => ({
        userId: 'local',
        runId: 'r1',
        rank: 1,
        mediaType: 'movie',
        mediaFilter: 'both',
        title: 'X',
        score: 0.5,
        status: 'rejected',
        ...over,
      });
      await db
        .insert(schema.titleRecommendations)
        .values([
          rec({ title: 'Solaris', year: 1972, userNote: 'Too slow.' }),
          rec({ title: 'No Note', year: 2001 }),
          rec({ title: 'Served', year: 2002, status: 'served', userNote: 'n/a' }),
          rec({ title: 'Lost', year: 2004, mediaType: 'tv', userNote: 'Never ends.' }),
          rec({ userId: 'other', title: 'Theirs', year: 2003, userNote: 'Not mine.' }),
        ]);
      const tiers = await buildScreenTiers(db, 'local');
      expect(tiers.get('movie')!.get('rejected')).toEqual([
        { title: 'Solaris', year: 1972, note: 'Too slow.' },
      ]);
      expect(tiers.get('tv')!.get('rejected')).toEqual([
        { title: 'Lost', year: 2004, note: 'Never ends.' },
      ]);
    });
  });
});

describe('volume cap (spec §5.3)', () => {
  it('sends 300 titles, keeping reviewed, favourite and extreme ones first', async () => {
    await withDb(async (db) => {
      const base = { userId: 'local', mediaType: 'movie', status: 'watched', year: 2000 };
      const values: (typeof schema.titles.$inferInsert)[] = [];
      for (let i = 0; i < 10; i++) {
        values.push({
          ...base,
          title: `Reviewed ${i}`,
          letterboxdRating: 4,
          letterboxdReview: 'Good.',
          lastWatchedOn: '2001-01-01',
        });
      }
      for (let i = 0; i < 5; i++) {
        values.push({
          ...base,
          title: `Favorite ${i}`,
          letterboxdRating: 3,
          isFavorite: true,
          lastWatchedOn: '2001-01-01',
        });
      }
      for (let i = 0; i < 5; i++) {
        values.push({ ...base, title: `Loved ${i}`, letterboxdRating: 5 }); // no date: nulls last
      }
      for (let i = 0; i < 290; i++) {
        const month = String(1 + Math.floor(i / 28)).padStart(2, '0');
        const day = String(1 + (i % 28)).padStart(2, '0');
        values.push({
          ...base,
          title: `Plain ${i}`,
          letterboxdRating: 3.5,
          lastWatchedOn: `2020-${month}-${day}`,
        });
      }
      await db.insert(schema.titles).values(values);

      const { tiers, sent, total } = await buildScreenTiersWithCounts(db, 'local');
      const movie = tiers.get('movie')!;
      const sentCount = [...movie.values()].reduce((n, list) => n + list.length, 0);
      expect(sentCount).toBe(300);

      expect(movie.get('4')!).toHaveLength(10); // every reviewed title
      expect(movie.get('3')!).toHaveLength(5); // every favourite
      expect(movie.get('5')!).toHaveLength(5); // every 5-star, despite no watch date
      expect(movie.get('3.5')!).toHaveLength(280);

      // The ten oldest plain titles are the ones cut (310 eligible - 300).
      const plainTitles = movie.get('3.5')!.map((p) => p.title);
      for (let i = 0; i < 10; i++) expect(plainTitles).not.toContain(`Plain ${i}`);
      expect(plainTitles).toContain('Plain 10');

      // Within a tier, payloads are in id order regardless of selection order.
      const plainIds = movie.get('3.5')!.map((p) => p.id as number);
      expect(plainIds).toEqual([...plainIds].sort((a, b) => a - b));

      expect(sent.get('movie')!.get('3.5')).toBe(280);
      expect(total.get('movie')!.get('3.5')).toBe(290);
      expect(total.get('movie')!.get('4')).toBe(10);
    });
  });

  it('sends the 50 most recent rejected recommendations, in id order', async () => {
    await withDb(async (db) => {
      const rows = Array.from({ length: 55 }, (_, i) => ({
        userId: 'local',
        runId: 'r1',
        rank: i + 1,
        mediaType: 'movie',
        mediaFilter: 'both',
        title: `Rejected ${i}`,
        score: 0.1,
        status: 'rejected',
        userNote: 'no',
      }));
      await db.insert(schema.titleRecommendations).values(rows);
      const { tiers, sent, total } = await buildScreenTiersWithCounts(db, 'local');
      const rejected = tiers.get('movie')!.get('rejected')!;
      expect(rejected).toHaveLength(50);
      expect(rejected[0].title).toBe('Rejected 5');
      expect(rejected.at(-1)!.title).toBe('Rejected 54');
      expect(sent.get('movie')!.get('rejected')).toBe(50);
      expect(total.get('movie')!.get('rejected')).toBe(55);
    });
  });
});
