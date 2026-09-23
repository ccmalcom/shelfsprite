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
import { z } from 'zod';
import type { Db } from './db';
import { classifyP31, isTvSeries, type ScreenKind } from './screenClasses';
import {
  FULL_ENTITY_PROPS,
  claimIds,
  claimStrings,
  claimYears,
  compareQids,
  entityLabel,
  entityNames,
  enwikiTitle,
  isQid,
  sitelinkCount,
  tvmazeShow,
  wikidataEntities,
  wikipediaSummary,
  type CatalogResult,
  type Deadline,
  type TvmazeShow,
  type WikidataEntity,
  type WikipediaSummary,
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

// --- Candidate record (spec §4.5) -------------------------------------------------------

export interface ScreenRef {
  qid: string;
  label: string | null;
}

export interface ScreenBasedOn {
  qid: string;
  title: string | null;
  author: string | null;
}

export interface ScreenCandidate {
  media_type: 'movie' | 'tv';
  title: string;
  year: number | null;
  wikidata_qid: string | null;
  tvmaze_id: number | null;
  image_url: string | null;
  description: string | null;
  description_source: 'wikipedia' | 'tvmaze' | null;
  description_url: string | null;
  wikipedia_page: string | null;
  genres: string[];
  directors: string[];
  creators: string[];
  writers: string[];
  countries: string[];
  /** ISO 639-1 code from the language item's P218, else its lower-cased label. */
  original_language: string | null;
  based_on: ScreenBasedOn[];
  main_subjects: string[];
  series: ScreenRef[];
  production_companies: ScreenRef[];
  sitelinks: number;
}

/** Hotlinked only (decision 8): nothing else may reach an <img src>. */
export const IMAGE_HOSTS = ['upload.wikimedia.org', 'static.tvmaze.com'] as const;
export const DESCRIPTION_HOSTS = ['en.wikipedia.org', 'www.tvmaze.com', 'tvmaze.com'] as const;

function allowedUrl(value: string | null | undefined, hosts: readonly string[]): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && hosts.includes(url.hostname) ? value : null;
  } catch {
    return null;
  }
}

function httpsUrlOn(hosts: readonly string[]) {
  return z
    .string()
    .max(2_000)
    .refine(
      (value) => allowedUrl(value, hosts) !== null,
      `must be an https URL on ${hosts.join(', ')}`
    );
}

const labelText = z.string().max(300);
const labelList = z.array(labelText).max(50);
const refSchema = z.object({ qid: z.string().regex(/^Q\d+$/), label: labelText.nullable() });

export const ScreenCandidateSchema = z.object({
  media_type: z.enum(['movie', 'tv']),
  title: z.string().trim().min(1).max(500),
  year: z.number().int().min(1870).max(2100).nullable(),
  wikidata_qid: z
    .string()
    .regex(/^Q\d+$/)
    .nullable(),
  tvmaze_id: z.number().int().positive().nullable(),
  image_url: httpsUrlOn(IMAGE_HOSTS).nullable(),
  description: z.string().max(20_000).nullable(),
  description_source: z.enum(['wikipedia', 'tvmaze']).nullable(),
  description_url: httpsUrlOn(DESCRIPTION_HOSTS).nullable(),
  wikipedia_page: z.string().max(500).nullable(),
  genres: labelList,
  directors: labelList,
  creators: labelList,
  writers: labelList,
  countries: labelList,
  original_language: z.string().max(100).nullable(),
  based_on: z
    .array(
      z.object({
        qid: z.string().regex(/^Q\d+$/),
        title: labelText.nullable(),
        author: labelText.nullable(),
      })
    )
    .max(50),
  main_subjects: labelList,
  series: z.array(refSchema).max(50),
  production_companies: z.array(refSchema).max(50),
  sitelinks: z.number().int().min(0),
});

const PROP = {
  genre: 'P136',
  director: 'P57',
  screenwriter: 'P58',
  creator: 'P170',
  country: 'P495',
  language: 'P364',
  basedOn: 'P144',
  author: 'P50',
  mainSubject: 'P921',
  series: 'P179',
  company: 'P272',
  iso6391: 'P218',
  tvmaze: 'P8600',
} as const;

const LIST_CAP = 20;

const TVMAZE_LANGUAGES: Record<string, string> = {
  English: 'en',
  Japanese: 'ja',
  Korean: 'ko',
  Spanish: 'es',
  French: 'fr',
  German: 'de',
  Italian: 'it',
  Portuguese: 'pt',
  Russian: 'ru',
  Chinese: 'zh',
  Swedish: 'sv',
  Danish: 'da',
  Norwegian: 'no',
  Dutch: 'nl',
  Hindi: 'hi',
  Polish: 'pl',
  Turkish: 'tr',
};

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
  apos: "'",
  nbsp: ' ',
};

/** TVmaze summaries are HTML fragments (spec §4.5: "HTML stripped"). */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, name: string) => HTML_ENTITIES[name])
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueNonNull(values: Array<string | null>): string[] {
  return [...new Set(values.filter((v): v is string => typeof v === 'string' && v.length > 0))];
}

function candidateFromEntity(
  entity: WikidataEntity,
  labelOf: (qid: string) => string | null,
  heavy: ReadonlyMap<string, WikidataEntity>
): ScreenCandidate {
  const p31 = claimIds(entity, 'P31');
  const tvmazeId = firstInt(claimStrings(entity, PROP.tvmaze));
  // Decision 18: only a TV *series* with a TVmaze crosswalk is TV. Specials stay movies.
  const mediaType: 'movie' | 'tv' = isTvSeries(p31) && tvmazeId !== null ? 'tv' : 'movie';
  let years = claimYears(entity, 'P577');
  if (years.length === 0) years = claimYears(entity, 'P580');
  const labels = (property: string) =>
    uniqueNonNull(claimIds(entity, property).map(labelOf)).slice(0, LIST_CAP);
  const refs = (property: string) =>
    claimIds(entity, property)
      .slice(0, LIST_CAP)
      .map((qid) => ({ qid, label: labelOf(qid) }));
  const languageItem = claimIds(entity, PROP.language)
    .map((qid) => heavy.get(qid))
    .find((item): item is WikidataEntity => item !== undefined);
  return {
    media_type: mediaType,
    title: entityLabel(entity) ?? entity.id,
    year: years[0] ?? null,
    wikidata_qid: entity.id,
    tvmaze_id: mediaType === 'tv' ? tvmazeId : null,
    image_url: null,
    description: null,
    description_source: null,
    description_url: null,
    wikipedia_page: null,
    genres: labels(PROP.genre),
    directors: labels(PROP.director),
    creators: labels(PROP.creator),
    writers: labels(PROP.screenwriter),
    countries: labels(PROP.country),
    original_language: languageItem
      ? (claimStrings(languageItem, PROP.iso6391)[0] ??
        entityLabel(languageItem)?.toLowerCase() ??
        null)
      : null,
    based_on: claimIds(entity, PROP.basedOn)
      .slice(0, LIST_CAP)
      .map((qid) => {
        const source = heavy.get(qid);
        const authorId = source ? claimIds(source, PROP.author)[0] : undefined;
        return {
          qid,
          title: source ? entityLabel(source) : null,
          author: authorId ? labelOf(authorId) : null,
        };
      }),
    main_subjects: labels(PROP.mainSubject),
    series: refs(PROP.series),
    production_companies: refs(PROP.company),
    sitelinks: sitelinkCount(entity),
  };
}

function withWikipedia(
  candidate: ScreenCandidate,
  page: string | null,
  summary: WikipediaSummary | null
): ScreenCandidate {
  const extract =
    summary && summary.type !== 'disambiguation' ? summary.extract?.trim() || null : null;
  const articleUrl = page
    ? `https://en.wikipedia.org/wiki/${encodeURIComponent(page.replace(/ /g, '_'))}`
    : null;
  return {
    ...candidate,
    wikipedia_page: page,
    description: extract,
    description_source: extract ? 'wikipedia' : null,
    description_url: extract
      ? (allowedUrl(summary?.content_urls?.desktop?.page, DESCRIPTION_HOSTS) ?? articleUrl)
      : null,
    image_url: allowedUrl(summary?.thumbnail?.source, IMAGE_HOSTS),
  };
}

/** A TV candidate: TVmaze identity, title, summary and image; Wikidata metadata when crosswalked. */
export function mergeTvmaze(show: TvmazeShow, wikidata: ScreenCandidate | null): ScreenCandidate {
  const summary = stripHtml(show.summary ?? '');
  const premiered = show.premiered ? Number(show.premiered.slice(0, 4)) : NaN;
  const showUrl =
    allowedUrl(show.url, DESCRIPTION_HOSTS) ?? `https://www.tvmaze.com/shows/${show.id}`;
  return {
    media_type: 'tv',
    title: show.name,
    year: Number.isInteger(premiered) ? premiered : (wikidata?.year ?? null),
    wikidata_qid: wikidata?.wikidata_qid ?? null,
    tvmaze_id: show.id,
    image_url:
      allowedUrl(show.image?.medium ?? show.image?.original, IMAGE_HOSTS) ??
      wikidata?.image_url ??
      null,
    description: summary || wikidata?.description || null,
    description_source: summary
      ? 'tvmaze'
      : wikidata?.description
        ? wikidata.description_source
        : null,
    description_url: summary ? showUrl : wikidata?.description ? wikidata.description_url : null,
    wikipedia_page: wikidata?.wikipedia_page ?? null,
    genres:
      wikidata && wikidata.genres.length > 0
        ? wikidata.genres
        : (show.genres ?? []).slice(0, LIST_CAP),
    directors: wikidata?.directors ?? [],
    creators: wikidata?.creators ?? [],
    writers: wikidata?.writers ?? [],
    countries: wikidata?.countries ?? [],
    original_language:
      wikidata?.original_language ??
      (show.language ? (TVMAZE_LANGUAGES[show.language] ?? null) : null),
    based_on: wikidata?.based_on ?? [],
    main_subjects: wikidata?.main_subjects ?? [],
    series: wikidata?.series ?? [],
    production_companies: wikidata?.production_companies ?? [],
    sitelinks: wikidata?.sitelinks ?? 0,
  };
}

export interface MetadataOptions {
  /** Entities the caller already fetched with FULL_ENTITY_PROPS (not refetched). */
  entities?: ReadonlyMap<string, WikidataEntity>;
  /** The caller already holds the TVmaze show and will merge it itself. */
  skipTvmaze?: boolean;
}

const LABEL_PROPERTIES = [
  PROP.genre,
  PROP.director,
  PROP.screenwriter,
  PROP.creator,
  PROP.country,
  PROP.mainSubject,
  PROP.series,
  PROP.company,
];

export async function fetchScreenMetadata(
  db: Db,
  qids: readonly string[],
  deadline: Deadline,
  options: MetadataOptions = {}
): Promise<CatalogResult<Map<string, ScreenCandidate>>> {
  const wanted = [...new Set(qids)].filter(isQid).sort(compareQids);
  const entities = new Map<string, WikidataEntity>();
  const toFetch: string[] = [];
  for (const qid of wanted) {
    const preloaded = options.entities?.get(qid);
    if (preloaded) entities.set(qid, preloaded);
    else toFetch.push(qid);
  }
  const fetched = await wikidataEntities(db, toFetch, FULL_ENTITY_PROPS, deadline);
  if (fetched.kind !== 'ok') return fetched;
  for (const [qid, entity] of fetched.value) entities.set(qid, entity);

  // Hop 1: based-on sources (for their P50 author) and language items (for P218).
  const heavyIds = new Set<string>();
  for (const entity of entities.values()) {
    for (const qid of claimIds(entity, PROP.basedOn)) heavyIds.add(qid);
    for (const qid of claimIds(entity, PROP.language)) heavyIds.add(qid);
  }
  const heavy = await wikidataEntities(db, [...heavyIds], 'labels|claims', deadline);
  if (heavy.kind !== 'ok') return heavy;

  // Hop 2: labels for every other referenced item, plus the authors found in hop 1.
  const labelIds = new Set<string>();
  for (const entity of entities.values()) {
    for (const property of LABEL_PROPERTIES) {
      for (const qid of claimIds(entity, property)) labelIds.add(qid);
    }
  }
  for (const source of heavy.value.values()) {
    for (const qid of claimIds(source, PROP.author)) labelIds.add(qid);
  }
  for (const qid of heavy.value.keys()) labelIds.delete(qid);
  const labels = await wikidataEntities(db, [...labelIds], 'labels', deadline);
  if (labels.kind !== 'ok') return labels;
  const labelOf = (qid: string): string | null => {
    const item = labels.value.get(qid) ?? heavy.value.get(qid);
    return item ? entityLabel(item) : null;
  };

  const out = new Map<string, ScreenCandidate>();
  for (const qid of wanted) {
    const entity = entities.get(qid);
    if (!entity) continue; // deleted or merged on Wikidata; the caller decides
    const page = enwikiTitle(entity);
    let summary: WikipediaSummary | null = null;
    if (page) {
      const fetchedSummary = await wikipediaSummary(db, page, deadline);
      if (fetchedSummary.kind === 'retryable') return fetchedSummary;
      summary = fetchedSummary.kind === 'ok' ? fetchedSummary.value : null;
    }
    let candidate = withWikipedia(candidateFromEntity(entity, labelOf, heavy.value), page, summary);
    if (candidate.media_type === 'tv' && candidate.tvmaze_id !== null && !options.skipTvmaze) {
      const show = await tvmazeShow(db, candidate.tvmaze_id, deadline);
      if (show.kind === 'retryable') return show;
      if (show.kind === 'ok') candidate = mergeTvmaze(show.value, candidate);
    }
    out.set(qid, candidate);
  }
  return { kind: 'ok', value: out };
}
