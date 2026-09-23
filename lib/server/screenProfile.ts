/**
 * Unified-profile plumbing shared by the builders, the status route and the screen
 * recommender (spec 2026-09-22 §5): which prompt variant runs, which titles changed, and the
 * screen_toggled_at guard that makes an opt-in/opt-out supersede an in-flight run.
 */
import { and, asc, eq, gt, isNotNull, or } from 'drizzle-orm';
import { schema, type Db } from './db';
import { ApiError } from './errors';
import { PROFILE_RUN_SUPERSEDED_MESSAGE } from './claudeErrors';
import { isScreenEnabled } from './screenSettings';
import { isTitleProfileEvidence, type TitleRow } from './titles';

/**
 * The screen variant runs only when ScreenSprite is enabled AND at least one title is profile
 * evidence (spec §5.1–§5.2). Otherwise the book variant runs, byte-identical to before.
 */
export async function screenVariantActive(db: Db, userId: string): Promise<boolean> {
  if (!(await isScreenEnabled(db, userId))) return false;
  const rows = await db.select().from(schema.titles).where(eq(schema.titles.userId, userId));
  return rows.some((row) => isTitleProfileEvidence(row));
}

/**
 * Titles changed since the last profile build (spec §5.5). Deliberately NOT filtered by
 * eligibility, unlike booksChangedSince: a title that stopped being evidence must reach the
 * model so the citation can be retracted. A title whose enrichment resolved after the cutoff
 * counts as changed. ORDER BY id keeps the prompt's changed-id list deterministic.
 */
export async function titlesChangedSince(
  db: Db,
  since: string | null,
  userId: string
): Promise<TitleRow[]> {
  const changed =
    since === null
      ? or(isNotNull(schema.titles.feedbackUpdatedAt), isNotNull(schema.titleEnrichment.id))
      : or(
          gt(schema.titles.feedbackUpdatedAt, since),
          gt(schema.titleEnrichment.resolvedAt, since)
        );
  const rows = await db
    .select({ title: schema.titles })
    .from(schema.titles)
    .leftJoin(schema.titleEnrichment, eq(schema.titleEnrichment.titleId, schema.titles.id))
    .where(and(eq(schema.titles.userId, userId), changed))
    .orderBy(asc(schema.titles.id));
  return rows.map((row) => row.title);
}

/**
 * Spec §5.7: profile, archetype and reveal writes compare screen_toggled_at INSIDE their
 * persisting transaction against the value read at run start. A mismatch throws, which rolls the
 * transaction back, so a superseded run writes nothing. Pass the transaction, never the outer db.
 */
export async function assertScreenToggleUnchanged(
  tx: Db,
  userId: string,
  expected: string | null
): Promise<void> {
  const rows = await tx
    .select({ toggledAt: schema.userSettings.screenToggledAt })
    .from(schema.userSettings)
    .where(eq(schema.userSettings.userId, userId));
  const actual = rows[0]?.toggledAt ?? null;
  if (actual !== expected) throw new ApiError(409, PROFILE_RUN_SUPERSEDED_MESSAGE);
}
