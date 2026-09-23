import { z } from 'zod';
import { makeAnthropicClient, resolveAnthropicKey } from '@/lib/server/claude';
import { getDb } from '@/lib/server/db';
import { ApiError, withApi } from '@/lib/server/http';
import { checkRateLimit, RATE_LIMITS } from '@/lib/server/ratelimit';
import { SCREEN_DEFAULT_N, runScreenRecommend } from '@/lib/server/screenRecommendRun';
import { MEDIA_FILTERS } from '@/lib/server/screenRecs';
import { requireScreenEnabled } from '@/lib/server/screenSettings';

// Two Claude calls plus up to ~20 Wikimedia queries, budgeted inside this ceiling by
// screenRecommendRun.ts (spec §6.4). Must stay a literal: Next's segment-config analyzer
// rejects an imported binding, and the build fails without naming this file.
export const maxDuration = 300;

const Body = z.object({
  media_filter: z.enum(MEDIA_FILTERS).default('both'),
  n: z.number().int().min(1).max(20).default(SCREEN_DEFAULT_N),
});

export const POST = withApi('/api/screen/recommend', async (req, ctx) => {
  // Unlike /api/recommend (FastAPI parity), an absent body means "all defaults".
  const text = await req.text();
  let raw: unknown = {};
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new ApiError(422, 'validation error: body is not valid JSON');
    }
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(
      422,
      `validation error: ${parsed.error.issues[0]?.message ?? 'invalid body'}`
    );
  }

  const db = getDb();
  const userId = ctx.user.userId;
  // Disabled users never spend a rate-limit slot.
  await requireScreenEnabled(db, userId);
  const limit = await checkRateLimit(db, {
    key: `screenRecommend:${userId}`,
    ...RATE_LIMITS.screenRecommend,
  });
  if (!limit.allowed) {
    throw new ApiError(429, 'Too many recommendation runs. Try again in a minute.');
  }

  const apiKey = await resolveAnthropicKey(db, userId);
  const client = apiKey ? makeAnthropicClient(apiKey) : null;
  const out = await runScreenRecommend(db, client, userId, {
    mediaFilter: parsed.data.media_filter,
    n: parsed.data.n,
  });
  ctx.timer.mark('claude');
  return Response.json(out);
});
