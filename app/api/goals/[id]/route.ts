import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { countForGoal, goalOut, loadReadRows, type GoalKind } from '@/lib/server/goals';
import { parseIdParam } from '@/lib/server/serialize';

const PatchBody = z.object({ target: z.number() });

/** Scoped read: another user's goal is 404, never 403 -- 403 would confirm it exists. */
async function ownedGoal(userId: string, goalId: number) {
  const rows = await getDb()
    .select()
    .from(schema.readingGoals)
    .where(and(eq(schema.readingGoals.id, goalId), eq(schema.readingGoals.userId, userId)));
  const goal = rows[0];
  if (!goal) throw new ApiError(404, `Goal ${goalId} not found.`);
  return goal;
}

export const PATCH = withApi('/api/goals/[id]', async (req, ctx) => {
  const goalId = parseIdParam(ctx.params.id);
  const parsed = PatchBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError(422, 'validation error: target is required');
  }
  const { target } = parsed.data;
  if (!Number.isInteger(target) || target <= 0) {
    throw new ApiError(422, 'target must be a positive whole number.');
  }

  const goal = await ownedGoal(ctx.user.userId, goalId);
  const db = getDb();
  await db.update(schema.readingGoals).set({ target }).where(eq(schema.readingGoals.id, goalId));
  const rows = await loadReadRows(db, ctx.user.userId);
  ctx.timer.mark('db');

  return Response.json(
    goalOut(
      { ...goal, target },
      countForGoal(rows, {
        year: goal.year,
        kind: goal.kind as GoalKind,
        subject: goal.subject,
        target,
      })
    )
  );
});

export const DELETE = withApi('/api/goals/[id]', async (_req, ctx) => {
  const goalId = parseIdParam(ctx.params.id);
  await ownedGoal(ctx.user.userId, goalId);
  await getDb().delete(schema.readingGoals).where(eq(schema.readingGoals.id, goalId));
  ctx.timer.mark('db');
  return Response.json({ ok: true });
});
