import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import {
  countForGoal,
  currentYear,
  goalOut,
  loadReadRows,
  topSubjects,
  yearStats,
  type GoalKind,
} from '@/lib/server/goals';

const Query = z.object({ year: z.coerce.number().int().min(1900).max(2200).optional() });

export const GET = withApi('/api/goals', async (req, ctx) => {
  const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) {
    throw new ApiError(
      422,
      `validation error: ${parsed.error.issues[0]?.message ?? 'invalid year'}`
    );
  }
  const year = parsed.data.year ?? currentYear();

  const db = getDb();
  const userId = ctx.user.userId;

  const goals = await db
    .select()
    .from(schema.readingGoals)
    .where(and(eq(schema.readingGoals.userId, userId), eq(schema.readingGoals.year, year)))
    .orderBy(
      asc(schema.readingGoals.kind),
      asc(schema.readingGoals.subject),
      asc(schema.readingGoals.id)
    );
  const rows = await loadReadRows(db, userId);
  ctx.timer.mark('db');

  return Response.json({
    year,
    stats: yearStats(rows, year),
    goals: goals.map((g) =>
      goalOut(
        g,
        countForGoal(rows, {
          year: g.year,
          kind: g.kind as GoalKind,
          subject: g.subject,
          target: g.target,
        })
      )
    ),
    subjects: topSubjects(rows),
  });
});
