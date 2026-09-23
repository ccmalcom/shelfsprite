import { describe, it, expect } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { makeTestDb, loadSeed, type Seed } from './helpers/pglite';
import seedJson from './fixtures/seed.json';
import { schema, type Db } from '../db';
import { disableScreen, previewScreenOptOut } from '../screenOptOut';
import { setScreen, TOGGLED_AT } from './helpers/screenProfileFixtures';

async function withSeed(fn: (db: Db) => Promise<void>): Promise<void> {
  const { db, close } = await makeTestDb();
  try {
    await loadSeed(db, seedJson as Seed); // traits 1-4 (local, book-only), 101 (other)
    await setScreen(db, true);
    await setScreen(db, true, 'other');
    const t = (over: Partial<typeof schema.tasteTraits.$inferInsert>) => ({
      userId: 'local',
      claim: 'x',
      polarity: 'reward',
      inferenceConfidence: 0.5,
      status: 'proposed',
      ...over,
    });
    await db.insert(schema.tasteTraits).values([
      t({ claim: 'Mixed confirmed', status: 'confirmed', exhibits: [1], exhibitTitleIds: [7] }),
      t({ claim: 'Title-only proposed', exhibitTitleIds: [8] }),
      t({
        claim: 'Edited, contrast title only',
        status: 'edited',
        exhibits: [2],
        contrastTitleIds: [9],
      }),
      t({ claim: 'Rejected, titles', status: 'rejected', exhibitTitleIds: [7] }),
      t({
        claim: 'Empty title arrays',
        exhibits: [3],
        exhibitTitleIds: [],
        contrastTitleIds: [],
      }),
      t({ userId: 'other', claim: 'Other tenant, titles', exhibitTitleIds: [7] }),
    ]);
    await fn(db);
  } finally {
    await close();
  }
}

async function claims(db: Db, userId: string): Promise<string[]> {
  const rows = await db
    .select({ claim: schema.tasteTraits.claim })
    .from(schema.tasteTraits)
    .where(eq(schema.tasteTraits.userId, userId))
    .orderBy(asc(schema.tasteTraits.id));
  return rows.map((r) => r.claim);
}

describe('previewScreenOptOut', () => {
  it('counts title-citing traits of any status, and the user-locked ones among them', async () => {
    await withSeed(async (db) => {
      expect(await previewScreenOptOut(db, 'local')).toEqual({ traits: 4, confirmed: 2 });
    });
  });
});

describe('disableScreen (spec §5.7)', () => {
  it('deletes every title-citing trait, clears the archetype, and marks a rebuild', async () => {
    await withSeed(async (db) => {
      const out = await disableScreen(db, 'local');
      expect(out).toEqual({ traits_removed: 4 });

      const remaining = await claims(db, 'local');
      expect(remaining).not.toContain('Mixed confirmed');
      expect(remaining).not.toContain('Title-only proposed');
      expect(remaining).not.toContain('Edited, contrast title only');
      expect(remaining).not.toContain('Rejected, titles');
      expect(remaining).toContain('Empty title arrays');
      // Book-only traits, confirmed ones included, are untouched.
      expect(remaining).toContain('Values competence and problem-solving protagonists.');
      expect(await claims(db, 'other')).toContain('Other tenant, titles');

      const archetypes = await db.select().from(schema.readerArchetypes);
      expect(archetypes.map((a) => a.userId)).toEqual(['other']);

      const [meta] = await db
        .select()
        .from(schema.profileMeta)
        .where(eq(schema.profileMeta.userId, 'local'));
      expect(meta.rebuildReason).toBe('screen_disabled');

      const [settings] = await db
        .select()
        .from(schema.userSettings)
        .where(eq(schema.userSettings.userId, 'local'));
      expect(settings.screenEnabled).toBe(false);
      expect(settings.screenToggledAt).not.toBe(TOGGLED_AT);
    });
  });

  it('is a no-op when ScreenSprite is already disabled: the toggle stamp does not move', async () => {
    await withSeed(async (db) => {
      await setScreen(db, false);
      const out = await disableScreen(db, 'local');
      expect(out).toEqual({ traits_removed: 0 });
      expect(await claims(db, 'local')).toContain('Mixed confirmed');
      const [settings] = await db
        .select()
        .from(schema.userSettings)
        .where(eq(schema.userSettings.userId, 'local'));
      expect(settings.screenToggledAt).toBe(TOGGLED_AT);
    });
  });
});
