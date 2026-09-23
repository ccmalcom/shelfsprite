/**
 * Spec §5.1: with ScreenSprite disabled, or enabled with no eligible title, the book profile's
 * full and update requests are BYTE-IDENTICAL to what they were before the screen work: prompt,
 * system prompt, tool schema, tool_choice, model and max_tokens.
 *
 * The golden was recorded once (wave 6 Task 1) from the pre-wave-6 code by running this file
 * with WRITE_PROFILE_GOLDEN=1. NEVER re-record it to make a red test green: red means the book
 * path changed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeTestDb, loadSeed, type Seed } from './helpers/pglite';
import { fakeClaude } from './helpers/fakeClaude';
import { setupTestEnv } from './helpers/testEnv';
import seedJson from './fixtures/seed.json';
import { extractTasteProfile } from '../profileBuild';
import { updateTasteProfile } from '../profileUpdate';
import { schema, type Db } from '../db';
import {
  insertTitle,
  insertTitleEnrichment,
  setScreen,
  toolResponse,
} from './helpers/screenProfileFixtures';

setupTestEnv();
beforeEach(() => {
  // Belt and braces over setupTestEnv: a developer's exported override must not leak in.
  delete process.env.MYLIBRARY_MODEL;
  delete process.env.MYLIBRARY_MODEL_PROFILE;
});

const GOLDEN_PATH = path.join(__dirname, 'fixtures', 'claude', 'profile-books-golden.json');

type Params = Record<string, unknown>;

async function capture(
  kind: 'full' | 'update',
  setup?: (db: Db) => Promise<void>
): Promise<Params[]> {
  const { db, close } = await makeTestDb();
  try {
    await loadSeed(db, seedJson as Seed);
    if (setup) await setup(db);
    const client = fakeClaude([
      toolResponse(kind === 'full' ? 'record_taste_traits' : 'revise_taste_traits', {
        traits: [],
      }),
    ]);
    if (kind === 'full') await extractTasteProfile(db, client, 'local');
    else await updateTasteProfile(db, client, 'local');
    // JSON round-trip: the golden is JSON, so compare like with like.
    return client.calls.map((c) => JSON.parse(JSON.stringify(c.params)) as Params);
  } finally {
    await close();
  }
}

function readGolden(): { full: Params; update: Params } {
  return JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
}

/** Rated, enriched titles plus a title signal and a favourite title: everything screen could leak. */
async function screenDataPresent(db: Db): Promise<void> {
  const arrival = await insertTitle(db, {
    title: 'Arrival',
    year: 2016,
    letterboxdRating: 5,
    isFavorite: true,
    lastWatchedOn: '2024-03-01',
  });
  await insertTitleEnrichment(db, arrival, {
    genres: ['science fiction film'],
    directors: ['Denis Villeneuve'],
  });
  await insertTitle(db, { title: 'Cats', year: 2019, status: 'dropped' });
  // Created before the seed's last_profiled_at, so it cannot change the update branch.
  await db.insert(schema.tasteSignal).values({
    userId: 'local',
    direction: 'more',
    targetKind: 'title',
    targetTitleId: arrival,
    createdAt: '2026-06-01 00:00:00',
  });
}

describe('books-only profile requests are byte-identical (spec §5.1)', () => {
  it('match the recorded golden with no screen data at all', async () => {
    const actual = { full: (await capture('full'))[0], update: (await capture('update'))[0] };
    if (process.env.WRITE_PROFILE_GOLDEN === '1') {
      fs.writeFileSync(GOLDEN_PATH, JSON.stringify(actual, null, 1) + '\n');
    }
    const golden = readGolden();
    // Sanity: the golden really is the book variant.
    expect(String(golden.full.system)).toContain('literary taste analyst');
    expect(String(golden.update.system)).toContain('evolving taste profile');
    expect(actual.full).toEqual(golden.full);
    expect(actual.update).toEqual(golden.update);
  });

  it('are unchanged while ScreenSprite is disabled, even with rated titles, signals and favourites', async () => {
    const golden = readGolden();
    const setup = async (db: Db) => {
      await setScreen(db, false);
      await screenDataPresent(db);
    };
    const full = await capture('full', setup);
    const update = await capture('update', setup);
    expect(full).toHaveLength(1);
    expect(update).toHaveLength(1);
    expect(full[0]).toEqual(golden.full);
    expect(update[0]).toEqual(golden.update);
  });

  it('are unchanged while ScreenSprite is enabled but no title is eligible', async () => {
    const golden = readGolden();
    const setup = async (db: Db) => {
      await setScreen(db, true);
      // None of these is evidence, and none carries feedback_updated_at or enrichment,
      // so none is "changed" either.
      await insertTitle(db, { title: 'Tenet', year: 2020, status: 'want' });
      await insertTitle(db, { title: 'Old', year: 2021, isFavorite: true });
      await insertTitle(db, {
        title: 'Excluded Film',
        year: 2010,
        letterboxdRating: 5,
        excludeFromProfile: true,
      });
    };
    const full = await capture('full', setup);
    const update = await capture('update', setup);
    expect(full).toHaveLength(1);
    expect(update).toHaveLength(1);
    expect(full[0]).toEqual(golden.full);
    expect(update[0]).toEqual(golden.update);
  });

  it('escalate to the book-variant full build, byte-identical, when titles change but none is eligible', async () => {
    const golden = readGolden();
    const calls = await capture('update', async (db) => {
      await setScreen(db, true);
      await insertTitle(db, {
        title: 'Tenet',
        year: 2020,
        status: 'want',
        feedbackUpdatedAt: '2026-07-25 00:00:00',
      });
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(golden.full);
  });
});
