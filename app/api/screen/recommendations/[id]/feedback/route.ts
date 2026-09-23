import { and, eq } from 'drizzle-orm';
import { getDb, schema, type Db } from '@/lib/server/db';
import { ApiError, withApi } from '@/lib/server/http';
import { ensureProfileMeta } from '@/lib/server/profileMeta';
import { isTitleIdentityViolation, type ScreenCandidate } from '@/lib/server/screenEnrichment';
import {
  ensureScreenTitle,
  fetchRecCandidate,
  SCREEN_REJECT_REASONS,
  titleRecOut,
  type TitleRecRow,
} from '@/lib/server/screenRecs';
import { requireScreenEnabled } from '@/lib/server/screenSettings';
import { parseIdParam, pyList, utcnowTs } from '@/lib/server/serialize';
import { titleOut } from '@/lib/server/titles';

const STATUSES = ['accepted', 'already_watched', 'rejected'] as const;
type FeedbackStatus = (typeof STATUSES)[number];
const REASONS: readonly string[] = SCREEN_REJECT_REASONS;

interface Feedback {
  status: FeedbackStatus;
  rejectReasons: string[] | null;
  userNote: string | null;
}

function parseFeedback(raw: unknown): Feedback {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ApiError(422, 'validation error: invalid body');
  }
  const body = raw as Record<string, unknown>;
  if (!STATUSES.includes(body.status as FeedbackStatus)) {
    throw new ApiError(422, "status must be one of 'accepted', 'already_watched', 'rejected'");
  }
  const status = body.status as FeedbackStatus;
  const userNote = body.user_note ?? null;
  if (userNote !== null && (typeof userNote !== 'string' || userNote.length > 2000)) {
    throw new ApiError(422, 'user_note must be a string of at most 2000 characters');
  }
  const reasons = body.reject_reasons ?? null;
  if (reasons === null) return { status, rejectReasons: null, userNote };
  if (status !== 'rejected') {
    throw new ApiError(422, "reject_reasons may only be provided when status is 'rejected'");
  }
  if (!Array.isArray(reasons) || reasons.length === 0) {
    throw new ApiError(
      422,
      `reject_reasons must be a non-empty list. Valid codes: ${pyList([...REASONS])}`
    );
  }
  const unknown = reasons.filter((r) => typeof r !== 'string' || !REASONS.includes(r));
  if (unknown.length > 0) {
    throw new ApiError(
      422,
      `Unknown reject_reasons: ${pyList(unknown.map(String))}. Valid codes: ${pyList([...REASONS])}`
    );
  }
  return { status, rejectReasons: reasons as string[], userNote };
}

async function apply(
  db: Db,
  userId: string,
  rec: TitleRecRow,
  feedback: Feedback,
  candidate: ScreenCandidate | null
) {
  return db.transaction(async (tx) => {
    await tx
      .update(schema.titleRecommendations)
      .set({
        status: feedback.status,
        userNote: feedback.userNote,
        rejectReasons: feedback.rejectReasons,
      })
      .where(eq(schema.titleRecommendations.id, rec.id));
    // Decision 9: every feedback call stamps it, not only rejections.
    const meta = await ensureProfileMeta(tx, userId);
    await tx
      .update(schema.profileMeta)
      .set({ recFeedbackUpdatedAt: utcnowTs() })
      .where(eq(schema.profileMeta.id, meta.id));
    if (feedback.status === 'rejected') return null;
    const landed = await ensureScreenTitle(
      tx,
      userId,
      rec,
      feedback.status === 'accepted' ? 'want' : 'watched',
      candidate
    );
    return titleOut(landed.title, landed.enrichment);
  });
}

/** Spec §6.7. Transactional and tenant-scoped; the metadata fetch runs before the transaction. */
export const POST = withApi('/api/screen/recommendations/[id]/feedback', async (req, ctx) => {
  const feedback = parseFeedback(await req.json().catch(() => null));
  const recId = parseIdParam(ctx.params.id);
  const db = getDb();
  const userId = ctx.user.userId;
  await requireScreenEnabled(db, userId);

  const recs = schema.titleRecommendations;
  const [rec] = await db
    .select()
    .from(recs)
    .where(and(eq(recs.id, recId), eq(recs.userId, userId)));
  if (!rec) throw new ApiError(404, `Recommendation ${recId} not found`);

  // Outside the transaction: db.ts uses max: 1, so a catalog call inside one would deadlock.
  const candidate = feedback.status === 'rejected' ? null : await fetchRecCandidate(db, rec);

  let title;
  try {
    title = await apply(db, userId, rec, feedback, candidate);
  } catch (error) {
    // Two quick clicks: the other request inserted this identity first. The retry finds it.
    if (!isTitleIdentityViolation(error)) throw error;
    title = await apply(db, userId, rec, feedback, candidate);
  }
  ctx.timer.mark('db');
  const updated = titleRecOut({
    ...rec,
    status: feedback.status,
    userNote: feedback.userNote,
    rejectReasons: feedback.rejectReasons,
  });
  return Response.json({
    id: updated.id,
    status: updated.status,
    user_note: updated.user_note,
    reject_reasons: updated.reject_reasons,
    title,
  });
});
