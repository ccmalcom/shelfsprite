import { makeTitle } from './fixtures/screenFixtures';
import {
  errorMessage,
  needsCorrection,
  sortTitles,
  titleEvidenceMap,
  titleLabel,
  traitsWarning,
} from '@/lib/screen';
import { ApiRequestError } from '@/lib/api';

const a = makeTitle({
  id: 1,
  title: 'Alien',
  year: 1979,
  rating: 3,
  last_watched_on: '2026-01-05',
});
const b = makeTitle({
  id: 2,
  title: 'blade Runner',
  year: 1982,
  rating: 5,
  last_watched_on: null,
  created_at: '2026-03-01T09:00:00',
});
const c = makeTitle({
  id: 3,
  title: 'Casablanca',
  year: null,
  rating: null,
  last_watched_on: '2026-02-10',
});

const ids = (xs: { id: number }[]) => xs.map((x) => x.id);

describe('sortTitles', () => {
  it('recent: last watched, else the day it was added, newest first', () => {
    expect(ids(sortTitles([a, b, c], 'recent'))).toEqual([2, 3, 1]);
  });
  it('title: case-insensitive A to Z', () => {
    expect(ids(sortTitles([c, b, a], 'title'))).toEqual([1, 2, 3]);
  });
  it('rating: highest first, unrated last', () => {
    expect(ids(sortTitles([c, a, b], 'rating'))).toEqual([2, 1, 3]);
  });
  it('year: newest first, unknown year last', () => {
    expect(ids(sortTitles([c, a, b], 'year'))).toEqual([2, 1, 3]);
  });
  it('does not mutate its input', () => {
    const input = [c, a, b];
    sortTitles(input, 'title');
    expect(ids(input)).toEqual([3, 1, 2]);
  });
});

describe('needsCorrection', () => {
  it('is true only for a LOW match', () => {
    const low = makeTitle();
    low.enrichment!.confidence_label = 'LOW';
    expect(needsCorrection(low)).toBe(true);
    expect(needsCorrection(makeTitle())).toBe(false);
    expect(needsCorrection(makeTitle({ enrichment: null }))).toBe(false);
  });
});

describe('labels', () => {
  it('adds the year when known', () => {
    expect(titleLabel('Heat', 1995)).toBe('Heat (1995)');
    expect(titleLabel('Paprika', null)).toBe('Paprika');
  });

  it('maps titles to evidence refs by id', () => {
    const map = titleEvidenceMap([
      a,
      makeTitle({ id: 9, media_type: 'tv', title: 'Severance', year: 2022 }),
    ]);
    expect(map.get(9)).toEqual({ id: 9, title: 'Severance', year: 2022, media_type: 'tv' });
    expect(map.size).toBe(2);
  });
});

describe('traitsWarning', () => {
  it('uses the spec 5.7 wording', () => {
    expect(traitsWarning({ traits: 3, confirmed: 1 })).toBe(
      '3 traits drew on your viewing history and will be removed, including 1 you confirmed.'
    );
  });
  it('is singular for one trait and drops a zero confirmed count', () => {
    expect(traitsWarning({ traits: 1, confirmed: 0 })).toBe(
      '1 trait drew on your viewing history and will be removed.'
    );
  });
  it('says so when nothing will be removed', () => {
    expect(traitsWarning({ traits: 0, confirmed: 0 })).toBe(
      'No traits drew on your viewing history, so every trait stays.'
    );
  });
});

describe('errorMessage', () => {
  it('prefers the error message and falls back otherwise', () => {
    expect(errorMessage(new ApiRequestError(409, 'Already there.'), 'x')).toBe('Already there.');
    expect(errorMessage('nope', 'Try again.')).toBe('Try again.');
  });
});
