import { describe, it, expect } from 'vitest';
import { setupTestEnv } from './helpers/testEnv';
import {
  DEFAULT_HAIKU_MODEL,
  DEFAULT_SONNET_MODEL,
  MODEL_ENV,
  modelFor,
  type ModelOperation,
} from '../models';

const ALL_OPS: ModelOperation[] = ['profile', 'rerank', 'seed', 'archetype', 'distill', 'reveal'];

describe('modelFor', () => {
  setupTestEnv();

  it("defaults every operation to the model it used before this wave", () => {
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
