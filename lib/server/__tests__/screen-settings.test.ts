import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ApiError } from '../errors';
import { schema, type Db } from '../db';
import {
  countTitles,
  isScreenEnabled,
  readScreenToggledAt,
  requireScreenEnabled,
  SCREEN_DISABLED_MESSAGE,
  setScreenEnabled,
} from '../screenSettings';
import { makeTestDb } from './helpers/pglite';

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await makeTestDb());
});
afterEach(async () => {
  await close();
});

async function reason(userId: string): Promise<string | null> {
  const rows = await db
    .select({ r: schema.profileMeta.rebuildReason })
    .from(schema.profileMeta)
    .where(eq(schema.profileMeta.userId, userId));
  return rows[0]?.r ?? null;
}

describe('screen opt-in flag', () => {
  test('is off with no settings row, and requireScreenEnabled answers 403', async () => {
    expect(await isScreenEnabled(db, 'local')).toBe(false);
    expect(await readScreenToggledAt(db, 'local')).toBeNull();
    const err = await requireScreenEnabled(db, 'local').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 403, detail: SCREEN_DISABLED_MESSAGE });
  });

  test('enabling creates the row, stamps toggled_at, and sets the rebuild reason', async () => {
    expect(await db.transaction((tx) => setScreenEnabled(tx, 'local', true))).toBe(true);
    expect(await isScreenEnabled(db, 'local')).toBe(true);
    expect(await readScreenToggledAt(db, 'local')).toEqual(expect.any(String));
    expect(await reason('local')).toBe('screen_enabled');
    await expect(requireScreenEnabled(db, 'local')).resolves.toBeUndefined();
  });

  test('setting the same value again is a no-op that does not restamp', async () => {
    await db.transaction((tx) => setScreenEnabled(tx, 'local', true));
    const first = await readScreenToggledAt(db, 'local');
    expect(await db.transaction((tx) => setScreenEnabled(tx, 'local', true))).toBe(false);
    expect(await readScreenToggledAt(db, 'local')).toBe(first);
  });

  test('disabling an enabled account updates the existing row and keeps a reason set', async () => {
    await db.insert(schema.userSettings).values({ userId: 'local', displayName: 'Sam' });
    await db.transaction((tx) => setScreenEnabled(tx, 'local', true));
    expect(await db.transaction((tx) => setScreenEnabled(tx, 'local', false))).toBe(true);
    expect(await isScreenEnabled(db, 'local')).toBe(false);
    const [settings] = await db
      .select()
      .from(schema.userSettings)
      .where(eq(schema.userSettings.userId, 'local'));
    expect(settings.displayName).toBe('Sam');
    // First reason wins until a full rebuild clears it (wave 2 contract).
    expect(await reason('local')).toBe('screen_enabled');
  });

  test('is per user', async () => {
    await db.transaction((tx) => setScreenEnabled(tx, 'other', true));
    expect(await isScreenEnabled(db, 'local')).toBe(false);
    expect(await reason('local')).toBeNull();
  });

  test('countTitles counts only the caller', async () => {
    await db.insert(schema.titles).values([
      { userId: 'local', mediaType: 'movie', title: 'A', status: 'want' },
      { userId: 'local', mediaType: 'tv', title: 'B', status: 'watching' },
      { userId: 'other', mediaType: 'movie', title: 'C', status: 'want' },
    ]);
    expect(await countTitles(db, 'local')).toBe(2);
  });
});
