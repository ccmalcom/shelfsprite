/**
 * Screen recommendation rows on the wire, the screen reject vocabulary, and (Task 10) landing an
 * accepted recommendation in the library. The screen twin of recs.ts.
 */
import { and, asc, eq, isNull, or } from 'drizzle-orm';
import { schema, type Db, type DbTx } from './db';
import { deadlineIn } from './screenCatalog';
import {
  candidateEnrichmentValues,
  fetchScreenMetadata,
  type ScreenCandidate,
} from './screenEnrichment';
import { normalizeTitleKey, type TitleEnrichmentRow, type TitleRow } from './titles';
import type { MediaFilter } from './screenAssemble';
import { serializeResolutionConfidence, tsToIso, utcnowTs } from './serialize';

export const MEDIA_FILTERS = ['both', 'movie', 'tv'] as const satisfies readonly MediaFilter[];

/**
 * Spec §6.7: the book list (recs.ts#REJECT_REASONS) without `tried_author`, in the same order,
 * so the 422 detail lists codes the way the book route does. `too_long` means runtime or
 * season count.
 */
export const SCREEN_REJECT_REASONS = [
  'wrong_genre',
  'too_dark',
  'too_long',
  'not_now',
  'overhyped',
  'wrong_vibe',
] as const;
export type ScreenRejectReason = (typeof SCREEN_REJECT_REASONS)[number];

export type TitleRecRow = typeof schema.titleRecommendations.$inferSelect;

export interface TitleRecOut {
  id: number;
  run_id: string;
  rank: number;
  media_type: 'movie' | 'tv';
  media_filter: MediaFilter;
  title: string;
  year: number | null;
  wikidata_qid: string | null;
  tvmaze_id: number | null;
  image_url: string | null;
  genres: string[];
  description: string | null;
  retrieval_pool: string | null;
  seed_reason: string | null;
  score: number;
  rationale: string | null;
  grounded_trait_ids: number[];
  grounded_book_ids: number[];
  grounded_title_ids: number[];
  status: 'served' | 'accepted' | 'rejected' | 'already_watched';
  user_note: string | null;
  reject_reasons: string[] | null;
  created_at: string | null;
}

function ids(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((v): v is number => typeof v === 'number') : [];
}

export function titleRecOut(r: TitleRecRow): TitleRecOut {
  return {
    id: r.id,
    run_id: r.runId,
    rank: r.rank,
    media_type: r.mediaType as 'movie' | 'tv',
    media_filter: r.mediaFilter as MediaFilter,
    title: r.title,
    year: r.year,
    wikidata_qid: r.wikidataQid,
    tvmaze_id: r.tvmazeId,
    image_url: r.imageUrl,
    genres: Array.isArray(r.genres) ? (r.genres as string[]) : [],
    description: r.description,
    retrieval_pool: r.retrievalPool,
    seed_reason: r.seedReason,
    score: r.score,
    rationale: r.rationale,
    grounded_trait_ids: ids(r.groundedTraitIds),
    grounded_book_ids: ids(r.groundedBookIds),
    grounded_title_ids: ids(r.groundedTitleIds),
    status: r.status as TitleRecOut['status'],
    user_note: r.userNote,
    reject_reasons: Array.isArray(r.rejectReasons) ? (r.rejectReasons as string[]) : null,
    created_at: tsToIso(r.createdAt),
  };
}

// --- Landing an accepted recommendation (spec §6.7) ----------------------------------

/** The metadata fetch runs before the transaction; usually a catalog_cache hit from the run. */
export const REC_METADATA_DEADLINE_MS = 20_000;

let recCandidateFetch: ((rec: TitleRecRow) => Promise<ScreenCandidate | null>) | null = null;

/** Test seam: replace the metadata fetch. `null` restores the catalog. */
export function _setRecCandidateFetchForTests(
  fn: ((rec: TitleRecRow) => Promise<ScreenCandidate | null>) | null
): void {
  recCandidateFetch = fn;
}

/**
 * Full metadata for a recommendation (decision 8), or null when it cannot be fetched now:
 * the caller then falls back to the fields stored on the recommendation row.
 */
export async function fetchRecCandidate(db: Db, rec: TitleRecRow): Promise<ScreenCandidate | null> {
  if (recCandidateFetch) return recCandidateFetch(rec);
  if (!rec.wikidataQid) return null;
  const result = await fetchScreenMetadata(
    db,
    [rec.wikidataQid],
    deadlineIn(REC_METADATA_DEADLINE_MS)
  );
  return result.kind === 'ok' ? (result.value.get(rec.wikidataQid) ?? null) : null;
}

/** Stored-field fallback, shaped like candidateEnrichmentValues' output. */
function recEnrichmentValues(rec: TitleRecRow) {
  return {
    wikidataQid: rec.wikidataQid,
    tvmazeId: rec.tvmazeId,
    wikipediaPage: null,
    genres: Array.isArray(rec.genres) ? rec.genres : [],
    directors: [],
    creators: [],
    writers: [],
    countries: [],
    originalLanguage: null,
    basedOn: [],
    mainSubjects: [],
    series: [],
    productionCompanies: [],
    sitelinks: null,
    description: rec.description,
    descriptionSource: null,
    descriptionUrl: null,
    imageUrl: rec.imageUrl,
  };
}

async function withEnrichment(tx: Db | DbTx, title: TitleRow) {
  const [enrichment] = await tx
    .select()
    .from(schema.titleEnrichment)
    .where(eq(schema.titleEnrichment.titleId, title.id));
  return { title, enrichment: enrichment ?? null, created: false };
}

/**
 * Idempotently land a recommendation in the library (spec §6.7). An existing title is returned
 * unchanged: nothing here may overwrite a status, rating, review or favorite.
 */
export async function ensureScreenTitle(
  tx: Db | DbTx,
  userId: string,
  rec: TitleRecRow,
  status: 'want' | 'watched',
  candidate: ScreenCandidate | null
): Promise<{ title: TitleRow; enrichment: TitleEnrichmentRow | null; created: boolean }> {
  const t = schema.titles;
  const tvmazeId = rec.mediaType === 'tv' ? rec.tvmazeId : null;
  const idMatches = [];
  if (rec.wikidataQid) idMatches.push(eq(t.wikidataQid, rec.wikidataQid));
  if (tvmazeId !== null) idMatches.push(eq(t.tvmazeId, tvmazeId));
  if (idMatches.length > 0) {
    const [byId] = await tx
      .select()
      .from(t)
      .where(and(eq(t.userId, userId), or(...idMatches)))
      .orderBy(asc(t.id))
      .limit(1);
    if (byId) return withEnrichment(tx, byId);
  }
  // Title + year, media type deliberately not compared (a miniseries imports as a movie).
  const key = normalizeTitleKey(rec.title, rec.year);
  const sameYear = await tx
    .select()
    .from(t)
    .where(and(eq(t.userId, userId), rec.year === null ? isNull(t.year) : eq(t.year, rec.year)))
    .orderBy(asc(t.id));
  const byTitle = sameYear.find((row) => normalizeTitleKey(row.title, row.year) === key);
  if (byTitle) return withEnrichment(tx, byTitle);

  const now = utcnowTs();
  const [title] = await tx
    .insert(t)
    .values({
      userId,
      mediaType: rec.mediaType,
      title: rec.title,
      year: rec.year,
      status,
      wikidataQid: rec.wikidataQid,
      tvmazeId,
      // Not a rating change (decision 10), so it never marks the profile dirty.
      feedbackUpdatedAt: null,
      updatedAt: now,
    })
    .returning();
  const [enrichment] = await tx
    .insert(schema.titleEnrichment)
    .values({
      titleId: title.id,
      ...(candidate ? candidateEnrichmentValues(candidate) : recEnrichmentValues(rec)),
      wikidataQid: rec.wikidataQid,
      tvmazeId,
      resolutionConfidence: serializeResolutionConfidence('HIGH'),
      confidenceLabel: 'HIGH',
      matchMethod: 'recommendation',
      identitySource: 'auto',
      duplicateOfTitleId: null,
      rawResponse: null,
      resolvedAt: now,
    })
    .returning();
  return { title, enrichment, created: true };
}
