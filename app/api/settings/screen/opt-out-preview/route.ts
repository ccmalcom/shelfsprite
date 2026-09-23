import { withApi } from '@/lib/server/http';
import { getDb } from '@/lib/server/db';
import { previewScreenOptOut } from '@/lib/server/screenOptOut';

/**
 * Spec 2026-09-22 §5.7 / §7.4: what disabling ScreenSprite would remove, for the confirmation
 * ("N traits drew on your viewing history and will be removed, including M you confirmed").
 */
export const GET = withApi('/api/settings/screen/opt-out-preview', async (_req, ctx) => {
  const db = getDb();
  const preview = await previewScreenOptOut(db, ctx.user.userId);
  ctx.timer.mark('db');
  return Response.json(preview);
});
