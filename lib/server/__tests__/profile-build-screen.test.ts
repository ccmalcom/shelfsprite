import { describe, it, expect } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { makeTestDb, loadSeed, type Seed } from './helpers/pglite';
import { fakeClaude } from './helpers/fakeClaude';
import { setupTestEnv } from './helpers/testEnv';
import seedJson from './fixtures/seed.json';
import { extractTasteProfile } from '../profileBuild';
import { SCREEN_PROFILE_SYSTEM, SCREEN_PROFILE_TOOL } from '../screenProfilePrompts';
import { schema, type Db } from '../db';
import { ApiError } from '../errors';
import {
  seedScreenLibrary,
  setScreen,
  toggleFlippingClient,
  toolResponse,
} from './helpers/screenProfileFixtures';

setupTestEnv();

async function withScreen(
  fn: (db: Db, t: Awaited<ReturnType<typeof seedScreenLibrary>>) => Promise<void>
) {
  const { db, close } = await makeTestDb();
  try {
    await loadSeed(db, seedJson as Seed);
    await setScreen(db, true);
    const t = await seedScreenLibrary(db);
    await fn(db, t);
  } finally {
    await close();
  }
}

const trait = (over: Record<string, unknown>) => ({
  claim: 'A claim.',
  polarity: 'reward',
  exhibits: [],
  contrasts: [],
  exhibit_titles: [],
  contrast_titles: [],
  inference_confidence: 0.7,
  ...over,
});

async function proposed(db: Db) {
  return db
    .select()
    .from(schema.tasteTraits)
    .where(and(eq(schema.tasteTraits.userId, 'local'), eq(schema.tasteTraits.status, 'proposed')))
    .orderBy(asc(schema.tasteTraits.id));
}

describe('extractTasteProfile, screen variant', () => {
  it('sends SCREEN DATA with the screen system prompt and tool', async () => {
    await withScreen(async (db, t) => {
      const client = fakeClaude([toolResponse('record_taste_traits', { traits: [] })]);
      const out = await extractTasteProfile(db, client, 'local');
      const params = client.calls[0].params;
      expect(params.system).toBe(SCREEN_PROFILE_SYSTEM);
      expect(params.tools).toEqual([SCREEN_PROFILE_TOOL]);
      expect(params.tool_choice).toEqual({ type: 'tool', name: 'record_taste_traits' });
      const prompt = (params.messages as { content: string }[])[0].content;
      const screenJson = prompt.slice(prompt.indexOf('SCREEN DATA (JSON):'));
      expect(screenJson).toContain(`"id": ${t.arrival}, "type": "movie", "title": "Arrival"`);
      expect(screenJson).not.toContain('Tenet');
      expect(screenJson).not.toContain('Other Tenant Film');
      expect(out.variant).toBe('screen');
      expect(out.rated_books).toBe(13);
      expect(out.rated_titles).toBe(4); // arrival, dune, severance, cats
    });
  });

  it('persists typed title evidence, validated against the titles actually sent', async () => {
    await withScreen(async (db, t) => {
      const client = fakeClaude([
        toolResponse('record_taste_traits', {
          traits: [
            trait({
              claim: 'Rewards cerebral first-contact stories.',
              exhibits: [1],
              exhibit_titles: [t.arrival, 99999],
              contrast_titles: [t.cats],
            }),
            trait({
              claim: 'Avoids spectacle musicals.',
              polarity: 'aversion',
              exhibit_titles: [t.cats],
            }),
            // Only an unsent (want) title and an unknown book: no valid exhibit in either medium.
            trait({ claim: 'Loves the watchlist.', exhibits: [99998], exhibit_titles: [t.tenet] }),
            // Another tenant's title is never sent, so it is never valid.
            trait({ claim: 'Borrowed taste.', exhibit_titles: [t.otherUsers] }),
          ],
        }),
      ]);
      const out = await extractTasteProfile(db, client, 'local');
      expect(out.traits_saved).toBe(2);

      const rows = await proposed(db);
      expect(rows.map((r) => r.claim)).toEqual([
        'Rewards cerebral first-contact stories.',
        'Avoids spectacle musicals.',
      ]);
      expect(rows[0].exhibits).toEqual([1]);
      expect(rows[0].exhibitTitleIds).toEqual([t.arrival]);
      expect(rows[0].contrastTitleIds).toEqual([t.cats]);
      expect(rows[1].exhibits).toEqual([]);
      expect(rows[1].exhibitTitleIds).toEqual([t.cats]);
    });
  });

  it('lists favourite films in the feedback block', async () => {
    await withScreen(async (db, t) => {
      await db
        .update(schema.titles)
        .set({ isFavorite: true })
        .where(eq(schema.titles.id, t.arrival));
      const client = fakeClaude([toolResponse('record_taste_traits', { traits: [] })]);
      await extractTasteProfile(db, client, 'local');
      const prompt = (client.calls[0].params.messages as { content: string }[])[0].content;
      expect(prompt).toContain('favorite films and shows');
      expect(prompt).toContain('Arrival (2016 film)');
    });
  });

  it('accepts evidence from either medium: a user with no rated books still builds', async () => {
    const { db, close } = await makeTestDb();
    try {
      await setScreen(db, true);
      await seedScreenLibrary(db);
      const client = fakeClaude([toolResponse('record_taste_traits', { traits: [] })]);
      const out = await extractTasteProfile(db, client, 'local');
      expect(out.rated_books).toBe(0);
      expect(out.rated_titles).toBe(4);
      expect(client.calls).toHaveLength(1);
    } finally {
      await close();
    }
  });
});

describe('screen_toggled_at guard on the full build (spec §5.7)', () => {
  it('writes nothing when ScreenSprite is toggled mid-run (screen variant)', async () => {
    await withScreen(async (db, t) => {
      const beforeTraits = await proposed(db);
      const [beforeMeta] = await db
        .select()
        .from(schema.profileMeta)
        .where(eq(schema.profileMeta.userId, 'local'));
      const client = toggleFlippingClient(
        db,
        toolResponse('record_taste_traits', {
          traits: [trait({ claim: 'Should never land.', exhibit_titles: [t.arrival] })],
        })
      );
      const err = await extractTasteProfile(db, client, 'local').catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(409);
      expect(await proposed(db)).toEqual(beforeTraits);
      const [afterMeta] = await db
        .select()
        .from(schema.profileMeta)
        .where(eq(schema.profileMeta.userId, 'local'));
      expect(afterMeta.lastProfiledAt).toBe(beforeMeta.lastProfiledAt);
    });
  });

  it('writes nothing when ScreenSprite is turned on mid-run (book variant)', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed); // no settings toggle yet: book variant
      const beforeTraits = await proposed(db);
      const client = toggleFlippingClient(
        db,
        toolResponse('record_taste_traits', {
          traits: [trait({ claim: 'Should never land.', exhibits: [1] })],
        })
      );
      const err = await extractTasteProfile(db, client, 'local').catch((e) => e);
      expect((err as ApiError).status).toBe(409);
      expect(await proposed(db)).toEqual(beforeTraits);
    } finally {
      await close();
    }
  });
});
