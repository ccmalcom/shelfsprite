import { z } from 'zod';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb } from '@/lib/server/db';
import { checkRateLimit, RATE_LIMITS } from '@/lib/server/ratelimit';
import { inviteRequestRateKey, submitInviteRequest } from '@/lib/server/inviteRequests';

const Body = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  /** Honeypot. Hidden from real users, so any value at all means a bot filled it. */
  website: z.string().optional(),
});

/**
 * Public waitlist submission. `requireAuth: false` because the entire audience is signed out.
 *
 * Every accepted outcome — new email, duplicate email, honeypot — returns the SAME
 * 200 {"ok": true}. A distinguishable response would make this endpoint an oracle for "is this
 * email already known to ShelfSprite", which on an invite-only product leaks the user list. Only
 * 422 (Zod rejected the email) and 429 (rate limited) differ.
 */
export const POST = withApi(
  '/api/invite-requests',
  async (req, ctx) => {
    const raw = await req.json().catch(() => null);
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        422,
        `validation error: ${parsed.error.issues[0]?.message ?? 'invalid body'}`
      );
    }

    // Honeypot first, before the limiter: a bot must not be able to burn a real visitor's
    // shared bucket, and there is nothing here worth logging or storing.
    if (parsed.data.website && parsed.data.website.length > 0) {
      return Response.json({ ok: true });
    }

    const db = getDb();
    const { limit, windowSeconds } = RATE_LIMITS.inviteRequest;
    const rate = await checkRateLimit(db, {
      key: inviteRequestRateKey(req),
      limit,
      windowSeconds,
    });
    if (!rate.allowed) {
      // Deliberately NOT rateLimitExceededResponse — see the note in ratelimit.ts.
      throw new ApiError(429, 'too many invite requests, try again later');
    }

    await submitInviteRequest(db, parsed.data.email);
    ctx.timer.mark('db');
    return Response.json({ ok: true });
  },
  { requireAuth: false }
);
