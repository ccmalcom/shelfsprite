import { z } from 'zod';
import { getDb } from '@/lib/server/db';
import { ApiError, withApi } from '@/lib/server/http';
import { checkRateLimit, RATE_LIMITS } from '@/lib/server/ratelimit';
import { deadlineIn } from '@/lib/server/screenCatalog';
import { searchMovies, searchShows } from '@/lib/server/screenEnrichment';
import { requireScreenEnabled } from '@/lib/server/screenSettings';
import { MEDIA_TYPES } from '@/lib/server/titles';

/**
 * A cold movie search is Stage A + wbsearchentities + entity and label hops + up to ten
 * Wikipedia summaries at 250 ms spacing: about 5-8 s. The deadline stops it well short of
 * any platform limit; what it cannot finish becomes a 503, never a short list.
 */
const SEARCH_DEADLINE_MS = 25_000;

const Query = z.object({
  q: z.string().trim().min(1).max(200),
  type: z.enum(MEDIA_TYPES),
});

/** Manual-add and correction search (spec §3.5): Wikidata for movies, TVmaze + Wikidata for TV. */
export const GET = withApi('/api/screen/search', async (req, ctx) => {
  const url = new URL(req.url);
  const parsed = Query.safeParse({
    q: url.searchParams.get('q') ?? '',
    type: url.searchParams.get('type') ?? '',
  });
  if (!parsed.success) {
    throw new ApiError(422, "q must be 1 to 200 characters; type must be 'movie' or 'tv'.");
  }
  const db = getDb();
  await requireScreenEnabled(db, ctx.user.userId);
  const rateLimit = await checkRateLimit(db, {
    key: `screenSearch:${ctx.user.userId}`,
    ...RATE_LIMITS.screenSearch,
  });
  if (!rateLimit.allowed) throw new ApiError(429, 'Too many searches. Try again in a minute.');

  const deadline = deadlineIn(SEARCH_DEADLINE_MS);
  const { q, type } = parsed.data;
  const result =
    type === 'movie' ? await searchMovies(db, q, deadline) : await searchShows(db, q, deadline);
  ctx.timer.mark('catalog');
  if (result.kind === 'retryable') {
    throw new ApiError(503, 'The catalog did not answer in time. Try the search again.');
  }
  return Response.json(result.kind === 'ok' ? result.value : []);
});
