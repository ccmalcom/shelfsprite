import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db';
import {
  FULL_ENTITY_PROPS,
  WDQS_ENDPOINT,
  _setScreenCatalogHooksForTests,
  claimIds,
  claimStrings,
  claimYears,
  enwikiTitle,
  entityLabel,
  entityNames,
  screenUrls,
  sitelinkCount,
  sparqlString,
  tvmazeSearch,
  tvmazeSingleSearch,
  wikidataEntities,
  wikidataSearch,
  wikidataSparql,
  wikipediaSummary,
  type Deadline,
  type WikidataEntity,
} from '../screenCatalog';
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

const film = (id: string, extra: Partial<WikidataEntity> = {}): WikidataEntity => ({
  id,
  labels: { en: { value: `Film ${id}` } },
  claims: { P31: [{ mainsnak: { datavalue: { value: { id: 'Q11424' } } } }] },
  sitelinks: { enwiki: { title: `Film ${id}` } },
  ...extra,
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

describe('URL builders', () => {
  it('builds wbgetentities with en|mul labels and pipe-separated ids', () => {
    expect(screenUrls.wikidataEntities(['Q1', 'Q2'], FULL_ENTITY_PROPS)).toBe(
      'https://www.wikidata.org/w/api.php?action=wbgetentities&ids=Q1%7CQ2' +
        '&props=labels%7Caliases%7Cclaims%7Csitelinks&languages=en%7Cmul&format=json'
    );
  });

  it('encodes a Wikipedia page title with underscores and a percent-encoded slash', () => {
    expect(screenUrls.wikipediaSummary('AC/DC (film)')).toBe(
      'https://en.wikipedia.org/api/rest_v1/page/summary/AC%2FDC_(film)'
    );
  });
});

describe('wikidataEntities', () => {
  it('sorts, de-duplicates, fetches 50 ids per call, and omits missing entities', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `Q${i + 1}`);
    const first = ids.slice(0, 50);
    const entities = Object.fromEntries(first.map((id) => [id, film(id)]));
    entities.Q3 = { id: 'Q3', missing: '' } as unknown as WikidataEntity;
    replay({
      [screenUrls.wikidataEntities(first, FULL_ENTITY_PROPS)]: { status: 200, body: { entities } },
      [screenUrls.wikidataEntities(['Q51'], FULL_ENTITY_PROPS)]: {
        status: 200,
        body: { entities: { Q51: film('Q51') } },
      },
    });
    const out = await wikidataEntities(
      db,
      [...ids].reverse().concat(['Q1']),
      FULL_ENTITY_PROPS,
      plenty
    );
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.value.size).toBe(50); // 51 ids, Q3 missing
    expect(out.value.has('Q3')).toBe(false);
    expect(called).toHaveLength(2);
  });

  it('is retryable when any batch fails', async () => {
    replay({ [screenUrls.wikidataEntities(['Q1'], FULL_ENTITY_PROPS)]: { status: 503 } });
    const out = await wikidataEntities(db, ['Q1'], FULL_ENTITY_PROPS, plenty);
    expect(out).toEqual({ kind: 'retryable', reason: 'HTTP 503' });
  });

  it('answers ok with an empty map for no ids, without a request', async () => {
    replay({});
    expect(await wikidataEntities(db, [], FULL_ENTITY_PROPS, plenty)).toEqual({
      kind: 'ok',
      value: new Map(),
    });
  });
});

describe('wikidataSearch', () => {
  it('returns only well-formed QIDs, in rank order', async () => {
    replay({
      [screenUrls.wikidataSearch('Her', 10)]: {
        status: 200,
        body: { search: [{ id: 'Q9' }, { id: 'L1' }, { id: 'Q2' }] },
      },
    });
    expect(await wikidataSearch(db, 'Her', 10, plenty)).toEqual({
      kind: 'ok',
      value: ['Q9', 'Q2'],
    });
  });
});

describe('wikidataSparql', () => {
  it('POSTs the query as a form body and returns the bindings', async () => {
    const query = 'SELECT ?q WHERE { }';
    replay({
      [replayKey(WDQS_ENDPOINT, { method: 'POST', body: screenUrls.sparqlBody(query) })]: {
        status: 200,
        body: {
          results: {
            bindings: [{ q: { type: 'uri', value: 'http://www.wikidata.org/entity/Q1' } }],
          },
        },
      },
    });
    const out = await wikidataSparql(db, query, plenty);
    expect(out).toEqual({
      kind: 'ok',
      value: [{ q: { type: 'uri', value: 'http://www.wikidata.org/entity/Q1' } }],
    });
  });

  it('escapes quotes, backslashes and newlines in a string literal', () => {
    expect(sparqlString('Say "hi"\\now\nplease')).toBe('"Say \\"hi\\"\\\\now\\nplease"');
  });
});

describe('Wikipedia and TVmaze', () => {
  it('answers empty for a missing Wikipedia page', async () => {
    replay({ [screenUrls.wikipediaSummary('Nope')]: { status: 404 } });
    expect(await wikipediaSummary(db, 'Nope', plenty)).toEqual({ kind: 'empty' });
  });

  it('answers empty when TVmaze singlesearch finds nothing', async () => {
    replay({ [screenUrls.tvmazeSingleSearch('zzqx')]: { status: 404 } });
    expect(await tvmazeSingleSearch(db, 'zzqx', plenty)).toEqual({ kind: 'empty' });
  });

  it('unwraps TVmaze search hits and drops malformed ones', async () => {
    replay({
      [screenUrls.tvmazeSearch('severance')]: {
        status: 200,
        body: [
          { score: 0.9, show: { id: 44933, name: 'Severance' } },
          { score: 0.1, show: {} },
        ],
      },
    });
    expect(await tvmazeSearch(db, 'severance', plenty)).toEqual({
      kind: 'ok',
      value: [{ id: 44933, name: 'Severance' }],
    });
  });
});

describe('entity helpers', () => {
  const e: WikidataEntity = {
    id: 'Q134773',
    labels: { mul: { value: 'Forrest Gump' } },
    aliases: { en: [{ value: 'Gump' }], mul: [{ value: 'Forrest Gump (film)' }] },
    claims: {
      P31: [
        { mainsnak: { datavalue: { value: { id: 'Q11424' } } } },
        { mainsnak: {} }, // a novalue snak has no datavalue
      ],
      P577: [
        { mainsnak: { datavalue: { value: { time: '+1994-07-06T00:00:00Z' } } } },
        { mainsnak: { datavalue: { value: { time: '+1994-10-07T00:00:00Z' } } } },
        { mainsnak: { datavalue: { value: { time: '+1995-02-03T00:00:00Z' } } } },
      ],
      P8600: [{ mainsnak: { datavalue: { value: '123' } } }],
    },
    sitelinks: { enwiki: { title: 'Forrest Gump' }, frwiki: { title: 'Forrest Gump' } },
  };

  it('reads the mul label when there is no en label', () => {
    expect(entityLabel(e)).toBe('Forrest Gump');
  });

  it('returns en and mul labels and aliases as scoring names', () => {
    expect(entityNames(e)).toEqual(['Forrest Gump', 'Gump', 'Forrest Gump (film)']);
  });

  it('reads item ids, strings, distinct sorted years, sitelinks and the enwiki title', () => {
    expect(claimIds(e, 'P31')).toEqual(['Q11424']);
    expect(claimStrings(e, 'P8600')).toEqual(['123']);
    expect(claimYears(e)).toEqual([1994, 1995]);
    expect(claimYears(e, 'P580')).toEqual([]);
    expect(sitelinkCount(e)).toBe(2);
    expect(enwikiTitle(e)).toBe('Forrest Gump');
  });
});
