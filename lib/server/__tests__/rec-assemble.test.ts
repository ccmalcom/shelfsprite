import { describe, test, expect } from 'vitest';
import {
  assemble,
  capPool,
  referenceSubjects,
  titleSeedMatch,
  TITLE_SEED_PREFIX,
  type AssembledCandidate,
  type PoolEntry,
} from '../recAssemble';
import type { Candidate } from '../catalog';
import { dedupKey } from '../recFilters';

const cand = (over: Partial<Candidate> = {}): Candidate => ({
  source: 'googlebooks',
  resolved_id: 'g1',
  title: 'A Candidate',
  author: 'Some Author',
  subjects: [],
  description: null,
  cover_url: null,
  year: 2000,
  language: null,
  raw: {},
  ...over,
});

const emptySignal = () => ({
  library_keys: new Set<string>(),
  library_isbns: new Set<string>(),
  library_series: new Map<string, Set<number>>(),
  library_titles: [] as string[],
  library_languages: new Set<string>(),
  library_authors: new Set<string>(),
});

const entry = (c: Candidate, reason = 'subject:x'): PoolEntry => [c, reason];

describe('assemble', () => {
  test('tags provenance and merges a candidate seen in both pools', () => {
    const out = assemble(
      [entry(cand({ title: 'Shared', author: 'A B', description: null }))],
      [entry(cand({ title: 'Shared', author: 'A B', description: 'filled in' }), 'query:q')],
      emptySignal(),
      60
    );
    expect(out).toHaveLength(1);
    expect(out[0].retrieval_pool).toBe('both');
    // seed_reason comes from the FIRST sighting; description backfills from the second.
    expect(out[0].seed_reason).toBe('subject:x');
    expect(out[0].description).toBe('filled in');
  });

  test('drops library books, library ISBNs, and untitled candidates', () => {
    const signal = emptySignal();
    // dedupKey() rather than a literal: the separator is a NUL, which does not
    // survive being typed into source.
    signal.library_keys.add(dedupKey('Dune', 'Frank Herbert'));
    signal.library_isbns.add('9780000000001');
    const out = assemble(
      [
        entry(cand({ title: 'Dune', author: 'Frank Herbert' })),
        entry(cand({ title: 'Kept', author: 'New Author', isbn13: '9780000000002' })),
        entry(cand({ title: 'Blocked By Isbn', author: 'X Y', isbn13: '9780000000001' })),
        entry(cand({ title: null })),
      ],
      [],
      signal,
      60
    );
    expect(out.map((c) => c.title)).toEqual(['Kept']);
  });

  test('applies the language, series, fuzzy and learner-edition filters', () => {
    const signal = emptySignal();
    signal.library_languages.add('en');
    signal.library_titles.push('The Hobbit');
    const out = assemble(
      [
        entry(cand({ title: 'French Book', author: 'A B', language: 'fr' })),
        entry(cand({ title: 'Unknown Lang', author: 'C D', language: null })),
        entry(cand({ title: 'Sequel (Unstarted, #4)', author: 'E F' })),
        entry(cand({ title: 'The Hobbit (Illustrated)', author: 'G H' })),
        entry(cand({ title: 'Reader', author: 'I J', subjects: ['Graded reader'] })),
      ],
      [],
      signal,
      60
    );
    expect(out.map((c) => c.title)).toEqual(['Unknown Lang']);
  });
});

describe('capPool', () => {
  const mk = (n: number, pool: string, withDesc = false): AssembledCandidate[] =>
    Array.from({ length: n }, (_, i) => ({
      title: `${pool}-${i}`,
      author: null,
      year: null,
      isbn13: null,
      subjects: [],
      description: withDesc ? 'd' : null,
      cover_url: null,
      catalog_source: null,
      catalog_id: null,
      language: null,
      seed_reason: 'r',
      retrieval_pool: pool,
    }));

  test('returns the input untouched when it already fits', () => {
    const all = mk(3, 'metadata');
    expect(capPool(all, 60)).toBe(all);
  });

  test('reserves 30% of the cap for seed-only candidates', () => {
    // cap 10 -> seedQuota = round(10 * 0.3) = 3. No "both" candidates.
    const out = capPool([...mk(20, 'metadata'), ...mk(20, 'claude_seed')], 10);
    expect(out).toHaveLength(10);
    expect(out.filter((c) => c.retrieval_pool === 'claude_seed')).toHaveLength(3);
    expect(out.filter((c) => c.retrieval_pool === 'metadata')).toHaveLength(7);
  });

  test('keeps every "both" candidate first', () => {
    const out = capPool([...mk(4, 'both'), ...mk(20, 'metadata'), ...mk(20, 'claude_seed')], 10);
    expect(out.slice(0, 4).every((c) => c.retrieval_pool === 'both')).toBe(true);
  });

  test('backfills with leftover seed candidates when metadata runs short', () => {
    const out = capPool([...mk(2, 'metadata'), ...mk(20, 'claude_seed')], 10);
    expect(out).toHaveLength(10);
    expect(out.filter((c) => c.retrieval_pool === 'claude_seed')).toHaveLength(8);
  });

  test('sorts description-carrying candidates first within each bucket', () => {
    const out = capPool([...mk(5, 'metadata', false), ...mk(5, 'metadata', true)], 5);
    expect(out.every((c) => c.description === 'd')).toBe(true);
  });

  test('keeps resolved cold-start title seeds with the "both" tier (QA 2026-10-30)', () => {
    // Twenty seed-query hits WITH descriptions would otherwise outrank the description-less
    // title seeds for the seed bucket's three slots.
    const titled = mk(4, 'claude_seed').map((c, i) => ({
      ...c,
      title: `titled-${i}`,
      seed_reason: `${TITLE_SEED_PREFIX}Book ${i} by A Writer`,
    }));
    const out = capPool(
      [...mk(30, 'metadata', true), ...mk(20, 'claude_seed', true), ...titled],
      10
    );
    expect(out.slice(0, 4).map((c) => c.title)).toEqual([
      'titled-0',
      'titled-1',
      'titled-2',
      'titled-3',
    ]);
  });
});

describe('assemble drops unreleased books (QA 2026-10-30)', () => {
  test('a year after this one never reaches the pool, on any path', () => {
    const next = new Date().getUTCFullYear() + 1;
    const out = assemble(
      [entry(cand({ title: 'Ninth Life of an Erstwhile Witch', author: 'R. Durst', year: next }))],
      [entry(cand({ title: 'Out Already', author: 'C D', year: 2020 }), 'query:q')],
      emptySignal(),
      60
    );
    expect(out.map((c) => c.title)).toEqual(['Out Already']);
  });
});

describe('titleSeedMatch', () => {
  const hits = [
    cand({ title: "Study Guide: Emily Wilde's Encyclopaedia of Faeries", author: 'SummaryCo' }),
    cand({
      title: "Emily Wilde's Encyclopaedia of Faeries: Book One",
      author: 'Heather Fawcett',
    }),
  ];

  test('takes the hit with the same author surname and a strongly similar title', () => {
    const seed = { title: "Emily Wilde's Encyclopaedia of Faeries", author: 'Heather Fawcett' };
    expect(titleSeedMatch(seed, hits)?.author).toBe('Heather Fawcett');
  });

  test("drops a seed whose only hits are someone else's books", () => {
    expect(
      titleSeedMatch({ title: 'Bookshops & Bonedust', author: 'Travis Baldree' }, [
        cand({ title: 'Summary of Bookshops & Bonedust', author: 'QuickReads' }),
        cand({ title: 'Bookshops & Bonedust', author: 'Imitation Press' }),
      ])
    ).toBeNull();
    expect(
      titleSeedMatch({ title: 'Nettle & Bone', author: 'T. Kingfisher' }, [
        cand({ title: 'Paladin’s Grace', author: 'T. Kingfisher' }),
      ])
    ).toBeNull();
  });

  test('without an author, takes the first strongly similar title that has one', () => {
    expect(
      titleSeedMatch({ title: 'Gilead', author: null }, [
        cand({ title: 'Gilead', author: null }),
        cand({ title: 'Gilead', author: 'Marilynne Robinson' }),
      ])?.author
    ).toBe('Marilynne Robinson');
  });
});

describe('referenceSubjects', () => {
  test('keeps genre-like subjects, fiction forms first, minus what the request excludes', () => {
    const gilead = cand({
      title: 'Gilead',
      author: 'Marilynne Robinson',
      subjects: [
        'Fiction',
        'Iowa, fiction',
        'Clergy',
        'Fathers and sons',
        'Congregationalists',
        'Religious fiction',
        'Epistolary fiction',
        'Domestic fiction',
        'Gilead',
      ],
    });
    // "not about religion" must also keep "Religious fiction" out of the searches.
    expect(referenceSubjects(gilead, ['religion'])).toEqual([
      'Epistolary fiction',
      'Domestic fiction',
      'Congregationalists',
    ]);
  });
});

describe('assemble threads preferred authors into the caps', () => {
  test('the empty-set default matches the four-argument call', () => {
    const signal = emptySignal();
    signal.library_authors.add('wolfe');
    const pool = [
      entry(cand({ title: 'One', author: 'Gene Wolfe' })),
      entry(cand({ title: 'Two', author: 'New Person' })),
    ];
    expect(assemble(pool, [], signal, 60)).toEqual(assemble(pool, [], signal, 60, new Set()));
  });

  test('a preferred library author is exempt from the library trim', () => {
    // Same fixture shape as rec-filters.test.ts, and for the same reason: the
    // preferred author must be one the CURRENT code drops, and enough non-preferred
    // library authors must survive the exemption to keep lib.length > maxLib.
    // 14 candidates → maxLib = trunc(14 * 0.4) = 5.
    const signal = emptySignal();
    for (const s of ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'wolfe']) {
      signal.library_authors.add(s);
    }
    const pool = [
      entry(cand({ title: 'L1', author: 'L1 One' })),
      entry(cand({ title: 'L2', author: 'L2 Two' })),
      entry(cand({ title: 'L3', author: 'L3 Three' })),
      entry(cand({ title: 'L4', author: 'L4 Four' })),
      entry(cand({ title: 'L5', author: 'L5 Five' })),
      entry(cand({ title: 'L6', author: 'L6 Six' })),
      entry(cand({ title: 'L7', author: 'L7 Seven' })),
      entry(cand({ title: 'P', author: 'Gene Wolfe' })),
      entry(cand({ title: 'N1', author: 'N1 A' })),
      entry(cand({ title: 'N2', author: 'N2 B' })),
      entry(cand({ title: 'N3', author: 'N3 C' })),
      entry(cand({ title: 'N4', author: 'N4 D' })),
      entry(cand({ title: 'N5', author: 'N5 E' })),
      entry(cand({ title: 'N6', author: 'N6 F' })),
    ];
    const without = assemble(pool, [], signal, 60).map((c) => c.title);
    const withPref = assemble(pool, [], signal, 60, new Set(['wolfe'])).map((c) => c.title);
    expect(without).not.toContain('P');
    expect(withPref[0]).toBe('P');
    // The trim still fired, so the exemption did not simply disable it.
    expect(withPref).not.toContain('L6');
    expect(withPref).not.toContain('L7');
  });
});
