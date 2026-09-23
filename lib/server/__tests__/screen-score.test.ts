import { describe, expect, it } from 'vitest';
import type { WikidataEntity } from '../screenCatalog';
import { scoreTitle } from '../screenEnrichment';

interface EntitySpec {
  id: string;
  label?: string;
  lang?: 'en' | 'mul';
  aliases?: string[];
  p31?: string;
  years?: number[];
  p580?: number[];
  sitelinks?: number;
  enwiki?: boolean;
  p8600?: string;
}

const FILM = 'Q11424';
const TV_SERIES = 'Q5398426';

function ent(spec: EntitySpec): WikidataEntity {
  const time = (y: number) => ({
    mainsnak: { datavalue: { value: { time: `+${y}-01-01T00:00:00Z` } } },
  });
  const sitelinks: Record<string, { title: string }> = {};
  if (spec.enwiki ?? true) sitelinks.enwiki = { title: spec.label ?? spec.id };
  for (let i = Object.keys(sitelinks).length; i < (spec.sitelinks ?? 1); i++) {
    sitelinks[`x${i}wiki`] = { title: 'x' };
  }
  return {
    id: spec.id,
    labels: spec.label ? { [spec.lang ?? 'en']: { value: spec.label } } : {},
    aliases: spec.aliases ? { en: spec.aliases.map((value) => ({ value })) } : {},
    claims: {
      P31: [{ mainsnak: { datavalue: { value: { id: spec.p31 ?? FILM } } } }],
      P577: (spec.years ?? []).map(time),
      P580: (spec.p580 ?? []).map(time),
      ...(spec.p8600 ? { P8600: [{ mainsnak: { datavalue: { value: spec.p8600 } } }] } : {}),
    },
    sitelinks,
  };
}

describe('scoreTitle: HIGH', () => {
  it('is HIGH for an exact title and an exact year', () => {
    const out = scoreTitle('Her', 2013, [ent({ id: 'Q1', label: 'Her', years: [2013] })]);
    expect([out.label, out.method, out.pick?.qid]).toEqual(['HIGH', 'wikidata:exact', 'Q1']);
  });

  it('matches an item that carries only a mul label', () => {
    const out = scoreTitle('Forrest Gump', 1994, [
      ent({ id: 'Q134773', label: 'Forrest Gump', lang: 'mul', years: [1994] }),
    ]);
    expect(out.label).toBe('HIGH');
  });

  it('matches an alias and accepts any of several P577 years', () => {
    const out = scoreTitle('Night Watch', 2005, [
      ent({ id: 'Q2', label: 'Nochnoy Dozor', aliases: ['Night Watch'], years: [2004, 2005] }),
    ]);
    expect(out.label).toBe('HIGH');
  });

  it('reads P580 for a TV item with no P577', () => {
    const out = scoreTitle('Tiger King', 2020, [
      ent({ id: 'Q3', label: 'Tiger King', p31: TV_SERIES, p580: [2020], p8600: '46519' }),
    ]);
    expect([out.label, out.pick?.kind, out.pick?.tvSeries, out.pick?.tvmazeId]).toEqual([
      'HIGH',
      'tv',
      true,
      46519,
    ]);
  });

  it('matches the base of a trailing parenthetical', () => {
    const out = scoreTitle('The Human Centipede (First Sequence)', 2009, [
      ent({ id: 'Q4', label: 'The Human Centipede', years: [2009] }),
    ]);
    expect(out.label).toBe('HIGH');
  });

  it('lets a film beat a TV item with the same title and year', () => {
    const out = scoreTitle('Frozen', 2010, [
      ent({ id: 'Q5', label: 'Frozen', p31: TV_SERIES, years: [2010], sitelinks: 90 }),
      ent({ id: 'Q6', label: 'Frozen', years: [2010], sitelinks: 3 }),
    ]);
    expect([out.label, out.method, out.pick?.qid]).toEqual([
      'HIGH',
      'wikidata:exact_tiebreak',
      'Q6',
    ]);
  });

  it('breaks an exact tie by the only enwiki article', () => {
    const out = scoreTitle('Titanic', 1997, [
      ent({ id: 'Q7', label: 'Titanic', years: [1997], enwiki: false, sitelinks: 5 }),
      ent({ id: 'Q8', label: 'Titanic', years: [1997], sitelinks: 2 }),
    ]);
    expect([out.label, out.method, out.pick?.qid]).toEqual([
      'HIGH',
      'wikidata:exact_tiebreak',
      'Q8',
    ]);
  });
});

describe('scoreTitle: MEDIUM', () => {
  it('breaks an exact tie by popularity at 2x as MEDIUM, never HIGH', () => {
    const out = scoreTitle('Aladdin', 1992, [
      ent({ id: 'Q9', label: 'Aladdin', years: [1992], sitelinks: 40 }),
      ent({ id: 'Q10', label: 'Aladdin', years: [1992], sitelinks: 12 }),
    ]);
    expect([out.label, out.method, out.pick?.qid]).toEqual(['MEDIUM', 'wikidata:popularity', 'Q9']);
  });

  it('is MEDIUM for a close spelling within a year', () => {
    const out = scoreTitle('The Boy in the Striped Pyjamas', 2008, [
      ent({ id: 'Q11', label: 'The Boy in the Striped Pajamas', years: [2008] }),
    ]);
    expect([out.label, out.method]).toEqual(['MEDIUM', 'wikidata:fuzzy']);
  });
});

describe('scoreTitle: never HIGH without an exact year', () => {
  it('labels an exact title one year off as MEDIUM', () => {
    const out = scoreTitle('Suspiria', 2018, [
      ent({ id: 'Q12', label: 'Suspiria', years: [2019] }),
    ]);
    expect(out.label).toBe('MEDIUM');
  });

  it('labels a title with no year LOW even on an exact title', () => {
    const out = scoreTitle('Suspiria', null, [
      ent({ id: 'Q12', label: 'Suspiria', years: [2018] }),
    ]);
    expect(out.label).toBe('LOW');
  });
});

describe('scoreTitle: LOW and UNRESOLVED', () => {
  it('keeps a popularity gap under 2x LOW', () => {
    const out = scoreTitle('Split', 2016, [
      ent({ id: 'Q13', label: 'Split', years: [2016], sitelinks: 20 }),
      ent({ id: 'Q14', label: 'Split', years: [2016], sitelinks: 12 }),
    ]);
    expect([out.label, out.method]).toEqual(['LOW', 'wikidata:ambiguous']);
  });

  it('keeps two equally close near-year matches LOW (no margin)', () => {
    const out = scoreTitle('Coco', 2017, [
      ent({ id: 'Q15', label: 'Coco', years: [2016] }),
      ent({ id: 'Q16', label: 'Coco', years: [2018] }),
    ]);
    expect(out.label).toBe('LOW');
  });

  it('never matches two different non-Latin titles (the book helper would say HIGH)', () => {
    const out = scoreTitle('東京物語', 1953, [
      ent({ id: 'Q17', label: 'おくりびと', lang: 'mul', years: [1953] }),
    ]);
    expect(out.label).not.toBe('HIGH');
    expect(out.label).not.toBe('MEDIUM');
  });

  it('matches a non-Latin title against itself', () => {
    const out = scoreTitle('東京物語', 1953, [
      ent({ id: 'Q18', label: '東京物語', lang: 'mul', years: [1953] }),
    ]);
    expect(out.label).toBe('HIGH');
  });

  it('never resolves a title that normalizes to nothing', () => {
    // 'Heat' scores 0 against '', so without the guard this would come back LOW, not UNRESOLVED.
    const out = scoreTitle('!!!', 2001, [ent({ id: 'Q19', label: 'Heat', years: [2001] })]);
    expect([out.label, out.method, out.pick]).toEqual(['UNRESOLVED', 'unresolved', null]);
  });

  it('ignores items that are neither films nor TV programs', () => {
    const out = scoreTitle('Her', 2013, [
      ent({ id: 'Q20', label: 'Her', p31: 'Q5', years: [2013] }),
    ]);
    expect(out.label).toBe('UNRESOLVED');
  });
});
