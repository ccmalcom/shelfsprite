import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from './db';
import { enrichLibrary } from './enrichment';
import { books, enrichment, enrichJobs, titleEnrichment, titles } from './schema';
import type { Deadline } from './screenCatalog';
import {
  persistTitleResolution,
  refreshMovies,
  resolveMovies,
  resolveTv,
  type FixedMovieInput,
  type MovieInput,
  type TitleResolution,
  type TvInput,
} from './screenEnrichment';
import { effectiveRating, tsToIso, utcnowTs } from './serialize';

export const FUNCTION_CEILING_SECONDS = 300; // Assumption: live Vercel Hobby + Fluid compute supports this.
// Restored to 240_000 after the 2026-08-13 continuation test passed against the production custom
// domain (shelfsprite.app). Under a temporary 100s budget, a forced 159-book run spanned two chunks:
// /api/enrich/start ran 18:05:42-18:07:22, re-armed, and /api/enrich/tick ran 47.4s to completion at
// 159/159. That proves the start->tick handoff, which had never once executed in production before
// the proxy matcher fix (proxy.ts matched /api/*, and updateSession 307-redirected the cookieless
// internal tick to /login — a 307 is a successful fetch, so nothing threw and nothing logged).
// Still unproven: tick->tick chaining. The run finished inside the first tick, so no tick ever had
// to re-arm another. At 240_000 this library completes in a single chunk and cannot test it again;
// reproducing it needs a budget near 40_000 or a substantially larger library.
export const CHUNK_BUDGET_MS = 240_000; // Leaves 60s under that assumed ceiling for final writes/response.
export const LEASE_SECONDS = 300;
export const STALE_JOB_SECONDS = 1_800;
export const MAX_JOB_ATTEMPTS = 25;
export const INTERRUPTED_MESSAGE = 'Enrichment was interrupted, please retry.';
export const STALLED_MESSAGE = 'Enrichment made no progress; please retry.';
export const ATTEMPTS_MESSAGE = 'Enrichment exceeded its retry limit; please retry.';

export interface JobOptions {
  force: boolean;
  limit: number | null;
}

export const defaultJobOptions: JobOptions = { force: false, limit: null };

export type JobKind = 'books' | 'screen';

export interface PublicJob {
  job_id: string;
  status: string;
  progress: number;
  total: number;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export type EnrichJobRow = typeof enrichJobs.$inferSelect;

export interface NewJobValues {
  jobId: string;
  userId: string;
  // Required, like progress/total: an insert never relies on a database default.
  kind: JobKind;
  status: string;
  progress: number;
  total: number;
  force: boolean;
  runLimit: number | null;
}

export type JobInsert = (db: Db, values: NewJobValues) => Promise<EnrichJobRow>;

export function serializeJob(row: EnrichJobRow): PublicJob {
  return {
    job_id: row.jobId,
    status: row.status,
    progress: row.progress,
    total: row.total,
    error: row.error,
    started_at: tsToIso(row.startedAt),
    finished_at: tsToIso(row.finishedAt),
  };
}

function storedOptions(row: EnrichJobRow): JobOptions {
  return { force: row.force, limit: row.runLimit };
}

export async function findActiveJob(
  db: Db,
  userId: string,
  kind: JobKind = 'books'
): Promise<EnrichJobRow | null> {
  const rows = await db
    .select()
    .from(enrichJobs)
    .where(
      and(
        eq(enrichJobs.userId, userId),
        eq(enrichJobs.kind, kind),
        inArray(enrichJobs.status, ['pending', 'running'])
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

const insertJob: JobInsert = async (db, values) => {
  const rows = await db.insert(enrichJobs).values(values).returning();
  const row = rows[0];
  if (!row) throw new Error('enrich job insert returned no row');
  return row;
};

function errorMessages(error: unknown): string[] {
  const messages: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current !== null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if ('message' in current && typeof current.message === 'string') messages.push(current.message);
    current = 'cause' in current ? current.cause : null;
  }
  return messages;
}

function isActiveUserViolation(error: unknown): boolean {
  // Wave 4 replaced uq_enrich_jobs_active_user with the (user_id, kind) index.
  return errorMessages(error).some((message) =>
    message.includes('uq_enrich_jobs_active_user_kind')
  );
}

export async function createOrGetActiveJob(
  db: Db,
  userId: string,
  options: JobOptions,
  create: JobInsert = insertJob,
  kind: JobKind = 'books'
): Promise<{ created: boolean; job: PublicJob; options: JobOptions }> {
  const active = await findActiveJob(db, userId, kind);
  if (active) return { created: false, job: serializeJob(active), options: storedOptions(active) };

  try {
    const row = await create(db, {
      jobId: randomUUID(),
      userId,
      kind,
      status: 'pending',
      // progress/total are NOT NULL with no server default in the Alembic-owned
      // table -- Python supplies them from the ORM-level `default=0`. Omitting
      // them here makes drizzle emit SQL `default`, which Postgres rejects.
      progress: 0,
      total: 0,
      force: options.force,
      runLimit: options.limit,
    });
    return { created: true, job: serializeJob(row), options: storedOptions(row) };
  } catch (error) {
    if (!isActiveUserViolation(error)) throw error;
    const winner = await findActiveJob(db, userId, kind);
    if (!winner) throw error;
    return { created: false, job: serializeJob(winner), options: storedOptions(winner) };
  }
}

function storageTimestamp(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

function timestampMillis(timestamp: string): number {
  return Date.parse(`${timestamp.replace(' ', 'T')}Z`);
}

export async function failIfStale(
  db: Db,
  row: EnrichJobRow,
  now = new Date()
): Promise<EnrichJobRow> {
  if (row.status !== 'running' || row.startedAt === null) return row;
  if (now.getTime() - timestampMillis(row.startedAt) <= STALE_JOB_SECONDS * 1_000) return row;

  const finishedAt = storageTimestamp(now);
  await db
    .update(enrichJobs)
    .set({
      status: 'error',
      error: INTERRUPTED_MESSAGE,
      finishedAt,
      leaseExpiresAt: null,
    })
    .where(eq(enrichJobs.id, row.id));
  return {
    ...row,
    status: 'error',
    error: INTERRUPTED_MESSAGE,
    finishedAt,
    leaseExpiresAt: null,
  };
}

export interface ActiveJobRepairSummary {
  examined: number;
  rearmed: number;
  failed: number;
  dispatchFailed: number;
}

export async function repairActiveJobs(
  db: Db,
  now: Date,
  dispatch: (jobId: string) => void | Promise<void>
): Promise<ActiveJobRepairSummary> {
  const activeRows = await db
    .select()
    .from(enrichJobs)
    .where(inArray(enrichJobs.status, ['pending', 'running']));
  let rearmed = 0;
  let failed = 0;
  let dispatchFailed = 0;

  for (const row of activeRows) {
    const repaired = await failIfStale(db, row, now);
    if (repaired.status === 'error') {
      failed += 1;
      continue;
    }
    if (
      repaired.leaseExpiresAt === null ||
      timestampMillis(repaired.leaseExpiresAt) <= now.getTime()
    ) {
      try {
        await dispatch(repaired.jobId);
        rearmed += 1;
      } catch (error) {
        dispatchFailed += 1;
        console.error(`Failed to dispatch enrichment job ${repaired.jobId}`, error);
      }
    }
  }

  return { examined: activeRows.length, rearmed, failed, dispatchFailed };
}

interface RawJobRow {
  id: number;
  job_id: string;
  user_id: string;
  status: string;
  kind: string;
  progress: number;
  total: number;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  lease_expires_at: string | null;
  attempts: number;
  force: boolean;
  run_limit: number | null;
  created_at: string;
}

function hydrateJob(row: RawJobRow): EnrichJobRow {
  return {
    id: row.id,
    jobId: row.job_id,
    userId: row.user_id,
    status: row.status,
    kind: row.kind,
    progress: row.progress,
    total: row.total,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
    leaseExpiresAt: row.lease_expires_at,
    attempts: row.attempts,
    force: row.force,
    runLimit: row.run_limit,
    createdAt: row.created_at,
  };
}

export async function claimJob(db: Db, jobId: string, now: Date): Promise<EnrichJobRow | null> {
  const nowTs = storageTimestamp(now);
  const leaseTs = storageTimestamp(new Date(now.getTime() + LEASE_SECONDS * 1_000));
  const result = await db.execute(sql`
    update enrich_jobs
    set status = 'running',
        started_at = coalesce(started_at, ${nowTs}),
        lease_expires_at = ${leaseTs},
        attempts = attempts + 1
    where job_id = ${jobId}
      and status in ('pending', 'running')
      and (lease_expires_at is null or lease_expires_at <= ${nowTs})
    returning *
  `);
  const rows = Array.isArray(result) ? result : (result as { rows: unknown[] }).rows;
  const row = rows[0] as RawJobRow | undefined;
  return row ? hydrateJob(row) : null;
}

interface RunOptions extends JobOptions {
  startedAt: string;
}

export interface RunClaimedChunkDeps {
  nowMs: () => number;
  runOne: (db: Db, bookId: number, options: JobOptions) => Promise<void>;
  dispatch: (jobId: string) => Promise<void>;
}

export interface RunClaimedChunkResult {
  outcome: 'done' | 'error' | 'continued';
  progressBefore: number;
  progressAfter: number;
  remaining: number;
  rearmed: boolean;
}

interface CandidateRow {
  book: typeof books.$inferSelect;
  enrichment: typeof enrichment.$inferSelect | null;
}

async function candidateRows(db: Db, userId: string): Promise<CandidateRow[]> {
  const rows = await db
    .select({ book: books, enrichment })
    .from(books)
    .leftJoin(enrichment, eq(enrichment.bookId, books.id))
    .where(eq(books.userId, userId));
  return rows.filter(({ book }) => effectiveRating(book.appRating, book.goodreadsRating) !== null);
}

/** A candidate row of either kind; the recount only reads its enrichment timestamp. */
interface RecountRow {
  enrichment: { resolvedAt: string } | null;
}

function processedThisRun(rows: readonly RecountRow[], startedAt: string): number {
  return rows.filter((row) => row.enrichment !== null && row.enrichment.resolvedAt >= startedAt)
    .length;
}

function selectableRows<T extends RecountRow>(rows: readonly T[], options: RunOptions): T[] {
  return rows.filter(({ enrichment: existing }) =>
    options.force ? existing === null || existing.resolvedAt < options.startedAt : existing === null
  );
}

function limitedCount(count: number, limit: number | null): number {
  if (limit === null) return count;
  return Math.min(count, limit);
}

interface ChunkState {
  progress: number;
  remaining: number;
  total: number;
}

function deriveFromRows(rows: readonly RecountRow[], options: RunOptions): ChunkState {
  const processed = processedThisRun(rows, options.startedAt);
  const preexisting = rows.filter(
    (row) => row.enrichment !== null && row.enrichment.resolvedAt < options.startedAt
  ).length;
  const selectable = selectableRows(rows, options).length;
  const allowance = options.limit === null ? selectable : Math.max(0, options.limit - processed);
  const remaining = Math.min(selectable, allowance);
  const initialWork = options.force
    ? rows.length
    : rows.filter((row) => row.enrichment === null).length + processed;
  const skipped = options.force ? 0 : preexisting;
  const total = skipped + limitedCount(initialWork, options.limit);
  return {
    progress: processed + (options.force ? 0 : preexisting),
    remaining,
    total,
  };
}

async function deriveState(db: Db, userId: string, options: RunOptions): Promise<ChunkState> {
  return deriveFromRows(await candidateRows(db, userId), options);
}

export async function countPersistedEnrichment(
  db: Db,
  userId: string,
  options: RunOptions
): Promise<number> {
  return (await deriveState(db, userId, options)).progress;
}

async function nextUnenrichedBook(
  db: Db,
  userId: string,
  options: RunOptions
): Promise<typeof books.$inferSelect | null> {
  const rows = await candidateRows(db, userId);
  return selectableRows(rows, options)[0]?.book ?? null;
}

async function writeDerivedProgress(
  db: Db,
  jobId: string,
  derived: number,
  total: number
): Promise<void> {
  await db.update(enrichJobs).set({ progress: derived, total }).where(eq(enrichJobs.jobId, jobId));
}

async function writeTerminal(
  db: Db,
  jobId: string,
  status: 'done' | 'error',
  progress: number,
  total: number,
  error: string | null
): Promise<void> {
  await db
    .update(enrichJobs)
    .set({
      status,
      progress,
      total,
      error: error?.slice(0, 2_000) ?? null,
      finishedAt: utcnowTs(),
      leaseExpiresAt: null,
    })
    .where(eq(enrichJobs.jobId, jobId));
}

export function oneBookEnrichmentRunner(userId: string): RunClaimedChunkDeps['runOne'] {
  return async (db, bookId, options) => {
    await enrichLibrary(db, { userId, force: options.force, bookIds: [bookId] });
  };
}

function runOptions(job: EnrichJobRow): RunOptions {
  if (job.startedAt === null) throw new Error('claimed enrichment job has no started_at');
  return { force: job.force, limit: job.runLimit, startedAt: job.startedAt };
}

interface ChunkWork {
  /** Recount from persisted rows -- never an in-memory counter (CLAUDE.md). */
  derive(): Promise<ChunkState>;
  /** Run the next unit of work; false when nothing is selectable. */
  runNext(deadline: Deadline): Promise<boolean>;
}

/**
 * The time-bounded chunk loop shared by both kinds. The book path's call sequence --
 * derive, budget check, next work, derive, write progress, stall check -- is exactly the
 * pre-wave-5 runClaimedChunk body, including where nowMs() is called: the existing tests
 * drive a sequence clock and would shift if a call were added or moved.
 */
async function runChunkLoop(
  db: Db,
  job: EnrichJobRow,
  work: ChunkWork,
  nowMs: () => number,
  dispatch: (jobId: string) => Promise<void>
): Promise<RunClaimedChunkResult> {
  const initial = await work.derive();
  const progressBefore = initial.progress;

  if (job.attempts > MAX_JOB_ATTEMPTS) {
    await writeTerminal(db, job.jobId, 'error', progressBefore, initial.total, ATTEMPTS_MESSAGE);
    return {
      outcome: 'error',
      progressBefore,
      progressAfter: progressBefore,
      remaining: initial.remaining,
      rearmed: false,
    };
  }

  const startedMs = nowMs();
  // Lazy: the book path never calls it, so its clock sequence is unchanged.
  const deadline: Deadline = { remainingMs: () => CHUNK_BUDGET_MS - (nowMs() - startedMs) };
  let lastDerived = progressBefore;
  while ((await work.derive()).remaining > 0) {
    if (nowMs() - startedMs >= CHUNK_BUDGET_MS) break;
    if (!(await work.runNext(deadline))) break;
    const derived = (await work.derive()).progress;
    await writeDerivedProgress(db, job.jobId, derived, initial.total);
    if (derived === lastDerived) break;
    lastDerived = derived;
  }
  const finalState = await work.derive();
  const progressAfter = finalState.progress;

  if (finalState.remaining === 0) {
    await writeTerminal(db, job.jobId, 'done', progressAfter, initial.total, null);
    return {
      outcome: 'done',
      progressBefore,
      progressAfter,
      remaining: 0,
      rearmed: false,
    };
  }

  if (progressAfter === progressBefore) {
    await writeTerminal(db, job.jobId, 'error', progressAfter, initial.total, STALLED_MESSAGE);
    return {
      outcome: 'error',
      progressBefore,
      progressAfter,
      remaining: finalState.remaining,
      rearmed: false,
    };
  }

  await db
    .update(enrichJobs)
    .set({ progress: progressAfter, total: initial.total, leaseExpiresAt: null })
    .where(eq(enrichJobs.jobId, job.jobId));
  let rearmed = true;
  try {
    await dispatch(job.jobId);
  } catch (error) {
    rearmed = false;
    console.error(`Failed to dispatch enrichment job ${job.jobId}`, error);
  }
  return {
    outcome: 'continued',
    progressBefore,
    progressAfter,
    remaining: finalState.remaining,
    rearmed,
  };
}

export async function runClaimedChunk(
  db: Db,
  job: EnrichJobRow,
  deps: RunClaimedChunkDeps
): Promise<RunClaimedChunkResult> {
  const options = runOptions(job);
  return runChunkLoop(
    db,
    job,
    {
      derive: () => deriveState(db, job.userId, options),
      runNext: async () => {
        const next = await nextUnenrichedBook(db, job.userId, options);
        if (!next) return false;
        await deps.runOne(db, next.id, options);
        return true;
      },
    },
    deps.nowMs,
    deps.dispatch
  );
}

// --- Screen enrichment (spec §4.6) ----------------------------------------------------

/**
 * Titles per loop iteration. The resolver batches Stage A SPARQL (~120 names per query)
 * and wbgetentities (50 ids per call), so one iteration per title would waste both. The
 * loop still recounts from persisted rows after every batch, and a batch that persists
 * nothing trips the stall check exactly as a book that fails to persist does.
 */
export const SCREEN_BATCH_SIZE = 50;

/**
 * Progress is recounted per batch, so a small library resolved as one batch jumps from 0 to done.
 * Split the run into about ten batches (never fewer than 5 titles each, never more than
 * SCREEN_BATCH_SIZE) so the bar moves, at the cost of a few extra queries for a small library.
 */
export function screenBatchSize(total: number): number {
  return Math.min(SCREEN_BATCH_SIZE, Math.max(5, Math.ceil(total / 10)));
}

export interface ScreenChunkDeps {
  nowMs: () => number;
  runBatch: (db: Db, titleIds: number[], options: JobOptions, deadline: Deadline) => Promise<void>;
  dispatch: (jobId: string) => Promise<void>;
}

interface ScreenCandidateRow {
  title: typeof titles.$inferSelect;
  enrichment: typeof titleEnrichment.$inferSelect | null;
}

/** Every title is a candidate: the want list needs identity for dedup and images (§4.6). */
async function screenCandidateRows(db: Db, userId: string): Promise<ScreenCandidateRow[]> {
  return db
    .select({ title: titles, enrichment: titleEnrichment })
    .from(titles)
    .leftJoin(titleEnrichment, eq(titleEnrichment.titleId, titles.id))
    .where(eq(titles.userId, userId))
    .orderBy(asc(titles.id));
}

export async function runClaimedScreenChunk(
  db: Db,
  job: EnrichJobRow,
  deps: ScreenChunkDeps
): Promise<RunClaimedChunkResult> {
  if (job.kind !== 'screen') throw new Error(`runClaimedScreenChunk was given a ${job.kind} job`);
  const options = runOptions(job);
  return runChunkLoop(
    db,
    job,
    {
      derive: async () => deriveFromRows(await screenCandidateRows(db, job.userId), options),
      runNext: async (deadline) => {
        const rows = await screenCandidateRows(db, job.userId);
        const { remaining, total } = deriveFromRows(rows, options);
        const batch = selectableRows(rows, options).slice(
          0,
          Math.min(screenBatchSize(total), remaining)
        );
        if (batch.length === 0) return false;
        await deps.runBatch(
          db,
          batch.map((row) => row.title.id),
          options,
          deadline
        );
        return true;
      },
    },
    deps.nowMs,
    deps.dispatch
  );
}

/**
 * Resolves one batch and persists every definite result in one transaction. Routing
 * (design decision 9): a TV title with a TVmaze id refreshes through TVmaze and the
 * crosswalk; a manual or corrected movie refreshes metadata by its QID; everything else is
 * resolved from its title and year. A deferred title writes nothing, so the next batch or
 * chunk retries it.
 */
export function screenEnrichmentRunner(userId: string): ScreenChunkDeps['runBatch'] {
  return async (db, titleIds, _options, deadline) => {
    if (titleIds.length === 0) return;
    const rows = await db
      .select({ title: titles, enrichment: titleEnrichment })
      .from(titles)
      .leftJoin(titleEnrichment, eq(titleEnrichment.titleId, titles.id))
      .where(and(eq(titles.userId, userId), inArray(titles.id, titleIds)))
      .orderBy(asc(titles.id));

    const movies: MovieInput[] = [];
    const fixed: FixedMovieInput[] = [];
    const shows: TvInput[] = [];
    for (const { title, enrichment: existing } of rows) {
      const fixedIdentity =
        existing?.identitySource === 'manual' || existing?.identitySource === 'corrected';
      if (title.mediaType === 'tv' && title.tvmazeId !== null) {
        shows.push({ id: title.id, tvmazeId: title.tvmazeId });
      } else if (fixedIdentity && title.wikidataQid !== null) {
        fixed.push({ id: title.id, wikidataQid: title.wikidataQid });
      } else {
        movies.push({ id: title.id, title: title.title, year: title.year });
      }
    }

    const results = new Map<number, TitleResolution>([
      ...(await resolveMovies(db, movies, deadline)),
      ...(await refreshMovies(db, fixed, deadline)),
      ...(await resolveTv(db, shows, deadline)),
    ]);

    await db.transaction(async (tx) => {
      for (const { title } of rows) {
        const result = results.get(title.id);
        if (!result || result.kind === 'deferred') continue;
        await persistTitleResolution(tx, title.id, result);
      }
    });
  };
}
