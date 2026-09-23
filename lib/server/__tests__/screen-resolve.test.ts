import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db';
import {
  FULL_ENTITY_PROPS,
  WDQS_ENDPOINT,
  _setScreenCatalogHooksForTests,
  screenUrls,
  type Deadline,
  type WikidataEntity,
} from '../screenCatalog';
import {
  crosswalkQuery,
  resolveMovies,
  resolveTv,
  searchMovies,
  searchShows,
  stageANames,
  stageAQuery,
} from '../screenEnrichment';
import { installHttpReplay, type ReplayEntry } from './helpers/httpReplay';
import { replayKey } from './helpers/replayKey';
import { makeTestDb } from './helpers/pglite';

let db: Db;
let close: () => Promise<void>;
let restore: (() => void) | null = null;
let called: string[];
const plenty: Deadline = { remainingMs: () => 600_000 };

function replay(fixtures: Record<string, ReplayEntry>): void {
  restore = installHttpReplay(fixtures, (key) => called.push(key));
}

const sparqlKey = (query: string) =>
  replayKey(WDQS_ENDPOINT, { method: 'POST', body: screenUrls.sparqlBody(query) });

const stageAFixture = (
  titles: string[],
  hits: Array<[string, string]>
): Record<string, ReplayEntry> => ({
  [sparqlKey(stageAQuery(stageANames(titles)))]: {
    status: 200,
    body: {
      results: {
        bindings: hits.map(([qid, name]) => ({
          q: { type: 'uri', value: `http://www.wikidata.org/entity/${qid}` },
          name: { type: 'literal', value: name, 'xml:lang': 'en' },
        })),
      },
    },
  },
});

function film(
  id: string,
  label: string,
  year: number,
  extra: Partial<WikidataEntity> = {}
): WikidataEntity {
  return {
    id,
    labels: { en: { value: label } },
    claims: {
      P31: [{ mainsnak: { datavalue: { value: { id: 'Q11424' } } } }],
      P577: [{ mainsnak: { datavalue: { value: { time: `+${year}-01-01T00:00:00Z` } } } }],
    },
    sitelinks: {},
    ...extra,
  };
}

const entitiesFixture = (entities: WikidataEntity[]): Record<string, ReplayEntry> => ({
  [screenUrls.wikidataEntities(
    entities.map((e) => e.id),
    FULL_ENTITY_PROPS
  )]: { status: 200, body: { entities: Object.fromEntries(entities.map((e) => [e.id, e])) } },
});

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

describe('resolveMovies', () => {
  it('resolves through Stage A without calling search', async () => {
    replay({
      ...stageAFixture(['Her'], [['Q1', 'Her']]),
      ...entitiesFixture([film('Q1', 'Her', 2013)]),
    });
    const out = await resolveMovies(db, [{ id: 7, title: 'Her', year: 2013 }], plenty);
    expect(out.get(7)).toMatchObject({
      kind: 'resolved',
      label: 'HIGH',
      method: 'wikidata:exact',
      candidate: { wikidata_qid: 'Q1', media_type: 'movie', year: 2013 },
      raw: { stage: 'A' },
    });
    expect(called.some((key) => key.includes('wbsearchentities'))).toBe(false);
  });

  it('falls back to search when Stage A has no item in the exact year', async () => {
    replay({
      ...stageAFixture(['Suspiria'], [['Q2', 'Suspiria']]),
      ...entitiesFixture([film('Q2', 'Suspiria', 1977)]),
      [screenUrls.wikidataSearch('Suspiria', 10)]: {
        status: 200,
        body: { search: [{ id: 'Q3' }] },
      },
      ...entitiesFixture([film('Q3', 'Suspiria', 2018)]),
    });
    const out = await resolveMovies(db, [{ id: 8, title: 'Suspiria', year: 2018 }], plenty);
    expect(out.get(8)).toMatchObject({
      kind: 'resolved',
      label: 'HIGH',
      candidate: { wikidata_qid: 'Q3' },
      raw: { stage: 'B' },
    });
  });

  it('defers every title, and resolves none, when Stage A fails', async () => {
    replay({ [sparqlKey(stageAQuery(stageANames(['Her', 'Heat'])))]: { status: 503 } });
    const out = await resolveMovies(
      db,
      [
        { id: 1, title: 'Her', year: 2013 },
        { id: 2, title: 'Heat', year: 1995 },
      ],
      plenty
    );
    expect([...out.values()].map((r) => r.kind)).toEqual(['deferred', 'deferred']);
  });

  it('marks a definite no-match unresolved', async () => {
    replay({
      ...stageAFixture(['Qwxzv Untitled'], []),
      [screenUrls.wikidataSearch('Qwxzv Untitled', 10)]: { status: 200, body: { search: [] } },
    });
    const out = await resolveMovies(db, [{ id: 3, title: 'Qwxzv Untitled', year: 2031 }], plenty);
    expect(out.get(3)?.kind).toBe('unresolved');
  });

  it('marks an empty-normalized title unresolved without any request', async () => {
    replay({});
    const out = await resolveMovies(db, [{ id: 4, title: '!!!', year: 2001 }], plenty);
    expect(out.get(4)?.kind).toBe('unresolved');
    expect(called).toEqual([]);
  });

  it('defers only the title whose search failed', async () => {
    replay({
      ...stageAFixture(['Her', 'Zzz'], [['Q1', 'Her']]),
      ...entitiesFixture([film('Q1', 'Her', 2013)]),
      [screenUrls.wikidataSearch('Zzz', 10)]: { status: 503 },
    });
    const out = await resolveMovies(
      db,
      [
        { id: 1, title: 'Her', year: 2013 },
        { id: 2, title: 'Zzz', year: 2020 },
      ],
      plenty
    );
    expect(out.get(1)?.kind).toBe('resolved');
    expect(out.get(2)?.kind).toBe('deferred');
  });
});

describe('resolveTv', () => {
  const SEVERANCE = {
    id: 44933,
    name: 'Severance',
    url: 'https://www.tvmaze.com/shows/44933/severance',
    premiered: '2022-02-18',
    summary: '<p>Office workers.</p>',
    genres: ['Drama'],
    language: 'English',
    image: null,
  };

  it('refreshes a show from TVmaze and adds crosswalked Wikidata metadata', async () => {
    const wd: WikidataEntity = {
      id: 'Q97',
      labels: { en: { value: 'Severance' } },
      claims: {
        P31: [{ mainsnak: { datavalue: { value: { id: 'Q5398426' } } } }],
        P8600: [{ mainsnak: { datavalue: { value: '44933' } } }],
      },
      sitelinks: {},
    };
    replay({
      [screenUrls.tvmazeShow(44933)]: { status: 200, body: SEVERANCE },
      [sparqlKey(crosswalkQuery([44933]))]: {
        status: 200,
        body: {
          results: {
            bindings: [
              {
                s: { type: 'uri', value: 'http://www.wikidata.org/entity/Q97' },
                tvm: { type: 'literal', value: '44933' },
              },
            ],
          },
        },
      },
      ...entitiesFixture([wd]),
    });
    const out = await resolveTv(db, [{ id: 5, tvmazeId: 44933 }], plenty);
    expect(out.get(5)).toMatchObject({
      kind: 'refreshed',
      candidate: {
        media_type: 'tv',
        tvmaze_id: 44933,
        wikidata_qid: 'Q97',
        description: 'Office workers.',
      },
    });
  });

  it('keeps stored metadata (refreshed null) when TVmaze no longer has the show', async () => {
    replay({ [screenUrls.tvmazeShow(1)]: { status: 404 } });
    const out = await resolveTv(db, [{ id: 6, tvmazeId: 1 }], plenty);
    expect(out.get(6)).toEqual({ kind: 'refreshed', candidate: null });
  });

  it('defers a show when TVmaze fails', async () => {
    replay({ [screenUrls.tvmazeShow(2)]: { status: 503 } });
    const out = await resolveTv(db, [{ id: 7, tvmazeId: 2 }], plenty);
    expect(out.get(7)?.kind).toBe('deferred');
  });
});

describe('search', () => {
  it('ranks an exact title in the queried year first, then exact titles, then the rest', async () => {
    replay({
      ...stageAFixture(
        ['Nosferatu'],
        [
          ['Q10', 'Nosferatu'],
          ['Q11', 'Nosferatu'],
        ]
      ),
      [screenUrls.wikidataSearch('Nosferatu', 10)]: {
        status: 200,
        body: { search: [{ id: 'Q10' }, { id: 'Q12' }] },
      },
      ...entitiesFixture([
        film('Q10', 'Nosferatu', 1922),
        film('Q11', 'Nosferatu', 2024),
        film('Q12', 'Nosferatu the Vampyre', 1979),
      ]),
    });
    const out = await searchMovies(db, 'Nosferatu 2024', plenty);
    expect(out.kind === 'ok' && out.value.map((c) => c.wikidata_qid)).toEqual([
      'Q11',
      'Q10',
      'Q12',
    ]);
  });

  it('returns TVmaze shows, crosswalked where Wikidata knows them', async () => {
    replay({
      [screenUrls.tvmazeSearch('severance')]: {
        status: 200,
        body: [
          { score: 1, show: { id: 44933, name: 'Severance', premiered: '2022-02-18' } },
          { score: 0.5, show: { id: 5, name: 'Severance (UK)', premiered: '2006-01-01' } },
        ],
      },
      [sparqlKey(crosswalkQuery([44933, 5]))]: {
        status: 200,
        body: {
          results: {
            bindings: [
              {
                s: { type: 'uri', value: 'http://www.wikidata.org/entity/Q97' },
                tvm: { type: 'literal', value: '44933' },
              },
            ],
          },
        },
      },
      ...entitiesFixture([
        {
          id: 'Q97',
          labels: { en: { value: 'Severance' } },
          claims: { P31: [{ mainsnak: { datavalue: { value: { id: 'Q5398426' } } } }] },
          sitelinks: {},
        },
      ]),
    });
    const out = await searchShows(db, 'severance', plenty);
    expect(
      out.kind === 'ok' && out.value.map((c) => [c.tvmaze_id, c.wikidata_qid, c.media_type])
    ).toEqual([
      [44933, 'Q97', 'tv'],
      [5, null, 'tv'],
    ]);
  });
});
