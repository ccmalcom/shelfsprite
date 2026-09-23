/**
 * Screen recommendation rows on the wire, the screen reject vocabulary, and (Task 10) landing an
 * accepted recommendation in the library. The screen twin of recs.ts.
 */
import type { schema } from './db';
import type { MediaFilter } from './screenAssemble';
import { tsToIso } from './serialize';

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
