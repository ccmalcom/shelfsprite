/**
 * SCREEN DATA for the unified taste profile (spec 2026-09-22 §5.2–§5.3): the twin of
 * profileTiers.ts for films and TV, under the same rules. Every mapping is a Map (V8 would
 * reorder integer-like keys and change the prompt bytes), payload key order is fixed, and every
 * query whose rows reach the prompt carries an explicit ORDER BY.
 *
 * Tiers are separate per medium because rating habits differ between Goodreads and Letterboxd.
 */
import { and, asc, desc, eq, isNotNull } from 'drizzle-orm';
import { schema, type Db } from './db';
import { tierFor, type Tiers } from './profileTiers';
import {
  effectiveTitleRating,
  effectiveTitleReview,
  isTitleProfileEvidence,
  type TitleEnrichmentRow,
  type TitleRow,
} from './titles';

export const SCREEN_TIER_KEYS = [
  '5',
  '4.5',
  '4',
  '3.5',
  '3',
  '<=2',
  'dropped',
  'rejected',
] as const;
export const SCREEN_MEDIA = ['movie', 'tv'] as const;
/** Hard cap on titles sent to the profile prompt (spec §5.3). No movie/TV quota. */
export const SCREEN_TITLE_CAP = 300;
/** Most recent rejected screen recommendations sent (spec §5.3). */
export const SCREEN_REJECTED_CAP = 50;
const REVIEW_MAX = 1000;
const GENRES_MAX = 8;

export type ScreenTiers = Map<string, Tiers>;
export type ScreenTierCounts = Map<string, Map<string, number>>;

export interface ScreenTierBuild {
  tiers: ScreenTiers;
  /** Per medium and tier: how many entries the prompt carries. */
  sent: ScreenTierCounts;
  /** Per medium and tier: how many exist before the volume cap. */
  total: ScreenTierCounts;
}

function emptyTiers(): Tiers {
  return new Map(SCREEN_TIER_KEYS.map((k) => [k, [] as Record<string, unknown>[]]));
}

function emptyCounts(): ScreenTierCounts {
  return new Map(SCREEN_MEDIA.map((m) => [m, new Map(SCREEN_TIER_KEYS.map((k) => [k, 0]))]));
}

function bump(counts: ScreenTierCounts, medium: string, tier: string): void {
  const byTier = counts.get(medium)!;
  byTier.set(tier, (byTier.get(tier) ?? 0) + 1);
}

function mediumOf(mediaType: string): 'movie' | 'tv' {
  return mediaType === 'tv' ? 'tv' : 'movie';
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function basedOnLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue;
    const { title, author } = item as { title?: unknown; author?: unknown };
    if (typeof title !== 'string' || !title) continue;
    out.push(typeof author === 'string' && author ? `${title} by ${author}` : title);
  }
  return out;
}

function reviewText(row: TitleRow): string | null {
  const review = effectiveTitleReview(row);
  if (review === null) return null;
  const trimmed = review.trim();
  return trimmed ? trimmed : null;
}

/**
 * Spec §5.2 per-title payload. Key order is load-bearing (it becomes prompt JSON): id, type,
 * title, year, genres, directors (films) or creators (TV), based_on, watched_year, and review
 * only when present.
 */
export function titlePayload(
  row: TitleRow,
  enr: TitleEnrichmentRow | null
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    id: row.id,
    type: row.mediaType,
    title: row.title,
    year: row.year,
    genres: enr ? strings(enr.genres).slice(0, GENRES_MAX) : [],
  };
  if (row.mediaType === 'tv') payload.creators = enr ? strings(enr.creators) : [];
  else payload.directors = enr ? strings(enr.directors) : [];
  payload.based_on = enr ? basedOnLabels(enr.basedOn) : [];
  payload.watched_year = row.lastWatchedOn ? Number(row.lastWatchedOn.slice(0, 4)) : null;
  const review = reviewText(row);
  if (review !== null) payload.review = review.slice(0, REVIEW_MAX);
  return payload;
}

/** The tier of an eligible title: `dropped` wins over any rating, as DNF does for books. */
export function screenTierFor(row: TitleRow): string | null {
  if (row.status === 'dropped') return 'dropped';
  const rating = effectiveTitleRating(row);
  return rating === null ? null : tierFor(rating);
}

/** Spec §5.3 priority groups: reviewed or dropped, then favourites, then 5 and <=2, then rest. */
function priorityGroup(row: TitleRow): number {
  if (row.status === 'dropped' || reviewText(row) !== null) return 0;
  if (row.isFavorite) return 1;
  const tier = screenTierFor(row);
  if (tier === '5' || tier === '<=2') return 2;
  return 3;
}

/** Group, then most recent last_watched_on (nulls last), then id. */
function capOrder(a: TitleRow, b: TitleRow): number {
  const byGroup = priorityGroup(a) - priorityGroup(b);
  if (byGroup !== 0) return byGroup;
  const da = a.lastWatchedOn;
  const dbDate = b.lastWatchedOn;
  if (da !== dbDate) {
    if (da === null) return 1;
    if (dbDate === null) return -1;
    return da < dbDate ? 1 : -1;
  }
  return a.id - b.id;
}

export async function buildScreenTiersWithCounts(db: Db, userId: string): Promise<ScreenTierBuild> {
  const tiers: ScreenTiers = new Map(SCREEN_MEDIA.map((m) => [m, emptyTiers()]));
  const sent = emptyCounts();
  const total = emptyCounts();

  const rows = await db
    .select({ title: schema.titles, enrichment: schema.titleEnrichment })
    .from(schema.titles)
    .leftJoin(schema.titleEnrichment, eq(schema.titleEnrichment.titleId, schema.titles.id))
    .where(eq(schema.titles.userId, userId))
    .orderBy(asc(schema.titles.id));

  const eligible = rows.filter(
    ({ title }) => isTitleProfileEvidence(title) && screenTierFor(title) !== null
  );
  for (const { title } of eligible) bump(total, mediumOf(title.mediaType), screenTierFor(title)!);

  const selected = [...eligible]
    .sort((a, b) => capOrder(a.title, b.title))
    .slice(0, SCREEN_TITLE_CAP)
    .sort((a, b) => a.title.id - b.title.id);
  for (const { title, enrichment } of selected) {
    const medium = mediumOf(title.mediaType);
    const tier = screenTierFor(title)!;
    tiers.get(medium)!.get(tier)!.push(titlePayload(title, enrichment));
    bump(sent, medium, tier);
  }

  const rejected = await db
    .select({
      id: schema.titleRecommendations.id,
      mediaType: schema.titleRecommendations.mediaType,
      title: schema.titleRecommendations.title,
      year: schema.titleRecommendations.year,
      userNote: schema.titleRecommendations.userNote,
    })
    .from(schema.titleRecommendations)
    .where(
      and(
        eq(schema.titleRecommendations.userId, userId),
        eq(schema.titleRecommendations.status, 'rejected'),
        isNotNull(schema.titleRecommendations.userNote)
      )
    )
    .orderBy(desc(schema.titleRecommendations.id));
  for (const rec of rejected) bump(total, mediumOf(rec.mediaType), 'rejected');
  for (const rec of rejected.slice(0, SCREEN_REJECTED_CAP).reverse()) {
    const medium = mediumOf(rec.mediaType);
    tiers
      .get(medium)!
      .get('rejected')!
      .push({ title: rec.title, year: rec.year, note: rec.userNote });
    bump(sent, medium, 'rejected');
  }

  return { tiers, sent, total };
}

export async function buildScreenTiers(db: Db, userId: string): Promise<ScreenTiers> {
  return (await buildScreenTiersWithCounts(db, userId)).tiers;
}

/** Ids of the titles a build actually sent: the only title ids a full build may cite (§5.4). */
export function sentTitleIds(tiers: ScreenTiers): Set<number> {
  const out = new Set<number>();
  for (const medium of tiers.values()) {
    for (const [tier, list] of medium) {
      if (tier === 'rejected') continue;
      for (const payload of list) if (typeof payload.id === 'number') out.add(payload.id);
    }
  }
  return out;
}
