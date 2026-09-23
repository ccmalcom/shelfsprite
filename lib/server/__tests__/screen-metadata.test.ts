import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db';
import {
  FULL_ENTITY_PROPS,
  _setScreenCatalogHooksForTests,
  screenUrls,
  type Deadline,
  type WikidataEntity,
} from '../screenCatalog';
import {
  ScreenCandidateSchema,
  fetchScreenMetadata,
  mergeTvmaze,
  stripHtml,
  type ScreenCandidate,
} from '../screenEnrichment';
import { installHttpReplay, type ReplayEntry } from './helpers/httpReplay';
import { makeTestDb } from './helpers/pglite';

let db: Db;
let close: () => Promise<void>;
let restore: (() => void) | null = null;
let called: string[];
const plenty: Deadline = { remainingMs: () => 600_000 };

type ClaimSpec = Record<string, Array<string | { id: string } | { time: string }>>;

function entity(
  id: string,
  label: string,
  claimSpec: ClaimSpec,
  sitelinks: string[] = []
): WikidataEntity {
  const claims = Object.fromEntries(
    Object.entries(claimSpec).map(([p, values]) => [
      p,
      values.map((value) => ({ mainsnak: { datavalue: { value } } })),
    ])
  );
  return {
    id,
    labels: { en: { value: label } },
    claims,
    sitelinks: Object.fromEntries(
      sitelinks.map((site) => [site, { title: site === 'enwiki' ? `${label} (film)` : label }])
    ),
  };
}

const labelOnly = (id: string, label: string): WikidataEntity => ({
  id,
  labels: { en: { value: label } },
});

function replay(fixtures: Record<string, ReplayEntry>): void {
  restore = installHttpReplay(fixtures, (key) => called.push(key));
}

beforeEach(async () => {
  ({ db, close } = await makeTestDb());
  called = [];
  _setScreenCatalogHooksForTests({ sleep: async () => undefined });
});

afterEach(async () => {
  restore?.();
  restore = null;
  _setScreenCatalogHooksForTests(null);
  await close();
});

const ARRIVAL = entity(
  'Q100',
  'Arrival',
  {
    P31: [{ id: 'Q11424' }],
    P577: [{ time: '+2016-09-01T00:00:00Z' }, { time: '+2016-11-11T00:00:00Z' }],
    P136: [{ id: 'Q200' }],
    P57: [{ id: 'Q300' }],
    P58: [{ id: 'Q301' }],
    P495: [{ id: 'Q30' }],
    P364: [{ id: 'Q1860' }],
    P144: [{ id: 'Q400' }],
    P921: [{ id: 'Q600' }],
    P272: [{ id: 'Q700' }],
  },
  ['enwiki', 'frwiki', 'dewiki']
);

function arrivalFixtures(summaryStatus = 200): Record<string, ReplayEntry> {
  return {
    [screenUrls.wikidataEntities(['Q100'], FULL_ENTITY_PROPS)]: {
      status: 200,
      body: { entities: { Q100: ARRIVAL } },
    },
    [screenUrls.wikidataEntities(['Q400', 'Q1860'], 'labels|claims')]: {
      status: 200,
      body: {
        entities: {
          Q400: entity('Q400', 'Story of Your Life', { P50: [{ id: 'Q500' }] }),
          Q1860: entity('Q1860', 'English', { P218: ['en'] }),
        },
      },
    },
    [screenUrls.wikidataEntities(
      ['Q30', 'Q200', 'Q300', 'Q301', 'Q500', 'Q600', 'Q700'],
      'labels'
    )]: {
      status: 200,
      body: {
        entities: {
          Q30: labelOnly('Q30', 'United States'),
          Q200: labelOnly('Q200', 'science fiction film'),
          Q300: labelOnly('Q300', 'Denis Villeneuve'),
          Q301: labelOnly('Q301', 'Eric Heisserer'),
          Q500: labelOnly('Q500', 'Ted Chiang'),
          Q600: labelOnly('Q600', 'first contact'),
          Q700: labelOnly('Q700', 'Lava Bear Films'),
        },
      },
    },
    [screenUrls.wikipediaSummary('Arrival (film)')]: {
      status: summaryStatus,
      body: {
        type: 'standard',
        extract: 'Arrival is a 2016 American science fiction film.',
        thumbnail: { source: 'https://upload.wikimedia.org/wikipedia/en/d/df/Arrival.jpg' },
        content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Arrival_(film)' } },
      },
    },
  };
}

describe('fetchScreenMetadata', () => {
  it('builds a full movie candidate from Wikidata and the Wikipedia summary', async () => {
    replay(arrivalFixtures());
    const out = await fetchScreenMetadata(db, ['Q100'], plenty);
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    const expected: ScreenCandidate = {
      media_type: 'movie',
      title: 'Arrival',
      year: 2016,
      wikidata_qid: 'Q100',
      tvmaze_id: null,
      image_url: 'https://upload.wikimedia.org/wikipedia/en/d/df/Arrival.jpg',
      description: 'Arrival is a 2016 American science fiction film.',
      description_source: 'wikipedia',
      description_url: 'https://en.wikipedia.org/wiki/Arrival_(film)',
      wikipedia_page: 'Arrival (film)',
      genres: ['science fiction film'],
      directors: ['Denis Villeneuve'],
      creators: [],
      writers: ['Eric Heisserer'],
      countries: ['United States'],
      original_language: 'en',
      based_on: [{ qid: 'Q400', title: 'Story of Your Life', author: 'Ted Chiang' }],
      main_subjects: ['first contact'],
      series: [],
      production_companies: [{ qid: 'Q700', label: 'Lava Bear Films' }],
      sitelinks: 3,
    };
    expect(out.value.get('Q100')).toEqual(expected);
    expect(ScreenCandidateSchema.safeParse(expected).success).toBe(true);
  });

  it('does not refetch entities the caller preloaded', async () => {
    const fixtures = arrivalFixtures();
    delete fixtures[screenUrls.wikidataEntities(['Q100'], FULL_ENTITY_PROPS)];
    replay(fixtures);
    const out = await fetchScreenMetadata(db, ['Q100'], plenty, {
      entities: new Map([['Q100', ARRIVAL]]),
    });
    expect(out.kind).toBe('ok');
  });

  it('is retryable when the Wikipedia summary fails, and builds nothing', async () => {
    replay(arrivalFixtures(503));
    const out = await fetchScreenMetadata(db, ['Q100'], plenty);
    expect(out).toEqual({ kind: 'retryable', reason: 'HTTP 503' });
  });

  it('converts a TV series with a TVmaze id and prefers the TVmaze summary and image', async () => {
    const tigerKing = entity(
      'Q800',
      'Tiger King',
      { P31: [{ id: 'Q5398426' }], P580: [{ time: '+2020-03-20T00:00:00Z' }], P8600: ['46519'] },
      ['enwiki']
    );
    replay({
      [screenUrls.wikidataEntities(['Q800'], FULL_ENTITY_PROPS)]: {
        status: 200,
        body: { entities: { Q800: tigerKing } },
      },
      [screenUrls.wikipediaSummary('Tiger King (film)')]: {
        status: 200,
        body: { type: 'standard', extract: 'Wikipedia text.' },
      },
      [screenUrls.tvmazeShow(46519)]: {
        status: 200,
        body: {
          id: 46519,
          name: 'Tiger King',
          url: 'https://www.tvmaze.com/shows/46519/tiger-king',
          premiered: '2020-03-20',
          summary: '<p><b>Tiger King</b> is a true crime docuseries &amp; more.</p>',
          genres: ['Crime'],
          language: 'English',
          image: { medium: 'https://static.tvmaze.com/uploads/images/medium_portrait/1/1.jpg' },
        },
      },
    });
    const out = await fetchScreenMetadata(db, ['Q800'], plenty);
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.value.get('Q800')).toMatchObject({
      media_type: 'tv',
      tvmaze_id: 46519,
      wikidata_qid: 'Q800',
      year: 2020,
      description: 'Tiger King is a true crime docuseries & more.',
      description_source: 'tvmaze',
      description_url: 'https://www.tvmaze.com/shows/46519/tiger-king',
      image_url: 'https://static.tvmaze.com/uploads/images/medium_portrait/1/1.jpg',
    });
  });

  it('keeps a TV special (no series class, no P8600) as a movie', async () => {
    const special = entity('Q900', 'Frosty Returns', {
      P31: [{ id: 'Q15416' }],
      P577: [{ time: '+1992-01-01T00:00:00Z' }],
    });
    replay({
      [screenUrls.wikidataEntities(['Q900'], FULL_ENTITY_PROPS)]: {
        status: 200,
        body: { entities: { Q900: special } },
      },
    });
    const out = await fetchScreenMetadata(db, ['Q900'], plenty);
    expect(out.kind === 'ok' && out.value.get('Q900')?.media_type).toBe('movie');
  });

  it('skips the TVmaze fetch when asked', async () => {
    const series = entity('Q801', 'Severance', { P31: [{ id: 'Q5398426' }], P8600: ['44933'] });
    replay({
      [screenUrls.wikidataEntities(['Q801'], FULL_ENTITY_PROPS)]: {
        status: 200,
        body: { entities: { Q801: series } },
      },
    });
    const out = await fetchScreenMetadata(db, ['Q801'], plenty, { skipTvmaze: true });
    expect(out.kind).toBe('ok');
    expect(called.some((key) => key.includes('tvmaze'))).toBe(false);
  });
});

describe('mergeTvmaze and stripHtml', () => {
  it('builds a TV candidate from TVmaze alone when there is no crosswalk', () => {
    const out = mergeTvmaze(
      {
        id: 1,
        name: 'Under the Dome',
        url: 'https://www.tvmaze.com/shows/1/under-the-dome',
        premiered: '2013-06-24',
        summary: '<p>A dome.</p>',
        genres: ['Drama', 'Science-Fiction'],
        language: 'English',
        image: null,
      },
      null
    );
    expect(out).toMatchObject({
      media_type: 'tv',
      title: 'Under the Dome',
      year: 2013,
      wikidata_qid: null,
      tvmaze_id: 1,
      genres: ['Drama', 'Science-Fiction'],
      original_language: 'en',
      description: 'A dome.',
      description_source: 'tvmaze',
      sitelinks: 0,
    });
    expect(ScreenCandidateSchema.safeParse(out).success).toBe(true);
  });

  it('strips tags and decodes common entities', () => {
    expect(stripHtml('<p>Tom &amp; Jerry&#39;s <i>big</i>&nbsp;day</p>')).toBe(
      "Tom & Jerry's big day"
    );
  });
});

describe('ScreenCandidateSchema', () => {
  it('rejects an image hosted anywhere but Wikimedia or TVmaze', () => {
    const base = mergeTvmaze({ id: 2, name: 'X', premiered: null, summary: null }, null);
    expect(
      ScreenCandidateSchema.safeParse({ ...base, image_url: 'https://evil.example/pixel.gif' })
        .success
    ).toBe(false);
    expect(
      ScreenCandidateSchema.safeParse({ ...base, image_url: 'http://upload.wikimedia.org/a.jpg' })
        .success
    ).toBe(false);
  });
});
