import { and, asc, eq, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, schema } from '@/lib/server/db';
import { ApiError, withApi } from '@/lib/server/http';
import { isValidRating } from '@/lib/server/rating';
import {
  candidateEnrichmentValues,
  findIdentityClash,
  isTitleIdentityViolation,
  ScreenCandidateSchema,
} from '@/lib/server/screenEnrichment';
import { requireScreenEnabled } from '@/lib/server/screenSettings';
import { serializeResolutionConfidence, utcnowTs } from '@/lib/server/serialize';
import { MEDIA_TYPES, TITLE_STATUSES, titleOut } from '@/lib/server/titles';

const Query = z.object({
  type: z.enum(MEDIA_TYPES).optional(),
  status: z.enum(TITLE_STATUSES).optional(),
});

export const GET = withApi('/api/screen/titles', async (req, ctx) => {
  const url = new URL(req.url);
  const parsed = Query.safeParse({
    type: url.searchParams.get('type') ?? undefined,
    status: url.searchParams.get('status') ?? undefined,
  });
  if (!parsed.success) {
    throw new ApiError(
      422,
      "type must be 'movie' or 'tv'; status must be watched, watching, dropped or want."
    );
  }
  const db = getDb();
  await requireScreenEnabled(db, ctx.user.userId);
  const conds: SQL[] = [eq(schema.titles.userId, ctx.user.userId)];
  if (parsed.data.type) conds.push(eq(schema.titles.mediaType, parsed.data.type));
  if (parsed.data.status) conds.push(eq(schema.titles.status, parsed.data.status));
  const rows = await db
    .select({ title: schema.titles, enrichment: schema.titleEnrichment })
    .from(schema.titles)
    .leftJoin(schema.titleEnrichment, eq(schema.titleEnrichment.titleId, schema.titles.id))
    .where(and(...conds))
    .orderBy(asc(schema.titles.id));
  ctx.timer.mark('db');
  return Response.json(rows.map((r) => titleOut(r.title, r.enrichment)));
});

const AddTitle = z.object({
  candidate: ScreenCandidateSchema,
  status: z.enum(TITLE_STATUSES),
  // Permissive z.number() on purpose: the manual isValidRating guard owns the 422 (CLAUDE.md).
  rating: z.number().nullish(),
  review: z.string().nullish(),
});

/** Manual add (spec §3.5): the user's pick fixes identity at once. */
export const POST = withApi('/api/screen/titles', async (req, ctx) => {
  const parsed = AddTitle.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError(
      422,
      `validation error: ${parsed.error.issues[0]?.message ?? 'invalid body'}`
    );
  }
  const { candidate, status, rating } = parsed.data;
  // 0 is the "unrated" sentinel on the wire, never a stored rating.
  if (rating != null && rating !== 0 && !isValidRating(rating)) {
    throw new ApiError(
      422,
      'rating must be 0.5 to 5 in half-star steps (or omitted/0 for unrated).'
    );
  }
  const rated = rating != null && rating !== 0;
  const review = (parsed.data.review ?? '').trim() || null;
  // Decision 16 mirrors AddBookModal; spec §3.2 exempts dropped, as wave 4's PATCH does.
  if (review && !rated && status !== 'dropped') {
    throw new ApiError(
      422,
      'A review requires a rating (0.5 to 5). Rate the title, or omit the review.'
    );
  }
  const tvmazeId = candidate.media_type === 'tv' ? candidate.tvmaze_id : null;
  if (candidate.media_type === 'movie' && !candidate.wikidata_qid) {
    throw new ApiError(422, 'A movie needs its Wikidata id. Pick it from the search results.');
  }
  if (candidate.media_type === 'tv' && tvmazeId === null) {
    throw new ApiError(422, 'A show needs its TVmaze id. Pick it from the search results.');
  }

  const db = getDb();
  const userId = ctx.user.userId;
  await requireScreenEnabled(db, userId);
  const duplicate = `"${candidate.title}" is already in your ScreenSprite library.`;
  // Title ids are serial from 1, so 0 excludes nothing.
  if (await findIdentityClash(db, userId, 0, candidate.wikidata_qid, tvmazeId)) {
    throw new ApiError(409, duplicate);
  }

  const now = utcnowTs();
  let created;
  try {
    created = await db.transaction(async (tx) => {
      const [title] = await tx
        .insert(schema.titles)
        .values({
          userId,
          mediaType: candidate.media_type,
          title: candidate.title,
          year: candidate.year,
          status,
          appRating: rated ? rating : null,
          appReview: review,
          wikidataQid: candidate.wikidata_qid,
          tvmazeId,
          feedbackUpdatedAt: rated || review ? now : null,
          updatedAt: now,
        })
        .returning();
      const [enr] = await tx
        .insert(schema.titleEnrichment)
        .values({
          titleId: title.id,
          ...candidateEnrichmentValues(candidate),
          tvmazeId,
          resolutionConfidence: serializeResolutionConfidence('HIGH'),
          confidenceLabel: 'HIGH',
          matchMethod: 'manual_add',
          identitySource: 'manual',
          duplicateOfTitleId: null,
          rawResponse: null,
          resolvedAt: now,
        })
        .returning();
      return { title, enr };
    });
  } catch (error) {
    if (isTitleIdentityViolation(error)) throw new ApiError(409, duplicate);
    throw error;
  }
  ctx.timer.mark('db');
  return Response.json(titleOut(created.title, created.enr), { status: 201 });
});
