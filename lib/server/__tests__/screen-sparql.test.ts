import { describe, test, expect } from 'vitest';
import {
  adaptationQuery,
  isQid,
  lovedGenresQuery,
  lovedPeopleQuery,
  metadataQuery,
  POPULARITY_MIN_SITELINKS,
  qidOf,
  qidRef,
  rowInt,
  rowLabel,
  seedMovieQuery,
  sparqlString,
  tvmazeCrosswalkQuery,
} from '../screenSparql';

const FLOOR = `FILTER(?sl >= ${POPULARITY_MIN_SITELINKS})`;
const ENWIKI = 'schema:isPartOf <https://en.wikipedia.org/>';

describe('escaping', () => {
  test('escapes user text: quotes, backslashes and newlines stay inside one literal', () => {
    const nasty = 'The "Real" Story\\\n} UNION { ?x ?y ?z';
    const lit = sparqlString(nasty);
    expect(lit.startsWith('"') && lit.endsWith('"')).toBe(true);
    expect(lit).toBe('"The \\"Real\\" Story\\\\\\n} UNION { ?x ?y ?z"');
    // The only unescaped quotes are the delimiters.
    expect(lit.slice(1, -1).replace(/\\\\|\\"/g, '')).not.toContain('"');
    expect(lit).not.toContain('\n');
    const q = adaptationQuery([{ variant: nasty, surname: 'o"brien' }]);
    expect(q).toContain(`(${lit}@en "o\\"brien")`);
  });

  test('qidRef rejects anything that is not a QID', () => {
    expect(qidRef('Q42')).toBe('wd:Q42');
    expect(() => qidRef('Q42 } ?x')).toThrow();
    expect(() => qidRef('P31')).toThrow();
    expect(isQid('Q0')).toBe(false);
    expect(qidOf('http://www.wikidata.org/entity/Q171048')).toBe('Q171048');
    expect(qidOf('http://www.wikidata.org/entity/P50')).toBeNull();
    expect(qidOf(undefined)).toBeNull();
  });

  test('row readers', () => {
    expect(rowInt({ n: { value: '12' } }, 'n')).toBe(12);
    expect(rowInt({ n: { value: 'x' } }, 'n')).toBeNull();
    expect(rowLabel({ lmul: { value: 'Toy Story' } })).toBe('Toy Story');
    expect(rowLabel({ len: { value: 'A' }, lmul: { value: 'B' } })).toBe('A');
  });
});

describe('queries', () => {
  test('loved people and genres aggregate over the loved QIDs', () => {
    const p = lovedPeopleQuery(['Q1', 'Q2']);
    expect(p.startsWith('# screen:loved-people\n')).toBe(true);
    expect(p).toContain('VALUES ?loved { wd:Q1 wd:Q2 }');
    expect(p).toContain('?loved wdt:P57|wdt:P58|wdt:P170 ?p .');
    expect(p).toContain('LIMIT 150');
    const g = lovedGenresQuery(['Q1']);
    expect(g.startsWith('# screen:loved-genres\n')).toBe(true);
    expect(g).toContain('?loved wdt:P136 ?g .');
    expect(g).toContain('LIMIT 40');
  });

  test('metadata queries require a person AND a genre, the class, and the floor', () => {
    const m = metadataQuery('movie', ['Q10'], ['Q20']);
    expect(m.startsWith('# screen:metadata-movie\n')).toBe(true);
    expect(m).toContain('?f wdt:P57|wdt:P58 ?p ; wdt:P136 ?g ; wdt:P31/wdt:P279* wd:Q11424 .');
    expect(m).toContain(FLOOR);
    expect(m).toContain(ENWIKI);
    expect(m).not.toContain('P8600');
    const t = metadataQuery('tv', ['Q10'], ['Q20']);
    expect(t.startsWith('# screen:metadata-tv\n')).toBe(true);
    expect(t).toContain('wdt:P170|wdt:P58|wdt:P57 ?p');
    expect(t).toContain('wd:Q5398426');
    expect(t).toContain('?f wdt:P8600 ?tvm0 .'); // TV must cross-walk: not OPTIONAL
  });

  test('the adaptation query matches the work or its series, en/mul, with the floor', () => {
    const q = adaptationQuery([{ variant: 'Leviathan Wakes', surname: 'corey' }]);
    expect(q.startsWith('# screen:adaptation\n')).toBe(true);
    expect(q).toContain('("Leviathan Wakes"@en "corey") ("Leviathan Wakes"@mul "corey")');
    expect(q).toContain('?work wdt:P179 ?ser . ?adapt wdt:P144 ?ser .');
    expect(q).toContain('FILTER(LANG(?an) IN ("en", "mul") && CONTAINS(LCASE(?an), ?surname))');
    expect(q).toContain(FLOOR);
    expect(q).toContain(ENWIKI);
    expect(q).toContain('OPTIONAL { ?adapt wdt:P8600 ?tvm }');
  });

  test('the adaptation floor runs last, so WDQS does not time out on the series hop', () => {
    // Measured 2026-09-23: with the enwiki-article join planned early, the work-OR-series
    // UNION timed out (502/504 after ~65-80 s); with hint:runLast it answered in 0.8 s.
    const q = adaptationQuery([{ variant: 'Leviathan Wakes', surname: 'corey' }]);
    expect(q).toContain(
      '?art schema:about ?adapt ; schema:isPartOf <https://en.wikipedia.org/> . hint:Prior hint:runLast true .'
    );
    expect(metadataQuery('movie', ['Q10'], ['Q20'])).not.toContain('hint:');
  });

  test('the seed movie lookup is exact label + year over en and mul', () => {
    const q = seedMovieQuery([{ label: 'Moon', year: 2009 }]);
    expect(q.startsWith('# screen:seed-movie\n')).toBe(true);
    expect(q).toContain('("Moon"@en 2009) ("Moon"@mul 2009)');
    expect(q).toContain('FILTER(YEAR(?d) = ?y)');
    expect(q).toContain(FLOOR);
    expect(() => seedMovieQuery([{ label: 'X', year: 2009.5 }])).toThrow();
  });

  test('the TV crosswalk keys on P8600 string ids', () => {
    const q = tvmazeCrosswalkQuery([44778, 1]);
    expect(q.startsWith('# screen:tv-crosswalk\n')).toBe(true);
    expect(q).toContain('VALUES ?tvm { "44778" "1" }');
    expect(q).toContain('?s wdt:P8600 ?tvm .');
    expect(q).toContain(FLOOR);
    expect(() => tvmazeCrosswalkQuery([1.5])).toThrow();
  });
});
