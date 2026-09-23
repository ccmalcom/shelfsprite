import { and, asc, desc, eq } from 'drizzle-orm';
import { getDb, schema } from '@/lib/server/db';
import { withApi } from '@/lib/server/http';
import { titleRecOut } from '@/lib/server/screenRecs';
import { requireScreenEnabled } from '@/lib/server/screenSettings';

const recs = schema.titleRecommendations;

/** Spec §6.6: the latest run across filters, rank order. The twin of GET /api/recommendations. */
export const GET = withApi('/api/screen/recommendations', async (_req, ctx) => {
  const db = getDb();
  const userId = ctx.user.userId;
  await requireScreenEnabled(db, userId);
  const last = await db
    .select({ runId: recs.runId })
    .from(recs)
    .where(eq(recs.userId, userId))
    .orderBy(desc(recs.createdAt), desc(recs.id))
    .limit(1);
  if (last.length === 0) {
    ctx.timer.mark('db');
    return Response.json([]);
  }
  const rows = await db
    .select()
    .from(recs)
    .where(and(eq(recs.userId, userId), eq(recs.runId, last[0].runId)))
    .orderBy(asc(recs.rank));
  ctx.timer.mark('db');
  return Response.json(rows.map(titleRecOut));
});
