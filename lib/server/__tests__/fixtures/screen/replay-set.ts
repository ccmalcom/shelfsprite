/**
 * The real titles the screen resolver is replayed against, and the summaries both the recorder
 * (scripts/record-screen-fixtures.ts) and the replay test compare. Deliberately free of vitest
 * imports. Spec §2.1 findings 2-4 name why each title is here.
 */
import type { Db } from '../../../db';
import { type CatalogResult, type Deadline } from '../../../screenCatalog';
import {
  resolveMovies,
  resolveTv,
  searchMovies,
  searchShows,
  type MovieInput,
  type ScreenCandidate,
  type TitleResolution,
  type TvInput,
} from '../../../screenEnrichment';

export const REPLAY_FILMS: readonly MovieInput[] = [
  { id: 1, title: 'Forrest Gump', year: 1994 }, // only a mul label (finding 2a)
  { id: 2, title: 'Toy Story', year: 1995 },
  { id: 3, title: 'Her', year: 2013 }, // short titles search never surfaces (finding 2b)
  { id: 4, title: 'Old', year: 2021 },
  { id: 5, title: 'Pig', year: 2021 },
  { id: 6, title: 'Nosferatu', year: 2024 }, // shares its title with 1922 and 1979
  { id: 7, title: 'Heat', year: 1995 },
  { id: 8, title: 'The Lord of the Rings: The Fellowship of the Ring', year: 2001 },
  { id: 9, title: 'Amélie', year: 2001 },
  { id: 10, title: 'Spirited Away', year: 2001 },
  { id: 11, title: 'Chernobyl', year: 2019 }, // a miniseries logged as a film (decision 18)
  { id: 12, title: 'Paprika', year: null }, // no year: never HIGH
  { id: 13, title: 'Qzxv Plumbline Orchard', year: 2011 }, // exists nowhere
];

export const REPLAY_SHOWS: readonly TvInput[] = [
  { id: 101, tvmazeId: 82 }, // Game of Thrones
  { id: 102, tvmazeId: 169 }, // Breaking Bad
];

export const REPLAY_MOVIE_SEARCH = 'Nosferatu 2024';
export const REPLAY_SHOW_SEARCH = 'severance';

export interface ResolutionSummary {
  id: number;
  kind: TitleResolution['kind'];
  label: string | null;
  title: string | null;
  qid: string | null;
  media_type: 'movie' | 'tv' | null;
  tvmaze_id: number | null;
  year: number | null;
  reason: string | null;
}

export interface SearchSummary {
  title: string;
  year: number | null;
  qid: string | null;
  tvmaze_id: number | null;
}

export interface ReplayObserved {
  films: ResolutionSummary[];
  shows: ResolutionSummary[];
  /** null when the search did not answer `ok`. */
  movieSearch: SearchSummary[] | null;
  showSearch: SearchSummary[] | null;
}

export function summarizeResolutions(results: Map<number, TitleResolution>): ResolutionSummary[] {
  return [...results.entries()]
    .sort(([a], [b]) => a - b)
    .map(([id, result]) => {
      const candidate =
        result.kind === 'resolved' || result.kind === 'refreshed' ? result.candidate : null;
      return {
        id,
        kind: result.kind,
        label: result.kind === 'resolved' ? result.label : null,
        title: candidate?.title ?? null,
        qid: candidate?.wikidata_qid ?? null,
        media_type: candidate?.media_type ?? null,
        tvmaze_id: candidate?.tvmaze_id ?? null,
        year: candidate?.year ?? null,
        reason: result.kind === 'deferred' ? result.reason : null,
      };
    });
}

export function summarizeSearch(result: CatalogResult<ScreenCandidate[]>): SearchSummary[] | null {
  if (result.kind !== 'ok') return null;
  return result.value.slice(0, 5).map((c) => ({
    title: c.title,
    year: c.year,
    qid: c.wikidata_qid,
    tvmaze_id: c.tvmaze_id,
  }));
}

/** Runs the whole set in a fixed order, so the recorded and replayed request sequences match. */
export async function runReplaySet(db: Db, deadline: Deadline): Promise<ReplayObserved> {
  const films = summarizeResolutions(await resolveMovies(db, REPLAY_FILMS, deadline));
  const shows = summarizeResolutions(await resolveTv(db, REPLAY_SHOWS, deadline));
  const movieSearch = summarizeSearch(await searchMovies(db, REPLAY_MOVIE_SEARCH, deadline));
  const showSearch = summarizeSearch(await searchShows(db, REPLAY_SHOW_SEARCH, deadline));
  return { films, shows, movieSearch, showSearch };
}
