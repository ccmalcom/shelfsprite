import { and, asc, eq, gt, isNotNull, sql } from 'drizzle-orm';
import { withApi } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { effectiveRating, tsToIso } from '@/lib/server/serialize';
import { isScreenEnabled } from '@/lib/server/screenSettings';
import { titlesChangedSince } from '@/lib/server/screenProfile';
import { blocksScreenRecs } from '@/lib/server/screenRecommendRun';

/** Port of library.py::profile_status (read-only — see Interfaces note). */
export const GET = withApi('/api/profile/status', async (_req, ctx) => {
  const db = getDb();
  const userId = ctx.user.userId;

  const metaRows = await db
    .select()
    .from(schema.profileMeta)
    .where(eq(schema.profileMeta.userId, userId));
  const meta = metaRows[0] ?? null;
  const since = meta?.lastProfiledAt ?? null;

  const changedWhere = since
    ? and(
        eq(schema.books.userId, userId),
        isNotNull(schema.books.feedbackUpdatedAt),
        gt(schema.books.feedbackUpdatedAt, since)
      )
    : and(eq(schema.books.userId, userId), isNotNull(schema.books.feedbackUpdatedAt));
  const candidates = await db
    .select()
    .from(schema.books)
    .where(changedWhere)
    .orderBy(asc(schema.books.id));
  const changed = candidates.filter(
    (b) =>
      effectiveRating(b.appRating, b.goodreadsRating) !== null ||
      b.exclusiveShelf === 'did-not-finish' ||
      b.isFavorite
  );

  // Spec 2026-09-22 §5.5 / §7.7: every title rating, review, status, favourite, exclusion or
  // re-resolved enrichment since the last build dirties the profile, but only while ScreenSprite
  // is enabled (a disabled user's titles never enter a build). updateTasteProfile applies the
  // same rule, so a dirty status always has an update that clears it.
  const screenEnabled = await isScreenEnabled(db, userId);
  // A title that changed only through enrichment (accepting a recommendation creates one) counts
  // only when it is profile evidence, the same predicate the recommend gate applies; otherwise
  // "Want to watch" would block the next run behind a re-profile (w7 Review Focus 1).
  const changedTitles = screenEnabled
    ? await editedOrEvidence(db, userId, since, await titlesChangedSince(db, since, userId))
    : [];

  const verdictWhere = since
    ? and(
        eq(schema.tasteTraits.userId, userId),
        isNotNull(schema.tasteTraits.verdictUpdatedAt),
        gt(schema.tasteTraits.verdictUpdatedAt, since)
      )
    : and(eq(schema.tasteTraits.userId, userId), isNotNull(schema.tasteTraits.verdictUpdatedAt));
  const verdictCount = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.tasteTraits)
    .where(verdictWhere);
  const traitVerdictDirty = Number(verdictCount[0]?.n ?? 0) > 0;
  ctx.timer.mark('db');

  const recRejectDirty =
    meta?.recFeedbackUpdatedAt != null && (since === null || meta.recFeedbackUpdatedAt > since);
  const enrichmentCorrectedDirty =
    meta?.enrichmentCorrectedAt != null && (since === null || meta.enrichmentCorrectedAt > since);
  // Spec §5.6: a pending full-rebuild reason keeps the profile dirty until a full rebuild
  // clears it. meta is read-only here; status never creates the profile_meta row.
  const rebuildReason = meta?.rebuildReason ?? null;

  return Response.json({
    dirty:
      changed.length > 0 ||
      changedTitles.length > 0 ||
      traitVerdictDirty ||
      recRejectDirty ||
      enrichmentCorrectedDirty ||
      rebuildReason !== null,
    changed_books: changed.length,
    changed_book_ids: changed.map((b) => b.id),
    changed_titles: changedTitles.length,
    changed_title_ids: changedTitles.map((t) => t.id),
    last_profiled_at: tsToIso(since),
    last_profile_kind: meta?.lastProfileKind ?? null,
    rebuild_reason: rebuildReason,
  });
});

async function editedOrEvidence(
  db: ReturnType<typeof getDb>,
  userId: string,
  since: string | null,
  titles: Awaited<ReturnType<typeof titlesChangedSince>>
) {
  if (titles.length === 0) return titles;
  const edited = await db
    .select({ id: schema.titles.id })
    .from(schema.titles)
    .where(
      and(
        eq(schema.titles.userId, userId),
        isNotNull(schema.titles.feedbackUpdatedAt),
        since ? gt(schema.titles.feedbackUpdatedAt, since) : undefined
      )
    );
  const editedIds = new Set(edited.map((row) => row.id));
  return titles.filter((t) => editedIds.has(t.id) || blocksScreenRecs(t));
}
