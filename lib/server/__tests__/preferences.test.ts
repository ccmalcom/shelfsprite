import { describe, test, expect } from 'vitest';
import { readPreferences, preferredAuthorSurnames } from '../preferences';

describe('readPreferences', () => {
  test('returns empty lists for a blob with no favorites', () => {
    expect(readPreferences({ exclude_authors: ['john ringo'] })).toEqual({
      prefer_subjects: [],
      prefer_authors: [],
    });
    expect(readPreferences(null)).toEqual({ prefer_subjects: [], prefer_authors: [] });
  });

  test('reads both families and drops blanks', () => {
    expect(
      readPreferences({
        prefer_authors: ['Gene Wolfe', '  ', ' Ursula K. Le Guin '],
        prefer_subjects: ['space opera'],
      })
    ).toEqual({
      prefer_authors: ['Gene Wolfe', 'Ursula K. Le Guin'],
      prefer_subjects: ['space opera'],
    });
  });

  test('ignores a non-array value', () => {
    expect(readPreferences({ prefer_authors: 'Gene Wolfe' })).toEqual({
      prefer_subjects: [],
      prefer_authors: [],
    });
  });
});

describe('preferredAuthorSurnames', () => {
  test('keys on surname(), lowercased, matching libraryAuthors', () => {
    expect(preferredAuthorSurnames(['Ursula K. Le Guin', 'Gene Wolfe'])).toEqual(
      new Set(['guin', 'wolfe'])
    );
  });

  test('skips names that reduce to nothing', () => {
    expect(preferredAuthorSurnames(['...', ''])).toEqual(new Set());
  });
});
