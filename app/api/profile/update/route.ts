import { withApi, ApiError } from '@/lib/server/http';
import { getDb } from '@/lib/server/db';
import { resolveAnthropicKey, makeAnthropicClient } from '@/lib/server/claude';
import { PROFILE_NO_KEY_MESSAGE } from '@/lib/server/claudeErrors';
import { updateTasteProfile } from '@/lib/server/profileUpdate';
import { snapshotProposedClaims, diffProposedClaims } from '@/lib/server/profileDiff';

// May delegate to the full builder, so it inherits that flow's ceiling.
export const maxDuration = 300;

/** Port of api.py::update_profile (909-916): RuntimeError -> 400. */
export const POST = withApi('/api/profile/update', async (_req, ctx) => {
  const db = getDb();
  const apiKey = await resolveAnthropicKey(db, ctx.user.userId);
  if (!apiKey) throw new ApiError(400, PROFILE_NO_KEY_MESSAGE);
  const client = makeAnthropicClient(apiKey);

  // Snapshot OUTSIDE updateTasteProfile: it has six branches, two delegating to the
  // full extractTasteProfile rebuild and one returning early without calling Claude.
  // A before/after snapshot reports the real outcome of every one of them (#81).
  const before = await snapshotProposedClaims(db, ctx.user.userId);
  const out = await updateTasteProfile(db, client, ctx.user.userId);
  ctx.timer.mark('claude');
  const after = await snapshotProposedClaims(db, ctx.user.userId);

  return Response.json({ ...out, changes: diffProposedClaims(before, after) });
});
