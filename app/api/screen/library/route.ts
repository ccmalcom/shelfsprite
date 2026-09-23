import { getDb } from '@/lib/server/db';
import { withApi } from '@/lib/server/http';
import { setRebuildReason } from '@/lib/server/profileMeta';
import { deleteProfileRows } from '@/lib/server/purge';
import { deleteScreenLibraryRows } from '@/lib/server/screenPurge';

/**
 * Spec §7.6 "Delete screen library": titles, their enrichment, screen recommendations, title
 * signals, and the shared profile; books survive. Not gated on the opt-in flag, so a user who
 * turned ScreenSprite off can still remove their viewing history. The flag itself is unchanged.
 */
export const DELETE = withApi('/api/screen/library', async (_req, ctx) => {
  const db = getDb();
  const userId = ctx.user.userId;
  const result = await db.transaction(async (tx) => {
    const screen = await deleteScreenLibraryRows(tx, userId);
    const profile = await deleteProfileRows(tx, userId);
    // deleteProfileRows removed profile_meta; this recreates it carrying the reason, so any
    // profile built next is a full one.
    await setRebuildReason(tx, userId, 'screen_library_deleted');
    return {
      titles_removed: screen.titles_removed,
      title_recommendations_removed: screen.title_recommendations_removed,
      title_signals_removed: screen.title_signals_removed,
      traits_removed: profile.traits_removed,
      recommendations_removed: profile.recommendations_removed,
      profile_reset: true as const,
    };
  });
  ctx.timer.mark('db');
  return Response.json(result);
});
