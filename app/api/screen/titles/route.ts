import { and, asc, eq, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, schema } from '@/lib/server/db';
import { ApiError, withApi } from '@/lib/server/http';
import { requireScreenEnabled } from '@/lib/server/screenSettings';
import { MEDIA_TYPES, TITLE_STATUSES, titleOut } from '@/lib/server/titles';

const Query = z.object({
  type: z.enum(MEDIA_TYPES).optional(),
  status: z.enum(TITLE_STATUSES).optional(),
});

export const GET = withApi('/api/screen/titles', async (req, ctx) => {
  const url = new URL(req.url);
  const parsed = Query.safeParse({
    type: url.searchParams.get('type') ?? undefined,
    status: url.searchParams.get('status') ?? undefined,
  });
  if (!parsed.success) {
    throw new ApiError(
      422,
      "type must be 'movie' or 'tv'; status must be watched, watching, dropped or want."
    );
  }
  const db = getDb();
  await requireScreenEnabled(db, ctx.user.userId);
  const conds: SQL[] = [eq(schema.titles.userId, ctx.user.userId)];
  if (parsed.data.type) conds.push(eq(schema.titles.mediaType, parsed.data.type));
  if (parsed.data.status) conds.push(eq(schema.titles.status, parsed.data.status));
  const rows = await db
    .select({ title: schema.titles, enrichment: schema.titleEnrichment })
    .from(schema.titles)
    .leftJoin(schema.titleEnrichment, eq(schema.titleEnrichment.titleId, schema.titles.id))
    .where(and(...conds))
    .orderBy(asc(schema.titles.id));
  ctx.timer.mark('db');
  return Response.json(rows.map((r) => titleOut(r.title, r.enrichment)));
});
