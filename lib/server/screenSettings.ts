/**
 * ScreenSprite opt-in (spec §3.1). The flag lives on user_settings; a missing row means off.
 * Every screen route except import and "Delete screen library" calls requireScreenEnabled.
 */
import { eq, sql } from 'drizzle-orm';
import { schema, type Db, type DbTx } from './db';
import { ApiError } from './errors';
import { setRebuildReason } from './profileMeta';
import { utcnowTs } from './serialize';

type Conn = Db | DbTx;

export const SCREEN_DISABLED_MESSAGE = 'ScreenSprite is not enabled for this account.';

async function settingsRow(db: Conn, userId: string) {
  const rows = await db
    .select({
      id: schema.userSettings.id,
      screenEnabled: schema.userSettings.screenEnabled,
      screenToggledAt: schema.userSettings.screenToggledAt,
    })
    .from(schema.userSettings)
    .where(eq(schema.userSettings.userId, userId));
  return rows[0] ?? null;
}

export async function isScreenEnabled(db: Conn, userId: string): Promise<boolean> {
  return (await settingsRow(db, userId))?.screenEnabled ?? false;
}

export async function requireScreenEnabled(db: Conn, userId: string): Promise<void> {
  if (!(await isScreenEnabled(db, userId))) throw new ApiError(403, SCREEN_DISABLED_MESSAGE);
}

export async function readScreenToggledAt(db: Conn, userId: string): Promise<string | null> {
  return (await settingsRow(db, userId))?.screenToggledAt ?? null;
}

/**
 * Flip the flag inside the caller's transaction. Only a real change stamps screen_toggled_at and
 * records a rebuild reason (spec §5.5: enabling or disabling screen forces a full rebuild), and
 * enabling records one only when the account already has titles.
 * Returns whether the flag changed. Wave 6's opt-out calls this for the disable half.
 */
export async function setScreenEnabled(
  tx: DbTx,
  userId: string,
  enabled: boolean
): Promise<boolean> {
  const row = await settingsRow(tx, userId);
  if ((row?.screenEnabled ?? false) === enabled) return false;
  const now = utcnowTs();
  if (row) {
    await tx
      .update(schema.userSettings)
      .set({ screenEnabled: enabled, screenToggledAt: now, updatedAt: now })
      .where(eq(schema.userSettings.id, row.id));
  } else {
    await tx
      .insert(schema.userSettings)
      .values({ userId, screenEnabled: enabled, screenToggledAt: now });
  }
  // Enabling an empty screen library changes nothing a rebuild would see: the unified prompt is the
  // book prompt byte for byte until a title exists, and titles added later take the update path.
  if (!enabled || (await countTitles(tx, userId)) > 0) {
    await setRebuildReason(tx, userId, enabled ? 'screen_enabled' : 'screen_disabled');
  }
  return true;
}

export async function countTitles(db: Conn, userId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.titles)
    .where(eq(schema.titles.userId, userId));
  return Number(rows[0]?.n ?? 0);
}
