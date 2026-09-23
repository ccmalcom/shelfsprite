import type { MediaType, ScreenOptOutPreview, TitleOut, TitleStatus } from '@/lib/api';

export type TitleSort = 'recent' | 'title' | 'rating' | 'year';
export const TITLE_SORTS: readonly TitleSort[] = ['recent', 'title', 'rating', 'year'];
export const TITLE_SORT_LABELS: Record<TitleSort, string> = {
  recent: 'Recently watched',
  title: 'Title',
  rating: 'Your rating',
  year: 'Release year',
};

export const TITLE_STATUSES: readonly TitleStatus[] = ['watched', 'watching', 'want', 'dropped'];
export const TITLE_STATUS_LABELS: Record<TitleStatus, string> = {
  watched: 'Watched',
  watching: 'Watching',
  want: 'Want to watch',
  dropped: 'Dropped',
};

export function mediaLabel(type: MediaType): 'Film' | 'TV' {
  return type === 'tv' ? 'TV' : 'Film';
}

export function titleLabel(title: string, year: number | null): string {
  return year === null ? title : `${title} (${year})`;
}

function recentKey(t: TitleOut): string {
  // Letterboxd imports share one created_at, so the watch date is the useful signal.
  return t.last_watched_on ?? t.created_at.slice(0, 10);
}

function byName(a: TitleOut, b: TitleOut): number {
  return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
}

/** A new array; an exhaustive switch, which is why useStickySort filters stale keys. */
export function sortTitles(titles: readonly TitleOut[], sort: TitleSort): TitleOut[] {
  const out = [...titles];
  switch (sort) {
    case 'recent':
      return out.sort((a, b) => recentKey(b).localeCompare(recentKey(a)) || byName(a, b));
    case 'title':
      return out.sort((a, b) => byName(a, b) || (a.year ?? 0) - (b.year ?? 0));
    case 'rating':
      return out.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || byName(a, b));
    case 'year':
      return out.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || byName(a, b));
  }
}

/** LOW-confidence matches offer correction (spec §4.4, §7.3). */
export function needsCorrection(t: TitleOut): boolean {
  return t.enrichment?.confidence_label === 'LOW';
}

/** Structurally identical to components/profile/TraitRow.tsx#TitleEvidence. */
export interface TitleRef {
  id: number;
  title: string;
  year: number | null;
  media_type: MediaType;
}

export function titleEvidenceMap(titles: readonly TitleOut[]): Map<number, TitleRef> {
  return new Map(
    titles.map((t) => [t.id, { id: t.id, title: t.title, year: t.year, media_type: t.media_type }])
  );
}

/** The opt-out confirmation (spec §5.7). */
export function traitsWarning({ traits, confirmed }: ScreenOptOutPreview): string {
  if (traits === 0) return 'No traits drew on your viewing history, so every trait stays.';
  const lead = traits === 1 ? '1 trait drew' : `${traits} traits drew`;
  const tail = confirmed > 0 ? `, including ${confirmed} you confirmed.` : '.';
  return `${lead} on your viewing history and will be removed${tail}`;
}

/** An error's message (ApiRequestError carries the server's detail), else the fallback. */
export function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}
