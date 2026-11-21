import { z } from 'zod';
import { getDb } from '@/lib/server/db';
import { ApiError, withApi } from '@/lib/server/http';
import { isNextReadPromptOn, setNextReadPromptOn } from '@/lib/server/nextReadSettings';

const Body = z.object({ prompt: z.boolean() }).strict();

/** Whether the home page offers a pick from the to-read shelf before a new batch. */
export const GET = withApi('/api/settings/next-read', async (_req, ctx) => {
  const db = getDb();
  const prompt = await isNextReadPromptOn(db, ctx.user.userId);
  ctx.timer.mark('db');
  return Response.json({ prompt });
});

export const PUT = withApi('/api/settings/next-read', async (req, ctx) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw new ApiError(422, 'prompt must be true or false.');
  const db = getDb();
  await setNextReadPromptOn(db, ctx.user.userId, parsed.data.prompt);
  const prompt = await isNextReadPromptOn(db, ctx.user.userId);
  ctx.timer.mark('db');
  return Response.json({ prompt });
});
