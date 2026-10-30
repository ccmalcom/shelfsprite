import { describe, it, expect } from 'vitest';
import { stripIdCitations } from '../traitText';

describe('stripIdCitations', () => {
  it('drops a parenthesised list of cited book ids', () => {
    expect(
      stripIdCitations(
        'The two books with racial injustice at their core (1138, 1140) are rated 5 and 4.5.',
        [1138, 1140]
      )
    ).toBe('The two books with racial injustice at their core are rated 5 and 4.5.');
  });

  it('drops a group that labels itself as ids, known or not', () => {
    expect(stripIdCitations('Rewards slow burns (ids 3 and 9).', [])).toBe('Rewards slow burns.');
    expect(stripIdCitations('Rewards slow burns (#3; #9).', [3, 9])).toBe('Rewards slow burns.');
  });

  it('keeps a year or any group that is not all known ids', () => {
    const text = 'Loves Orwell-style dystopias (1984) and late Le Guin (1138, 2001).';
    expect(stripIdCitations(text, [1138])).toBe(text);
  });

  it('returns untouched text unchanged', () => {
    expect(stripIdCitations('Rewards  odd spacing , kept as is.', [1])).toBe(
      'Rewards  odd spacing , kept as is.'
    );
  });
});
