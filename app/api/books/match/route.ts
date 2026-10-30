import { z } from 'zod';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb } from '@/lib/server/db';
import { checkRateLimit, RATE_LIMITS } from '@/lib/server/ratelimit';
import { libraryWorks } from '@/lib/server/addBook';
import { catalogSearch, MATCH_BATCH_MAX, matchItems } from '@/lib/server/bulkMatch';

// Each request is bounded by MATCH_BUDGET_MS (20 s) of lookups; this is headroom for the
// lookups already in flight when the budget runs out. Keep it a literal: Next's static
// segment-config analyzer rejects an imported binding.
export const maxDuration = 60;

const Body = z.object({
  items: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(300),
        author: z.string().trim().max(200).nullish(),
      })
    )
    .min(1)
    .max(MATCH_BATCH_MAX),
  mode: z.enum(['best', 'strict']).default('best'),
});

/**
 * Bulk catalog matching for onboarding (a pasted list, the quick-rate grid). Returns one
 * result per item, in order: `matched` with the best catalog hit and alternatives, each
 * flagged `in_library` against this reader's books; `unmatched`; or `pending` when the time
 * budget ran out first, for the client to send again. Writes nothing.
 */
export const POST = withApi('/api/books/match', async (req, ctx) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError(
      422,
      `validation error: ${parsed.error.issues[0]?.message ?? 'invalid body'}`
    );
  }
  const db = getDb();
  const rl = await checkRateLimit(db, {
    key: `book_match:${ctx.user.userId}`,
    ...RATE_LIMITS.bookMatch,
  });
  if (!rl.allowed) {
    throw new ApiError(429, 'Too many lookups at once. Wait a minute and try again.');
  }
  const library = await libraryWorks(db, ctx.user.userId);
  ctx.timer.mark('db');
  const results = await matchItems(
    parsed.data.items.map((i) => ({ title: i.title, author: i.author || null })),
    { mode: parsed.data.mode, search: catalogSearch(db), library }
  );
  ctx.timer.mark('catalog');
  return Response.json({ results });
});
