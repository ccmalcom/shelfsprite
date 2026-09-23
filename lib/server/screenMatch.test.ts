import { describe, expect, it } from 'vitest';
import { normalizeTitle } from './dedup';
import { ratio } from './similarity';
import { screenNormalize, screenRatio, screenSimilarity, titleVariants } from './screenMatch';

describe('screenNormalize', () => {
  it('lowercases, applies NFKC, and turns punctuation into single spaces', () => {
    expect(screenNormalize('Spider-Man: No Way Home')).toBe('spider man no way home');
    expect(screenNormalize('  WALL·E  ')).toBe('wall e');
    expect(screenNormalize('Ｔｏｋｙｏ')).toBe('tokyo'); // fullwidth "Tokyo"
  });

  it('keeps the full title, including subtitles and parentheticals', () => {
    expect(screenNormalize('The Human Centipede (First Sequence)')).toBe(
      'the human centipede first sequence'
    );
  });

  it('keeps non-Latin letters and combining marks', () => {
    expect(screenNormalize('東京物語')).toBe('東京物語');
    expect(screenNormalize('Amélie')).toBe('amélie');
    expect(screenNormalize('नमस्ते')).toBe('नमस्ते');
  });

  it('returns an empty string for punctuation-only and missing titles', () => {
    expect(screenNormalize('!!!')).toBe('');
    expect(screenNormalize('')).toBe('');
    expect(screenNormalize(null)).toBe('');
  });
});

describe('screenRatio and screenSimilarity', () => {
  it('never scores two empty titles as a match (unlike the raw ratio)', () => {
    expect(ratio('', '')).toBe(1);
    expect(screenRatio('', '')).toBe(0);
    expect(screenSimilarity('!!!', '???')).toBe(0);
  });

  it('keeps two different non-Latin titles apart, where the book helper collapses them', () => {
    const tokyoStory = '東京物語';
    const departures = 'おくりびと';
    expect(normalizeTitle(tokyoStory)).toBe(normalizeTitle(departures)); // both '' -- the bug
    expect(screenSimilarity(tokyoStory, departures)).toBe(0);
    expect(screenSimilarity(tokyoStory, tokyoStory)).toBe(1);
  });

  it('scores near-identical Latin titles highly', () => {
    expect(
      screenSimilarity('The Boy in the Striped Pyjamas', 'The Boy in the Striped Pajamas')
    ).toBeGreaterThanOrEqual(0.9);
  });
});

describe('titleVariants', () => {
  it('returns the spike variant set: as given, title case, capitalized, lower, upper', () => {
    expect(titleVariants("don't look up")).toEqual([
      "don't look up",
      "Don'T Look Up",
      "Don't look up",
      "DON'T LOOK UP",
    ]);
  });

  it('adds the base title and "Base: Parenthetical" for a trailing parenthetical', () => {
    const v = titleVariants('The Human Centipede (First Sequence)');
    expect(v).toContain('The Human Centipede (First Sequence)');
    expect(v).toContain('The Human Centipede');
    expect(v).toContain('The Human Centipede: First Sequence');
  });

  it('never returns an empty variant', () => {
    expect(titleVariants('(500)').every((x) => x.trim() !== '')).toBe(true);
  });
});
