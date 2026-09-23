import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, schema } from '@/lib/server/db';
import { ApiError, withApi } from '@/lib/server/http';
import { ensureProfileMeta } from '@/lib/server/profileMeta';
import {
  candidateEnrichmentValues,
  findIdentityClash,
  isTitleIdentityViolation,
  ScreenCandidateSchema,
} from '@/lib/server/screenEnrichment';
import { requireScreenEnabled } from '@/lib/server/screenSettings';
import { parseIdParam, utcnowTs } from '@/lib/server/serialize';
import { titleOut } from '@/lib/server/titles';

const Body = z.object({ candidate: ScreenCandidateSchema });

/**
 * Correction (spec §4.4): the user picks the right catalog entry for a mis-resolved title.
 * One tenant-scoped transaction, as PATCH /api/books/[id]/enrichment. identity_source
 * 'corrected' is what stops a later forced job from re-resolving it (persistTitleResolution).
 */
export const POST = withApi('/api/screen/titles/[id]/correct', async (req, ctx) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError(
      422,
      `validation error: ${parsed.error.issues[0]?.message ?? 'invalid body'}`
    );
  }
  const { candidate } = parsed.data;
  const tvmazeId = candidate.media_type === 'tv' ? candidate.tvmaze_id : null;
  if (candidate.media_type === 'movie' && !candidate.wikidata_qid) {
    throw new ApiError(422, 'A movie needs its Wikidata id. Pick it from the search results.');
  }
  if (candidate.media_type === 'tv' && tvmazeId === null) {
    throw new ApiError(422, 'A show needs its TVmaze id. Pick it from the search results.');
  }
  const id = parseIdParam(ctx.params.id);
  const userId = ctx.user.userId;
  const db = getDb();
  await requireScreenEnabled(db, userId);
  const [owned] = await db
    .select({ id: schema.titles.id })
    .from(schema.titles)
    .where(and(eq(schema.titles.id, id), eq(schema.titles.userId, userId)));
  if (!owned) throw new ApiError(404, `Title ${id} not found.`);

  const clash = await findIdentityClash(db, userId, id, candidate.wikidata_qid, tvmazeId);
  const clashMessage = (title: string) =>
    `That pick is already in your ScreenSprite library as "${title}".`;
  if (clash) throw new ApiError(409, clashMessage(clash.title));

  const now = utcnowTs();
  try {
    const out = await db.transaction(async (tx) => {
      const [title] = await tx
        .update(schema.titles)
        .set({
          mediaType: candidate.media_type,
          wikidataQid: candidate.wikidata_qid,
          tvmazeId,
          // A year-less import (Letterboxd omits some) takes the pick's year; a year it has stays.
          year: sql`coalesce(${schema.titles.year}, ${candidate.year})`,
          updatedAt: now,
        })
        .where(and(eq(schema.titles.id, id), eq(schema.titles.userId, userId)))
        .returning();
      const values = {
        ...candidateEnrichmentValues(candidate),
        tvmazeId,
        resolutionConfidence: 1.0,
        confidenceLabel: 'CORRECTED',
        matchMethod: 'user_correction',
        identitySource: 'corrected',
        duplicateOfTitleId: null,
        resolvedAt: now,
      };
      const [enr] = await tx
        .insert(schema.titleEnrichment)
        .values({ titleId: id, ...values })
        .onConflictDoUpdate({ target: schema.titleEnrichment.titleId, set: values })
        .returning();
      const meta = await ensureProfileMeta(tx, userId);
      await tx
        .update(schema.profileMeta)
        .set({ enrichmentCorrectedAt: now })
        .where(eq(schema.profileMeta.id, meta.id));
      return titleOut(title, enr);
    });
    ctx.timer.mark('db');
    return Response.json(out);
  } catch (error) {
    if (isTitleIdentityViolation(error)) {
      throw new ApiError(409, 'That pick is already in your ScreenSprite library.');
    }
    throw error;
  }
});
