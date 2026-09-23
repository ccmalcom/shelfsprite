import { describe, test, expect } from 'vitest';
import { makeTestDb } from './helpers/pglite';
import { seedScreenLibrary } from './helpers/screenRecFixtures';
import { schema } from '../db';
import { buildScreenSignal, OWNED_LIST_CAP, titleLabel } from '../screenSignal';
import { normalizeTitleKey } from '../titles';

describe('buildScreenSignal', () => {
  test('reads loved books and titles, favorites and traits for this user only', async () => {
    const { db, close } = await makeTestDb();
    try {
      await seedScreenLibrary(db);
      const s = await buildScreenSignal(db, 'local');

      expect(s.loved_books.map((b) => b.id)).toEqual([1, 2]);
      expect(s.loved_books[0]).toMatchObject({
        title: 'Leviathan Wakes (The Expanse, #1)',
        author: 'James S.A. Corey',
        rating: 5,
        read_year: 2024,
      });
      expect(s.favorite_books).toEqual([
        { id: 2, title: 'All Systems Red (The Murderbot Diaries, #1)', author: 'Martha Wells' },
      ]);

      // Loved = profile evidence with effective rating >= 4; want (Arrival) is never loved.
      expect(s.loved_titles.map((t) => t.id)).toEqual([2, 1, 4]);
      expect(s.loved_titles[2]).toMatchObject({
        type: 'tv',
        wikidata_qid: 'Q900004',
        people: ['Dan Erickson'],
      });
      expect(s.favorite_titles).toEqual([{ id: 2, type: 'movie', title: 'Toy Story', year: 1995 }]);

      expect(s.traits.map((t) => t.id)).toEqual([1]);
      expect(s.top_genres).toContain('animated film');
      expect(s.original_languages).toEqual(['English']);
    } finally {
      await close();
    }
  });

  test('owned identity covers every status, including want, and never another user', async () => {
    const { db, close } = await makeTestDb();
    try {
      await seedScreenLibrary(db);
      const s = await buildScreenSignal(db, 'local');
      expect([...s.owned_qids].sort()).toEqual(['Q134773', 'Q171048', 'Q900003', 'Q900004']);
      expect([...s.owned_tvmaze_ids]).toEqual([44778]);
      expect(s.owned_keys.has(normalizeTitleKey('Arrival', 2016))).toBe(true);
      expect(s.owned_qids.has('Q900099')).toBe(false);
      // Most recently watched first; never-watched rows last.
      expect(s.owned_list).toEqual([
        'Severance (2022)',
        'Forrest Gump (1994)',
        'Toy Story (1995)',
        'Arrival (2016)',
      ]);
    } finally {
      await close();
    }
  });

  test('rejected screen recs join the owned sets and carry their notes', async () => {
    const { db, close } = await makeTestDb();
    try {
      await seedScreenLibrary(db);
      await db.insert(schema.titleRecommendations).values([
        {
          userId: 'local',
          runId: 'r1',
          rank: 1,
          mediaType: 'movie',
          mediaFilter: 'both',
          title: 'Heat',
          year: 1995,
          wikidataQid: 'Q900050',
          score: 0.5,
          status: 'rejected',
          userNote: 'Too long',
          rejectReasons: ['too_long'],
        },
        {
          userId: 'other',
          runId: 'r2',
          rank: 1,
          mediaType: 'movie',
          mediaFilter: 'both',
          title: 'Other Rejected',
          year: 2000,
          wikidataQid: 'Q900051',
          score: 0.5,
          status: 'rejected',
        },
      ]);
      const s = await buildScreenSignal(db, 'local');
      expect(s.owned_qids.has('Q900050')).toBe(true);
      expect(s.owned_qids.has('Q900051')).toBe(false);
      expect(s.rejected_list).toEqual(['Heat (1995)']);
      expect(s.rejected_with_notes).toEqual([
        { title: 'Heat', year: 1995, type: 'movie', note: 'Too long' },
      ]);
      expect([...s.reject_reason_counts]).toEqual([['too_long', 1]]);
    } finally {
      await close();
    }
  });

  test('title more/less-like signals resolve to labels, scoped to this user', async () => {
    const { db, close } = await makeTestDb();
    try {
      await seedScreenLibrary(db);
      await db.insert(schema.tasteSignal).values([
        { userId: 'local', direction: 'more', targetKind: 'title', targetTitleId: 4 },
        { userId: 'local', direction: 'less', targetKind: 'title', targetTitleId: 1 },
        { userId: 'local', direction: 'more', targetKind: 'title', targetTitleId: 5 }, // other user's title
      ]);
      const s = await buildScreenSignal(db, 'local');
      expect(s.more_like_titles).toEqual(['Severance (2022)']);
      expect(s.less_like_titles).toEqual(['Forrest Gump (1994)']);
    } finally {
      await close();
    }
  });

  test('the owned list is capped', async () => {
    const { db, close } = await makeTestDb();
    try {
      await seedScreenLibrary(db);
      const many = Array.from({ length: OWNED_LIST_CAP + 5 }, (_, i) => ({
        userId: 'local',
        mediaType: 'movie',
        title: `Filler ${i}`,
        year: 2000,
        status: 'want',
      }));
      await db.insert(schema.titles).values(many);
      const s = await buildScreenSignal(db, 'local');
      expect(s.owned_list).toHaveLength(OWNED_LIST_CAP);
      expect(titleLabel('Untitled', null)).toBe('Untitled');
    } finally {
      await close();
    }
  });
});
