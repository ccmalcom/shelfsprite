import { z } from 'zod';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb } from '@/lib/server/db';
import { resolveAnthropicKey, makeAnthropicClient } from '@/lib/server/claude';
import { checkRateLimit, RATE_LIMITS } from '@/lib/server/ratelimit';
import { runNextRead } from '@/lib/server/nextReadRun';

// One Claude rerank over the reader's own to-read shelf; no catalog calls.
export const maxDuration = 120;

const Body = z.object({
  n: z.number().int().min(1).max(10).default(3),
});

/**
 * "Pick my next read": rank the to-read shelf against the reader's taste. Ephemeral; nothing
 * is persisted. An absent body means all defaults.
 */
export const POST = withApi('/api/next-read', async (req, ctx) => {
  const raw: unknown = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new ApiError(
      422,
      `validation error: ${parsed.error.issues[0]?.message ?? 'invalid body'}`
    );
  }

  const db = getDb();
  const rl = await checkRateLimit(db, {
    key: `next_read:${ctx.user.userId}`,
    ...RATE_LIMITS.nextRead,
  });
  if (!rl.allowed) {
    throw new ApiError(429, 'Too many picks in a minute. Try again shortly.');
  }

  const apiKey = await resolveAnthropicKey(db, ctx.user.userId);
  const client = apiKey ? makeAnthropicClient(apiKey) : null;

  const out = await runNextRead(db, client, ctx.user.userId, parsed.data.n);
  ctx.timer.mark('claude');
  return Response.json(out);
});
