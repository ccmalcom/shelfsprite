import { describe, expect, it } from 'vitest';
import {
  FILM_CLASSES,
  TV_PROGRAM_CLASSES,
  TV_SERIES_CLASSES,
  classifyP31,
  isTvSeries,
} from './screenClasses';

describe('screen class sets', () => {
  it('contains each root class (P279* includes the zero-length path)', () => {
    expect(FILM_CLASSES.has('Q11424')).toBe(true);
    expect(TV_PROGRAM_CLASSES.has('Q15416')).toBe(true);
    expect(TV_SERIES_CLASSES.has('Q5398426')).toBe(true);
  });

  it('is large enough to be a real walk, not a failed query', () => {
    expect(FILM_CLASSES.size).toBeGreaterThan(300);
    expect(TV_PROGRAM_CLASSES.size).toBeGreaterThan(200);
    expect(TV_SERIES_CLASSES.size).toBeGreaterThan(80);
  });

  it('nests TV series inside TV programs', () => {
    expect([...TV_SERIES_CLASSES].every((c) => TV_PROGRAM_CLASSES.has(c))).toBe(true);
  });
});

describe('classifyP31', () => {
  it('classifies films, TV programs and everything else', () => {
    expect(classifyP31(['Q11424'])).toBe('film');
    expect(classifyP31(['Q5398426'])).toBe('tv');
    expect(classifyP31(['Q5'])).toBeNull();
    expect(classifyP31([])).toBeNull();
  });

  it('prefers film when an item is both', () => {
    expect(classifyP31(['Q5398426', 'Q11424'])).toBe('film');
  });
});

describe('isTvSeries', () => {
  it('is true only for TV series classes', () => {
    expect(isTvSeries(['Q5398426'])).toBe(true);
    expect(isTvSeries(['Q11424'])).toBe(false);
    expect(isTvSeries(['Q15416'])).toBe(false); // a TV program root is not a series
  });
});
