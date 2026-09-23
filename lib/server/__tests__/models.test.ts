import { describe, it, expect } from 'vitest';
import { setupTestEnv } from './helpers/testEnv';
import {
  DEFAULT_HAIKU_MODEL,
  DEFAULT_SONNET_MODEL,
  MODEL_ENV,
  modelFor,
  type ModelOperation,
} from '../models';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { makeTestDb, loadSeed, type Seed } from './helpers/pglite';
import { fakeClaude } from './helpers/fakeClaude';
import seedJson from './fixtures/seed.json';
import { extractTasteProfile } from '../profileBuild';
import { updateTasteProfile } from '../profileUpdate';
import { deriveArchetype } from '../archetypeDerive';
import { distillDirective } from '../directiveDistill';
import { generateRevealLines } from '../revealLines';
import { schema } from '../db';

const ALL_OPS: ModelOperation[] = ['profile', 'rerank', 'seed', 'archetype', 'distill', 'reveal'];

describe('modelFor', () => {
  setupTestEnv();

  it('defaults every operation to the model it used before this wave', () => {
    expect(modelFor('profile')).toBe('claude-sonnet-5');
    expect(modelFor('rerank')).toBe('claude-sonnet-5');
    expect(modelFor('seed')).toBe('claude-haiku-4-5-20251001');
    expect(modelFor('archetype')).toBe('claude-haiku-4-5-20251001');
    expect(modelFor('distill')).toBe('claude-haiku-4-5-20251001');
    expect(modelFor('reveal')).toBe('claude-haiku-4-5-20251001');
    expect(DEFAULT_SONNET_MODEL).toBe('claude-sonnet-5');
    expect(DEFAULT_HAIKU_MODEL).toBe('claude-haiku-4-5-20251001');
  });

  it('names one env var per operation', () => {
    expect(MODEL_ENV).toEqual({
      profile: 'MYLIBRARY_MODEL_PROFILE',
      rerank: 'MYLIBRARY_MODEL_RERANK',
      seed: 'MYLIBRARY_MODEL_SEED',
      archetype: 'MYLIBRARY_MODEL_ARCHETYPE',
      distill: 'MYLIBRARY_MODEL_DISTILL',
      reveal: 'MYLIBRARY_MODEL_REVEAL',
    });
  });

  it('lets MYLIBRARY_MODEL move profile and rerank only, never the Haiku operations', () => {
    process.env.MYLIBRARY_MODEL = 'claude-opus-5-5';
    expect(modelFor('profile')).toBe('claude-opus-5-5');
    expect(modelFor('rerank')).toBe('claude-opus-5-5');
    expect(modelFor('seed')).toBe(DEFAULT_HAIKU_MODEL);
    expect(modelFor('archetype')).toBe(DEFAULT_HAIKU_MODEL);
    expect(modelFor('distill')).toBe(DEFAULT_HAIKU_MODEL);
    expect(modelFor('reveal')).toBe(DEFAULT_HAIKU_MODEL);
  });

  it('prefers the per-operation override over MYLIBRARY_MODEL', () => {
    process.env.MYLIBRARY_MODEL = 'claude-opus-5-5';
    process.env.MYLIBRARY_MODEL_RERANK = 'claude-sonnet-5';
    expect(modelFor('rerank')).toBe('claude-sonnet-5');
    expect(modelFor('profile')).toBe('claude-opus-5-5');
  });

  it('moves exactly one operation per override', () => {
    for (const op of ALL_OPS) {
      for (const name of Object.values(MODEL_ENV)) delete process.env[name];
      process.env[MODEL_ENV[op]] = 'override-model';
      for (const other of ALL_OPS) {
        if (other === op) expect(modelFor(other)).toBe('override-model');
        else expect(modelFor(other)).not.toBe('override-model');
      }
    }
  });

  it('ignores an empty or whitespace-only override and trims a padded one', () => {
    process.env.MYLIBRARY_MODEL_SEED = '';
    expect(modelFor('seed')).toBe(DEFAULT_HAIKU_MODEL);
    process.env.MYLIBRARY_MODEL_SEED = '   ';
    expect(modelFor('seed')).toBe(DEFAULT_HAIKU_MODEL);
    process.env.MYLIBRARY_MODEL = '  ';
    expect(modelFor('profile')).toBe(DEFAULT_SONNET_MODEL);
    process.env.MYLIBRARY_MODEL_SEED = '  claude-sonnet-5 ';
    expect(modelFor('seed')).toBe('claude-sonnet-5');
  });

  it('reads the environment at call time, not at import time', () => {
    expect(modelFor('reveal')).toBe(DEFAULT_HAIKU_MODEL);
    process.env.MYLIBRARY_MODEL_REVEAL = 'claude-sonnet-5';
    expect(modelFor('reveal')).toBe('claude-sonnet-5');
  });
});

const emptyTool = (name: string, input: Record<string, unknown>) => ({
  content: [{ type: 'tool_use', name, input }],
  usage: { input_tokens: 1, output_tokens: 1 },
});

describe('call sites honour their operation override', () => {
  setupTestEnv();

  it('profile_full and profile_update send MYLIBRARY_MODEL_PROFILE and report it', async () => {
    process.env.MYLIBRARY_MODEL_PROFILE = 'claude-opus-5-5';
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      const full = fakeClaude([emptyTool('record_taste_traits', { traits: [] })]);
      const out = await extractTasteProfile(db, full, 'local');
      expect(full.calls[0].params.model).toBe('claude-opus-5-5');
      expect(out.model).toBe('claude-opus-5-5');

      // extractTasteProfile just stamped last_profiled_at; move it back so the seeded book
      // changes (2, 3, 9 at 2026-07-15..20) count as changed and the update path calls Claude.
      // The update path also needs at least one proposed trait (the empty build left none).
      await db
        .update(schema.profileMeta)
        .set({ lastProfiledAt: '2026-07-01 12:00:00' })
        .where(eq(schema.profileMeta.userId, 'local'));
      await db.insert(schema.tasteTraits).values({
        userId: 'local',
        claim: 'Rewards dense prose.',
        polarity: 'reward',
        exhibits: [1],
        contrasts: [],
        inferenceConfidence: 0.8,
        status: 'proposed',
      });
      const upd = fakeClaude([emptyTool('revise_taste_traits', { traits: [] })]);
      const updOut = await updateTasteProfile(db, upd, 'local');
      expect(updOut.mode).toBe('update');
      expect(upd.calls[0].params.model).toBe('claude-opus-5-5');
      expect(updOut.model).toBe('claude-opus-5-5');
    } finally {
      await close();
    }
  });

  it('archetype, distill and reveal each read only their own override', async () => {
    process.env.MYLIBRARY_MODEL_ARCHETYPE = 'model-archetype';
    process.env.MYLIBRARY_MODEL_DISTILL = 'model-distill';
    process.env.MYLIBRARY_MODEL_REVEAL = 'model-reveal';
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);

      const a = fakeClaude([emptyTool('record_archetype_scores', {})]);
      // Output validation may reject the empty scores; only the request matters here.
      await deriveArchetype(db, a, 'local').catch(() => {});
      expect(a.calls[0].params.model).toBe('model-archetype');

      const d = fakeClaude([emptyTool('record_directive', { proposed_text: 'x' })]);
      await distillDirective(db, d, { message: 'less grimdark', userId: 'local' });
      expect(d.calls[0].params.model).toBe('model-distill');

      const r = fakeClaude([emptyTool('record_reveal_lines', { lines: [] })]);
      const reveal = await generateRevealLines(db, r, 'local');
      expect(r.calls[0].params.model).toBe('model-reveal');
      expect(reveal.model).toBe('model-reveal');
    } finally {
      await close();
    }
  });

  it('keeps the no-op reveal result reporting the configured model', async () => {
    process.env.MYLIBRARY_MODEL_REVEAL = 'model-reveal';
    const { db, close } = await makeTestDb();
    try {
      // No traits at all: nothing pending, no Claude call, no key needed.
      const out = await generateRevealLines(db, null, 'local');
      expect(out).toEqual({ generated: 0, traits: 0, model: 'model-reveal' });
    } finally {
      await close();
    }
  });
});

describe('no hardcoded model ids outside models.ts and the pricing table', () => {
  it('finds no claude-* model literal in any other lib/server module', () => {
    const dir = path.resolve(__dirname, '..');
    const allowed = new Set(['models.ts', 'anthropic.ts']);
    const offenders: string[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts') || allowed.has(file)) continue;
      const text = readFileSync(path.join(dir, file), 'utf8');
      if (/'claude-(haiku|sonnet|opus)[^']*'/.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
