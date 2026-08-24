import { withApi, ApiError } from '@/lib/server/http';
import { getDb } from '@/lib/server/db';
import { parseIdParam } from '@/lib/server/serialize';
import { markReviewed } from '@/lib/server/inviteRequests';

/** Decline a waitlist request. Local bookkeeping only — no GoTrue call. */
export const POST = withApi(
  '/api/admin/invite-requests/[id]/decline',
  async (_req, ctx) => {
    const id = parseIdParam(ctx.params.id);
    const updated = await markReviewed(getDb(), id, 'declined', ctx.user.userId);
    if (!updated) throw new ApiError(404, 'invite request not found');
    ctx.timer.mark('db');
    return Response.json(updated);
  },
  { requireAdmin: true }
);
