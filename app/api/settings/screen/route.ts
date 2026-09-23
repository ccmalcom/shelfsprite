import { z } from 'zod';
import { getDb, type Db } from '@/lib/server/db';
import { ApiError, withApi } from '@/lib/server/http';
import {
  countTitles,
  isScreenEnabled,
  readScreenToggledAt,
  setScreenEnabled,
} from '@/lib/server/screenSettings';
import { tsToIso } from '@/lib/server/serialize';

const Body = z.object({ enabled: z.boolean() }).strict();

async function screenState(db: Db, userId: string) {
  // Sequential on purpose: db.ts runs one pooled connection.
  const enabled = await isScreenEnabled(db, userId);
  const toggledAt = await readScreenToggledAt(db, userId);
  const titleCount = await countTitles(db, userId);
  return { enabled, toggled_at: tsToIso(toggledAt), title_count: titleCount };
}

export const GET = withApi('/api/settings/screen', async (_req, ctx) => {
  const db = getDb();
  const state = await screenState(db, ctx.user.userId);
  ctx.timer.mark('db');
  return Response.json(state);
});

export const PUT = withApi('/api/settings/screen', async (req, ctx) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw new ApiError(422, 'enabled must be true or false.');
  const db = getDb();
  // Wave 4: disabling is a plain flag flip (stamps screen_toggled_at, sets the rebuild reason).
  // Wave 6 replaces the disable branch with the spec §5.7 opt-out (trait deletion, archetype clear).
  await db.transaction((tx) => setScreenEnabled(tx, ctx.user.userId, parsed.data.enabled));
  const state = await screenState(db, ctx.user.userId);
  ctx.timer.mark('db');
  return Response.json(state);
});
