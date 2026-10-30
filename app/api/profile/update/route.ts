import { withApi, ApiError } from '@/lib/server/http';
import { getDb } from '@/lib/server/db';
import { resolveAnthropicKey, makeAnthropicClient } from '@/lib/server/claude';
import { PROFILE_NO_KEY_MESSAGE } from '@/lib/server/claudeErrors';
import { updateTasteProfile } from '@/lib/server/profileUpdate';
import { snapshotProposedClaims, diffProposedClaims } from '@/lib/server/profileDiff';
import { ensureProfileMeta } from '@/lib/server/profileMeta';
import { keepArchetypeCurrent } from '@/lib/server/archetypeDerive';

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
  const priorProfiledAt = (await ensureProfileMeta(db, ctx.user.userId)).lastProfiledAt;
  const out = await updateTasteProfile(db, client, ctx.user.userId);
  ctx.timer.mark('claude');
  const after = await snapshotProposedClaims(db, ctx.user.userId);
  const changes = diffProposedClaims(before, after);

  // An unchanged trait set leaves the archetype as current as it was (see keepArchetypeCurrent).
  if (!changes.added.length && !changes.dropped.length && !changes.reworded.length) {
    await keepArchetypeCurrent(db, ctx.user.userId, priorProfiledAt);
  }

  return Response.json({ ...out, changes });
});
