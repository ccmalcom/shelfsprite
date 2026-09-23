import { z } from 'zod';
import { getDb } from '@/lib/server/db';
import { ApiError, withApi } from '@/lib/server/http';
import { checkRateLimit, RATE_LIMITS } from '@/lib/server/ratelimit';
import { startScreenEnrichment } from '@/lib/server/screenJobs';
import { requireScreenEnabled } from '@/lib/server/screenSettings';

const Body = z.object({
  force: z.boolean().default(false),
  limit: z.number().int().positive().nullable().default(null),
});

// Next.js requires a statically analyzable literal here -- an imported binding fails the build
// with "Invalid segment configuration export detected". Must stay equal to
// FUNCTION_CEILING_SECONDS in lib/server/enrichmentJobs.ts; enrich-max-duration.test.ts asserts it.
export const maxDuration = 300;

/** Start or resume the screen enrichment job (spec §4.6); "Retry enrichment" in settings. */
export const POST = withApi('/api/screen/enrich/start', async (req, ctx) => {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiError(422, 'request body must be JSON');
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(
      422,
      `validation error: ${parsed.error.issues[0]?.message ?? 'invalid body'}`
    );
  }
  const db = getDb();
  await requireScreenEnabled(db, ctx.user.userId);
  const rateLimit = await checkRateLimit(db, {
    key: `screenEnrichStart:${ctx.user.userId}`,
    ...RATE_LIMITS.screenEnrichStart,
  });
  if (!rateLimit.allowed) {
    throw new ApiError(429, 'Too many enrichment starts. Try again in a minute.');
  }
  const job = await startScreenEnrichment(db, req, ctx.user.userId, parsed.data);
  ctx.timer.mark('db');
  return Response.json(job);
});
