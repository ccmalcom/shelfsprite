import { getDb } from '@/lib/server/db';
import { failIfStale, findActiveJob, serializeJob } from '@/lib/server/enrichmentJobs';
import { withApi } from '@/lib/server/http';
import { requireScreenEnabled } from '@/lib/server/screenSettings';

/**
 * The caller's active screen job, so a reload or a reopened import modal recovers its
 * progress view (spec §4.6, §7.4). Progress then polls the shared
 * GET /api/enrich/status/{job_id}. A stale job comes back as the error it now is.
 */
export const GET = withApi('/api/screen/enrich/active', async (_req, ctx) => {
  const db = getDb();
  await requireScreenEnabled(db, ctx.user.userId);
  const found = await findActiveJob(db, ctx.user.userId, 'screen');
  const job = found ? serializeJob(await failIfStale(db, found, new Date())) : null;
  ctx.timer.mark('db');
  return Response.json({ job });
});
