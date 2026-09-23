/**
 * Screen enrichment: movie resolution (spec §4.3), TV crosswalk, metadata (§4.5),
 * identity and clash rules (§4.4), and the ScreenCandidate record shared by manual
 * add, correction and recommendations.
 *
 * The resolver is a port of the 2026-09-22 spike (resolve3.py / cold.py), which
 * measured HIGH 97.3 %, MEDIUM 1.8 %, LOW 0.9 %, unresolved 0 on a real 562-film
 * export. Departures from the spike are deliberate and named where they occur:
 * film-beats-TV runs first (the spec added it), and scoring names include mul aliases.
 */
import { classifyP31, isTvSeries, type ScreenKind } from './screenClasses';
import {
  claimIds,
  claimStrings,
  claimYears,
  compareQids,
  entityNames,
  enwikiTitle,
  sitelinkCount,
  type WikidataEntity,
} from './screenCatalog';
import { screenNormalize, screenRatio, titleVariants } from './screenMatch';

// --- Scoring (spec §4.3) --------------------------------------------------------------

/** Validated by the spike on real data (§2.1 finding 2). */
export const SIMILARITY_THRESHOLD = 0.9;
export const SIMILARITY_MARGIN = 0.1;
export const POPULARITY_FACTOR = 2;

export type ScreenLabel = 'HIGH' | 'MEDIUM' | 'LOW';

export type ScreenMatchMethod =
  | 'wikidata:exact'
  | 'wikidata:exact_tiebreak'
  | 'wikidata:popularity'
  | 'wikidata:fuzzy'
  | 'wikidata:ambiguous'
  | 'unresolved'
  | 'manual'
  | 'user_correction'
  | 'refresh';

export interface ScoredCandidate {
  qid: string;
  kind: ScreenKind;
  similarity: number;
  exact: boolean;
  yearExact: boolean;
  yearNear: boolean;
  years: number[];
  enwiki: boolean;
  sitelinks: number;
  tvSeries: boolean;
  tvmazeId: number | null;
}

export interface TitleScore {
  label: ScreenLabel | 'UNRESOLVED';
  method: ScreenMatchMethod;
  pick: ScoredCandidate | null;
  top: ScoredCandidate[];
}

function firstInt(values: string[]): number | null {
  for (const value of values) {
    if (/^\d+$/.test(value)) return Number(value);
  }
  return null;
}

export function scoreCandidate(
  normalized: string,
  variants: ReadonlySet<string>,
  year: number | null,
  entity: WikidataEntity
): ScoredCandidate | null {
  const p31 = claimIds(entity, 'P31');
  const kind = classifyP31(p31);
  if (!kind) return null;
  const names = entityNames(entity).map(screenNormalize).filter(Boolean);
  if (names.length === 0) return null;
  let years = claimYears(entity, 'P577');
  if (kind === 'tv' && years.length === 0) years = claimYears(entity, 'P580');
  return {
    qid: entity.id,
    kind,
    similarity: Math.max(...names.map((name) => screenRatio(normalized, name))),
    exact: names.some((name) => variants.has(name)),
    yearExact: year !== null && years.includes(year),
    yearNear: year !== null && years.some((y) => Math.abs(y - year) <= 1),
    years,
    enwiki: enwikiTitle(entity) !== null,
    sitelinks: sitelinkCount(entity),
    tvSeries: isTvSeries(p31),
    tvmazeId: firstInt(claimStrings(entity, 'P8600')),
  };
}

const UNRESOLVED_SCORE: TitleScore = {
  label: 'UNRESOLVED',
  method: 'unresolved',
  pick: null,
  top: [],
};

export function scoreTitle(
  title: string,
  year: number | null,
  entities: readonly WikidataEntity[]
): TitleScore {
  const normalized = screenNormalize(title);
  if (!normalized) return UNRESOLVED_SCORE; // an empty normalized title never matches
  const variants = new Set(titleVariants(title).map(screenNormalize).filter(Boolean));
  const scored = [...entities]
    .sort((a, b) => compareQids(a.id, b.id))
    .map((entity) => scoreCandidate(normalized, variants, year, entity))
    .filter((c): c is ScoredCandidate => c !== null);
  if (scored.length === 0) return UNRESOLVED_SCORE;

  const near = scored
    .filter((c) => c.yearNear)
    .sort(
      (a, b) =>
        b.similarity - a.similarity || b.sitelinks - a.sitelinks || compareQids(a.qid, b.qid)
    );
  const top = near.slice(0, 3);

  let exact = scored.filter((c) => c.exact && c.yearExact);
  let tiebreak: 'film' | 'enwiki' | 'popularity' | null = null;
  if (exact.length > 1) {
    // Letterboxd is a film log: a film beats a TV item with the same title and year.
    const films = exact.filter((c) => c.kind === 'film');
    if (films.length > 0 && films.length < exact.length) {
      exact = films;
      tiebreak = 'film';
    }
  }
  if (exact.length > 1) {
    const withArticle = exact.filter((c) => c.enwiki);
    if (withArticle.length === 1) {
      exact = withArticle;
      tiebreak = 'enwiki';
    } else {
      const pool = [...(withArticle.length > 0 ? withArticle : exact)].sort(
        (a, b) => b.sitelinks - a.sitelinks || compareQids(a.qid, b.qid)
      );
      if (pool[0].sitelinks >= POPULARITY_FACTOR * Math.max(1, pool[1].sitelinks)) {
        exact = [pool[0]];
        tiebreak = 'popularity';
      }
    }
  }

  if (exact.length === 1) {
    if (tiebreak === 'popularity') {
      return { label: 'MEDIUM', method: 'wikidata:popularity', pick: exact[0], top };
    }
    return {
      label: 'HIGH',
      method: tiebreak ? 'wikidata:exact_tiebreak' : 'wikidata:exact',
      pick: exact[0],
      top,
    };
  }
  if (
    near.length > 0 &&
    near[0].similarity >= SIMILARITY_THRESHOLD &&
    (near.length === 1 || near[0].similarity - near[1].similarity >= SIMILARITY_MARGIN)
  ) {
    return { label: 'MEDIUM', method: 'wikidata:fuzzy', pick: near[0], top };
  }
  const bestBySimilarity = [...scored].sort(
    (a, b) => b.similarity - a.similarity || compareQids(a.qid, b.qid)
  )[0];
  return {
    label: 'LOW',
    method: 'wikidata:ambiguous',
    pick: exact[0] ?? near[0] ?? bestBySimilarity,
    top,
  };
}
