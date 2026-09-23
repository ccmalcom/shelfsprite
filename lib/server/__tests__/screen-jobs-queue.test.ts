import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../db';
import { _setDispatchForTests } from '../enrichmentDispatch';
import { defaultJobOptions } from '../enrichmentJobs';
import { enrichJobs } from '../schema';
import { makeTestDb } from './helpers/pglite';

const { runClaimedScreenChunkMock } = vi.hoisted(() => ({ runClaimedScreenChunkMock: vi.fn() }));

vi.mock('../enrichmentJobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../enrichmentJobs')>()),
  runClaimedScreenChunk: runClaimedScreenChunkMock,
}));

import { queueScreenEnrichment, startScreenEnrichment } from '../screenJobs';

let db: Db;
let close: () => Promise<void>;
let scheduled: Array<() => void | Promise<void>>;
const request = () => new Request('http://test/api/screen/import', { method: 'POST' });

beforeEach(async () => {
  ({ db, close } = await makeTestDb());
  scheduled = [];
  _setDispatchForTests({ schedule: (callback) => void scheduled.push(callback) });
  vi.stubEnv('CRON_SECRET', 'test-cron-secret');
  runClaimedScreenChunkMock.mockReset();
  runClaimedScreenChunkMock.mockResolvedValue({
    outcome: 'continued',
    progressBefore: 0,
    progressAfter: 1,
    remaining: 1,
    rearmed: true,
  });
});

afterEach(async () => {
  _setDispatchForTests(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await close();
});

async function jobRows() {
  return db.select().from(enrichJobs).orderBy(enrichJobs.id);
}

describe('queueScreenEnrichment', () => {
  it('queues a pending screen job and schedules its first tick after the response', async () => {
    const job = await queueScreenEnrichment(db, request(), 'user-a');
    expect(job.status).toBe('pending');
    expect(scheduled).toHaveLength(1);
    expect(runClaimedScreenChunkMock).not.toHaveBeenCalled();
    const [row] = await jobRows();
    expect([row.jobId, row.kind, row.userId, row.leaseExpiresAt]).toEqual([
      job.job_id,
      'screen',
      'user-a',
      null,
    ]);
  });

  it('reuses the active screen job without scheduling a second tick', async () => {
    const first = await queueScreenEnrichment(db, request(), 'user-a');
    const second = await queueScreenEnrichment(db, request(), 'user-a');
    expect(second.job_id).toBe(first.job_id);
    expect(scheduled).toHaveLength(1);
    expect(await jobRows()).toHaveLength(1);
  });

  it('sits beside an active book job instead of reusing it', async () => {
    await db.insert(enrichJobs).values({
      jobId: 'book-job',
      userId: 'user-a',
      kind: 'books',
      status: 'running',
      progress: 0,
      total: 0,
    });
    const job = await queueScreenEnrichment(db, request(), 'user-a');
    expect(job.job_id).not.toBe('book-job');
    expect((await jobRows()).map((row) => [row.jobId === 'book-job', row.kind])).toEqual([
      [true, 'books'],
      [false, 'screen'],
    ]);
  });

  it('leaves the job pending, and does not throw, when the tick cannot be scheduled', async () => {
    vi.stubEnv('CRON_SECRET', '');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const job = await queueScreenEnrichment(db, request(), 'user-a');
    expect(job.status).toBe('pending');
    expect(scheduled).toHaveLength(0);
    expect(errors).toHaveBeenCalledTimes(1);
  });
});

describe('startScreenEnrichment', () => {
  it('creates a screen job, claims it and runs one chunk inline', async () => {
    const job = await startScreenEnrichment(db, request(), 'user-a', defaultJobOptions);
    expect(runClaimedScreenChunkMock).toHaveBeenCalledTimes(1);
    expect(runClaimedScreenChunkMock.mock.calls[0][1]).toMatchObject({
      jobId: job.job_id,
      kind: 'screen',
      userId: 'user-a',
      status: 'running',
    });
    expect(job.status).toBe('running');
  });

  it('claims a stranded pending job that it did not create', async () => {
    vi.stubEnv('CRON_SECRET', '');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const queued = await queueScreenEnrichment(db, request(), 'user-a'); // dispatch failed
    vi.stubEnv('CRON_SECRET', 'test-cron-secret');
    const started = await startScreenEnrichment(db, request(), 'user-a', defaultJobOptions);
    expect(started.job_id).toBe(queued.job_id);
    expect(runClaimedScreenChunkMock).toHaveBeenCalledTimes(1);
  });

  it('runs nothing while another chunk holds the lease', async () => {
    const leaseUntil = new Date(Date.now() + 60_000).toISOString();
    await db.insert(enrichJobs).values({
      jobId: 'held',
      userId: 'user-a',
      kind: 'screen',
      status: 'running',
      progress: 0,
      total: 0,
      attempts: 1,
      startedAt: new Date().toISOString(),
      leaseExpiresAt: leaseUntil,
    });
    const job = await startScreenEnrichment(db, request(), 'user-a', defaultJobOptions);
    expect(job.job_id).toBe('held');
    expect(runClaimedScreenChunkMock).not.toHaveBeenCalled();
    const [row] = await db.select().from(enrichJobs).where(eq(enrichJobs.jobId, 'held'));
    expect(row.attempts).toBe(1);
  });

  it("never claims another user's screen job", async () => {
    await db.insert(enrichJobs).values({
      jobId: 'theirs',
      userId: 'user-b',
      kind: 'screen',
      status: 'pending',
      progress: 0,
      total: 0,
    });
    const job = await startScreenEnrichment(db, request(), 'user-a', defaultJobOptions);
    expect(job.job_id).not.toBe('theirs');
    const [theirs] = await db.select().from(enrichJobs).where(eq(enrichJobs.jobId, 'theirs'));
    expect([theirs.status, theirs.attempts]).toEqual(['pending', 0]);
  });
});
