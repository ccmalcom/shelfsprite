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

  // The conflict rule is applyDirectiveConstraints' rule, not a string compare:
  // exclude_authors holds SURNAMES and exclude_subjects match a whole word INSIDE a
  // subject. A favorite that survives cleaning must be one the recommender would
  // actually keep, or it drives retrieval and is then deleted from the candidate pool.
  it('drops a preference the exclusions would filter out downstream', () => {
    expect(
      cleanDirectiveConstraints({
        exclude_authors: ['Sanderson'],
        prefer_authors: ['Brandon Sanderson', 'Gene Wolfe'],
        exclude_subjects: ['GRIMDARK'],
        prefer_subjects: ['grimdark fantasy', 'space opera'],
      })
    ).toEqual({
      exclude_authors: ['sanderson'],
      exclude_subjects: ['grimdark'],
      prefer_authors: ['Gene Wolfe'],
      prefer_subjects: ['space opera'],
    });
  });

  // The narrower half of the same rule: whole-word, so an exclusion must not swallow a
  // subject that merely contains it as a substring.
  it('keeps a preference whose exclusion overlap is only a substring', () => {
    const out = cleanDirectiveConstraints({
      exclude_subjects: ['war'],
      prefer_subjects: ['warmth'],
    });
    expect(out.prefer_subjects).toEqual(['warmth']);
  });

  // Inherited quirk, pinned: applyDirectiveConstraints tests a candidate's surname, so
  // an exclusion stored as a full name matches nothing and filters nothing. Dropping the
  // favorite for it would cost the reader a slot over an exclusion that never fires.
  it('keeps a preference when the exclusion is a full name, which filters nothing', () => {
    const out = cleanDirectiveConstraints({
      exclude_authors: ['Brandon Sanderson'],
      prefer_authors: ['Brandon Sanderson'],
    });
    expect(out.prefer_authors).toEqual(['Brandon Sanderson']);
  });

  it('ignores non-array values', () => {
    expect(cleanDirectiveConstraints({ prefer_authors: 'Gene Wolfe', prefer_subjects: 7 })).toEqual(
      {}
    );
  });
});
