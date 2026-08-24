import { withApi, ApiError } from '@/lib/server/http';
import { getDb } from '@/lib/server/db';
import { parseIdParam } from '@/lib/server/serialize';
import { getInviteRequest, markReviewed } from '@/lib/server/inviteRequests';
import { createInvite, InviteError } from '@/lib/server/invites';
import { SupabaseAdminError } from '@/lib/server/supabaseAdmin';

/**
 * Approve a waitlist request: send the real invite, then record the review.
 *
 * DELIBERATELY NOT TRANSACTIONAL — do not "fix" this. createInvite performs a GoTrue write that
 * cannot be rolled back, which is the same reason createInvite itself is not wrapped in a
 * transaction while backfillFromSupabase is (see lib/server/invites.ts). The irreversible remote
 * call goes first and the local bookkeeping follows it.
 *
 * If createInvite throws, the row stays 'pending', the admin sees the error, and the action is
 * safely retryable. If it succeeds and the status update then fails, the admin sees the invite in
 * the roster next to a still-pending request — visible, harmless, and cleared by approving again,
 * since createInvite already upserts on an existing email.
 */
export const POST = withApi(
  '/api/admin/invite-requests/[id]/approve',
  async (_req, ctx) => {
    const id = parseIdParam(ctx.params.id);
    const db = getDb();

    const row = await getInviteRequest(db, id);
    if (!row) throw new ApiError(404, 'invite request not found');

    try {
      await createInvite({ email: row.email, invitedBy: ctx.user.userId });
    } catch (err) {
      if (err instanceof InviteError) throw new ApiError(422, err.message);
      if (err instanceof SupabaseAdminError) throw new ApiError(502, err.message);
      throw err;
    }
    ctx.timer.mark('invite');

    const updated = await markReviewed(db, id, 'approved', ctx.user.userId);
    if (!updated) throw new ApiError(404, 'invite request not found');
    return Response.json(updated);
  },
  { requireAdmin: true }
);
