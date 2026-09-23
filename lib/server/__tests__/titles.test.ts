import { describe, expect, test } from 'vitest';
import {
  effectiveTitleRating,
  effectiveTitleReview,
  isTitleProfileEvidence,
  normalizeTitleKey,
  titleOut,
  type TitleEnrichmentRow,
  type TitleRow,
} from '../titles';

function row(overrides: Partial<TitleRow> = {}): TitleRow {
  return {
    id: 1,
    userId: 'local',
    mediaType: 'movie',
    title: 'The Lantern Keeper',
    year: 2019,
    status: 'watched',
    letterboxdRating: null,
    appRating: null,
    letterboxdReview: null,
    appReview: null,
    lastWatchedOn: null,
    letterboxdUri: null,
    wikidataQid: null,
    tvmazeId: null,
    isFavorite: false,
    excludeFromProfile: false,
    feedbackUpdatedAt: null,
    createdAt: '2026-09-22 10:00:00',
    updatedAt: null,
    ...overrides,
  };
}

describe('effective values', () => {
  test('app rating wins, else letterboxd, else null', () => {
    expect(effectiveTitleRating(row({ appRating: 3, letterboxdRating: 4.5 }))).toBe(3);
    expect(effectiveTitleRating(row({ letterboxdRating: 4.5 }))).toBe(4.5);
    expect(effectiveTitleRating(row())).toBeNull();
  });
  test('app review wins, else letterboxd review', () => {
    expect(effectiveTitleReview(row({ appReview: 'mine', letterboxdReview: 'lb' }))).toBe('mine');
    expect(effectiveTitleReview(row({ letterboxdReview: 'lb' }))).toBe('lb');
    expect(effectiveTitleReview(row())).toBeNull();
  });
});

describe('isTitleProfileEvidence (spec §3.2)', () => {
  test.each([
    ['dropped unrated', { status: 'dropped' }, true],
    ['want rated', { status: 'want', letterboxdRating: 5 }, false],
    ['watched unrated', { status: 'watched' }, false],
    ['watched rated', { status: 'watched', letterboxdRating: 4 }, true],
    ['watching rated in app', { status: 'watching', appRating: 2 }, true],
    ['excluded rated', { status: 'watched', appRating: 5, excludeFromProfile: true }, false],
    ['excluded dropped', { status: 'dropped', excludeFromProfile: true }, false],
  ])('%s', (_name, overrides, expected) => {
    expect(isTitleProfileEvidence(row(overrides as Partial<TitleRow>))).toBe(expected);
  });
});

describe('normalizeTitleKey', () => {
  test('folds case, punctuation and width, keeps the year', () => {
    expect(normalizeTitleKey('Spider-Man: No Way Home', 2021)).toBe(
      'spider man no way home\u00002021'
    );
    expect(normalizeTitleKey('ＡＢＣ', 1999)).toBe('abc\u00001999');
    expect(normalizeTitleKey('Salt & Static', null)).toBe('salt static\u0000');
  });
  test('keeps non-Latin letters and combining marks', () => {
    expect(normalizeTitleKey('夜の図書館', 2016)).toBe('夜の図書館\u00002016');
    expect(normalizeTitleKey('Amélie', 2001)).toBe('amélie\u00002001');
    expect(normalizeTitleKey('नमस्ते', 2020)).toBe('नमस्ते\u00002020');
  });
  test('an empty normalized title yields no key', () => {
    expect(normalizeTitleKey('!!!', 2020)).toBe('');
    expect(normalizeTitleKey('   ', null)).toBe('');
  });
});

describe('titleOut', () => {
  test('serializes effective values and a null enrichment', () => {
    expect(
      titleOut(
        row({ letterboxdRating: 4.5, letterboxdReview: 'lb', letterboxdUri: 'https://boxd.it/a' }),
        null
      )
    ).toEqual({
      id: 1,
      media_type: 'movie',
      title: 'The Lantern Keeper',
      year: 2019,
      status: 'watched',
      rating: 4.5,
      app_rating: null,
      letterboxd_rating: 4.5,
      review: 'lb',
      app_review: null,
      letterboxd_review: 'lb',
      last_watched_on: null,
      is_favorite: false,
      exclude_from_profile: false,
      wikidata_qid: null,
      tvmaze_id: null,
      created_at: '2026-09-22T10:00:00',
      enrichment: null,
    });
  });

  test('serializes enrichment with list defaults', () => {
    const enr = {
      id: 5,
      titleId: 1,
      confidenceLabel: 'HIGH',
      resolutionConfidence: 0.95,
      matchMethod: 'exact',
      identitySource: 'auto',
      imageUrl: 'https://upload.wikimedia.org/x.jpg',
      description: 'A keeper of lanterns.',
      descriptionSource: 'wikipedia',
      descriptionUrl: 'https://en.wikipedia.org/wiki/X',
      wikipediaPage: 'X',
      genres: ['drama film'],
      directors: null,
      creators: 'not a list',
      duplicateOfTitleId: null,
    } as unknown as TitleEnrichmentRow;
    expect(titleOut(row(), enr).enrichment).toEqual({
      confidence_label: 'HIGH',
      resolution_confidence: 0.95,
      match_method: 'exact',
      identity_source: 'auto',
      image_url: 'https://upload.wikimedia.org/x.jpg',
      description: 'A keeper of lanterns.',
      description_source: 'wikipedia',
      description_url: 'https://en.wikipedia.org/wiki/X',
      wikipedia_page: 'X',
      genres: ['drama film'],
      directors: [],
      creators: [],
      duplicate_of_title_id: null,
    });
  });
});
