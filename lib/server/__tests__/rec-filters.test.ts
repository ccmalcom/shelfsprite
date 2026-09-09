import { describe, test, expect } from 'vitest';
import {
  dedupKey,
  EMPTY_DEDUP_KEY,
  allowedLanguages,
  languageOk,
  seriesInfo,
  seriesOk,
  fuzzyDuplicate,
  isLearnerEdition,
  applyAuthorCaps,
  MAX_PER_AUTHOR,
  subjectHits,
  applyDirectiveConstraints,
} from '../recFilters';

describe('dedupKey', () => {
  test('is normalized title + author surname', () => {
    expect(dedupKey('Dune: Special Edition', 'Frank Herbert')).toBe(dedupKey('Dune', 'Herbert'));
    expect(dedupKey(null, null)).toBe(EMPTY_DEDUP_KEY);
  });

  test('separator cannot be forged from normalized text', () => {
    // normalizeTitle emits only [a-z0-9 ], so "a b"/"" and "a"/"b" cannot collide.
    expect(dedupKey('a b', null)).not.toBe(dedupKey('a', 'b'));
  });
});

describe('language', () => {
  test('empty library languages default to en', () => {
    expect(allowedLanguages(new Set())).toEqual(new Set(['en']));
    expect(allowedLanguages(new Set(['fr', 'en']))).toEqual(new Set(['fr', 'en']));
  });

  test('unknown language always passes; known must be allowed', () => {
    const allowed = new Set(['en']);
    expect(languageOk(null, allowed)).toBe(true);
    expect(languageOk('', allowed)).toBe(true);
    expect(languageOk('en', allowed)).toBe(true);
    expect(languageOk('fr', allowed)).toBe(false);
  });
});

describe('series', () => {
  test('parses the trailing (Series, #N) marker', () => {
    expect(seriesInfo('Mistborn (Mistborn, #6)')).toEqual(['mistborn', 6]);
    expect(seriesInfo('Words of Radiance (The Stormlight Archive, Book 2)')).toEqual([
      'the stormlight archive',
      2,
    ]);
    expect(seriesInfo('Dune (Dune Chronicles, Vol. 1)')).toEqual(['dune chronicles', 1]);
    expect(seriesInfo('Just A Title')).toBeNull();
    expect(seriesInfo(null)).toBeNull();
  });

  test('is not stateful across calls (regex must not be global)', () => {
    expect(seriesInfo('Mistborn (Mistborn, #6)')).toEqual(['mistborn', 6]);
    expect(seriesInfo('Mistborn (Mistborn, #6)')).toEqual(['mistborn', 6]);
  });

  test('blocks book N>1 of an unstarted series, allows everything else', () => {
    const owned = new Map([['mistborn', new Set([1])]]);
    expect(seriesOk('Mistborn (Mistborn, #2)', owned)).toBe(true);
    expect(seriesOk('Elantris (Elantris, #2)', owned)).toBe(false);
    expect(seriesOk('Elantris (Elantris, #1)', owned)).toBe(true); // position <= 1
    expect(seriesOk('An Unmarked Standalone', owned)).toBe(true); // no marker -> pass
  });
});

describe('fuzzyDuplicate', () => {
  test('catches near-identical normalized titles regardless of author', () => {
    expect(fuzzyDuplicate('The Hobbit (Illustrated)', ['The Hobbit'])).toBe(true);
    expect(fuzzyDuplicate('Kindred', ['The Hobbit', 'Dune'])).toBe(false);
    expect(fuzzyDuplicate(null, ['The Hobbit'])).toBe(false);
    expect(fuzzyDuplicate('Anything', [])).toBe(false);
  });
});

describe('isLearnerEdition', () => {
  test('flags graded-reader / ESL phrasing in title or subjects', () => {
    expect(isLearnerEdition({ title: 'Dune: A Graded Reader', subjects: [] })).toBe(true);
    expect(isLearnerEdition({ title: 'Dune', subjects: ['Readers for foreign speakers'] })).toBe(
      true
    );
    expect(isLearnerEdition({ title: 'Dune', subjects: ['Science Fiction'] })).toBe(false);
    expect(isLearnerEdition({ title: null, subjects: null })).toBe(false);
  });
});

describe('applyAuthorCaps', () => {
  const c = (title: string, author: string | null) => ({ title, author });

  test('caps each author at 2 and never caps authorless candidates', () => {
    const out = applyAuthorCaps(
      [c('a', 'Ursula Le Guin'), c('b', 'Ursula Le Guin'), c('c', 'Ursula Le Guin'), c('d', null)],
      new Set()
    );
    expect(out.map((x) => x.title)).toEqual(['a', 'b', 'd']);
  });

  test('trims library-author candidates past 40% and reorders new authors first', () => {
    // 5 kept -> maxLib = trunc(5 * 0.4) = 2. 3 library-author candidates -> 1 dropped.
    const out = applyAuthorCaps(
      [
        c('lib1', 'Herbert'),
        c('new1', 'Chiang'),
        c('lib2', 'Butler'),
        c('new2', 'Jemisin'),
        c('lib3', 'Herbert'),
      ],
      new Set(['herbert', 'butler'])
    );
    expect(out.map((x) => x.title)).toEqual(['new1', 'new2', 'lib1', 'lib2']);
  });

  test('maxLib floors at 1, and an empty input returns empty', () => {
    const out = applyAuthorCaps(
      [c('lib1', 'Herbert'), c('lib2', 'Butler')],
      new Set(['herbert', 'butler'])
    );
    expect(out.map((x) => x.title)).toEqual(['lib1']); // trunc(2*0.4)=0 -> max(1,0)=1
    expect(applyAuthorCaps([], new Set())).toEqual([]);
  });
});

describe('subjectHits', () => {
  test('matches whole words only, and escapes regex metacharacters', () => {
    expect(subjectHits('war', 'war fiction')).toBe(true);
    expect(subjectHits('war', 'warmth')).toBe(false);
    expect(subjectHits('war', 'steward')).toBe(false);
    expect(subjectHits('sci-fi', 'sci-fi novels')).toBe(true);
    // Escaping is what keeps this from throwing "Nothing to repeat" on the bare `++`.
    // It still does not MATCH: \b needs a word/non-word transition, and '+' followed
    // by a space is non-word on both sides. Python's re.escape + \b behaves identically
    // (verified against CPython), so returning false here is parity, not a bug.
    expect(() => subjectHits('c++', 'c++ programming')).not.toThrow();
    expect(subjectHits('c++', 'c++ programming')).toBe(false);
  });
});

describe('applyDirectiveConstraints', () => {
  const cand = (over: Record<string, unknown> = {}) => ({
    title: 't',
    author: 'Frank Herbert',
    year: 1990,
    subjects: ['Science Fiction'],
    ...over,
  });

  test('an empty constraints object is a no-op (Python: {} is falsy)', () => {
    const all = [cand()];
    expect(applyDirectiveConstraints(all, {})).toBe(all);
  });

  test('filters on year range, but only for integer years', () => {
    expect(applyDirectiveConstraints([cand({ year: 1980 })], { min_year: 1990 })).toEqual([]);
    expect(applyDirectiveConstraints([cand({ year: 2000 })], { max_year: 1990 })).toEqual([]);
    expect(applyDirectiveConstraints([cand({ year: null })], { min_year: 1990 })).toHaveLength(1);
    // Python's isinstance(year, int) is False for a float -> the candidate passes.
    expect(applyDirectiveConstraints([cand({ year: 1980.5 })], { min_year: 1990 })).toHaveLength(1);
  });

  test('drops candidates whose subjects hit an excluded term', () => {
    expect(
      applyDirectiveConstraints([cand({ subjects: ['War Fiction'] })], {
        exclude_subjects: ['war'],
      })
    ).toEqual([]);
    expect(
      applyDirectiveConstraints([cand({ subjects: ['Warmth'] })], { exclude_subjects: ['war'] })
    ).toHaveLength(1);
    expect(
      applyDirectiveConstraints([cand({ subjects: null })], { exclude_subjects: ['war'] })
    ).toHaveLength(1);
  });

  test('PYTHON QUIRK: exclude_authors compares a SURNAME against a full name', () => {
    // Python: `_surname(cand["author"]).lower() in {a.lower() for a in exclude_authors}`.
    // "herbert" is never equal to "frank herbert", so a full-name exclude silently
    // does nothing. Reproduced deliberately -- do NOT "fix" it here.
    expect(
      applyDirectiveConstraints([cand()], { exclude_authors: ['Frank Herbert'] })
    ).toHaveLength(1);
    expect(applyDirectiveConstraints([cand()], { exclude_authors: ['Herbert'] })).toEqual([]);
  });
});

describe('applyAuthorCaps with preferred authors', () => {
  const c = (author: string) => ({ author });

  test('the empty-set default is behavior-identical to the two-argument call', () => {
    const pool = [c('A One'), c('B Two'), c('A One')];
    const lib = new Set(['one']);
    expect(applyAuthorCaps(pool, lib)).toEqual(applyAuthorCaps(pool, lib, new Set()));
  });

  // FIXTURE DESIGN, do not "simplify": the preferred author must be one the CURRENT
  // code actually drops, and enough non-preferred library authors must remain after
  // the exemption that `lib.length > maxLib` still holds — otherwise applyAuthorCaps
  // returns `kept` untouched and the test proves nothing about either branch.
  //
  // 14 candidates → maxLib = trunc(14 * 0.4) = 5.
  // kept order: L1..L7 (library, not preferred), P (library, PREFERRED), N1..N6 (new).
  //   no preference: lib = [L1..L7, P] (8) > 5 → [N1..N6, L1..L5]; P is dropped.
  //   preferring P:  lib = [L1..L7]   (7) > 5 → [P, N1..N6, L1..L5]; P survives, first.
  const libAuthors = ['L1 One', 'L2 Two', 'L3 Three', 'L4 Four', 'L5 Five', 'L6 Six', 'L7 Seven'];
  const capPool14 = [
    ...libAuthors.map(c),
    c('Gene Wolfe'),
    ...['N1 A', 'N2 B', 'N3 C', 'N4 D', 'N5 E', 'N6 F'].map(c),
  ];
  // surname() lowercases via normalizeTitle and keeps the last token, so these are
  // spelled out rather than importing surname() into this file just for the fixture.
  const capLib = new Set(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'wolfe']);

  test('a preferred library author survives a trim that drops them today', () => {
    const trimmed = applyAuthorCaps(capPool14, capLib).map((x) => x.author);
    expect(trimmed).not.toContain('Gene Wolfe');

    const kept = applyAuthorCaps(capPool14, capLib, new Set(['wolfe'])).map((x) => x.author);
    expect(kept).toContain('Gene Wolfe');
  });

  test('a preferred author is not reordered down, and the reorder branch still runs', () => {
    const kept = applyAuthorCaps(capPool14, capLib, new Set(['wolfe'])).map((x) => x.author);
    // Preferred sorts into the non-library partition, which is emitted first — and it
    // was NOT first in the input, so this could only come from the partition change.
    expect(kept[0]).toBe('Gene Wolfe');
    // The trim genuinely fired: L6/L7 lost their slots to maxLib = 5.
    expect(kept).not.toContain('L6 Six');
    expect(kept).not.toContain('L7 Seven');
  });

  test('MAX_PER_AUTHOR still caps a preferred author at 2', () => {
    const pool = [c('Gene Wolfe'), c('Gene Wolfe'), c('Gene Wolfe'), c('Gene Wolfe')];
    const kept = applyAuthorCaps(pool, new Set(['wolfe']), new Set(['wolfe']));
    expect(kept).toHaveLength(MAX_PER_AUTHOR);
  });
});

describe('applyDirectiveConstraints and favorites', () => {
  // A preference must NEVER remove a candidate. This object is non-empty, so it
  // walks every candidate instead of taking the early return — correct today only
  // because no branch reads the new keys. Pinned so a future unrecognized-key guard
  // cannot silently empty the pool.
  test('a constraints object containing only prefer_* keys returns every candidate', () => {
    const pool = [
      { author: 'Gene Wolfe', year: 1980, subjects: ['space opera'] },
      { author: 'Someone Else', year: 2020, subjects: ['grimdark'] },
      { author: null, year: null, subjects: null },
    ];
    expect(
      applyDirectiveConstraints(pool, {
        prefer_authors: ['Gene Wolfe'],
        prefer_subjects: ['space opera'],
      })
    ).toEqual(pool);
  });
});
