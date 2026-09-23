/**
 * Screen title domain rules (spec §3.2). The screen counterpart of books.ts + the rating parts
 * of serialize.ts, kept separate because the storage rules differ: titles store null for
 * unrated, never a 0 sentinel.
 */
import { schema } from './db';
import { tsToIso } from './serialize';

export type TitleRow = typeof schema.titles.$inferSelect;
export type TitleEnrichmentRow = typeof schema.titleEnrichment.$inferSelect;

export const MEDIA_TYPES = ['movie', 'tv'] as const;
export const TITLE_STATUSES = ['watched', 'watching', 'dropped', 'want'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];
export type TitleStatus = (typeof TITLE_STATUSES)[number];

export const WATCH_DATE_MESSAGE = 'last_watched_on must be a real date as YYYY-MM-DD.';

/**
 * A YYYY-MM-DD string naming a real day; the shape alone lets 2026-02-30 reach Postgres. Year 0000
 * round-trips through Date but Postgres has no year zero, so it is refused here instead of a 500.
 */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export interface TitleOut {
  id: number;
  media_type: 'movie' | 'tv';
  title: string;
  year: number | null;
  status: 'watched' | 'watching' | 'dropped' | 'want';
  rating: number | null; // effective
  app_rating: number | null;
  letterboxd_rating: number | null;
  review: string | null; // effective
  app_review: string | null;
  letterboxd_review: string | null;
  last_watched_on: string | null;
  is_favorite: boolean;
  exclude_from_profile: boolean;
  wikidata_qid: string | null;
  tvmaze_id: number | null;
  created_at: string;
  enrichment: {
    confidence_label: string | null;
    resolution_confidence: number;
    match_method: string | null;
    identity_source: 'auto' | 'manual' | 'corrected';
    image_url: string | null;
    description: string | null;
    description_source: 'wikipedia' | 'tvmaze' | null;
    description_url: string | null;
    wikipedia_page: string | null;
    genres: string[];
    directors: string[];
    creators: string[];
    duplicate_of_title_id: number | null;
  } | null;
}

/** app_rating ?? letterboxd_rating. A stored 0 is impossible (check constraint). */
export function effectiveTitleRating(
  row: Pick<TitleRow, 'appRating' | 'letterboxdRating'>
): number | null {
  return row.appRating ?? row.letterboxdRating ?? null;
}

/** app_review ?? letterboxd_review: clearing the app review reveals the Letterboxd one. */
export function effectiveTitleReview(
  row: Pick<TitleRow, 'appReview' | 'letterboxdReview'>
): string | null {
  return row.appReview ?? row.letterboxdReview ?? null;
}

/**
 * Spec §3.2 profile eligibility: dropped behaves like DNF (evidence even unrated); want is never
 * evidence; watched/watching count only when rated; an excluded title is never evidence.
 */
export function isTitleProfileEvidence(
  row: Pick<TitleRow, 'status' | 'excludeFromProfile' | 'appRating' | 'letterboxdRating'>
): boolean {
  if (row.excludeFromProfile) return false;
  if (row.status === 'dropped') return true;
  if (row.status === 'want') return false;
  return effectiveTitleRating(row) !== null;
}

/**
 * Unicode-safe title + year key for import matching and dedup. NFKC folds width and
 * compatibility forms; letters (any script), combining marks and digits survive; everything else
 * becomes a single space. Deliberately NOT dedup.normalizeTitle, which strips every non-[a-z0-9]
 * character and so maps every non-Latin title to '' (spec §1, §4.3). Returns '' when nothing
 * survives, and '' must never be used as a match key.
 */
export function normalizeTitleKey(title: string, year: number | null): string {
  const norm = title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();
  if (!norm) return '';
  return `${norm}\u0000${year ?? ''}`;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function titleOut(row: TitleRow, enr: TitleEnrichmentRow | null): TitleOut {
  return {
    id: row.id,
    media_type: row.mediaType as MediaType,
    title: row.title,
    year: row.year,
    status: row.status as TitleStatus,
    rating: effectiveTitleRating(row),
    app_rating: row.appRating,
    letterboxd_rating: row.letterboxdRating,
    review: effectiveTitleReview(row),
    app_review: row.appReview,
    letterboxd_review: row.letterboxdReview,
    last_watched_on: row.lastWatchedOn,
    is_favorite: row.isFavorite,
    exclude_from_profile: row.excludeFromProfile,
    wikidata_qid: row.wikidataQid,
    tvmaze_id: row.tvmazeId,
    created_at: tsToIso(row.createdAt) ?? row.createdAt,
    enrichment: enr
      ? {
          confidence_label: enr.confidenceLabel,
          resolution_confidence: enr.resolutionConfidence,
          match_method: enr.matchMethod,
          identity_source: enr.identitySource as 'auto' | 'manual' | 'corrected',
          image_url: enr.imageUrl,
          description: enr.description,
          description_source: enr.descriptionSource as 'wikipedia' | 'tvmaze' | null,
          description_url: enr.descriptionUrl,
          wikipedia_page: enr.wikipediaPage,
          genres: stringList(enr.genres),
          directors: stringList(enr.directors),
          creators: stringList(enr.creators),
          duplicate_of_title_id: enr.duplicateOfTitleId,
        }
      : null,
  };
}
