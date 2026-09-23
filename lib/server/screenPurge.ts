import { and, eq, inArray, isNotNull, or } from 'drizzle-orm';
import { schema, type DbTx } from './db';

export interface ScreenLibraryPurgeResult {
  titles_removed: number;
  title_recommendations_removed: number;
  title_signals_removed: number;
}

export async function deleteTitleRecommendationRows(tx: DbTx, userId: string): Promise<number> {
  const rows = await tx
    .delete(schema.titleRecommendations)
    .where(eq(schema.titleRecommendations.userId, userId))
    .returning({ id: schema.titleRecommendations.id });
  return rows.length;
}

/** Spec §7.6 "Delete screen library", minus the shared profile (the route adds that). */
export async function deleteScreenLibraryRows(
  tx: DbTx,
  userId: string
): Promise<ScreenLibraryPurgeResult> {
  const owned = await tx
    .select({ id: schema.titles.id })
    .from(schema.titles)
    .where(eq(schema.titles.userId, userId));
  const ids = owned.map(({ id }) => id);

  // LOAD-BEARING: bulk deletes do not cascade; title_enrichment.title_id is an FK.
  if (ids.length > 0) {
    await tx.delete(schema.titleEnrichment).where(inArray(schema.titleEnrichment.titleId, ids));
  }
  const titles = await tx
    .delete(schema.titles)
    .where(eq(schema.titles.userId, userId))
    .returning({ id: schema.titles.id });
  const titleRecommendations = await deleteTitleRecommendationRows(tx, userId);
  const signals = await tx
    .delete(schema.tasteSignal)
    .where(
      and(
        eq(schema.tasteSignal.userId, userId),
        or(isNotNull(schema.tasteSignal.targetTitleId), eq(schema.tasteSignal.targetKind, 'title'))
      )
    )
    .returning({ id: schema.tasteSignal.id });

  return {
    titles_removed: titles.length,
    title_recommendations_removed: titleRecommendations,
    title_signals_removed: signals.length,
  };
}
