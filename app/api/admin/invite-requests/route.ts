import { withApi, ApiError } from '@/lib/server/http';
import { getDb } from '@/lib/server/db';
import { isInviteRequestStatus, listInviteRequests } from '@/lib/server/inviteRequests';

/** Every waitlist request, newest first. Optional ?status=pending|approved|declined. */
export const GET = withApi(
  '/api/admin/invite-requests',
  async (req, ctx) => {
    const raw = new URL(req.url).searchParams.get('status');
    if (raw !== null && !isInviteRequestStatus(raw)) {
      throw new ApiError(422, 'validation error: unknown invite request status');
    }
    const rows = await listInviteRequests(getDb(), raw);
    ctx.timer.mark('db');
    return Response.json(rows);
  },
  { requireAdmin: true }
);
