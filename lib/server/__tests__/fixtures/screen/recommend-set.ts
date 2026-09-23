/**
 * The Stage 1 pool run the screen recommender is replayed against, shared by
 * scripts/record-screen-rec-fixture.ts and screen-recommend-fixture.test.ts. Deliberately free
 * of vitest imports. Records ScreenCatalogPort traffic, not HTTP (wave 7 decision 12).
 */
import type { Db } from '../../../db';
import {
  adaptationPool,
  assembleScreenPool,
  metadataPool,
  seedPool,
  type MediaFilter,
  type ScreenCatalogPort,
  type ScreenPoolCandidate,
  type SeedProposal,
  type TvmazeHit,
} from '../../../screenAssemble';
import type { Deadline } from '../../../screenCatalog';
import type { ScreenCandidate } from '../../../screenEnrichment';
import { buildScreenSignal } from '../../../screenSignal';
import type { SparqlRow } from '../../../screenSparql';

/** Fixed seed proposals stand in for the seed call, so the run needs no Claude. */
export const REC_SEEDS: SeedProposal[] = [
  { title: 'Moon', media_type: 'movie', year: 2009, reason: 'quiet, isolated science fiction' },
  { title: 'Arrival', media_type: 'movie', year: 2016, reason: 'first contact through language' },
  { title: 'The Expanse', media_type: 'tv', year: 2015, reason: 'adapts a loved series' },
  { title: 'Station Eleven', media_type: 'tv', year: 2021, reason: 'literary post-collapse drama' },
];

export const REC_FILTERS: MediaFilter[] = ['both', 'movie', 'tv'];

/** null records a definite empty answer. */
export interface RecordedPort {
  sparql: Record<string, SparqlRow[] | null>;
  tvmaze: Record<string, TvmazeHit | null>;
  metadata: Record<string, ScreenCandidate | null>;
}

export interface CandidateSummary {
  qid: string | null;
  media_type: 'movie' | 'tv';
  title: string;
  year: number | null;
  tvmaze_id: number | null;
  retrieval_pool: string;
  sitelinks: number;
}

export type RecObserved = Record<MediaFilter, CandidateSummary[]>;

export function emptyRecording(): RecordedPort {
  return { sparql: {}, tvmaze: {}, metadata: {} };
}

/** Wraps a live port; a retryable answer is noted in `failures` and passed through. */
export function recordingPort(
  inner: ScreenCatalogPort,
  into: RecordedPort,
  failures: string[]
): ScreenCatalogPort {
  return {
    async sparql(query) {
      const res = await inner.sparql(query);
      if (res.kind === 'retryable') failures.push(`sparql ${query.split('\n')[0]}: ${res.reason}`);
      else into.sparql[query] = res.kind === 'ok' ? res.value : null;
      return res;
    },
    async tvmazeSingleSearch(name) {
      const res = await inner.tvmazeSingleSearch(name);
      if (res.kind === 'retryable') failures.push(`tvmaze ${name}: ${res.reason}`);
      else into.tvmaze[name] = res.kind === 'ok' ? res.value : null;
      return res;
    },
    async fetchMetadata(qids) {
      const res = await inner.fetchMetadata(qids);
      if (res.kind === 'retryable') failures.push(`metadata ${qids.join(',')}: ${res.reason}`);
      else if (res.kind === 'ok') for (const q of qids) into.metadata[q] = res.value.get(q) ?? null;
      else for (const q of qids) into.metadata[q] = null;
      return res;
    },
  };
}

/** Serves only recorded answers; anything unrecorded is a broken fixture and throws. */
export function replayPort(recorded: RecordedPort): ScreenCatalogPort {
  return {
    async sparql(query) {
      if (!(query in recorded.sparql)) {
        throw new Error(`recommend fixture: no recorded answer for ${query.split('\n')[0]}`);
      }
      const rows = recorded.sparql[query];
      return rows === null ? { kind: 'empty' } : { kind: 'ok', value: rows };
    },
    async tvmazeSingleSearch(name) {
      if (!(name in recorded.tvmaze)) {
        throw new Error(`recommend fixture: no recorded TVmaze answer for ${name}`);
      }
      const hit = recorded.tvmaze[name];
      return hit === null ? { kind: 'empty' } : { kind: 'ok', value: hit };
    },
    async fetchMetadata(qids) {
      const out = new Map<string, ScreenCandidate>();
      for (const q of qids) {
        if (!(q in recorded.metadata)) {
          throw new Error(`recommend fixture: no recorded metadata for ${q}`);
        }
        const c = recorded.metadata[q];
        if (c) out.set(q, c);
      }
      return { kind: 'ok', value: out };
    },
  };
}

function summarize(c: ScreenPoolCandidate): CandidateSummary {
  return {
    qid: c.wikidata_qid,
    media_type: c.media_type,
    title: c.title,
    year: c.year,
    tvmaze_id: c.tvmaze_id,
    retrieval_pool: c.retrieval_pool,
    sitelinks: c.sitelinks,
  };
}

/** The same pool order runScreenRecommend uses (Task 8), once per filter. */
export async function runRecommendSet(
  db: Db,
  port: ScreenCatalogPort,
  deadline: Deadline
): Promise<RecObserved> {
  const signal = await buildScreenSignal(db, 'local');
  const out = {} as RecObserved;
  for (const filter of REC_FILTERS) {
    const seeds = REC_SEEDS.filter((s) => filter === 'both' || s.media_type === filter);
    const seedHits = await seedPool(port, seeds, deadline);
    const adaptationHits = await adaptationPool(port, signal, filter, deadline);
    const metadataHits = await metadataPool(port, signal, filter, deadline);
    const candidates = await assembleScreenPool(
      port,
      [adaptationHits, metadataHits, seedHits],
      signal,
      filter,
      deadline
    );
    out[filter] = candidates.map(summarize);
  }
  return out;
}
