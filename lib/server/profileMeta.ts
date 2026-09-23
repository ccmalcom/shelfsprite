import { eq, sql } from 'drizzle-orm';
import { schema, type Db } from './db';
import { utcnowTs } from './serialize';

export type ProfileMetaRow = typeof schema.profileMeta.$inferSelect;

/**
 * Why the next profile build must be a full rebuild (spec 2026-09-22 §5.6). Written by the
 * screen waves: enabling/disabling screen and deleting titles change evidence in ways the
 * incremental prompt cannot retract.
 */
export type RebuildReason =
  'screen_enabled' | 'screen_disabled' | 'title_deleted' | 'screen_library_deleted';

/** Port of profile.get_profile_meta: fetch-or-create the singleton row. */
export async function ensureProfileMeta(db: Db, userId: string): Promise<ProfileMetaRow> {
  const rows = await db
    .select()
    .from(schema.profileMeta)
    .where(eq(schema.profileMeta.userId, userId));
  if (rows[0]) return rows[0];
  const [created] = await db.insert(schema.profileMeta).values({ userId }).returning();
  return created;
}

/**
 * Records a pending full-rebuild reason. First reason wins for the label: an existing non-null
 * reason is left alone, because any reason forces the same full rebuild. But every call stamps
 * `rebuild_requested_at`, and a full build clears the reason only when that stamp predates its
 * own start (profileBuild.ts#markProfiled). Without the stamp, a second request landing while
 * a build that had already observed the first one was running would be cleared with it.
 *
 * Accepts a transaction as well as the db (a drizzle tx satisfies `Db` structurally, exactly as
 * markProfiled's `tx: Db` already relies on; this holds only while `Db` is the plain
 * PostgresJsDatabase type, not `ReturnType<typeof drizzle>`). The insert is conflict-tolerant
 * so two writers racing to create the row cannot 500.
 */
export async function setRebuildReason(
  db: Db,
  userId: string,
  reason: RebuildReason
): Promise<void> {
  const now = utcnowTs();
  await db
    .insert(schema.profileMeta)
    .values({ userId, rebuildReason: reason, rebuildRequestedAt: now })
    .onConflictDoNothing({ target: schema.profileMeta.userId });
  await db
    .update(schema.profileMeta)
    .set({
      rebuildReason: sql`coalesce(${schema.profileMeta.rebuildReason}, ${reason})`,
      rebuildRequestedAt: now,
    })
    .where(eq(schema.profileMeta.userId, userId));
}

/** The pending rebuild reason, or null. Read-only: never creates the row. */
export async function readRebuildReason(db: Db, userId: string): Promise<RebuildReason | null> {
  const rows = await db
    .select({ reason: schema.profileMeta.rebuildReason })
    .from(schema.profileMeta)
    .where(eq(schema.profileMeta.userId, userId));
  return (rows[0]?.reason ?? null) as RebuildReason | null;
}
