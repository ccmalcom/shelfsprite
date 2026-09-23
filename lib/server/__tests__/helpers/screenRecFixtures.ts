/**
 * Synthetic ScreenSprite library for wave 7 tests. Never shaped from a real export.
 *
 * Owner 'local': screen enabled, profiled at PROFILED_AT, with
 *   books  1 Leviathan Wakes (5, loved)   2 All Systems Red (4.5, loved, favorite)
 *          3 A Book I Disliked (2)        -- and 'other' owns book 4 (Dune)
 *   titles 1 Forrest Gump (movie, 4.5, Q134773)   2 Toy Story (movie, 5, favorite, Q171048)
 *          3 Arrival (movie, want, Q900003)       4 Severance (tv, 4, tvmaze 44933, Q900004)
 *          -- and 'other' owns title 5 (Heat, Q900099)
 *   traits 1 proposed   2 rejected   -- and 'other' owns trait 3
 * All enrichment resolved and all feedback stamped BEFORE PROFILED_AT, so the gate is clean.
 */
import { schema, type Db } from '../../db';
import type { ScreenCandidate } from '../../screenEnrichment';
import type { ScreenCatalogPort, TvmazeHit } from '../../screenAssemble';
import type { SparqlRow } from '../../screenSparql';

export const PROFILED_AT = '2026-09-10 00:00:00';
export const BEFORE = '2026-09-01 00:00:00';
export const AFTER = '2026-09-15 00:00:00';

export async function seedScreenLibrary(db: Db, opts: { enabled?: boolean } = {}): Promise<void> {
  await db.insert(schema.userSettings).values([
    { userId: 'local', screenEnabled: opts.enabled ?? true },
    { userId: 'other', screenEnabled: true },
  ]);
  await db.insert(schema.books).values([
    {
      userId: 'local',
      title: 'Leviathan Wakes (The Expanse, #1)',
      author: 'James S.A. Corey',
      goodreadsRating: 5,
      exclusiveShelf: 'read',
      dateRead: '2024-05-01',
      source: 'goodreads',
    },
    {
      userId: 'local',
      title: 'All Systems Red (The Murderbot Diaries, #1)',
      author: 'Martha Wells',
      goodreadsRating: 4.5,
      exclusiveShelf: 'read',
      dateRead: '2023-02-01',
      isFavorite: true,
      source: 'goodreads',
    },
    {
      userId: 'local',
      title: 'A Book I Disliked',
      author: 'Some Author',
      goodreadsRating: 2,
      exclusiveShelf: 'read',
      source: 'goodreads',
    },
    {
      userId: 'other',
      title: 'Dune',
      author: 'Frank Herbert',
      goodreadsRating: 5,
      source: 'goodreads',
    },
  ]);
  await db.insert(schema.titles).values([
    {
      userId: 'local',
      mediaType: 'movie',
      title: 'Forrest Gump',
      year: 1994,
      status: 'watched',
      letterboxdRating: 4.5,
      wikidataQid: 'Q134773',
      lastWatchedOn: '2025-01-02',
      feedbackUpdatedAt: BEFORE,
    },
    {
      userId: 'local',
      mediaType: 'movie',
      title: 'Toy Story',
      year: 1995,
      status: 'watched',
      letterboxdRating: 5,
      wikidataQid: 'Q171048',
      isFavorite: true,
      lastWatchedOn: '2024-03-03',
      feedbackUpdatedAt: BEFORE,
    },
    {
      userId: 'local',
      mediaType: 'movie',
      title: 'Arrival',
      year: 2016,
      status: 'want',
      wikidataQid: 'Q900003',
    },
    {
      userId: 'local',
      mediaType: 'tv',
      title: 'Severance',
      year: 2022,
      status: 'watched',
      appRating: 4,
      tvmazeId: 44933,
      lastWatchedOn: '2025-06-01',
      feedbackUpdatedAt: BEFORE,
    },
    {
      userId: 'other',
      mediaType: 'movie',
      title: 'Heat',
      year: 1995,
      status: 'watched',
      letterboxdRating: 5,
      wikidataQid: 'Q900099',
    },
  ]);
  const enr = (titleId: number, extra: Record<string, unknown>) => ({
    titleId,
    resolutionConfidence: 1,
    confidenceLabel: 'HIGH',
    matchMethod: 'test',
    identitySource: 'auto',
    resolvedAt: BEFORE,
    genres: [],
    directors: [],
    creators: [],
    ...extra,
  });
  await db.insert(schema.titleEnrichment).values([
    enr(1, {
      wikidataQid: 'Q134773',
      genres: ['drama film'],
      directors: ['Robert Zemeckis'],
      originalLanguage: 'English',
    }),
    enr(2, {
      wikidataQid: 'Q171048',
      genres: ['animated film', 'comedy film'],
      directors: ['John Lasseter'],
      originalLanguage: 'English',
    }),
    enr(3, { wikidataQid: 'Q900003', genres: ['science fiction film'] }),
    enr(4, {
      wikidataQid: 'Q900004',
      tvmazeId: 44933,
      genres: ['drama television series'],
      creators: ['Dan Erickson'],
      originalLanguage: 'English',
    }),
    enr(5, { wikidataQid: 'Q900099', genres: ['crime film'] }),
  ]);
  await db.insert(schema.tasteTraits).values([
    {
      userId: 'local',
      claim: 'Rewards slow-burn mysteries',
      polarity: 'reward',
      exhibits: [1],
      contrasts: [],
      exhibitTitleIds: [4],
      inferenceConfidence: 0.8,
      status: 'proposed',
    },
    {
      userId: 'local',
      claim: 'Rejected claim',
      polarity: 'reward',
      exhibits: [],
      contrasts: [],
      inferenceConfidence: 0.9,
      status: 'rejected',
    },
    {
      userId: 'other',
      claim: 'Their trait',
      polarity: 'reward',
      exhibits: [],
      contrasts: [],
      inferenceConfidence: 0.9,
      status: 'proposed',
    },
  ]);
  await db.insert(schema.profileMeta).values([{ userId: 'local', lastProfiledAt: PROFILED_AT }]);
}

export const wd = (qid: string) => ({ value: `http://www.wikidata.org/entity/${qid}` });
export const lit = (v: string | number) => ({ value: String(v) });

/** A full ScreenCandidate with empty metadata, overridable per field. */
export function candidate(
  partial: Partial<ScreenCandidate> & { title: string; wikidata_qid: string }
): ScreenCandidate {
  return {
    media_type: 'movie',
    year: null,
    tvmaze_id: null,
    image_url: null,
    description: null,
    description_source: null,
    description_url: null,
    wikipedia_page: null,
    genres: [],
    directors: [],
    creators: [],
    writers: [],
    countries: [],
    original_language: null,
    based_on: [],
    main_subjects: [],
    series: [],
    production_companies: [],
    sitelinks: 50,
    ...partial,
  };
}

export interface FakePortScript {
  /** Keyed by the query's `# screen:<name>` marker; 'retryable' simulates a transport failure. */
  sparql?: Record<string, SparqlRow[] | 'retryable'>;
  tvmaze?: Record<string, TvmazeHit>;
  metadata?: Record<string, ScreenCandidate>;
  metadataRetryable?: boolean;
}

export type FakePort = ScreenCatalogPort & {
  queries: string[];
  tvmazeCalls: string[];
  metadataCalls: string[][];
};

export function fakeScreenPort(script: FakePortScript = {}): FakePort {
  const queries: string[] = [];
  const tvmazeCalls: string[] = [];
  const metadataCalls: string[][] = [];
  return {
    queries,
    tvmazeCalls,
    metadataCalls,
    async sparql(query) {
      queries.push(query);
      const marker = /^# screen:([a-z-]+)/.exec(query)?.[1] ?? '';
      const rows = script.sparql?.[marker];
      if (rows === 'retryable') return { kind: 'retryable', reason: 'fake transport failure' };
      if (!rows) return { kind: 'empty' };
      return { kind: 'ok', value: rows };
    },
    async tvmazeSingleSearch(name) {
      tvmazeCalls.push(name);
      const hit = script.tvmaze?.[name];
      return hit ? { kind: 'ok', value: hit } : { kind: 'empty' };
    },
    async fetchMetadata(qids) {
      metadataCalls.push([...qids]);
      if (script.metadataRetryable) return { kind: 'retryable', reason: 'fake transport failure' };
      const out = new Map<string, ScreenCandidate>();
      for (const q of qids) {
        const c = script.metadata?.[q];
        if (c) out.set(q, c);
      }
      return { kind: 'ok', value: out };
    },
  };
}

export const OPEN_DEADLINE = { remainingMs: () => 60_000 };
export const SPENT_DEADLINE = { remainingMs: () => 0 };
