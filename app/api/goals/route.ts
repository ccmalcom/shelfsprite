import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import {
  countForGoal,
  currentYear,
  GOAL_KINDS,
  goalOut,
  loadReadRows,
  topSubjects,
  yearStats,
  type GoalKind,
} from '@/lib/server/goals';
import { pyList, pyTitle } from '@/lib/server/serialize';

const Query = z.object({ year: z.coerce.number().int().min(1900).max(2200).optional() });

// Permissive on values by design: the manual guards below own the 422 messages,
// matching how the books routes handle ratings.
const CreateBody = z.object({
  year: z.number().int().optional(),
  kind: z.string(),
  subject: z.string().nullish(),
  target: z.number(),
});

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

export const POST = withApi('/api/goals', async (req, ctx) => {
  const raw = await req.json().catch(() => null);
  const parsed = CreateBody.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(
      422,
      `validation error: ${parsed.error.issues[0]?.message ?? 'invalid body'}`
    );
  }
  const { kind, target } = parsed.data;
  const year = parsed.data.year ?? currentYear();

  if (!(GOAL_KINDS as readonly string[]).includes(kind)) {
    throw new ApiError(422, `kind must be one of ${pyList([...GOAL_KINDS])}.`);
  }
  if (!Number.isInteger(target) || target <= 0) {
    throw new ApiError(422, 'target must be a positive whole number.');
  }
  if (year < 1900 || year > 2200) {
    throw new ApiError(422, 'year must be between 1900 and 2200.');
  }

  const trimmed = (parsed.data.subject ?? '').trim();
  if (kind === 'genre' && !trimmed) {
    throw new ApiError(422, 'A genre goal requires a subject.');
  }
  if (kind !== 'genre' && trimmed) {
    throw new ApiError(422, `A ${kind} goal cannot have a subject.`);
  }
  // Normalized so 'history' and 'History' are the same goal, and so the stored
  // spelling matches the suggestion list the UI offers.
  const subject = kind === 'genre' ? pyTitle(trimmed) : null;

  const db = getDb();
  const userId = ctx.user.userId;

  // Explicit duplicate check: Postgres treats NULLs as distinct in a unique
  // constraint, so uq_reading_goal does NOT stop two 'books' goals in one year.
  const existing = await db
    .select({ id: schema.readingGoals.id })
    .from(schema.readingGoals)
    .where(
      and(
        eq(schema.readingGoals.userId, userId),
        eq(schema.readingGoals.year, year),
        eq(schema.readingGoals.kind, kind),
        subject === null
          ? isNull(schema.readingGoals.subject)
          : eq(schema.readingGoals.subject, subject)
      )
    );
  if (existing.length > 0) {
    throw new ApiError(409, 'That goal already exists for this year.');
  }

  const inserted = await db
    .insert(schema.readingGoals)
    .values({ userId, year, kind, subject, target })
    .returning();
  const rows = await loadReadRows(db, userId);
  ctx.timer.mark('db');

  const goal = inserted[0];
  return Response.json(
    goalOut(goal, countForGoal(rows, { year, kind: kind as GoalKind, subject, target }))
  );
});
