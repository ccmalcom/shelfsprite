import { eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../db';
import {
  CHUNK_BUDGET_MS,
  SCREEN_BATCH_SIZE,
  STALLED_MESSAGE,
  createOrGetActiveJob,
  defaultJobOptions,
  findActiveJob,
  runClaimedScreenChunk,
  screenEnrichmentRunner,
  type EnrichJobRow,
  type JobInsert,
} from '../enrichmentJobs';
import { _setScreenCatalogHooksForTests, type Deadline } from '../screenCatalog';
import { books, enrichment, enrichJobs, titleEnrichment, titles } from '../schema';
import { makeTestDb } from './helpers/pglite';

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await makeTestDb());
});

afterEach(async () => {
  vi.unstubAllGlobals();
  _setScreenCatalogHooksForTests(null);
  await close();
});

function errorText(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  return [
    error instanceof Error ? error.message : String(error),
    cause instanceof Error ? cause.message : String(cause ?? ''),
  ].join(' ');
}

async function seedTitles(userId: string, count: number): Promise<number[]> {
  const rows = await db
    .insert(titles)
    .values(
      Array.from({ length: count }, (_, i) => ({
        userId,
        mediaType: 'movie',
        title: `Heat ${i}`,
        year: 1995,
        status: 'watched',
      }))
    )
    .returning({ id: titles.id });
  return rows.map((row) => row.id);
}

async function seedScreenJob(userId: string): Promise<EnrichJobRow> {
  const [row] = await db
    .insert(enrichJobs)
    .values({
      jobId: `screen-${userId}`,
      userId,
      kind: 'screen',
      status: 'running',
      progress: 0,
      total: 0,
      attempts: 1,
      startedAt: '2026-08-11 12:00:00.000',
      leaseExpiresAt: '2026-08-11 12:05:00.000',
    })
    .returning();
  return row;
}

const persistAll = async (_db: Db, titleIds: number[]) => {
  for (const titleId of titleIds) {
    await db.insert(titleEnrichment).values({
      titleId,
      resolutionConfidence: 0.95,
      confidenceLabel: 'HIGH',
      resolvedAt: '2026-08-11 12:00:01.000',
    });
  }
};

const noDispatch = async () => undefined;

describe('job kinds', () => {
  it('lets a book job and a screen job be active for one user at once', async () => {
    const book = await createOrGetActiveJob(db, 'user-a', defaultJobOptions);
    const screen = await createOrGetActiveJob(db, 'user-a', defaultJobOptions, undefined, 'screen');
    const again = await createOrGetActiveJob(db, 'user-a', defaultJobOptions, undefined, 'screen');
    expect([book.created, screen.created, again.created]).toEqual([true, true, false]);
    expect(again.job.job_id).toBe(screen.job.job_id);
    expect(screen.job.job_id).not.toBe(book.job.job_id);
    expect((await findActiveJob(db, 'user-a', 'screen'))?.jobId).toBe(screen.job.job_id);
    expect((await findActiveJob(db, 'user-a'))?.jobId).toBe(book.job.job_id);
    const kinds = await db.select({ kind: enrichJobs.kind }).from(enrichJobs);
    expect(kinds.map((k) => k.kind).sort()).toEqual(['books', 'screen']);
  });

  it('still rejects a second active screen job through the (user_id, kind) index', async () => {
    const values = { userId: 'user-a', kind: 'screen', status: 'pending', progress: 0, total: 0 };
    await db.insert(enrichJobs).values({ ...values, jobId: 'one' });
    let message = '';
    try {
      await db.insert(enrichJobs).values({ ...values, jobId: 'two' });
    } catch (error) {
      message = errorText(error);
    }
    expect(message).toContain('uq_enrich_jobs_active_user_kind');
  });

  it('recovers a racing screen insert by returning the screen winner', async () => {
    const insert: JobInsert = async (conn, values) => {
      await conn.insert(enrichJobs).values({ ...values, jobId: 'winner' });
      const [row] = await conn.insert(enrichJobs).values(values).returning();
      return row;
    };
    const out = await createOrGetActiveJob(db, 'user-a', defaultJobOptions, insert, 'screen');
    expect([out.created, out.job.job_id]).toEqual([false, 'winner']);
  });
});

describe('runClaimedScreenChunk', () => {
  it('runs a batch and recounts progress from title_enrichment rows', async () => {
    const ids = await seedTitles('user-a', 3);
    const job = await seedScreenJob('user-a');
    const runBatch = vi.fn(persistAll);
    const result = await runClaimedScreenChunk(db, job, {
      nowMs: () => 0,
      runBatch,
      dispatch: noDispatch,
    });
    expect(runBatch.mock.calls.map((call) => call[1])).toEqual([ids]);
    expect(result).toEqual({
      outcome: 'done',
      progressBefore: 0,
      progressAfter: 3,
      remaining: 0,
      rearmed: false,
    });
    const [row] = await db.select().from(enrichJobs).where(eq(enrichJobs.jobId, job.jobId));
    expect([row.status, row.progress, row.total]).toEqual(['done', 3, 3]);
  });

  it(`hands at most ${SCREEN_BATCH_SIZE} titles to each batch`, async () => {
    await seedTitles('user-a', SCREEN_BATCH_SIZE + 10);
    const job = await seedScreenJob('user-a');
    const runBatch = vi.fn(persistAll);
    const result = await runClaimedScreenChunk(db, job, {
      nowMs: () => 0,
      runBatch,
      dispatch: noDispatch,
    });
    expect(runBatch.mock.calls.map((call) => call[1].length)).toEqual([SCREEN_BATCH_SIZE, 10]);
    expect(result.outcome).toBe('done');
  });

  it('gives each batch a deadline measured on the chunk clock', async () => {
    await seedTitles('user-a', 1);
    const job = await seedScreenJob('user-a');
    let seen = -1;
    await runClaimedScreenChunk(db, job, {
      nowMs: () => 5_000,
      runBatch: async (conn, titleIds, _options, deadline: Deadline) => {
        seen = deadline.remainingMs();
        await persistAll(conn, titleIds);
      },
      dispatch: noDispatch,
    });
    expect(seen).toBe(CHUNK_BUDGET_MS);
  });

  it('fails the job when a chunk persists nothing (stall check)', async () => {
    await seedTitles('user-a', 2);
    const job = await seedScreenJob('user-a');
    const dispatch = vi.fn(noDispatch);
    const result = await runClaimedScreenChunk(db, job, {
      nowMs: () => 0,
      runBatch: async () => undefined,
      dispatch,
    });
    expect([result.outcome, dispatch.mock.calls.length]).toEqual(['error', 0]);
    const [row] = await db.select().from(enrichJobs).where(eq(enrichJobs.jobId, job.jobId));
    expect([row.status, row.error]).toEqual(['error', STALLED_MESSAGE]);
  });

  it("never selects books, and never another user's titles", async () => {
    await db
      .insert(books)
      .values({ userId: 'user-a', title: 'Dune', goodreadsRating: 5, source: 'test' });
    const mine = await seedTitles('user-a', 1);
    await seedTitles('user-b', 2);
    const job = await seedScreenJob('user-a');
    const runBatch = vi.fn(persistAll);
    await runClaimedScreenChunk(db, job, { nowMs: () => 0, runBatch, dispatch: noDispatch });
    expect(runBatch.mock.calls.map((call) => call[1])).toEqual([mine]);
    expect(await db.select().from(enrichment)).toEqual([]);
  });

  it('refuses a book job', async () => {
    const job = { ...(await seedScreenJob('user-a')), kind: 'books' };
    await expect(
      runClaimedScreenChunk(db, job, { nowMs: () => 0, runBatch: persistAll, dispatch: noDispatch })
    ).rejects.toThrow(/books/);
  });

  it('runs a screen chunk against a failing catalog and persists nothing', async () => {
    // Review Focus 1 and the spec §10 transport test: a retryable failure never persists
    // "unresolved", and the job ends in an error the user can retry.
    _setScreenCatalogHooksForTests({ sleep: async () => undefined });
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 503 }));
    const ids = await seedTitles('user-a', 3);
    const job = await seedScreenJob('user-a');
    const result = await runClaimedScreenChunk(db, job, {
      nowMs: () => 0,
      runBatch: screenEnrichmentRunner('user-a'),
      dispatch: noDispatch,
    });
    expect(
      await db.select().from(titleEnrichment).where(inArray(titleEnrichment.titleId, ids))
    ).toEqual([]);
    expect(result.outcome).toBe('error');
    const [row] = await db.select().from(enrichJobs).where(eq(enrichJobs.jobId, job.jobId));
    expect(row.error).toBe(STALLED_MESSAGE);
  });
});
