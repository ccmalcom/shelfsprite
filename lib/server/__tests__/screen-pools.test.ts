import { describe, test, expect } from 'vitest';
import {
  adaptationPool,
  authorTokens,
  bookTitleVariants,
  metadataPool,
  querySurname,
  seedPool,
  stripSeriesSuffix,
} from '../screenAssemble';
import type { ScreenLovedBook, ScreenLovedTitle } from '../screenSignal';
import {
  fakeScreenPort,
  lit,
  OPEN_DEADLINE,
  SPENT_DEADLINE,
  wd,
} from './helpers/screenRecFixtures';

const owned = { owned_qids: new Set(['Q134773']), owned_tvmaze_ids: new Set([44933]) };

function lovedTitle(id: number, qid: string | null): ScreenLovedTitle {
  return {
    id,
    type: 'movie',
    title: `T${id}`,
    year: 2000,
    rating: 5,
    genres: [],
    people: [],
    wikidata_qid: qid,
    watched_year: null,
  };
}

function book(
  id: number,
  title: string,
  author: string | null,
  extra: string[] = []
): ScreenLovedBook {
  return { id, title, author, additional_authors: extra, rating: 5, read_year: 2024 };
}

describe('title and author helpers', () => {
  test('strip the Goodreads series suffix and add the pre-colon variant', () => {
    expect(stripSeriesSuffix('Leviathan Wakes (The Expanse, #1)')).toBe('Leviathan Wakes');
    expect(stripSeriesSuffix('Golden Son (Red Rising Saga, #2)')).toBe('Golden Son');
    expect(stripSeriesSuffix('Piranesi')).toBe('Piranesi');
    expect(bookTitleVariants('Shōgun: A Novel of Japan (Asian Saga, #1)')).toEqual([
      'Shōgun: A Novel of Japan',
      'Shōgun',
    ]);
    expect(bookTitleVariants('三体')).toEqual(['三体']);
  });

  test('author matching is an order-insensitive token set', () => {
    expect(authorTokens('Liu Cixin')).toBe(authorTokens('Cixin Liu'));
    expect(authorTokens('James S.A. Corey')).toBe(authorTokens('James S. A. Corey'));
    expect(authorTokens('Stephen King')).not.toBe(authorTokens('Stifn King'));
    expect(querySurname('James S.A. Corey')).toBe('corey');
  });
});

describe('metadataPool', () => {
  const rows = [
    { f: wd('Q5001'), np: lit(1), ng: lit(3), nsl: lit(40), len: lit('Film A'), yr: lit(2001) },
    { f: wd('Q5002'), np: lit(2), ng: lit(1), nsl: lit(20), lmul: lit('Film B'), yr: lit(2002) },
    {
      f: wd('Q134773'),
      np: lit(5),
      ng: lit(5),
      nsl: lit(99),
      len: lit('Forrest Gump'),
      yr: lit(1994),
    },
  ];

  test('ranks by shared people, then genres, then sitelinks, dropping owned films', async () => {
    const port = fakeScreenPort({
      sparql: {
        'loved-people': [{ p: wd('Q10'), n: lit(2) }],
        'loved-genres': [{ g: wd('Q20'), n: lit(2) }],
        'metadata-movie': rows,
      },
    });
    const hits = await metadataPool(
      port,
      { ...owned, loved_titles: [lovedTitle(1, 'Q1'), lovedTitle(2, null)] },
      'movie',
      OPEN_DEADLINE
    );
    expect(hits.map((h) => h.qid)).toEqual(['Q5002', 'Q5001']);
    expect(hits[0]).toMatchObject({
      media_type: 'movie',
      label: 'Film B',
      year: 2002,
      sitelinks: 20,
      pool: 'metadata',
      seed_reason: 'metadata:people=2;genres=1',
    });
    expect(port.queries.some((q) => q.startsWith('# screen:metadata-tv'))).toBe(false);
    expect(port.queries[0]).toContain('VALUES ?loved { wd:Q1 }');
  });

  test('series hits carry their TVmaze id; no loved QIDs means no queries at all', async () => {
    const port = fakeScreenPort({
      sparql: {
        'loved-people': [{ p: wd('Q10'), n: lit(1) }],
        'loved-genres': [{ g: wd('Q20'), n: lit(1) }],
        'metadata-tv': [
          {
            f: wd('Q6001'),
            np: lit(1),
            ng: lit(1),
            nsl: lit(30),
            tvm: lit(123),
            len: lit('Show'),
            yr: lit(2019),
          },
        ],
      },
    });
    const hits = await metadataPool(
      port,
      { ...owned, loved_titles: [lovedTitle(1, 'Q1')] },
      'tv',
      OPEN_DEADLINE
    );
    expect(hits).toEqual([
      expect.objectContaining({ qid: 'Q6001', media_type: 'tv', tvmaze_id: 123 }),
    ]);

    const empty = fakeScreenPort();
    expect(
      await metadataPool(
        empty,
        { ...owned, loved_titles: [lovedTitle(1, null)] },
        'both',
        OPEN_DEADLINE
      )
    ).toEqual([]);
    expect(empty.queries).toEqual([]);
  });

  test('a spent deadline or a retryable failure yields nothing, never a throw', async () => {
    const port = fakeScreenPort({ sparql: { 'loved-people': 'retryable' } });
    expect(
      await metadataPool(
        port,
        { ...owned, loved_titles: [lovedTitle(1, 'Q1')] },
        'both',
        OPEN_DEADLINE
      )
    ).toEqual([]);
    const spent = fakeScreenPort();
    expect(
      await metadataPool(
        spent,
        { ...owned, loved_titles: [lovedTitle(1, 'Q1')] },
        'both',
        SPENT_DEADLINE
      )
    ).toEqual([]);
    expect(spent.queries).toEqual([]);
  });
});

describe('adaptationPool', () => {
  const adaptRow = (o: {
    title: string;
    an: string;
    qid: string;
    kind: 'movie' | 'tv';
    sl: number;
    via?: string;
    src?: string;
    tvm?: number;
    label?: string;
  }) => ({
    title: lit(o.title),
    an: lit(o.an),
    via: lit(o.via ?? 'work'),
    src: wd(o.src ?? 'Q7000'),
    adapt: wd(o.qid),
    kind: lit(o.kind),
    sl: lit(o.sl),
    ...(o.tvm === undefined ? {} : { tvm: lit(o.tvm) }),
    len: lit(o.label ?? o.qid),
    yr: lit(2015),
  });

  test('matches work or series, checks the author token set, requires a TVmaze id for series', async () => {
    const port = fakeScreenPort({
      sparql: {
        adaptation: [
          adaptRow({
            title: 'Leviathan Wakes',
            an: 'James S. A. Corey',
            qid: 'Q8001',
            kind: 'tv',
            sl: 60,
            via: 'series',
            src: 'Q7001',
            tvm: 1825,
            label: 'The Expanse',
          }),
          adaptRow({
            title: 'Leviathan Wakes',
            an: 'James S. A. Corey',
            qid: 'Q8002',
            kind: 'tv',
            sl: 55,
          }), // no tvm
          adaptRow({
            title: 'Leviathan Wakes',
            an: 'Somebody Else Corey',
            qid: 'Q8003',
            kind: 'movie',
            sl: 50,
          }),
          adaptRow({
            title: 'All Systems Red',
            an: 'Martha Wells',
            qid: 'Q8004',
            kind: 'tv',
            sl: 30,
            via: 'series',
            tvm: 60000,
            label: 'Murderbot',
          }),
        ],
      },
    });
    const signal = {
      ...owned,
      loved_books: [
        book(1, 'Leviathan Wakes (The Expanse, #1)', 'James S.A. Corey'),
        book(2, 'All Systems Red (The Murderbot Diaries, #1)', 'Martha Wells'),
        book(3, 'Anonymous Book', null),
      ],
    };
    const hits = await adaptationPool(port, signal, 'both', OPEN_DEADLINE);
    expect(hits.map((h) => h.qid)).toEqual(['Q8001', 'Q8004']);
    expect(hits[0]).toMatchObject({
      media_type: 'tv',
      tvmaze_id: 1825,
      label: 'The Expanse',
      pool: 'adaptation',
      seed_reason: 'adaptation:series=Q7001;book=1',
      adaptation: {
        book_id: 1,
        book_title: 'Leviathan Wakes (The Expanse, #1)',
        source_qid: 'Q7001',
        via: 'series',
      },
    });
    expect(port.queries[0]).toContain('("Leviathan Wakes"@en "corey")');
    expect(port.queries[0]).not.toContain('The Expanse, #1');
    expect(port.queries[0]).not.toContain('Anonymous Book');
  });

  test('caps three per book by sitelinks and never repeats a candidate across books', async () => {
    const rows = [1, 2, 3, 4].map((n) =>
      adaptRow({ title: 'Dune', an: 'Frank Herbert', qid: `Q90${n}`, kind: 'movie', sl: 10 * n })
    );
    rows.push(
      adaptRow({ title: 'Dune Messiah', an: 'Frank Herbert', qid: 'Q904', kind: 'movie', sl: 40 })
    );
    rows.push(
      adaptRow({ title: 'Dune Messiah', an: 'Frank Herbert', qid: 'Q905', kind: 'movie', sl: 15 })
    );
    const port = fakeScreenPort({ sparql: { adaptation: rows } });
    const hits = await adaptationPool(
      port,
      {
        ...owned,
        loved_books: [book(1, 'Dune', 'Frank Herbert'), book(2, 'Dune Messiah', 'Frank Herbert')],
      },
      'movie',
      OPEN_DEADLINE
    );
    expect(hits.map((h) => [h.qid, h.adaptation?.book_id])).toEqual([
      ['Q904', 1],
      ['Q903', 1],
      ['Q902', 1],
      ['Q905', 2],
    ]);
  });

  test('matches an additional author and honors the media filter', async () => {
    const port = fakeScreenPort({
      sparql: {
        adaptation: [
          adaptRow({
            title: 'Good Omens',
            an: 'Neil Gaiman',
            qid: 'Q9500',
            kind: 'tv',
            sl: 80,
            tvm: 5,
          }),
        ],
      },
    });
    const signal = {
      ...owned,
      loved_books: [book(1, 'Good Omens', 'Terry Pratchett', ['Neil Gaiman'])],
    };
    expect((await adaptationPool(port, signal, 'both', OPEN_DEADLINE)).map((h) => h.qid)).toEqual([
      'Q9500',
    ]);
    expect(await adaptationPool(port, signal, 'movie', OPEN_DEADLINE)).toEqual([]);
  });
});

describe('seedPool', () => {
  test('resolves films by exact label + year (best sitelinks) and shows via TVmaze + crosswalk', async () => {
    const port = fakeScreenPort({
      sparql: {
        'seed-movie': [
          { name: lit('Moon'), y: lit(2009), q: wd('Q11001'), sl: lit(12), len: lit('Moon') },
          { name: lit('Moon'), y: lit(2009), q: wd('Q11002'), sl: lit(70), len: lit('Moon') },
        ],
        'tv-crosswalk': [{ s: wd('Q12001'), tvm: lit(1825), sl: lit(60), len: lit('The Expanse') }],
      },
      tvmaze: {
        'The Expanse': { id: 1825, name: 'The Expanse', premiered: '2015-12-14' },
        'Old Show': { id: 77, name: 'Old Show', premiered: '1990-01-01' },
        'Not Crosswalked': { id: 999, name: 'Not Crosswalked', premiered: '2020-01-01' },
      },
    });
    const hits = await seedPool(
      port,
      [
        { title: 'Moon', media_type: 'movie', year: 2009, reason: 'quiet isolation sci-fi' },
        { title: 'The Expanse', media_type: 'tv', year: 2015, reason: 'loved the books' },
        { title: 'Old Show', media_type: 'tv', year: 2021, reason: 'wrong year' },
        { title: 'Not Crosswalked', media_type: 'tv', year: 2020, reason: 'no P8600' },
      ],
      OPEN_DEADLINE
    );
    expect(hits.map((h) => [h.qid, h.media_type, h.tvmaze_id])).toEqual([
      ['Q11002', 'movie', null],
      ['Q12001', 'tv', 1825],
    ]);
    expect(hits[0].seed_reason).toBe('seed:quiet isolation sci-fi');
    expect(port.tvmazeCalls).toEqual(['The Expanse', 'Old Show', 'Not Crosswalked']);
  });

  test('a spent deadline makes no calls', async () => {
    const port = fakeScreenPort();
    expect(
      await seedPool(
        port,
        [{ title: 'X', media_type: 'tv', year: 2020, reason: '' }],
        SPENT_DEADLINE
      )
    ).toEqual([]);
    expect(port.tvmazeCalls).toEqual([]);
  });
});
