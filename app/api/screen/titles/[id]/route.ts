import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, schema, type Db, type DbTx } from '@/lib/server/db';
import { ApiError, withApi } from '@/lib/server/http';
import { setRebuildReason } from '@/lib/server/profileMeta';
import { isValidRating } from '@/lib/server/rating';
import { requireScreenEnabled } from '@/lib/server/screenSettings';
import { parseIdParam, utcnowTs } from '@/lib/server/serialize';
import {
  effectiveTitleRating,
  effectiveTitleReview,
  isTitleProfileEvidence,
  TITLE_STATUSES,
  titleOut,
  type TitleRow,
} from '@/lib/server/titles';

// Permissive z.number() on purpose: the manual isValidRating guard owns the 422 (CLAUDE.md).
const Body = z.object({
  rating: z.number().nullish(),
  review: z.string().nullish(),
  status: z.enum(TITLE_STATUSES).nullish(),
  is_favorite: z.boolean().nullish(),
  exclude_from_profile: z.boolean().nullish(),
});

async function loadOwned(db: Db, userId: string, id: number) {
  const rows = await db
    .select({ title: schema.titles, enrichment: schema.titleEnrichment })
    .from(schema.titles)
    .leftJoin(schema.titleEnrichment, eq(schema.titleEnrichment.titleId, schema.titles.id))
    .where(and(eq(schema.titles.id, id), eq(schema.titles.userId, userId)));
  const row = rows[0];
  if (!row) throw new ApiError(404, `Title ${id} not found.`);
  return row;
}

export const GET = withApi('/api/screen/titles/[id]', async (_req, ctx) => {
  const id = parseIdParam(ctx.params.id);
  const db = getDb();
  await requireScreenEnabled(db, ctx.user.userId);
  const row = await loadOwned(db, ctx.user.userId, id);
  ctx.timer.mark('db');
  return Response.json(titleOut(row.title, row.enrichment));
});

export const PATCH = withApi('/api/screen/titles/[id]', async (req, ctx) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError(
      422,
      `validation error: ${parsed.error.issues[0]?.message ?? 'invalid body'}`
    );
  }
  const b = parsed.data;
  const id = parseIdParam(ctx.params.id);

  // 0 is the clear sentinel, not a rating.
  if (b.rating != null && b.rating !== 0 && !isValidRating(b.rating)) {
    throw new ApiError(422, 'rating must be 0.5 to 5 in half-star steps (or 0 to clear).');
  }
  if (
    b.rating == null &&
    b.review == null &&
    b.status == null &&
    b.is_favorite == null &&
    b.exclude_from_profile == null
  ) {
    throw new ApiError(
      422,
      'Nothing to update: pass a rating, review, status, favorite, and/or exclude flag.'
    );
  }

  const db = getDb();
  await requireScreenEnabled(db, ctx.user.userId);
  const row = await loadOwned(db, ctx.user.userId, id);

  const next: TitleRow = { ...row.title };
  if (b.rating != null) next.appRating = b.rating === 0 ? null : b.rating;
  if (b.review != null) next.appReview = b.review.trim() || null;
  if (b.status != null) next.status = b.status;
  if (b.is_favorite != null) next.isFavorite = b.is_favorite;
  if (b.exclude_from_profile != null) next.excludeFromProfile = b.exclude_from_profile;

  // After applying, like the book route: a review needs an effective rating unless dropped.
  if (
    effectiveTitleReview(next) !== null &&
    effectiveTitleRating(next) === null &&
    next.status !== 'dropped'
  ) {
    throw new ApiError(
      422,
      'A review requires a rating. Rate the title 0.5 to 5 (same update is fine) before saving a review.'
    );
  }

  const now = utcnowTs();
  next.feedbackUpdatedAt = now;
  next.updatedAt = now;
  await db
    .update(schema.titles)
    .set({
      appRating: next.appRating,
      appReview: next.appReview,
      status: next.status,
      isFavorite: next.isFavorite,
      excludeFromProfile: next.excludeFromProfile,
      feedbackUpdatedAt: now,
      updatedAt: now,
    })
    .where(and(eq(schema.titles.id, id), eq(schema.titles.userId, ctx.user.userId)));
  ctx.timer.mark('db');
  return Response.json(titleOut(next, row.enrichment));
});

async function citedByTrait(tx: DbTx, userId: string, titleId: number): Promise<boolean> {
  const needle = JSON.stringify(titleId);
  const result = await tx.execute(sql`
    select 1 from taste_traits
    where user_id = ${userId}
      and (coalesce(exhibit_title_ids::jsonb, '[]'::jsonb) @> ${needle}::jsonb
        or coalesce(contrast_title_ids::jsonb, '[]'::jsonb) @> ${needle}::jsonb)
    limit 1
  `);
  const rows = Array.isArray(result) ? result : (result as { rows: unknown[] }).rows;
  return rows.length > 0;
}

export const DELETE = withApi('/api/screen/titles/[id]', async (_req, ctx) => {
  const id = parseIdParam(ctx.params.id);
  const userId = ctx.user.userId;
  const db = getDb();
  await requireScreenEnabled(db, userId);
  const row = await loadOwned(db, userId, id);
  await db.transaction(async (tx) => {
    // duplicate_of_title_id is a plain integer (merging is out of v1); clear dangling pointers.
    await tx
      .update(schema.titleEnrichment)
      .set({ duplicateOfTitleId: null })
      .where(
        and(
          eq(schema.titleEnrichment.duplicateOfTitleId, id),
          inArray(
            schema.titleEnrichment.titleId,
            tx
              .select({ id: schema.titles.id })
              .from(schema.titles)
              .where(eq(schema.titles.userId, userId))
          )
        )
      );
    // LOAD-BEARING order: title_enrichment.title_id is an FK with no cascade.
    await tx.delete(schema.titleEnrichment).where(eq(schema.titleEnrichment.titleId, id));
    await tx
      .delete(schema.titles)
      .where(and(eq(schema.titles.id, id), eq(schema.titles.userId, userId)));
    // Spec §5.5: deleting a title forces a full rebuild -- but only when the profile could have
    // used it. A watchlist entry nobody cites changes nothing.
    if (isTitleProfileEvidence(row.title) || (await citedByTrait(tx, userId, id))) {
      await setRebuildReason(tx, userId, 'title_deleted');
    }
  });
  ctx.timer.mark('db');
  return Response.json({ id, title: row.title.title, removed: true });
});
