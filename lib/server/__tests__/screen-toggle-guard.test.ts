import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeTestDb, loadSeed, type Seed } from './helpers/pglite';
import { fakeClaude } from './helpers/fakeClaude';
import { setupTestEnv } from './helpers/testEnv';
import seedJson from './fixtures/seed.json';
import { schema, type Db } from '../db';
import { ApiError } from '../errors';
import { deriveArchetype } from '../archetypeDerive';
import { generateRevealLines } from '../revealLines';
import { setScreen, toggleFlippingClient, toolResponse } from './helpers/screenProfileFixtures';

setupTestEnv();

async function withSeed(fn: (db: Db) => Promise<void>): Promise<void> {
  const { db, close } = await makeTestDb();
  try {
    await loadSeed(db, seedJson as Seed);
    await setScreen(db, true);
    await fn(db);
  } finally {
    await close();
  }
}

const archetypeResponse = () =>
  toolResponse('record_archetype_scores', {
    lens: 0.5,
    engine: -0.2,
    range: 0.1,
    resonance: 0.3,
    lens_rationale: 'a',
    engine_rationale: 'b',
    range_rationale: 'c',
    resonance_rationale: 'd',
  });

async function archetypeRow(db: Db) {
  const [row] = await db
    .select()
    .from(schema.readerArchetypes)
    .where(eq(schema.readerArchetypes.userId, 'local'));
  return row;
}

async function revealLineOf(db: Db, id: number) {
  const [row] = await db
    .select({ revealLine: schema.tasteTraits.revealLine })
    .from(schema.tasteTraits)
    .where(eq(schema.tasteTraits.id, id));
  return row.revealLine;
}

describe('archetype writes (spec §5.7)', () => {
  it('persists normally when nothing was toggled', async () => {
    await withSeed(async (db) => {
      const before = await archetypeRow(db);
      await deriveArchetype(db, fakeClaude([archetypeResponse()]), 'local');
      expect((await archetypeRow(db)).derivedAt).not.toBe(before.derivedAt);
    });
  });

  it('writes nothing when ScreenSprite is toggled mid-run', async () => {
    await withSeed(async (db) => {
      const before = await archetypeRow(db);
      const err = await deriveArchetype(
        db,
        toggleFlippingClient(db, archetypeResponse()),
        'local'
      ).catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(409);
      expect(await archetypeRow(db)).toEqual(before);
    });
  });
});

describe('reveal-line writes (spec §5.7)', () => {
  const lines = () =>
    toolResponse('record_reveal_lines', { lines: [{ id: 3, reveal_line: 'You like endings.' }] });

  it('persists normally when nothing was toggled', async () => {
    await withSeed(async (db) => {
      await generateRevealLines(db, fakeClaude([lines()]), 'local');
      expect(await revealLineOf(db, 3)).toBe('You like endings.');
    });
  });

  it('writes nothing when ScreenSprite is toggled mid-run', async () => {
    await withSeed(async (db) => {
      const err = await generateRevealLines(db, toggleFlippingClient(db, lines()), 'local').catch(
        (e) => e
      );
      expect((err as ApiError).status).toBe(409);
      expect(await revealLineOf(db, 3)).toBeNull();
    });
  });
});
