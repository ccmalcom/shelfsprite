import { eq } from 'drizzle-orm';
import { withApi } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { suggestPreferences } from '@/lib/server/preferenceSuggest';

/**
 * Deterministic favorites suggestions drawn from the caller's own loved books. No
 * Claude call and no catalog call, so unlike POST /directive/draft this route
 * deliberately has no RATE_LIMITS entry.
 *
 * Reads the caller's stored constraints so a value they already listed (as a
 * favorite OR as an exclusion) is never proposed back to them.
 */
export const GET = withApi('/api/directive/suggestions', async (_req, ctx) => {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.userDirective)
    .where(eq(schema.userDirective.userId, ctx.user.userId));
  const constraints = (rows[0]?.constraints ?? {}) as Record<string, unknown>;
  const suggestions = await suggestPreferences(db, ctx.user.userId, constraints);
  ctx.timer.mark('db');
  return Response.json(suggestions);
});
