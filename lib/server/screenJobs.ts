/**
 * Screen enrichment job entry points (spec §4.6), shared by the import and start routes.
 * The chunk itself lives in enrichmentJobs.ts (runClaimedScreenChunk); this module only
 * decides when a chunk is queued and when one runs inline.
 */
import { eq } from 'drizzle-orm';
import type { Db } from './db';
import { rearmAfterResponse } from './enrichmentDispatch';
import {
  claimJob,
  createOrGetActiveJob,
  defaultJobOptions,
  runClaimedScreenChunk,
  screenEnrichmentRunner,
  serializeJob,
  type JobOptions,
  type PublicJob,
} from './enrichmentJobs';
import { enrichJobs } from './schema';

async function readPublicJob(db: Db, jobId: string): Promise<PublicJob> {
  const [row] = await db.select().from(enrichJobs).where(eq(enrichJobs.jobId, jobId)).limit(1);
  if (!row) throw new Error(`screen enrichment job disappeared: ${jobId}`);
  return serializeJob(row);
}

/**
 * Create or reuse the user's active screen job and hand its first chunk to /api/enrich/tick
 * after the response (design decision 11: the import route never runs a chunk inline). A job
 * that already exists is not re-dispatched: its own chain of ticks, or startScreenEnrichment,
 * is already responsible for it, and the loop recounts selectable titles before every batch,
 * so titles imported now are picked up by it.
 */
export async function queueScreenEnrichment(
  db: Db,
  request: Request,
  userId: string
): Promise<PublicJob> {
  const { created, job } = await createOrGetActiveJob(
    db,
    userId,
    defaultJobOptions,
    undefined,
    'screen'
  );
  if (created) {
    try {
      rearmAfterResponse(request, job.job_id);
    } catch (error) {
      // No CRON_SECRET: the job stays pending with no lease. startScreenEnrichment ("Retry
      // enrichment") claims it, and so does the daily janitor.
      console.error(`Failed to dispatch screen enrichment job ${job.job_id}`, error);
    }
  }
  return job;
}

/**
 * Start or resume the user's screen job and run one chunk inline, as the book start route
 * does. Unlike the book route it also claims an existing job whose lease is free, so a job
 * whose first dispatch never ran is recovered here rather than a day later by the janitor.
 * claimJob is an atomic conditional update, so this can never run a second concurrent chunk.
 */
export async function startScreenEnrichment(
  db: Db,
  request: Request,
  userId: string,
  options: JobOptions
): Promise<PublicJob> {
  const { job } = await createOrGetActiveJob(db, userId, options, undefined, 'screen');
  const claimed = await claimJob(db, job.job_id, new Date());
  if (!claimed) return readPublicJob(db, job.job_id);
  await runClaimedScreenChunk(db, claimed, {
    nowMs: () => Date.now(),
    runBatch: screenEnrichmentRunner(userId),
    dispatch: async (jobId) => {
      rearmAfterResponse(request, jobId);
    },
  });
  return readPublicJob(db, job.job_id);
}
