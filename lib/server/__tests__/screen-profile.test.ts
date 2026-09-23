import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers/pglite';
import { type Db } from '../db';
import { ApiError } from '../errors';
import { PROFILE_RUN_SUPERSEDED_MESSAGE } from '../claudeErrors';
import {
  assertScreenToggleUnchanged,
  screenVariantActive,
  titlesChangedSince,
} from '../screenProfile';
import {
  insertTitle,
  insertTitleEnrichment,
  setScreen,
  TOGGLED_AT,
} from './helpers/screenProfileFixtures';

async function withDb(fn: (db: Db) => Promise<void>): Promise<void> {
  const { db, close } = await makeTestDb();
  try {
    await fn(db);
  } finally {
    await close();
  }
}

describe('screenVariantActive', () => {
  it('is false while ScreenSprite is disabled, even with eligible titles', async () => {
    await withDb(async (db) => {
      await setScreen(db, false);
      await insertTitle(db, { title: 'Arrival', letterboxdRating: 5 });
      expect(await screenVariantActive(db, 'local')).toBe(false);
    });
  });

  it('is false when enabled with no eligible title', async () => {
    await withDb(async (db) => {
      await setScreen(db, true);
      await insertTitle(db, { title: 'Tenet', status: 'want' });
      await insertTitle(db, { title: 'Old' }); // watched, unrated
      await insertTitle(db, { title: 'Hidden', letterboxdRating: 5, excludeFromProfile: true });
      expect(await screenVariantActive(db, 'local')).toBe(false);
    });
  });

  it('is true when enabled with a rated title or an unrated dropped one', async () => {
    await withDb(async (db) => {
      await setScreen(db, true);
      await insertTitle(db, { title: 'Cats', status: 'dropped' });
      expect(await screenVariantActive(db, 'local')).toBe(true);
    });
  });

  it("never counts another tenant's titles", async () => {
    await withDb(async (db) => {
      await setScreen(db, true);
      await insertTitle(db, { userId: 'other', title: 'Theirs', letterboxdRating: 5 });
      expect(await screenVariantActive(db, 'local')).toBe(false);
    });
  });
});

describe('titlesChangedSince (spec §5.5: no eligibility filter)', () => {
  it('returns titles whose feedback or enrichment moved after the cutoff, in id order', async () => {
    await withDb(async (db) => {
      const since = '2026-07-01 12:00:00';
      const rated = await insertTitle(db, {
        title: 'Rated',
        letterboxdRating: 4,
        feedbackUpdatedAt: '2026-07-02 00:00:00',
      });
      await insertTitle(db, {
        title: 'Before',
        letterboxdRating: 4,
        feedbackUpdatedAt: '2026-06-30 00:00:00',
      });
      const enriched = await insertTitle(db, { title: 'Enriched', letterboxdRating: 3 });
      await insertTitleEnrichment(db, enriched, { resolvedAt: '2026-07-03 00:00:00' });
      const stale = await insertTitle(db, { title: 'Stale enrichment', letterboxdRating: 3 });
      await insertTitleEnrichment(db, stale, { resolvedAt: '2026-06-03 00:00:00' });
      const want = await insertTitle(db, {
        title: 'Want',
        status: 'want',
        feedbackUpdatedAt: '2026-07-04 00:00:00',
      });
      await insertTitle(db, {
        userId: 'other',
        title: 'Theirs',
        feedbackUpdatedAt: '2026-07-05 00:00:00',
      });

      const changed = await titlesChangedSince(db, since, 'local');
      expect(changed.map((t) => t.id)).toEqual([rated, enriched, want]);
    });
  });

  it('treats a null cutoff as "every title with feedback or enrichment"', async () => {
    await withDb(async (db) => {
      const a = await insertTitle(db, { title: 'A', feedbackUpdatedAt: '2026-01-01 00:00:00' });
      const b = await insertTitle(db, { title: 'B' });
      await insertTitleEnrichment(db, b);
      await insertTitle(db, { title: 'C' });
      const changed = await titlesChangedSince(db, null, 'local');
      expect(changed.map((t) => t.id)).toEqual([a, b]);
    });
  });
});

describe('assertScreenToggleUnchanged', () => {
  it('passes when the stamp is unchanged, including a user with no settings row', async () => {
    await withDb(async (db) => {
      await expect(assertScreenToggleUnchanged(db, 'local', null)).resolves.toBeUndefined();
      await setScreen(db, true);
      await expect(assertScreenToggleUnchanged(db, 'local', TOGGLED_AT)).resolves.toBeUndefined();
    });
  });

  it('throws a 409 when ScreenSprite was toggled after the run began', async () => {
    await withDb(async (db) => {
      await setScreen(db, true);
      const err = await assertScreenToggleUnchanged(db, 'local', null).catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(409);
      expect((err as ApiError).message).toBe(PROFILE_RUN_SUPERSEDED_MESSAGE);
    });
  });
});
