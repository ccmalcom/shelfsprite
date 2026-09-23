/**
 * ScreenSprite opt-out (spec 2026-09-22 §5.7). Disabling deletes every trait with at least one
 * title reference (any status, including confirmed, edited and mixed-evidence), clears the stored
 * archetype, sets rebuild_reason, and stamps screen_toggled_at — one transaction. The stamp is
 * what makes an in-flight profile, archetype or reveal run write nothing (screenProfile.ts).
 *
 * Deletion was chosen over "mark for reassessment": opt-out is rare, deletion is deterministic,
 * and the cost is disclosed first through previewScreenOptOut. Titles themselves are kept, so
 * re-enabling restores the library.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { schema, type Db } from './db';
import { setRebuildReason } from './profileMeta';
import { setScreenEnabled } from './screenSettings';

interface TraitRefs {
  id: number;
  status: string;
  exhibitTitleIds: unknown;
  contrastTitleIds: unknown;
}

function citesTitles(t: TraitRefs): boolean {
  const ex = Array.isArray(t.exhibitTitleIds) ? t.exhibitTitleIds : [];
  const co = Array.isArray(t.contrastTitleIds) ? t.contrastTitleIds : [];
  return ex.length > 0 || co.length > 0;
}

async function traitRefs(db: Db, userId: string): Promise<TraitRefs[]> {
  return db
    .select({
      id: schema.tasteTraits.id,
      status: schema.tasteTraits.status,
      exhibitTitleIds: schema.tasteTraits.exhibitTitleIds,
      contrastTitleIds: schema.tasteTraits.contrastTitleIds,
    })
    .from(schema.tasteTraits)
    .where(eq(schema.tasteTraits.userId, userId));
}

/**
 * What disabling would remove: "N traits drew on your viewing history and will be removed,
 * including M you confirmed." M counts confirmed AND edited traits: both are claims the user
 * locked in and would lose.
 */
export async function previewScreenOptOut(
  db: Db,
  userId: string
): Promise<{ traits: number; confirmed: number }> {
  const citing = (await traitRefs(db, userId)).filter(citesTitles);
  return {
    traits: citing.length,
    confirmed: citing.filter((t) => t.status === 'confirmed' || t.status === 'edited').length,
  };
}

/**
 * Disables ScreenSprite for the user. A no-op when it is already disabled: re-stamping
 * screen_toggled_at would needlessly supersede an in-flight run.
 */
export async function disableScreen(db: Db, userId: string): Promise<{ traits_removed: number }> {
  return db.transaction(async (tx) => {
    const settings = await tx
      .select({ id: schema.userSettings.id, enabled: schema.userSettings.screenEnabled })
      .from(schema.userSettings)
      .where(eq(schema.userSettings.userId, userId));
    if (!settings[0]?.enabled) return { traits_removed: 0 };

    const ids = (await traitRefs(tx, userId)).filter(citesTitles).map((t) => t.id);
    if (ids.length) {
      await tx
        .delete(schema.tasteTraits)
        .where(and(eq(schema.tasteTraits.userId, userId), inArray(schema.tasteTraits.id, ids)));
    }
    await tx.delete(schema.readerArchetypes).where(eq(schema.readerArchetypes.userId, userId));
    await setRebuildReason(tx, userId, 'screen_disabled');
    // Wave 4's helper: flips the flag and stamps screen_toggled_at, which is what supersedes
    // any in-flight profile, archetype or reveal run.
    await setScreenEnabled(tx, userId, false);

    return { traits_removed: ids.length };
  });
}
