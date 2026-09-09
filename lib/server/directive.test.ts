import { describe, it, expect } from 'vitest';
import { cleanDirectiveConstraints, MAX_PREFER_ENTRIES } from './directive';

describe('cleanDirectiveConstraints', () => {
  it('normalizes languages to 2-letter lowercase', () => {
    expect(cleanDirectiveConstraints({ languages: ['EN', ' fr ', ''] })).toEqual({
      languages: ['en', 'fr'],
    });
  });
  it('coerces digit strings, keeps ints, skips bools, drops unknown keys', () => {
    expect(
      cleanDirectiveConstraints({ min_year: '1990', max_year: 2020, page_max: 400, series: true })
    ).toEqual({ min_year: 1990, max_year: 2020 });
  });
  it('empty input → {}', () => {
    expect(cleanDirectiveConstraints(null)).toEqual({});
  });
});

describe('cleanDirectiveConstraints — favorites', () => {
  it('lowercases prefer_subjects and preserves prefer_authors casing', () => {
    expect(
      cleanDirectiveConstraints({
        prefer_subjects: ['Space Opera', ' Translated Fiction '],
        prefer_authors: ['Ursula K. Le Guin', '  Gene   Wolfe  '],
      })
    ).toEqual({
      prefer_subjects: ['space opera', 'translated fiction'],
      // Case preserved, internal whitespace collapsed to single spaces.
      prefer_authors: ['Ursula K. Le Guin', 'Gene Wolfe'],
    });
  });

  it('dedups case-insensitively, keeping the first occurrence casing', () => {
    expect(
      cleanDirectiveConstraints({ prefer_authors: ['Gene Wolfe', 'gene wolfe', 'GENE WOLFE'] })
    ).toEqual({ prefer_authors: ['Gene Wolfe'] });
  });

  it('caps each family at MAX_PREFER_ENTRIES', () => {
    const many = Array.from({ length: MAX_PREFER_ENTRIES + 4 }, (_, i) => `author ${i}`);
    const out = cleanDirectiveConstraints({ prefer_authors: many, prefer_subjects: many });
    expect((out.prefer_authors as string[]).length).toBe(MAX_PREFER_ENTRIES);
    expect((out.prefer_subjects as string[]).length).toBe(MAX_PREFER_ENTRIES);
    expect((out.prefer_authors as string[])[0]).toBe('author 0');
  });

  it('omits empty lists entirely', () => {
    expect(cleanDirectiveConstraints({ prefer_authors: ['  ', ''], prefer_subjects: [] })).toEqual(
      {}
    );
  });

  it('drops a preference that collides with the matching exclude list', () => {
    expect(
      cleanDirectiveConstraints({
        exclude_authors: ['Brandon Sanderson'],
        prefer_authors: ['brandon sanderson', 'Gene Wolfe'],
        exclude_subjects: ['GRIMDARK'],
        prefer_subjects: ['grimdark', 'space opera'],
      })
    ).toEqual({
      exclude_authors: ['brandon sanderson'],
      exclude_subjects: ['grimdark'],
      prefer_authors: ['Gene Wolfe'],
      prefer_subjects: ['space opera'],
    });
  });

  it('ignores non-array values', () => {
    expect(cleanDirectiveConstraints({ prefer_authors: 'Gene Wolfe', prefer_subjects: 7 })).toEqual(
      {}
    );
  });
});
