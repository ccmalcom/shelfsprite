import { describe, expect, test } from 'vitest';
import type { Candidate } from '../catalog';
import { schema } from '../db';
import {
  countLovedGenres,
  deriveGenreSuppression,
  dropSuppressedGenreEntries,
  hitsSuppressedGenre,
  primaryGenres,
  RECENT_WRONG_GENRE,
} from '../genreSuppression';
import type { PoolEntry } from '../recAssemble';
import { buildSeedPrompt, buildRerankPrompt } from '../recPrompts';
import { buildSignal } from '../recSignal';
import { assembleScreenPool, type PoolHit } from '../screenAssemble';
import { buildScreenSeedPrompt, buildScreenRerankPrompt } from '../screenRecPrompts';
import { buildScreenSignal } from '../screenSignal';
import seedJson from './fixtures/seed.json';
import { loadSeed, makeTestDb } from './helpers/pglite';
import {
  candidate as screenCandidate,
  fakeScreenPort,
  OPEN_DEADLINE,
  seedScreenLibrary,
} from './helpers/screenRecFixtures';

const wrong = (genres: string[]) => ({ rejectReasons: ['wrong_genre'], genres });

describe('primaryGenres', () => {
  test('normalizes, skips catalog bookkeeping headings and keeps the first three', () => {
    expect(
      primaryGenres([
        'Fiction',
        'Accessible book',
        'nyt:hardcover-fiction=2020-01-01',
        'Performing Arts ',
        'performing arts',
        'Animated films.',
        'Japan',
        'Motion pictures',
      ])
    ).toEqual(['performing arts', 'animated films', 'japan']);
    expect(primaryGenres(null)).toEqual([]);
  });
});

describe('deriveGenreSuppression', () => {
  test('suppresses the primary genres of wrong_genre skips, most recent first', () => {
    const out = deriveGenreSuppression(
      [
        wrong(['Performing Arts']),
        { rejectReasons: ['too_long'], genres: ['History'] },
        wrong(['Animated films', 'Performing Arts']),
      ],
      new Map()
    );
    expect(out).toEqual({ suppressed: ['animated films', 'performing arts'], soft: [] });
  });

  test('a genre on two loved books, or a favorite subject, stays soft', () => {
    const loved = new Map<string, number>();
    countLovedGenres(loved, ['Fantasy', 'Dragons']);
    countLovedGenres(loved, ['fantasy', 'Fantasy']); // counted once per book
    expect(loved.get('fantasy')).toBe(2);
    expect(loved.get('dragons')).toBe(1);

    const out = deriveGenreSuppression([wrong(['Fantasy', 'Dragons', 'Space opera'])], loved, [
      'Space Opera',
    ]);
    expect(out).toEqual({ suppressed: ['dragons'], soft: ['fantasy', 'space opera'] });
  });

  test('only the most recent wrong_genre skips count', () => {
    const rows = [
      wrong(['Old Genre']),
      ...Array.from({ length: RECENT_WRONG_GENRE }, (_, i) => wrong([`Genre ${i}`])),
    ];
    const out = deriveGenreSuppression(rows, new Map());
    expect(out.suppressed).toHaveLength(RECENT_WRONG_GENRE);
    expect(out.suppressed).not.toContain('old genre');
    expect(out.suppressed[0]).toBe(`genre ${RECENT_WRONG_GENRE - 1}`);
  });

  test('matching is exact primary against primary, never containment', () => {
    expect(hitsSuppressedGenre(['Science fiction -- history and criticism'], ['history'])).toBe(
      false
    );
    expect(hitsSuppressedGenre(['Fiction', 'History'], ['history'])).toBe(true);
    // A suppressed genre deep in the list is not a primary subject.
    expect(hitsSuppressedGenre(['Romance', 'Weddings', 'Bakeries', 'History'], ['history'])).toBe(
      false
    );
    expect(hitsSuppressedGenre(['History'], [])).toBe(false);
  });
});

function book(
  title: string,
  author: string,
  subjects: string[],
  source = 'googlebooks'
): Candidate {
  return {
    source,
    resolved_id: `${source}:${title}`,
    title,
    author,
    subjects,
    description: 'd',
    cover_url: null,
    year: 2020,
    language: 'en',
    raw: {},
  };
}

describe('dropSuppressedGenreEntries', () => {
  test('drops a book from every pool when any of its entries carries a suppressed genre', () => {
    const meta: PoolEntry[] = [
      [book("Miyazaki and the Hero's Journey", 'Ann Writer', ['Performing Arts']), 'subject:x'],
      [book('The Left Hand of Darkness', 'Ursula K. Le Guin', ['Science fiction']), 'subject:x'],
    ];
    const seed: PoolEntry[] = [
      [
        book("Miyazaki and the Hero's Journey", 'Ann Writer', ['Film criticism'], 'openlibrary'),
        'query:y',
      ],
      [book('Spirited Reads', 'Bo Writer', ['Fantasy']), 'query:y'],
    ];
    const [m, s] = dropSuppressedGenreEntries([meta, seed], ['performing arts']);
    expect(m.map(([c]) => c.title)).toEqual(['The Left Hand of Darkness']);
    expect(s.map(([c]) => c.title)).toEqual(['Spirited Reads']);
  });

  test('is a pass-through with nothing suppressed', () => {
    const pools: PoolEntry[][] = [[[book('A', 'B', ['History']), 'r']]];
    expect(dropSuppressedGenreEntries(pools, [])).toBe(pools);
  });
});

function bookRec(
  id: number,
  title: string,
  subjects: string[],
  rejectReasons: string[] | null,
  userId = 'local'
) {
  return {
    id,
    userId,
    runId: 'wg-run',
    rank: 1,
    title,
    author: 'Some Author',
    subjects,
    score: 0.5,
    status: 'rejected',
    rejectReasons,
  };
}

describe('book signal and prompts', () => {
  test('wrong_genre skips become suppressed or soft genres, and both prompts say so', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      await db
        .insert(schema.recommendations)
        .values([
          bookRec(9001, 'Ghiblipedia', ['Performing Arts', 'Animated films'], ['wrong_genre']),
          bookRec(9002, 'Dragon Atlas', ['Fantasy', 'Dragons'], ['wrong_genre', 'too_long']),
          bookRec(9003, 'Too Grim', ['Horror'], ['too_dark']),
          bookRec(9004, 'Not Mine', ['Westerns'], ['wrong_genre'], 'other'),
        ]);
      const s = await buildSignal(db, 'local');
      // The seeded reader loves several fantasy books, so that skip was about something else.
      expect(s.genre_suppression).toEqual({
        suppressed: ['dragons', 'performing arts', 'animated films'],
        soft: ['fantasy'],
      });

      const seedText = buildSeedPrompt(s, 8)[1].text;
      expect(seedText).toContain(
        'the reader recently skipped books in them as the wrong genre: ' +
          '["dragons", "performing arts", "animated films"].'
      );
      expect(seedText).not.toContain('fantasy"');

      const context = buildRerankPrompt([], s, 5)[0].text;
      expect(context).toContain(
        'WRONG-GENRE SKIPS (genres of books the reader recently skipped as the wrong genre;'
      );
      expect(context).toContain('["dragons", "performing arts", "animated films"]');
      expect(context).toContain('SOFT WRONG-GENRE SKIPS');
      expect(context).toContain('["fantasy"]');
    } finally {
      await close();
    }
  });

  test('a reader with no wrong_genre skips gets neither prompt line', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      const s = await buildSignal(db, 'local');
      expect(s.genre_suppression).toEqual({ suppressed: [], soft: [] });
      expect(buildSeedPrompt(s, 8)[1].text).not.toContain('wrong genre');
      expect(buildRerankPrompt([], s, 5)[0].text).not.toContain('WRONG-GENRE');
    } finally {
      await close();
    }
  });
});

function hit(qid: string): PoolHit {
  return {
    qid,
    media_type: 'movie',
    tvmaze_id: null,
    label: `Film ${qid}`,
    year: 2010,
    sitelinks: 20,
    enwiki: true,
    pool: 'metadata',
    seed_reason: 'metadata:people=1;genres=1',
    adaptation: null,
  };
}

describe('screen', () => {
  test('wrong_genre screen skips suppress their genres in the signal and the prompts', async () => {
    const { db, close } = await makeTestDb();
    try {
      await seedScreenLibrary(db);
      const row = {
        userId: 'local',
        mediaType: 'movie',
        mediaFilter: 'both',
        rank: 1,
        score: 0.5,
        status: 'rejected',
      };
      await db.insert(schema.titleRecommendations).values([
        {
          ...row,
          runId: 'r1',
          title: 'The Wind Rises',
          year: 2013,
          wikidataQid: 'Q900060',
          genres: ['film', 'anime film', 'biographical film'],
          rejectReasons: ['wrong_genre'],
        },
        {
          ...row,
          runId: 'r1',
          title: 'Heat',
          year: 1995,
          wikidataQid: 'Q900061',
          genres: ['crime film'],
          rejectReasons: ['too_long'],
        },
      ]);
      const s = await buildScreenSignal(db, 'local');
      expect(s.genre_suppression).toEqual({
        suppressed: ['anime film', 'biographical film'],
        soft: [],
      });
      expect(buildScreenSeedPrompt(s, 'both', 10)[1].text).toContain(
        'as the wrong genre: ["anime film", "biographical film"].'
      );
      expect(buildScreenRerankPrompt([], s, 5)[0].text).toContain(
        'WRONG-GENRE SKIPS (genres of titles the viewer recently skipped'
      );
    } finally {
      await close();
    }
  });

  test('assembleScreenPool drops hydrated candidates whose primary genre is suppressed', async () => {
    const port = fakeScreenPort({
      metadata: {
        Q1: screenCandidate({
          title: 'Porco Rosso',
          wikidata_qid: 'Q1',
          year: 1992,
          genres: ['anime film', 'adventure film'],
        }),
        Q2: screenCandidate({
          title: 'Arrival Again',
          wikidata_qid: 'Q2',
          year: 2020,
          genres: ['science fiction film'],
        }),
      },
    });
    const out = await assembleScreenPool(
      port,
      [[hit('Q1'), hit('Q2')]],
      {
        owned_qids: new Set(),
        owned_tvmaze_ids: new Set(),
        owned_keys: new Set(),
        directive_constraints: {},
        genre_suppression: { suppressed: ['anime film'], soft: [] },
      },
      'movie',
      OPEN_DEADLINE
    );
    expect(out.map((c) => c.wikidata_qid)).toEqual(['Q2']);
  });
});
