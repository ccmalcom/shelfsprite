/**
 * Per-operation Claude model selection (spec 2026-09-22 §6.8, decision 10).
 *
 * Each operation reads its own override at CALL time (never at module load: CI runs with no
 * environment at all, see docs/conventions.md). With no override, every operation keeps the
 * model it used before per-operation settings existed, so a deploy changes nothing:
 *
 *   profile, rerank  -> MYLIBRARY_MODEL -> claude-sonnet-5
 *   seed, archetype, distill, reveal -> claude-haiku-4-5-20251001
 *
 * MYLIBRARY_MODEL deliberately does NOT apply to the four Haiku operations. Before this module
 * they were hardcoded to Haiku; letting the old global override reach them would silently move
 * four cheap calls to a model twice the price.
 *
 * Kept dependency-free on purpose, like rating.ts: it is pure configuration.
 */
export type ModelOperation = 'profile' | 'rerank' | 'seed' | 'archetype' | 'distill' | 'reveal';

export const DEFAULT_SONNET_MODEL = 'claude-sonnet-5';
export const DEFAULT_HAIKU_MODEL = 'claude-haiku-4-5-20251001';

export const MODEL_ENV: Readonly<Record<ModelOperation, string>> = {
  profile: 'MYLIBRARY_MODEL_PROFILE',
  rerank: 'MYLIBRARY_MODEL_RERANK',
  seed: 'MYLIBRARY_MODEL_SEED',
  archetype: 'MYLIBRARY_MODEL_ARCHETYPE',
  distill: 'MYLIBRARY_MODEL_DISTILL',
  reveal: 'MYLIBRARY_MODEL_REVEAL',
};

/** A set, non-blank env value, trimmed; otherwise null (a blank dashboard field is "unset"). */
function envModel(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

export function modelFor(op: ModelOperation): string {
  const override = envModel(MODEL_ENV[op]);
  if (override) return override;
  if (op === 'profile' || op === 'rerank') {
    return envModel('MYLIBRARY_MODEL') ?? DEFAULT_SONNET_MODEL;
  }
  return DEFAULT_HAIKU_MODEL;
}
