/**
 * Screen recommendations (spec §6): the two-stage orchestrator, the screen twin of
 * recommendRun.ts.
 *
 * Locked decision: the LLM is NOT the recommender. Claude's seeds are lookup INPUTS; only items
 * Stage 1 retrieved from Wikidata/TVmaze can be ranked, every cited index and id is validated,
 * and a rerank with no surviving picks mints no run (issue #64).
 *
 * Like recommendRun.ts, both Claude calls and every catalog fetch run OUTSIDE any transaction
 * (db.ts uses max: 1; touching `db` inside an open transaction deadlocks). The run is written
 * in one transaction afterwards.
 *
 * Time budget (spec §6.4), all measured from entry against the route's literal 300s ceiling:
 * seeds <= 45s (the SDK request is aborted), retrieval until 180s, the rerank gets the
 * remainder minus a 20s persistence reserve.
 */
import { randomUUID } from 'node:crypto';
import { trackedCreate } from './anthropic';
import { toolInput, type ClaudeClient } from './claude';
import {
  NO_PROFILE_MESSAGE,
  RECOMMEND_NO_KEY_MESSAGE,
  SCREEN_REBUILD_REQUIRED_MESSAGE,
  SCREEN_TIMEOUT_MESSAGE,
  screenStaleMessage,
} from './claudeErrors';
import { schema, type Db } from './db';
import { ApiError } from './errors';
import { logDebug } from './log';
import { modelFor } from './models';
import { asIdList } from './profileBuild';
import { ensureProfileMeta, readRebuildReason } from './profileMeta';
import { booksChangedSince } from './profileUpdate';
import {
  adaptationPool,
  assembleScreenPool,
  defaultScreenCatalogPort,
  metadataPool,
  seedPool,
  type MediaFilter,
  type ScreenCatalogPort,
  type ScreenPoolCandidate,
  type SeedProposal,
} from './screenAssemble';
import type { Deadline } from './screenCatalog';
import { titlesChangedSince } from './screenProfile';
import {
  buildScreenRerankPrompt,
  buildScreenSeedPrompt,
  SCREEN_RANK_MAX_TOKENS,
  SCREEN_RANK_SYSTEM,
  SCREEN_RANK_TOOL,
  SCREEN_SEED_COUNT,
  SCREEN_SEED_MAX_TOKENS,
  SCREEN_SEED_SYSTEM,
  SCREEN_SEED_TOOL,
  validEvidenceIds,
} from './screenRecPrompts';
import { requireScreenEnabled } from './screenSettings';
import { buildScreenSignal, type ScreenSignal } from './screenSignal';
import { round2, utcnowTs } from './serialize';
import { effectiveTitleRating, type TitleRow } from './titles';

export const SCREEN_DEFAULT_N = 10;
/** Must equal the route's literal `maxDuration = 300` (seconds). */
export const SCREEN_REQUEST_BUDGET_MS = 300_000;
export const SEED_BUDGET_MS = 45_000;
export const RETRIEVAL_END_MS = 180_000;
export const PERSIST_RESERVE_MS = 20_000;
/** A rerank with less than this left would almost certainly be aborted: answer 504 instead. */
export const MIN_RERANK_MS = 10_000;
/** Seeds kept from one proposal (the prompt asks for SCREEN_SEED_COUNT). */
const MAX_SEEDS = Math.round(SCREEN_SEED_COUNT * 1.5);

export interface ScreenRecommendOptions {
  mediaFilter: MediaFilter;
  n?: number;
}

export interface ScreenRecommendDeps {
  nowMs: () => number;
  abortAfter: (ms: number) => AbortSignal;
  catalog: (db: Db, deadline: Deadline) => ScreenCatalogPort;
}

export const defaultScreenRecommendDeps: ScreenRecommendDeps = {
  nowMs: () => Date.now(),
  abortAfter: (ms) => AbortSignal.timeout(ms),
  catalog: defaultScreenCatalogPort,
};

interface RankedScreenCandidate extends ScreenPoolCandidate {
  score: number;
  rationale: string;
  grounded_trait_ids: number[];
  grounded_book_ids: number[];
  grounded_title_ids: number[];
}

/**
 * The gate counts a changed title only when it is profile evidence the build would have seen:
 * rated, dropped, or a favorite -- the predicate booksChangedSince applies to books. A new
 * unrated `want` row (what accepting a recommendation creates) never blocks: spec §6.2 says rec
 * feedback does not block the server gate.
 */
export function blocksScreenRecs(t: TitleRow): boolean {
  return effectiveTitleRating(t) !== null || t.status === 'dropped' || t.isFavorite;
}

export function parseSeedProposals(
  input: Record<string, unknown> | null,
  mediaFilter: MediaFilter,
  nowYear: number
): SeedProposal[] {
  const raw = Array.isArray(input?.comparables) ? (input.comparables as unknown[]) : [];
  const seen = new Set<string>();
  const out: SeedProposal[] = [];
  for (const entry of raw) {
    if (out.length >= MAX_SEEDS) break;
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const media = item.media_type;
    const year = item.year;
    if (!title || (media !== 'movie' && media !== 'tv')) continue;
    if (typeof year !== 'number' || !Number.isInteger(year) || year < 1880 || year > nowYear + 2)
      continue;
    if (mediaFilter !== 'both' && media !== mediaFilter) continue;
    const key = `${media}\u0000${title.toLowerCase()}\u0000${year}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      title,
      media_type: media,
      year,
      reason: typeof item.reason === 'string' ? item.reason.trim() : '',
    });
  }
  return out;
}

async function claudeScreenSeeds(
  db: Db,
  client: ClaudeClient,
  signal: ScreenSignal,
  userId: string,
  mediaFilter: MediaFilter,
  abortSignal: AbortSignal
): Promise<SeedProposal[]> {
  const message = await trackedCreate(
    client,
    db,
    { userId, operation: 'screen_rec_seed' },
    {
      model: modelFor('seed'),
      max_tokens: SCREEN_SEED_MAX_TOKENS,
      system: SCREEN_SEED_SYSTEM,
      tools: [SCREEN_SEED_TOOL],
      tool_choice: { type: 'tool', name: SCREEN_SEED_TOOL.name },
      messages: [
        { role: 'user', content: buildScreenSeedPrompt(signal, mediaFilter, SCREEN_SEED_COUNT) },
      ],
    },
    { signal: abortSignal }
  );
  return parseSeedProposals(toolInput(message, ''), mediaFilter, new Date().getUTCFullYear());
}

async function claudeScreenRerank(
  db: Db,
  client: ClaudeClient,
  candidates: ScreenPoolCandidate[],
  signal: ScreenSignal,
  userId: string,
  n: number,
  abortSignal: AbortSignal
): Promise<RankedScreenCandidate[]> {
  const ids = validEvidenceIds(signal, candidates);
  const message = await trackedCreate(
    client,
    db,
    { userId, operation: 'screen_rec_rank' },
    {
      model: modelFor('rerank'),
      max_tokens: SCREEN_RANK_MAX_TOKENS,
      system: SCREEN_RANK_SYSTEM,
      tools: [SCREEN_RANK_TOOL],
      tool_choice: { type: 'tool', name: SCREEN_RANK_TOOL.name },
      messages: [{ role: 'user', content: buildScreenRerankPrompt(candidates, signal, n) }],
    },
    { signal: abortSignal }
  );

  const input = toolInput(message, '');
  const rankedRaw = (input?.recommendations as Array<Record<string, unknown>> | undefined) ?? [];
  const out: RankedScreenCandidate[] = [];
  const seenIdx = new Set<number>();
  for (const r of rankedRaw) {
    const idx = r.candidate_index;
    // Claude cannot add a candidate: an index outside the pool, or a repeat, is dropped.
    if (
      typeof idx !== 'number' ||
      !Number.isInteger(idx) ||
      idx < 0 ||
      idx >= candidates.length ||
      seenIdx.has(idx)
    ) {
      continue;
    }
    seenIdx.add(idx);
    out.push({
      ...candidates[idx],
      score: Number(r.score ?? 0),
      rationale: String(r.rationale ?? '').trim(),
      grounded_trait_ids: asIdList(r.grounded_trait_ids, ids.traitIds),
      grounded_book_ids: asIdList(r.grounded_book_ids, ids.bookIds),
      grounded_title_ids: asIdList(r.grounded_title_ids, ids.titleIds),
    });
  }
  if (rankedRaw.length > 0 && out.length === 0) {
    logDebug('screen-recommend', 'rerank returned no usable candidate indices', {
      userId,
      returned: rankedRaw.length,
      candidates: candidates.length,
      sampleIndex: JSON.stringify(rankedRaw[0]?.candidate_index ?? null),
    });
  }
  out.sort((a, b) => b.score - a.score);
  const withDesc = out.filter((c) => c.description);
  const withoutDesc = out.filter((c) => !c.description);
  return [...withDesc, ...withoutDesc].slice(0, n);
}

export async function runScreenRecommend(
  db: Db,
  client: ClaudeClient | null,
  userId: string,
  opts: ScreenRecommendOptions,
  deps: ScreenRecommendDeps = defaultScreenRecommendDeps
): Promise<Record<string, unknown>> {
  const startMs = deps.nowMs();
  const mediaFilter = opts.mediaFilter;
  const n = opts.n ?? SCREEN_DEFAULT_N;

  await requireScreenEnabled(db, userId);

  // Gate (spec §6.2): mirrors runRecommend, widened to titles and the rebuild reason. No
  // loved-titles requirement: a book-built profile is enough.
  const meta = await ensureProfileMeta(db, userId);
  if (meta.lastProfiledAt === null) throw new ApiError(400, NO_PROFILE_MESSAGE);
  if (await readRebuildReason(db, userId)) throw new ApiError(400, SCREEN_REBUILD_REQUIRED_MESSAGE);
  const changedBooks = await booksChangedSince(db, meta.lastProfiledAt, userId);
  const changedTitles = (await titlesChangedSince(db, meta.lastProfiledAt, userId)).filter(
    blocksScreenRecs
  );
  if (changedBooks.length > 0 || changedTitles.length > 0) {
    throw new ApiError(400, screenStaleMessage(changedBooks.length, changedTitles.length));
  }

  // Seeds always run, so the key is required up front (the book path defers this check only
  // because its seed stage is optional).
  if (!client) throw new ApiError(400, RECOMMEND_NO_KEY_MESSAGE);

  const signal = await buildScreenSignal(db, userId);

  // Stage 1b first: the seed call is paid for, so its titles resolve before the free pools
  // spend the retrieval window. A timeout is not an error -- the other pools still serve.
  let seeds: SeedProposal[] = [];
  let seedTimedOut = false;
  const seedAbort = deps.abortAfter(SEED_BUDGET_MS);
  try {
    seeds = await claudeScreenSeeds(db, client, signal, userId, mediaFilter, seedAbort);
  } catch (err) {
    if (!seedAbort.aborted) throw err;
    seedTimedOut = true;
    logDebug('screen-recommend', 'seed call aborted at the 45s budget', { userId });
  }

  const retrievalDeadline: Deadline = {
    remainingMs: () => startMs + RETRIEVAL_END_MS - deps.nowMs(),
  };
  const port = deps.catalog(db, retrievalDeadline);
  const seedHits = await seedPool(port, seeds, retrievalDeadline);
  const adaptationHits = await adaptationPool(port, signal, mediaFilter, retrievalDeadline);
  const metadataHits = await metadataPool(port, signal, mediaFilter, retrievalDeadline);
  // Merge order is provenance order: an adaptation keeps its "adaptation of" reason.
  const candidates = await assembleScreenPool(
    port,
    [adaptationHits, metadataHits, seedHits],
    signal,
    mediaFilter,
    retrievalDeadline
  );

  const summary = {
    media_filter: mediaFilter,
    candidates: candidates.length,
    pool_adaptation: adaptationHits.length,
    pool_metadata: metadataHits.length,
    pool_seed: seedHits.length,
    seeds: seeds.map((s) => `${s.title} (${s.year})`),
    seed_timed_out: seedTimedOut,
  };

  if (candidates.length === 0) {
    return {
      run_id: null,
      served: 0,
      ...summary,
      note: 'Retrieval surfaced no new candidates (catalog empty or unreachable?).',
      recommendations: [],
    };
  }

  const rerankMs = SCREEN_REQUEST_BUDGET_MS - PERSIST_RESERVE_MS - (deps.nowMs() - startMs);
  if (rerankMs < MIN_RERANK_MS) throw new ApiError(504, SCREEN_TIMEOUT_MESSAGE);
  const rankAbort = deps.abortAfter(rerankMs);
  let ranked: RankedScreenCandidate[];
  try {
    ranked = await claudeScreenRerank(db, client, candidates, signal, userId, n, rankAbort);
  } catch (err) {
    if (rankAbort.aborted) throw new ApiError(504, SCREEN_TIMEOUT_MESSAGE);
    throw err;
  }

  // A rerank that survives none of its own citations must not mint a run: an empty run writes
  // no rows, so GET /screen/recommendations keeps serving the PREVIOUS run (issue #64).
  if (ranked.length === 0) {
    return {
      run_id: null,
      served: 0,
      ...summary,
      note: `The reranker returned no usable picks from ${candidates.length} candidates.`,
      recommendations: [],
    };
  }

  const runId = randomUUID().replace(/-/g, '').slice(0, 12);
  const createdAt = utcnowTs();
  const recsOut: Record<string, unknown>[] = [];
  await db.transaction(async (tx) => {
    for (let i = 0; i < ranked.length; i++) {
      const c = ranked[i];
      const rank = i + 1;
      await tx.insert(schema.titleRecommendations).values({
        userId,
        runId,
        rank,
        mediaType: c.media_type,
        mediaFilter,
        title: c.title,
        year: c.year,
        wikidataQid: c.wikidata_qid,
        tvmazeId: c.tvmaze_id,
        imageUrl: c.image_url,
        genres: c.genres.slice(0, 8),
        description: c.description,
        retrievalPool: c.retrieval_pool,
        seedReason: c.seed_reason,
        score: c.score,
        rationale: c.rationale,
        groundedTraitIds: c.grounded_trait_ids,
        groundedBookIds: c.grounded_book_ids,
        groundedTitleIds: c.grounded_title_ids,
        status: 'served',
        createdAt,
      });
      recsOut.push({
        rank,
        media_type: c.media_type,
        title: c.title,
        year: c.year,
        score: round2(c.score),
        rationale: c.rationale,
        retrieval_pool: c.retrieval_pool,
        seed_reason: c.seed_reason,
        grounded_trait_ids: c.grounded_trait_ids,
        grounded_book_ids: c.grounded_book_ids,
        grounded_title_ids: c.grounded_title_ids,
      });
    }
  });

  return {
    run_id: runId,
    served: recsOut.length,
    ...summary,
    model: modelFor('rerank'),
    recommendations: recsOut,
  };
}
