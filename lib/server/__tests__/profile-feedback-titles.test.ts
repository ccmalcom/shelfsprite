import { describe, it, expect } from 'vitest';
import { makeTestDb, loadSeed, type Seed } from './helpers/pglite';
import seedJson from './fixtures/seed.json';
import { schema, type Db } from '../db';
import { feedbackBlock, feedbackContext } from '../profileFeedback';
import { insertTitle } from './helpers/screenProfileFixtures';

async function withSeed(fn: (db: Db) => Promise<void>): Promise<void> {
  const { db, close } = await makeTestDb();
  try {
    await loadSeed(db, seedJson as Seed);
    await fn(db);
  } finally {
    await close();
  }
}

async function seedSignals(db: Db) {
  const arrival = await insertTitle(db, { title: 'Arrival', year: 2016, isFavorite: true });
  const severance = await insertTitle(db, { title: 'Severance', year: 2022, mediaType: 'tv' });
  const undated = await insertTitle(db, { title: 'Undated', year: null, isFavorite: true });
  const theirs = await insertTitle(db, { userId: 'other', title: 'Theirs', isFavorite: true });
  const signal = (over: Partial<typeof schema.tasteSignal.$inferInsert>) => ({
    userId: 'local',
    direction: 'more',
    targetKind: 'title',
    createdAt: '2026-06-01 00:00:00',
    ...over,
  });
  await db.insert(schema.tasteSignal).values([
    signal({ targetTitleId: arrival }),
    signal({ targetKind: 'book', targetBookId: 1 }),
    signal({ direction: 'less', targetTitleId: severance }),
    signal({ targetTitleId: theirs }), // another tenant's title: must resolve to nothing
    signal({ userId: 'other', targetTitleId: theirs }),
  ]);
  return { arrival, severance, undated };
}

describe('feedbackContext title data', () => {
  it('ignores title signals and favourite titles unless asked (book variant)', async () => {
    await withSeed(async (db) => {
      await seedSignals(db);
      const ctx = await feedbackContext(db, 'local');
      expect(ctx.more_like).toEqual(['Dune by Frank Herbert']);
      expect(ctx.less_like).toEqual([]);
      expect('favorite_titles' in ctx).toBe(false);
    });
  });

  it('reads title signals in signal order and favourite titles when asked', async () => {
    await withSeed(async (db) => {
      await seedSignals(db);
      const ctx = await feedbackContext(db, 'local', { titles: true });
      expect(ctx.more_like).toEqual(['Arrival (2016 film)', 'Dune by Frank Herbert']);
      expect(ctx.less_like).toEqual(['Severance (2022 TV series)']);
      expect(ctx.favorite_titles).toEqual(['Arrival (2016 film)', 'Undated (film)']);
    });
  });
});

describe('feedbackBlock favourite titles line', () => {
  it('is rendered only when favourite titles are present', async () => {
    await withSeed(async (db) => {
      await seedSignals(db);
      const books = await feedbackContext(db, 'local');
      const screen = await feedbackContext(db, 'local', { titles: true });
      expect(feedbackBlock(books)).not.toContain('favorite films and shows');
      expect(feedbackBlock(screen)).toContain(
        "- The following are the user's all-time favorite films and shows — weight these as " +
          'the strongest possible positive signal when deriving taste traits: ' +
          'Arrival (2016 film); Undated (film)\n'
      );
      expect(feedbackBlock({ ...screen, favorite_titles: [] })).not.toContain(
        'favorite films and shows'
      );
    });
  });
});
