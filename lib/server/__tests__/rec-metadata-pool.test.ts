import { describe, test, expect, vi, beforeEach } from 'vitest';

// Every catalog call is recorded in order, so a test can assert the exact request
// sequence — the property the merge-and-truncate budget is really about.
const calls: string[] = [];

vi.mock('../catalog', () => ({
  openlibrarySubject: async (_db: unknown, s: string) => {
    calls.push(`ol_subject:${s}`);
    return [];
  },
  googleBooksSubject: async (_db: unknown, s: string) => {
    calls.push(`gb_subject:${s}`);
    return [{ title: `S ${s}`, author: 'A B', subjects: [], raw: {} }];
  },
  googleBooksAuthor: async (_db: unknown, a: string) => {
    calls.push(`gb_author:${a}`);
    return [{ title: `A ${a}`, author: a, subjects: [], raw: {} }];
  },
  googleBooksQuery: async () => [],
  openlibraryQuery: async () => [],
  openlibraryWorkDescription: async () => null,
}));

const { metadataPool } = await import('../recAssemble');

const db = {} as never;
const sig = (subjects: string[], authors: string[]) => ({
  top_subjects: subjects,
  top_authors: authors,
});

beforeEach(() => {
  calls.length = 0;
});

describe('metadataPool without preferences', () => {
  test('reproduces today’s call sequence and reason tags exactly', async () => {
    const out = await metadataPool(db, sig(['a', 'b'], ['X Y']), 8, false);
    expect(calls).toEqual([
      'ol_subject:a',
      'gb_subject:a',
      'ol_subject:b',
      'gb_subject:b',
      'gb_author:X Y',
    ]);
    expect(out.map(([, reason]) => reason)).toEqual(['subject:a', 'subject:b', 'author:X Y']);
  });

  test('cold start still skips inferred authors', async () => {
    await metadataPool(db, sig(['a'], ['X Y']), 8, true);
    expect(calls).toEqual(['ol_subject:a', 'gb_subject:a']);
  });

  test('duplicate and case-variant inferred subjects are still queried separately', async () => {
    // /similar feeds metadataPool raw enrichment.subjects (recSignal.ts:363), which
    // today are neither deduplicated nor case-folded. Collapsing them would change
    // that route's recorded catalog call sequence.
    await metadataPool(db, sig(['Space Opera', 'space opera', 'Space Opera'], []), 8, false);
    expect(calls).toEqual([
      'ol_subject:Space Opera',
      'gb_subject:Space Opera',
      'ol_subject:space opera',
      'gb_subject:space opera',
      'ol_subject:Space Opera',
      'gb_subject:Space Opera',
    ]);
  });
});

describe('metadataPool with preferences', () => {
  test('queries preferred subjects first and tags their provenance', async () => {
    const out = await metadataPool(db, sig(['inferred'], []), 8, false, {
      prefer_subjects: ['space opera'],
      prefer_authors: [],
    });
    expect(calls).toEqual([
      'ol_subject:space opera',
      'gb_subject:space opera',
      'ol_subject:inferred',
      'gb_subject:inferred',
    ]);
    expect(out.map(([, r]) => r)).toEqual(['preferred_subject:space opera', 'subject:inferred']);
  });

  test('queries preferred authors in COLD START, while inferred authors stay skipped', async () => {
    const out = await metadataPool(db, sig([], ['Inferred Author']), 8, true, {
      prefer_subjects: [],
      prefer_authors: ['Gene Wolfe'],
    });
    expect(calls).toEqual(['gb_author:Gene Wolfe']);
    expect(out.map(([, r]) => r)).toEqual(['preferred_author:Gene Wolfe']);
  });

  test('reserves two inferred slots in each list', async () => {
    // 10 favorites, but only TOP_SUBJECTS - 2 = 6 may generate subject queries and
    // only TOP_AUTHORS - 2 = 4 may generate author queries.
    const many = (p: string) => Array.from({ length: 10 }, (_, i) => `${p}${i}`);
    await metadataPool(db, sig(['inf0', 'inf1', 'inf2'], ['ia0', 'ia1', 'ia2']), 8, false, {
      prefer_subjects: many('ps'),
      prefer_authors: many('pa'),
    });
    const subjects = calls.filter((c) => c.startsWith('gb_subject:')).map((c) => c.slice(11));
    const authors = calls.filter((c) => c.startsWith('gb_author:')).map((c) => c.slice(10));
    expect(subjects).toEqual(['ps0', 'ps1', 'ps2', 'ps3', 'ps4', 'ps5', 'inf0', 'inf1']);
    expect(authors).toEqual(['pa0', 'pa1', 'pa2', 'pa3', 'ia0', 'ia1']);
  });

  test('a favorite that duplicates an inferred entry is queried once, as preferred', async () => {
    await metadataPool(db, sig(['Space Opera'], []), 8, false, {
      prefer_subjects: ['space opera'],
      prefer_authors: [],
    });
    expect(calls).toEqual(['ol_subject:space opera', 'gb_subject:space opera']);
  });
});
