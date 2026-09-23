import { describe, it, expect } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { makeTestDb, loadSeed, type Seed } from './helpers/pglite';
import { fakeClaude } from './helpers/fakeClaude';
import { setupTestEnv } from './helpers/testEnv';
import seedJson from './fixtures/seed.json';
import { updateTasteProfile } from '../profileUpdate';
import { SCREEN_REVISE_SYSTEM, SCREEN_REVISE_TOOL } from '../screenProfilePrompts';
import { titlesChangedSince } from '../screenProfile';
import { schema, type Db } from '../db';
import { ApiError } from '../errors';
import { utcnowTs } from '../serialize';
import type { ClaudeClient, ClaudeMessage } from '../claude';
import {
  seedScreenLibrary,
  setLastProfiledAt,
  setScreen,
  toggleFlippingClient,
  toolResponse,
  type ScreenLibraryIds,
} from './helpers/screenProfileFixtures';

setupTestEnv();

/** After every seeded book change (07-xx), so only what a test stamps counts as changed. */
const SINCE = '2026-08-01 00:00:00';
const AFTER = '2026-08-02 00:00:00';

async function withScreen(fn: (db: Db, t: ScreenLibraryIds) => Promise<void>) {
  const { db, close } = await makeTestDb();
  try {
    await loadSeed(db, seedJson as Seed);
    await setScreen(db, true);
    const t = await seedScreenLibrary(db);
    await setLastProfiledAt(db, SINCE);
    // Seeded proposed trait 1 already cites Arrival.
    await db
      .update(schema.tasteTraits)
      .set({ exhibitTitleIds: [t.arrival] })
      .where(eq(schema.tasteTraits.id, 1));
    await fn(db, t);
  } finally {
    await close();
  }
}

async function stamp(
  db: Db,
  titleId: number,
  values: Partial<typeof schema.titles.$inferInsert> = {}
) {
  await db
    .update(schema.titles)
    .set({ feedbackUpdatedAt: AFTER, ...values })
    .where(eq(schema.titles.id, titleId));
}

const revise = (traits: unknown[]) => toolResponse('revise_taste_traits', { traits });

function promptOf(client: { calls: { params: Record<string, unknown> }[] }): string {
  return (client.calls[0].params.messages as { content: string }[])[0].content;
}

describe('updateTasteProfile, screen variant', () => {
  it('revises with changed and cited titles, each carrying rating and status', async () => {
    await withScreen(async (db, t) => {
      await stamp(db, t.dune, { appRating: 3 });
      await stamp(db, t.tenet); // a changed want title: sent, but not citable
      const client = fakeClaude([
        revise([
          {
            claim: 'Rewards Villeneuve-style scale.',
            polarity: 'reward',
            exhibits: [1],
            contrasts: [],
            exhibit_titles: [t.arrival, t.tenet, 99999],
            contrast_titles: [t.dune],
            inference_confidence: 0.8,
          },
        ]),
      ]);
      const out = await updateTasteProfile(db, client, 'local');

      const params = client.calls[0].params;
      expect(params.system).toBe(SCREEN_REVISE_SYSTEM);
      expect(params.tools).toEqual([SCREEN_REVISE_TOOL]);
      const prompt = promptOf(client);
      expect(prompt).toContain(
        `CHANGED TITLE IDS (the edits driving this update): [${t.dune}, ${t.tenet}]\n`
      );
      expect(prompt).toContain('CHANGED BOOK IDS (the edits driving this update): []\n');
      expect(prompt).toContain(`"exhibit_titles": [${t.arrival}]`); // trait 1's current titles
      const titles = prompt.slice(prompt.indexOf('TITLES (id -> metadata'));
      expect(titles).toContain(`"${t.arrival}": {"id": ${t.arrival}`); // cited
      expect(titles).toContain('"rating": 3, "status": "watched"'); // dune, changed
      expect(titles).toContain('"rating": null, "status": "want"'); // tenet, changed
      expect(titles).not.toContain('Severance'); // neither changed nor cited

      expect(out.mode).toBe('update');
      expect(out.variant).toBe('screen');
      expect(out.changed_titles).toBe(2);
      expect(out.titles_sent).toBe(3);

      const [row] = await db
        .select()
        .from(schema.tasteTraits)
        .where(
          and(eq(schema.tasteTraits.userId, 'local'), eq(schema.tasteTraits.status, 'proposed'))
        );
      expect(row.exhibitTitleIds).toEqual([t.arrival]); // tenet (want) and 99999 dropped
      expect(row.contrastTitleIds).toEqual([t.dune]);
    });
  });

  it('says "already up to date" when nothing changed', async () => {
    await withScreen(async (db) => {
      const client = fakeClaude([]);
      const out = await updateTasteProfile(db, client, 'local');
      expect(client.calls).toHaveLength(0);
      expect(String(out.note)).toContain('already up to date');
    });
  });

  it('escalates to a full build when the only title change is an exclusion', async () => {
    await withScreen(async (db, t) => {
      await stamp(db, t.dune, { excludeFromProfile: true });
      const client = fakeClaude([toolResponse('record_taste_traits', { traits: [] })]);
      const out = await updateTasteProfile(db, client, 'local');
      expect(out.mode).toBe('full');
      expect(out.variant).toBe('screen');
    });
  });

  it('counts a title whose enrichment resolved after the last build as changed', async () => {
    await withScreen(async (db, t) => {
      await db
        .update(schema.titleEnrichment)
        .set({ resolvedAt: AFTER })
        .where(eq(schema.titleEnrichment.titleId, t.severance));
      const client = fakeClaude([revise([])]);
      await updateTasteProfile(db, client, 'local');
      expect(promptOf(client)).toContain(
        `CHANGED TITLE IDS (the edits driving this update): [${t.severance}]`
      );
    });
  });

  it('writes nothing when ScreenSprite is toggled mid-run', async () => {
    await withScreen(async (db, t) => {
      await stamp(db, t.dune, { appRating: 3 });
      const before = await db
        .select()
        .from(schema.tasteTraits)
        .where(eq(schema.tasteTraits.userId, 'local'))
        .orderBy(asc(schema.tasteTraits.id));
      const client = toggleFlippingClient(db, revise([]));
      const err = await updateTasteProfile(db, client, 'local').catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(409);
      const after = await db
        .select()
        .from(schema.tasteTraits)
        .where(eq(schema.tasteTraits.userId, 'local'))
        .orderBy(asc(schema.tasteTraits.id));
      expect(after).toEqual(before);
    });
  });

  it('keeps a title edited during the run pending afterwards (spec §5.6 with titles)', async () => {
    await withScreen(async (db, t) => {
      await stamp(db, t.dune, { appRating: 3 });
      const response: ClaudeMessage = revise([]);
      const client: ClaudeClient = {
        messages: {
          async create() {
            // Strictly after the run's start, and strictly before its completion.
            await new Promise((r) => setTimeout(r, 20));
            await db
              .update(schema.titles)
              .set({ appRating: 2, feedbackUpdatedAt: utcnowTs() })
              .where(eq(schema.titles.id, t.severance));
            await new Promise((r) => setTimeout(r, 20));
            return response;
          },
        },
      };
      await updateTasteProfile(db, client, 'local');
      const [meta] = await db
        .select()
        .from(schema.profileMeta)
        .where(eq(schema.profileMeta.userId, 'local'));
      const pending = await titlesChangedSince(db, meta.lastProfiledAt, 'local');
      expect(pending.map((x) => x.id)).toContain(t.severance);
    });
  });
});
