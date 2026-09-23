# Wave 2: model settings and profile run boundary. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every Claude operation its own model setting (each defaulting to today's model), record Opus 5.5 cost correctly, stop a profile build from marking edits made during the build as profiled, and add a durable `rebuild_reason` that forces the next profile update to be a full rebuild.

**Architecture:** A new dependency-free `lib/server/models.ts` owns model selection. It reads a per-operation env override at call time, then the operation's historical default. Every hardcoded model constant is replaced with a `modelFor(op)` call. `markProfiled` stops stamping completion time: both profile builders capture `runStartedAt` before their first read and stamp that. `profile_meta.rebuild_reason` (nullable varchar) is set by later waves through `setRebuildReason`. It makes the status route report dirty and makes `updateTasteProfile` escalate to `extractTasteProfile`. A completed full rebuild clears it, but only when the value is still the one it read at run start. This wave is book-only; the screen waves (4, 6) are the first writers of `rebuild_reason`.

**Tech Stack:** TypeScript, Next.js route handlers, drizzle-orm + drizzle-kit, Vitest (`lib/server/**`, `app/api/**`), PGlite test database.

**Spec:** `docs/superpowers/specs/2026-09-22-screen-media-design.md`. This wave implements §5.6, §6.8 and decision 10. Read the plan index first: `docs/superpowers/plans/2026-09-22-screen-media-00-index.md`. Its "Cross-wave contract" fixes `modelFor`, `RebuildReason`, `setRebuildReason` and the new `markProfiled`/`persistProposedTraits` signatures.

**Issue:** #96 (these are prerequisites the screen waves build on; they also fix an existing book bug).

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Two test runners with disjoint ownership.** `npm run test:server` (Vitest) owns exactly
  `lib/server/**` and `app/api/**`; `npm test` (Jest) owns everything else. Before naming a single
  test file as a gate, confirm the runner sees it: `npx vitest list <path>` or
  `npx jest --listTests <path>`. A gate that matches zero tests exits 0.
- **Full gate at the end of every wave**, from the repository root: `npm run test:server`,
  `npm test`, `npm run type-check`, `npm run lint`, `npm run format:check`, `npm run build`.
  `npm run build` is the only gate that catches Next segment-config and prerender failures.
- **Real-flow verification before a wave is called done** (spec §10). Tests alone never close a
  wave. Use an isolated local run: a scratch Postgres in Docker plus a local-mode dev server
  (`ALLOW_LOCAL_AUTH=true`) with **no `.env` file in scope**, following the procedure recorded in
  the project memory note `marketing-screenshot-pipeline`. Never point a verification run at the
  production database. Record what you actually observe, not what a plan predicts.
- **Secrets.** Never open, print, or name the contents of `.env*` files; check presence only.
  Never ask Codex to inspect them.
- **Ratings.** `numeric(2,1)` with drizzle `mode: 'number'` on every rating column. `0` on an API
  mutation means "clear". The manual `isValidRating` guard owns the 422 message; do not move the
  grid rule into Zod.
- **Wire format.** API JSON is snake_case. Prompt payloads use `pyJsonDumps` over ordered `Map`s
  (`lib/server/serialize.ts`); never `JSON.stringify` a prompt payload.
- **Long-running routes** export the literal `export const maxDuration = 300;`, never an imported
  binding. Every new one is added to `app/api/enrich/enrich-max-duration.test.ts`.
- **Tenancy.** Every query on a user-owned table filters by `user_id`; every route test includes a
  second user whose ids are rejected (404, never 403 that leaks existence).
- **Schema changes.** Edit `lib/server/schema.ts`, run `npm run db:generate`, read the generated
  SQL, and mirror the change in `lib/server/__tests__/helpers/pglite.ts` (the test database is
  hand-written SQL, not generated) plus `loadSeed`'s key/JSON/timestamp/sequence lists when a seed
  needs the table. `books` is never dropped or recreated. Applying a migration to production is
  Chase's step, not the executor's; the plan's final task lists the command for him.
- **`.tsx` string literals are ASCII-only**; put a non-ASCII value in an expression container
  (`{'…'}`), never in a bare JSX attribute. `text-base` is a colour, not a size.
- **Copy.** User-facing copy says **ScreenSprite**; code, routes, tables and settings keys say
  `screen` (spec decision 13).
- **Git.** Work on `feat/screen-media`. Chase commits manually by default: a plan's "Commit" step
  runs only when Chase has authorized commits for that execution session; otherwise stage the
  listed paths and leave them. Plain commit messages, no `Co-Authored-By` trailer; end each with
  the `Claude-Session:` line from the session's attribution instructions. Subjects:
  `feat(profile): … (#97)` for wave 1, `feat(screen): … (#96)` or `fix(profile): … (#96)` after.
- **Next.js here is not the Next.js you know.** Before writing route, page or `next/image` code,
  read the relevant guide in `node_modules/next/dist/docs/`.

Wave-specific constraints:

- **Nothing changes on deploy.** With no new env var set, every Claude call must send exactly the
  model it sends today: profile and rerank go to `MYLIBRARY_MODEL`, then `claude-sonnet-5`; seed,
  archetype, distill and reveal go to `claude-haiku-4-5-20251001`. `recommend-run.test.ts`
  compares the recorded request snapshots (including `model`) with total equality. It must stay
  green **without editing `fixtures/claude/prompts.json`**.
- **Env reads happen at call time, never at module load** (`docs/conventions.md`, "Continuous
  integration"). `models.ts` must not read `process.env` at the top level.
- **Do not touch prompt strings.** Profile, update, seed and rerank prompts and tools are
  byte-pinned. This wave changes only the `model` value and the persistence tail.
- **Do not change `runRecommend`'s gate.** `rebuild_reason` makes the profile *status* dirty.
  The Home UI already blocks on `dirty`. Adding it to the book recommend gate is out of scope
  (spec §6.2 adds it to the *screen* gate in wave 7).
- **Do not open `.env.example`.** Documenting the new env vars goes in `docs/hosting.md`. If
  Chase wants them in `.env.example`, he adds them.

---

## Review Focus

These are the inputs most likely to hurt a real user that no ordinary task test reaches. Each
line is pinned by a test in the task named.

1. **An edit made while a profile build is running** (a rating changed in another tab during a
   30-second Sonnet call) must still show as pending afterwards, for both the full build and the
   incremental update. Today it is silently marked profiled. *(Task 4, two tests, mutation-tested.)*
2. **A rebuild reason that arrives during a full rebuild** (e.g. a title deleted while the build
   runs) must survive it, so the next update escalates again, **including when another reason
   was already pending at run start** (first-reason-wins keeps the old label, so only
   `rebuild_requested_at` can tell the build the request is newer). An unconditional clear, or a
   clear keyed on the label alone, would lose it. *(Task 4, both clauses mutation-tested.)*
3. **`MYLIBRARY_MODEL` set in production** (it is documented and may be set) must keep moving
   only profile and rerank, never the four Haiku operations; otherwise one env var doubles their
   price silently. *(Task 1.)*
4. **An empty or whitespace-only override** (`MYLIBRARY_MODEL_SEED=` left blank in a dashboard)
   must fall back to the default, not send `""` as the model and 400 every call. *(Task 1.)*
5. **Another user's `rebuild_reason`** must never make this user's profile dirty, and a status
   read must not create or alter a `profile_meta` row. *(Task 5, status route test.)*

---

## Design decisions already settled

1. **Env var names** are fixed by the index contract: `MYLIBRARY_MODEL_PROFILE`,
   `MYLIBRARY_MODEL_RERANK`, `MYLIBRARY_MODEL_SEED`, `MYLIBRARY_MODEL_ARCHETYPE`,
   `MYLIBRARY_MODEL_DISTILL`, `MYLIBRARY_MODEL_REVEAL`. Profile and rerank fall back to
   `MYLIBRARY_MODEL`, then `claude-sonnet-5`. The other four fall back directly to
   `claude-haiku-4-5-20251001`; `MYLIBRARY_MODEL` never applies to them. The chat that set this
   up said why: "If Sonnet 5 were the default everywhere, it would quietly move four Haiku calls
   to Sonnet at double the price."
2. **Which operation each call site uses:**

   | Call site | `operation` recorded | `modelFor(…)` |
   |---|---|---|
   | `profileBuild.ts#extractTasteProfile` | `profile_full` | `'profile'` (via `profileModel()`) |
   | `profileUpdate.ts#updateTasteProfile` | `profile_update` | `'profile'` (via `profileModel()`) |
   | `recommendRun.ts` seed | `recommend_seed` | `'seed'` |
   | `recommendRun.ts` rerank | `recommend_rerank` | `'rerank'` (via `rankModel()`) |
   | `recSimilarRun.ts` seed | `similar_seed` | `'seed'` |
   | `recSimilarRun.ts` rerank | `similar_rerank` | `'rerank'` |
   | `recDiscoverRun.ts` interpret | `discover_interpret` | `'seed'` |
   | `recDiscoverRun.ts` rerank | `discover_rerank` | `'rerank'` |
   | `archetypeDerive.ts` | `archetype` | `'archetype'` |
   | `directiveDistill.ts` | `directive_distill` | `'distill'` |
   | `revealLines.ts` | `reveal_lines` | `'reveal'` |

   `discover_interpret` is a Haiku query-proposal call like the seeds and already imports
   `SEED_MODEL`, so it maps to `'seed'`.
3. **The hardcoded constants are deleted, not kept as aliases.** `SEED_MODEL`, `ARCHETYPE_MODEL`,
   `REVEAL_MODEL` and `DISTILL_MODEL` are only referenced inside `lib/server` (verified by grep).
   Any constant left behind is exactly the value that would silently ignore an override.
   `profileModel()` and `rankModel()` stay because the contract names them and several modules
   import them.
4. **Opus 5.5 price row:** `'claude-opus-5-5': [4.0, 20.0, 5.0, 0.4]`, which is spec §6.8's
   $4/$20 per MTok. Cache write (1.25×) and cache read (0.1×) follow the same ratios as every
   other row in the table. Task 2 verifies the live price before committing.
5. **`runStartedAt` is captured before the builder's first database read**, not just before the
   Claude call. An edit that lands between the reads and the call is also missing from the
   prompt. The cost is conservative: an edit landing between `runStartedAt` and the reads is
   included in the prompt *and* shows as pending, so one extra "update available" banner can
   appear. That is the right direction to err.
6. **The full-rebuild clear is conditional.** `extractTasteProfile` reads `rebuild_reason` at run
   start. The persist transaction then clears it with
   `where rebuild_reason = <value read at start> and (rebuild_requested_at is null or
   rebuild_requested_at < runStartedAt)`. `setRebuildReason` stamps `rebuild_requested_at` on
   every call, even when it keeps the existing label, so a request made mid-run survives whether
   or not a reason was already pending (a Fable review found the label-only clear dropped a
   `title_deleted` that arrived while `screen_enabled` was pending). This adds one optional
   trailing parameter (`observedRebuildReason`) to the contract's
   `markProfiled`/`persistProposedTraits` signatures and one column. It is additive, and existing
   callers are unaffected.
7. **Known, accepted edge:** `GET /api/profile/archetype` computes
   `is_stale = derived_at < last_profiled_at`. With the start-of-run stamp, an archetype derived
   *during* a profile build (two tabs, simultaneous) reads as fresh although it used the old
   traits. It needs two concurrent user actions, the reader can re-derive it, and the
   alternative (a second completion timestamp) is a schema change nothing else needs. Leave it,
   and do not "fix" the archetype route in this wave.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `lib/server/models.ts` | Create | `ModelOperation`, `MODEL_ENV`, `modelFor`. Dependency-free. |
| `lib/server/__tests__/models.test.ts` | Create | Unit tests for `modelFor`, call-site override tests for the Haiku operations and the profile build, and a tripwire against hardcoded model ids. |
| `lib/server/__tests__/helpers/testEnv.ts` | Modify | Add the six env names to `ENV_KEYS` and delete them in `beforeEach`. |
| `lib/server/profileBuild.ts` | Modify | `profileModel()` → `modelFor('profile')`; `markProfiled`/`persistProposedTraits` take `runStartedAt` (+ optional observed reason); `extractTasteProfile` captures both. |
| `lib/server/profileUpdate.ts` | Modify | Capture `runStartedAt`; escalate to full rebuild when `rebuild_reason` is set. |
| `lib/server/recPrompts.ts` | Modify | Delete `SEED_MODEL`; `rankModel()` → `modelFor('rerank')`. |
| `lib/server/recommendRun.ts`, `recSimilarRun.ts`, `recDiscoverRun.ts` | Modify | `SEED_MODEL` → `modelFor('seed')`. |
| `lib/server/recSimilarPrompts.ts` | Modify | Comment only: it names `SEED_MODEL`. |
| `lib/server/archetypeDerive.ts`, `directiveDistill.ts`, `revealLines.ts` | Modify | Delete the constant; call `modelFor`. |
| `lib/server/anthropic.ts` | Modify | Add the `claude-opus-5-5` pricing row. |
| `lib/server/__tests__/anthropic.test.ts` | Modify | Price test for Opus 5.5. |
| `lib/server/__tests__/similar-run.test.ts`, `discover-run.test.ts`, `recommend-run.test.ts` | Modify | One override test each. |
| `lib/server/schema.ts` | Modify | `profileMeta.rebuildReason`. |
| `drizzle/0007_*.sql` + `drizzle/meta/*` | Generate | `ALTER TABLE "profile_meta" ADD COLUMN "rebuild_reason" varchar;` and `… ADD COLUMN "rebuild_requested_at" timestamp;` |
| `lib/server/__tests__/helpers/pglite.ts` | Modify | Mirror `rebuild_reason text` on `profile_meta`. |
| `lib/server/profileMeta.ts` | Modify | `RebuildReason`, `setRebuildReason`, `readRebuildReason`. |
| `lib/server/__tests__/profile-meta.test.ts` | Create | Tests for the two helpers. |
| `lib/server/__tests__/profile-run-boundary.test.ts` | Create | Cutoff, conditional-clear and escalation tests. |
| `app/api/profile/status/route.ts` | Modify | Report `rebuild_reason`; dirty when set. |
| `app/api/profile/status/route.test.ts` | Create | Route tests including tenancy. |
| `lib/api.ts` | Modify | `ProfileStatus.rebuild_reason: string \| null`. |
| `docs/hosting.md`, `docs/architecture.md` | Modify | Document the env vars and the new module. |

---

## Handoff batching

This plan is written for a controller session dispatching one subagent per task. **Stop and hand off after Task 3.** Keep the `.superpowers/sdd/` ledger current after every task.

- **Batch A:** Task 1, Task 2, Task 3 → hand off
- **Batch B:** Task 4, Task 5, Task 6

---

### Task 1: `modelFor` and the test environment

**Files:**
- Create: `lib/server/models.ts`
- Create: `lib/server/__tests__/models.test.ts`
- Modify: `lib/server/__tests__/helpers/testEnv.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (index contract):
  - `export type ModelOperation = 'profile' | 'rerank' | 'seed' | 'archetype' | 'distill' | 'reveal'`
  - `export const MODEL_ENV: Readonly<Record<ModelOperation, string>>`
  - `export const DEFAULT_SONNET_MODEL = 'claude-sonnet-5'`
  - `export const DEFAULT_HAIKU_MODEL = 'claude-haiku-4-5-20251001'`
  - `export function modelFor(op: ModelOperation): string`

- [ ] **Step 1: Register the new env names in the test environment**

In `lib/server/__tests__/helpers/testEnv.ts`, add the six names to `ENV_KEYS` directly after
`'MYLIBRARY_MODEL',`:

```ts
  'MYLIBRARY_MODEL',
  'MYLIBRARY_MODEL_PROFILE',
  'MYLIBRARY_MODEL_RERANK',
  'MYLIBRARY_MODEL_SEED',
  'MYLIBRARY_MODEL_ARCHETYPE',
  'MYLIBRARY_MODEL_DISTILL',
  'MYLIBRARY_MODEL_REVEAL',
```

and in `beforeEach`, directly after the existing `delete process.env.MYLIBRARY_MODEL;` line:

```ts
    // Same hazard as MYLIBRARY_MODEL: a developer with a per-operation override exported
    // would change every pinned `model` in the request snapshots.
    delete process.env.MYLIBRARY_MODEL_PROFILE;
    delete process.env.MYLIBRARY_MODEL_RERANK;
    delete process.env.MYLIBRARY_MODEL_SEED;
    delete process.env.MYLIBRARY_MODEL_ARCHETYPE;
    delete process.env.MYLIBRARY_MODEL_DISTILL;
    delete process.env.MYLIBRARY_MODEL_REVEAL;
```

- [ ] **Step 2: Write the failing unit tests**

Create `lib/server/__tests__/models.test.ts`:

```ts
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
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest list lib/server/__tests__/models.test.ts` (expect 7 tests listed), then
`npx vitest run lib/server/__tests__/models.test.ts`
Expected: FAIL. The module `../models` cannot be resolved.

- [ ] **Step 4: Implement `models.ts`**

Create `lib/server/models.ts`:

```ts
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
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run lib/server/__tests__/models.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add lib/server/models.ts lib/server/__tests__/models.test.ts lib/server/__tests__/helpers/testEnv.ts
git commit -m "feat(screen): add per-operation Claude model settings (#96)"
```

---

### Task 2: Route every Claude call through `modelFor`, and price Opus 5.5

**Files:**
- Modify: `lib/server/profileBuild.ts:20-24`
- Modify: `lib/server/recPrompts.ts:8-9,21-23,69-72`
- Modify: `lib/server/recommendRun.ts:41-53,230`
- Modify: `lib/server/recSimilarRun.ts:27,130`
- Modify: `lib/server/recSimilarPrompts.ts:7` (comment)
- Modify: `lib/server/recDiscoverRun.ts:33,164`
- Modify: `lib/server/archetypeDerive.ts:17,207`
- Modify: `lib/server/directiveDistill.ts:14,189`
- Modify: `lib/server/revealLines.ts:26,157,175,225`
- Modify: `lib/server/anthropic.ts:25-29`
- Modify: `docs/hosting.md` (env table), `docs/architecture.md` (module map)
- Test: `lib/server/__tests__/models.test.ts` (append), `anthropic.test.ts`, `similar-run.test.ts`, `discover-run.test.ts`, `recommend-run.test.ts`

**Interfaces:**
- Consumes: `modelFor` from Task 1.
- Produces: `profileModel(): string` (unchanged name, now `modelFor('profile')`); `rankModel(): string` (now `modelFor('rerank')`). **Removed exports:** `SEED_MODEL`, `ARCHETYPE_MODEL`, `REVEAL_MODEL`, `DISTILL_MODEL`.

- [ ] **Step 1: Write the failing call-site tests**

In `lib/server/__tests__/models.test.ts`, add these imports below the existing ones at the top of
the file (ESLint expects imports first):

```ts
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
```

Then append to the end of the file:

```ts
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
```

Append to `lib/server/__tests__/anthropic.test.ts`, inside `describe('costUsd', …)`:

```ts
  it('prices opus-5-5 at $4/$20 with the standard cache multipliers', () => {
    // 1M of each = 4 + 20 + 5.00 (1.25x write) + 0.40 (0.1x read)
    const usage = {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
    };
    expect(costUsd('claude-opus-5-5', usage)).toBeCloseTo(29.4, 6);
  });
```

Append to `lib/server/__tests__/similar-run.test.ts`, inside `describe('runSimilar', …)`:

```ts
  test('sends the seed and rerank overrides to their own stages', async () => {
    process.env.MYLIBRARY_MODEL_SEED = 'model-seed';
    process.env.MYLIBRARY_MODEL_RERANK = 'model-rerank';
    const { db, close } = await makeTestDb();
    const restore = installHttpReplay(httpFixtures as any);
    try {
      await loadSeed(db, seedJson as any);
      const client = fakeClient([{ candidate_index: 0, score: 0.5, rationale: 'r' }]);
      const out: any = await runSimilar(db, client, 'local', 1, 8);
      expect(client.calls[0].model).toBe('model-seed');
      expect(client.calls[1].model).toBe('model-rerank');
      expect(out.model).toBe('model-rerank');
    } finally {
      restore();
      await close();
    }
  });
```

Append to `lib/server/__tests__/discover-run.test.ts`, inside `describe('runDiscover', …)`:

```ts
  test('sends the seed override to interpretation and the rerank override to ranking', async () => {
    process.env.MYLIBRARY_MODEL_SEED = 'model-seed';
    process.env.MYLIBRARY_MODEL_RERANK = 'model-rerank';
    const { db, close } = await makeTestDb();
    const restore = installHttpReplay(httpFixtures as any);
    try {
      await loadSeed(db, seedJson as any);
      const client = fakeClient(INTERP_INPUT, [{ candidate_index: 0, score: 0.5, rationale: 'r' }]);
      const out: any = await runDiscover(db, client, 'local', DISCOVER_QUERY, 10);
      expect(client.calls[0].model).toBe('model-seed');
      expect(client.calls[1].model).toBe('model-rerank');
      expect(out.model).toBe('model-rerank');
    } finally {
      restore();
      await close();
    }
  });
```

Append to `lib/server/__tests__/recommend-run.test.ts`, inside `describe('runRecommend happy path', …)`:

```ts
  test('sends the seed and rerank overrides without touching the snapshot defaults', async () => {
    process.env.MYLIBRARY_MODEL_SEED = 'model-seed';
    process.env.MYLIBRARY_MODEL_RERANK = 'model-rerank';
    const { db, close } = await seeded();
    const restore = installHttpReplay(httpFixtures as any);
    const client = fakeClaude([seedResponse, rerankResponse([0, 1, 2])] as any);
    try {
      const out = (await runRecommend(db, client, 'local', opts())) as any;
      expect(client.calls[0].params.model).toBe('model-seed');
      expect(client.calls[1].params.model).toBe('model-rerank');
      expect(out.model).toBe('model-rerank');
    } finally {
      restore();
      await close();
    }
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run lib/server/__tests__/models.test.ts lib/server/__tests__/anthropic.test.ts lib/server/__tests__/similar-run.test.ts lib/server/__tests__/discover-run.test.ts lib/server/__tests__/recommend-run.test.ts`
Expected: FAIL. The new override tests still receive the hardcoded Haiku or Sonnet ids; the
tripwire lists `archetypeDerive.ts`, `directiveDistill.ts`, `profileBuild.ts`, `recPrompts.ts`
and `revealLines.ts`; and Opus is billed at the $3/$15 fallback (`toBeCloseTo(29.4)` fails at
22.05). Every pre-existing test still passes.

- [ ] **Step 3: Rewire the Sonnet-default operations**

`lib/server/profileBuild.ts`: add `import { modelFor } from './models';` beside the other
imports, and replace

```ts
/** Twin of config.get_settings().model — read at call time, as Python does. */
export function profileModel(): string {
  return process.env.MYLIBRARY_MODEL || 'claude-sonnet-5';
}
```

with

```ts
/** The profile builder's model (lib/server/models.ts). Read at call time, as Python did. */
export function profileModel(): string {
  return modelFor('profile');
}
```

`lib/server/recPrompts.ts`: replace `import { profileModel } from './profileBuild';` with
`import { modelFor } from './models';`, delete the line
`export const SEED_MODEL = 'claude-haiku-4-5-20251001';`, and replace

```ts
/** Python reads settings.model at call time; profileModel() is the same env lookup. */
export function rankModel(): string {
  return profileModel();
}
```

with

```ts
/** The rerank model (lib/server/models.ts), read at call time. */
export function rankModel(): string {
  return modelFor('rerank');
}
```

- [ ] **Step 4: Rewire the seed call sites**

`lib/server/recommendRun.ts`: remove `SEED_MODEL,` from the `./recPrompts` import list, add
`import { modelFor } from './models';`, and in `claudeSeedQueries` change `model: SEED_MODEL,` to
`model: modelFor('seed'),`.

`lib/server/recSimilarRun.ts`: change the import to
`import { rankModel, RANK_MAX_TOKENS, SEED_MAX_TOKENS, SEED_TOOL } from './recPrompts';`, add
`import { modelFor } from './models';`, and in `bookFacetQueries` change `model: SEED_MODEL,` to
`model: modelFor('seed'),`.

`lib/server/recDiscoverRun.ts`: change the import to
`import { rankModel, RANK_MAX_TOKENS, SEED_MAX_TOKENS } from './recPrompts';`, add
`import { modelFor } from './models';`, and in the interpret call change `model: SEED_MODEL,` to
`model: modelFor('seed'),`.

`lib/server/recSimilarPrompts.ts` line 7: change the comment's `SEED_TOOL/SEED_MODEL/SEED_MAX_TOKENS`
to `SEED_TOOL/SEED_MAX_TOKENS and modelFor('seed')`.

- [ ] **Step 5: Rewire the three remaining Haiku operations**

`lib/server/archetypeDerive.ts`: delete `export const ARCHETYPE_MODEL = 'claude-haiku-4-5-20251001';`,
add `import { modelFor } from './models';`, and change `model: ARCHETYPE_MODEL,` to
`model: modelFor('archetype'),`.

`lib/server/directiveDistill.ts`: delete `export const DISTILL_MODEL = 'claude-haiku-4-5-20251001';`,
add `import { modelFor } from './models';`, and change `model: DISTILL_MODEL,` to
`model: modelFor('distill'),`.

`lib/server/revealLines.ts`: delete `export const REVEAL_MODEL = 'claude-haiku-4-5-20251001';`,
add `import { modelFor } from './models';`. In `generateRevealLines`, add as the first statement
of the function body:

```ts
  const model = modelFor('reveal');
```

and replace the three uses of `REVEAL_MODEL` in that function with `model` (the early-return
object, the `trackedCreate` params, and the final return object).

- [ ] **Step 6: Add the Opus 5.5 price row**

First confirm the live price. Invoke the `claude-api` skill and read its pricing reference, or
fetch `https://www.anthropic.com/pricing`. Compare Opus 5.5 input, output, cache-write and
cache-read against `[4.0, 20.0, 5.0, 0.4]`. If they differ, **stop and report**: spec §6.8
states $4/$20, and a mismatch is a spec question, not an executor decision.

In `lib/server/anthropic.ts`, change the comment date `last_verified 2026-09-01` to the date you
verified, and add the row:

```ts
const MODEL_PRICING: Record<string, Pricing> = {
  'claude-sonnet-5': [2.0, 10.0, 2.5, 0.2],
  'claude-sonnet-4-6': [3.0, 15.0, 3.75, 0.3],
  'claude-haiku-4-5-20251001': [1.0, 5.0, 1.25, 0.1],
  // Not used by default (spec 2026-09-22 §6.8). Present so a per-operation switch to Opus
  // records its real cost instead of the $3/$15 fallback, which would under-report it.
  'claude-opus-5-5': [4.0, 20.0, 5.0, 0.4],
};
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run lib/server/__tests__/models.test.ts lib/server/__tests__/anthropic.test.ts lib/server/__tests__/similar-run.test.ts lib/server/__tests__/discover-run.test.ts lib/server/__tests__/recommend-run.test.ts lib/server/__tests__/profile-build.test.ts lib/server/__tests__/profile-update.test.ts`
Expected: PASS. In particular `recommend-run.test.ts > matches the recorded request snapshots`
is still green **with `fixtures/claude/prompts.json` unmodified**. Confirm:
`git diff --stat lib/server/__tests__/fixtures/` prints nothing.

Then: `grep -rn "SEED_MODEL\|ARCHETYPE_MODEL\|REVEAL_MODEL\|DISTILL_MODEL" --include=*.ts --include=*.tsx app lib components`
Expected: no output.

- [ ] **Step 8: Document the settings**

In `docs/hosting.md`, replace the `MYLIBRARY_MODEL` row of the environment table with these
rows. Keep the table's column alignment; `npm run format` will re-pad it.

```markdown
| `MYLIBRARY_MODEL`                      | Profile and rerank model override; defaults to `claude-sonnet-5`. Never applies to the Haiku operations. |
| `MYLIBRARY_MODEL_PROFILE`              | Profile build/update model; falls back to `MYLIBRARY_MODEL`.                    |
| `MYLIBRARY_MODEL_RERANK`               | Rerank model (recommend, similar, discover); falls back to `MYLIBRARY_MODEL`.   |
| `MYLIBRARY_MODEL_SEED`                 | Seed/interpret model; defaults to `claude-haiku-4-5-20251001`.                  |
| `MYLIBRARY_MODEL_ARCHETYPE`            | Archetype model; defaults to `claude-haiku-4-5-20251001`.                       |
| `MYLIBRARY_MODEL_DISTILL`              | Directive-distill model; defaults to `claude-haiku-4-5-20251001`.               |
| `MYLIBRARY_MODEL_REVEAL`               | Reveal-line model; defaults to `claude-haiku-4-5-20251001`.                     |
```

In `docs/architecture.md`, under "API, identity, and persistence", after the
`claude.ts, anthropic.ts, claudeErrors.ts` bullet, add:

```markdown
- `models.ts` — per-operation Claude model selection (`modelFor`). Each operation reads its own
  `MYLIBRARY_MODEL_<OP>` override at call time and otherwise keeps its historical model; the
  global `MYLIBRARY_MODEL` reaches only profile and rerank.
```

Run: `npx prettier --write docs/hosting.md docs/architecture.md`

- [ ] **Step 9: Type-check and commit**

Run: `npm run type-check`
Expected: exit 0.

```bash
git add lib/server/profileBuild.ts lib/server/recPrompts.ts lib/server/recommendRun.ts \
  lib/server/recSimilarRun.ts lib/server/recSimilarPrompts.ts lib/server/recDiscoverRun.ts \
  lib/server/archetypeDerive.ts lib/server/directiveDistill.ts lib/server/revealLines.ts \
  lib/server/anthropic.ts lib/server/__tests__/models.test.ts lib/server/__tests__/anthropic.test.ts \
  lib/server/__tests__/similar-run.test.ts lib/server/__tests__/discover-run.test.ts \
  lib/server/__tests__/recommend-run.test.ts docs/hosting.md docs/architecture.md
git commit -m "feat(screen): route every Claude call through modelFor; price Opus 5.5 (#96)"
```

---

### Task 3: `profile_meta.rebuild_reason` and its helpers

**Files:**
- Modify: `lib/server/schema.ts` (`profileMeta`)
- Generate: `drizzle/0007_*.sql`, `drizzle/meta/0007_snapshot.json`, `drizzle/meta/_journal.json`
- Modify: `lib/server/__tests__/helpers/pglite.ts` (`profile_meta` DDL)
- Modify: `lib/server/profileMeta.ts`
- Create: `lib/server/__tests__/profile-meta.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (index contract):
  - `profileMeta.rebuildReason` → column `rebuild_reason varchar` nullable.
  - `profileMeta.rebuildRequestedAt` → column `rebuild_requested_at timestamp` nullable: when a
    reason was last requested. A full build clears the reason only if this is older than its own
    start, so a second request that lands mid-run (even the same reason, even while an earlier one
    was already pending) survives.
  - `export type RebuildReason = 'screen_enabled' | 'screen_disabled' | 'title_deleted' | 'screen_library_deleted'`
  - `export async function setRebuildReason(db: Db, userId: string, reason: RebuildReason): Promise<void>` — accepts a transaction too (`markProfiled` already takes `tx: Db` the same way). Upserts the row; never overwrites a non-null reason; **always** stamps `rebuild_requested_at = utcnowTs()`.
  - `export async function readRebuildReason(db: Db, userId: string): Promise<RebuildReason | null>` — read-only; never creates a row.

- [ ] **Step 1: Write the failing tests**

Create `lib/server/__tests__/profile-meta.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeTestDb } from './helpers/pglite';
import { schema } from '../db';
import { readRebuildReason, setRebuildReason } from '../profileMeta';

async function metaRows(db: any, userId: string) {
  return db.select().from(schema.profileMeta).where(eq(schema.profileMeta.userId, userId));
}

describe('setRebuildReason', () => {
  it('creates the profile_meta row when the user has none', async () => {
    const { db, close } = await makeTestDb();
    try {
      await setRebuildReason(db, 'u1', 'screen_enabled');
      const rows = await metaRows(db, 'u1');
      expect(rows).toHaveLength(1);
      expect(rows[0].rebuildReason).toBe('screen_enabled');
      expect(rows[0].lastProfiledAt).toBeNull();
    } finally {
      await close();
    }
  });

  it('sets the reason on an existing row without touching its timestamps', async () => {
    const { db, close } = await makeTestDb();
    try {
      await db.insert(schema.profileMeta).values({
        userId: 'u1',
        lastProfiledAt: '2026-07-01 12:00:00',
        lastProfileKind: 'full',
      });
      await setRebuildReason(db, 'u1', 'title_deleted');
      const [row] = await metaRows(db, 'u1');
      expect(row.rebuildReason).toBe('title_deleted');
      expect(row.lastProfiledAt).toBe('2026-07-01 12:00:00');
      expect(row.lastProfileKind).toBe('full');
    } finally {
      await close();
    }
  });

  it('keeps the first reason until a full rebuild clears it', async () => {
    const { db, close } = await makeTestDb();
    try {
      await setRebuildReason(db, 'u1', 'screen_enabled');
      await setRebuildReason(db, 'u1', 'title_deleted');
      expect(await readRebuildReason(db, 'u1')).toBe('screen_enabled');
      expect(await metaRows(db, 'u1')).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it('stamps rebuild_requested_at on every call, even when a reason is already pending', async () => {
    const { db, close } = await makeTestDb();
    try {
      await setRebuildReason(db, 'u1', 'screen_enabled');
      const [first] = await metaRows(db, 'u1');
      expect(first.rebuildRequestedAt).not.toBeNull();
      await new Promise((r) => setTimeout(r, 5));
      await setRebuildReason(db, 'u1', 'title_deleted');
      const [second] = await metaRows(db, 'u1');
      expect(second.rebuildReason).toBe('screen_enabled');
      expect(second.rebuildRequestedAt > first.rebuildRequestedAt).toBe(true);
    } finally {
      await close();
    }
  });

  it('works inside a transaction', async () => {
    const { db, close } = await makeTestDb();
    try {
      await db.transaction(async (tx) => {
        await setRebuildReason(tx as any, 'u1', 'screen_disabled');
      });
      expect(await readRebuildReason(db, 'u1')).toBe('screen_disabled');
    } finally {
      await close();
    }
  });

  it("never touches another user's row", async () => {
    const { db, close } = await makeTestDb();
    try {
      await db.insert(schema.profileMeta).values({ userId: 'other' });
      await setRebuildReason(db, 'u1', 'title_deleted');
      expect(await readRebuildReason(db, 'other')).toBeNull();
    } finally {
      await close();
    }
  });
});

describe('readRebuildReason', () => {
  it('returns null and creates nothing for a user with no row', async () => {
    const { db, close } = await makeTestDb();
    try {
      expect(await readRebuildReason(db, 'nobody')).toBeNull();
      expect(await metaRows(db, 'nobody')).toHaveLength(0);
    } finally {
      await close();
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/server/__tests__/profile-meta.test.ts`
Expected: FAIL. `setRebuildReason` and `readRebuildReason` are not exported; `rebuildReason` is
not a column.

- [ ] **Step 3: Add the column to the schema and the test database**

In `lib/server/schema.ts`, inside `profileMeta`, after `enrichmentCorrectedAt`:

```ts
    enrichmentCorrectedAt: timestamp('enrichment_corrected_at', { mode: 'string' }),
    // Why the next profile build must be a FULL rebuild (spec 2026-09-22 §5.6), e.g. screen
    // was enabled or a title was deleted: changes the incremental prompt cannot retract.
    // Null = no pending reason. Set via profileMeta.ts#setRebuildReason (first reason wins);
    // cleared only by a completed full rebuild that started after the last request.
    rebuildReason: varchar('rebuild_reason'),
    // Bumped by every setRebuildReason call, even when a reason is already pending, so a
    // request that lands while a full build is running is never cleared by that build.
    rebuildRequestedAt: timestamp('rebuild_requested_at', { mode: 'string' }),
```

In `lib/server/__tests__/helpers/pglite.ts`, change the `profile_meta` DDL to:

```sql
    create table profile_meta (
      id serial primary key,
      user_id text not null default 'local' unique,
      last_profiled_at timestamp,
      last_profile_kind text,
      rec_feedback_updated_at timestamp,
      enrichment_corrected_at timestamp,
      rebuild_reason text,
      rebuild_requested_at timestamp
    );
```

- [ ] **Step 4: Generate and inspect the migration**

Run: `npm run db:generate`

`drizzle.config.ts` loads a local `.env` for `db:migrate` credentials. `generate` does not
connect to a database, so this is safe. Do not open or print that file.

Expected: one new file `drizzle/0007_<generated_name>.sql`, a new `drizzle/meta/0007_snapshot.json`,
and an updated `drizzle/meta/_journal.json`. Read the SQL. It must be exactly these two
statements (drizzle-kit may separate them with `--> statement-breakpoint`):

```sql
ALTER TABLE "profile_meta" ADD COLUMN "rebuild_reason" varchar;
ALTER TABLE "profile_meta" ADD COLUMN "rebuild_requested_at" timestamp;
```

If it contains anything else (a `DROP`, an unrelated `ALTER`, any statement on `books`), **stop and
report**. That means the snapshot and `schema.ts` had already drifted, and it is not this task's
to reconcile. Record what you actually observe.

- [ ] **Step 5: Implement the helpers**

Replace `lib/server/profileMeta.ts` with:

```ts
import { eq, sql } from 'drizzle-orm';
import { schema, type Db } from './db';
import { utcnowTs } from './serialize';

export type ProfileMetaRow = typeof schema.profileMeta.$inferSelect;

/**
 * Why the next profile build must be a full rebuild (spec 2026-09-22 §5.6). Written by the
 * screen waves: enabling/disabling screen and deleting titles change evidence in ways the
 * incremental prompt cannot retract.
 */
export type RebuildReason =
  | 'screen_enabled'
  | 'screen_disabled'
  | 'title_deleted'
  | 'screen_library_deleted';

/** Port of profile.get_profile_meta: fetch-or-create the singleton row. */
export async function ensureProfileMeta(db: Db, userId: string): Promise<ProfileMetaRow> {
  const rows = await db
    .select()
    .from(schema.profileMeta)
    .where(eq(schema.profileMeta.userId, userId));
  if (rows[0]) return rows[0];
  const [created] = await db.insert(schema.profileMeta).values({ userId }).returning();
  return created;
}

/**
 * Records a pending full-rebuild reason. First reason wins for the label: an existing non-null
 * reason is left alone, because any reason forces the same full rebuild. But every call stamps
 * `rebuild_requested_at`, and a full build clears the reason only when that stamp predates its
 * own start (profileBuild.ts#markProfiled). Without the stamp, a second request landing while
 * a build that had already observed the first one was running would be cleared with it.
 *
 * Accepts a transaction as well as the db (a drizzle tx satisfies `Db` structurally, exactly as
 * markProfiled's `tx: Db` already relies on; this holds only while `Db` is the plain
 * PostgresJsDatabase type, not `ReturnType<typeof drizzle>`). The insert is conflict-tolerant
 * so two writers racing to create the row cannot 500.
 */
export async function setRebuildReason(
  db: Db,
  userId: string,
  reason: RebuildReason
): Promise<void> {
  const now = utcnowTs();
  await db
    .insert(schema.profileMeta)
    .values({ userId, rebuildReason: reason, rebuildRequestedAt: now })
    .onConflictDoNothing({ target: schema.profileMeta.userId });
  await db
    .update(schema.profileMeta)
    .set({
      rebuildReason: sql`coalesce(${schema.profileMeta.rebuildReason}, ${reason})`,
      rebuildRequestedAt: now,
    })
    .where(eq(schema.profileMeta.userId, userId));
}

/** The pending rebuild reason, or null. Read-only: never creates the row. */
export async function readRebuildReason(db: Db, userId: string): Promise<RebuildReason | null> {
  const rows = await db
    .select({ reason: schema.profileMeta.rebuildReason })
    .from(schema.profileMeta)
    .where(eq(schema.profileMeta.userId, userId));
  return (rows[0]?.reason ?? null) as RebuildReason | null;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run lib/server/__tests__/profile-meta.test.ts lib/server/__tests__/profile-build.test.ts lib/server/__tests__/profile-update.test.ts lib/server/__tests__/purge-routes.test.ts`
Expected: PASS (6 new tests; the existing suites unaffected by the new nullable column).

- [ ] **Step 7: Type-check and commit**

Run: `npm run type-check`
Expected: exit 0.

```bash
git add lib/server/schema.ts lib/server/__tests__/helpers/pglite.ts lib/server/profileMeta.ts \
  lib/server/__tests__/profile-meta.test.ts drizzle/
git commit -m "feat(screen): add profile_meta.rebuild_reason (#96)"
```

**Handoff point (end of Batch A).** Update the ledger and stop.

---

### Task 4: Stamp the start of the run, not its end

**Files:**
- Modify: `lib/server/profileBuild.ts` (`markProfiled`, `persistProposedTraits`, `extractTasteProfile`)
- Modify: `lib/server/profileUpdate.ts` (`updateTasteProfile`)
- Create: `lib/server/__tests__/profile-run-boundary.test.ts`

**Interfaces:**
- Consumes: `readRebuildReason`, `setRebuildReason` (Task 3); `utcnowTs` from `serialize.ts`.
- Produces (index contract, plus one additive optional parameter; see decision 6):
  - `markProfiled(tx: Db, kind: string, userId: string, runStartedAt: string, observedRebuildReason: string | null = null): Promise<void>`
  - `persistProposedTraits(db: Db, userId: string, traits: Record<string, unknown>[], validIds: Set<number>, kind: 'full' | 'update', runStartedAt: string, observedRebuildReason: string | null = null): Promise<number>`

- [ ] **Step 1: Write the failing tests**

Create `lib/server/__tests__/profile-run-boundary.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeTestDb, loadSeed, type Seed } from './helpers/pglite';
import seedJson from './fixtures/seed.json';
import { schema, type Db } from '../db';
import type { ClaudeClient, ClaudeMessage } from '../claude';
import { extractTasteProfile, persistProposedTraits } from '../profileBuild';
import { booksChangedSince, updateTasteProfile } from '../profileUpdate';
import { readRebuildReason, setRebuildReason } from '../profileMeta';
import { utcnowTs } from '../serialize';
import { fakeClaude } from './helpers/fakeClaude';

const tool = (name: string, traits: unknown[] = []): ClaudeMessage => ({
  content: [{ type: 'tool_use', name, input: { traits } }],
  usage: { input_tokens: 1, output_tokens: 1 },
});

/**
 * A Claude client whose call runs `during` (a concurrent user edit) before answering,
 * so the edit lands strictly after the run started and strictly before it persists.
 */
function clientWithEdit(response: ClaudeMessage, during: () => Promise<void>) {
  const calls: Record<string, unknown>[] = [];
  const client: ClaudeClient = {
    messages: {
      async create(params) {
        calls.push(params);
        await new Promise((r) => setTimeout(r, 5));
        await during();
        await new Promise((r) => setTimeout(r, 5));
        return response;
      },
    },
  };
  return { client, calls };
}

/** A rating change exactly as PATCH /api/books/[id]/feedback writes it. */
async function rateBook(db: Db, bookId: number, rating: number) {
  await db
    .update(schema.books)
    .set({ appRating: rating, feedbackUpdatedAt: utcnowTs() })
    .where(eq(schema.books.id, bookId));
}

async function lastProfiledAt(db: Db): Promise<string | null> {
  const rows = await db
    .select()
    .from(schema.profileMeta)
    .where(eq(schema.profileMeta.userId, 'local'));
  return rows[0]?.lastProfiledAt ?? null;
}

describe('markProfiled stamps the start of the run', () => {
  it('a rating changed during a FULL build is still pending afterwards', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      const { client } = clientWithEdit(tool('record_taste_traits'), () => rateBook(db, 5, 4.5));

      await extractTasteProfile(db, client, 'local');

      const pending = await booksChangedSince(db, await lastProfiledAt(db), 'local');
      expect(pending.map((b) => b.id)).toContain(5);
    } finally {
      await close();
    }
  });

  it('a rating changed during an INCREMENTAL update is still pending afterwards', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed); // proposed traits exist; books 2, 3, 9 changed
      const { client, calls } = clientWithEdit(tool('revise_taste_traits'), () =>
        rateBook(db, 5, 4.5)
      );

      const out = await updateTasteProfile(db, client, 'local');
      expect(out.mode).toBe('update');
      expect((calls[0].tool_choice as { name: string }).name).toBe('revise_taste_traits');

      const pending = await booksChangedSince(db, await lastProfiledAt(db), 'local');
      expect(pending.map((b) => b.id)).toEqual([5]);
    } finally {
      await close();
    }
  });

  it('stamps exactly the runStartedAt it is given', async () => {
    const { db, close } = await makeTestDb();
    try {
      await persistProposedTraits(db, 'local', [], new Set(), 'full', '2026-01-02 03:04:05.678');
      expect(await lastProfiledAt(db)).toBe('2026-01-02 03:04:05.678');
    } finally {
      await close();
    }
  });
});

describe('a full rebuild clears only the rebuild reason it read at its start', () => {
  it('clears the reason that was pending when the run began', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      await setRebuildReason(db, 'local', 'title_deleted');
      // The clear needs rebuild_requested_at < runStartedAt, strictly; a same-millisecond tie
      // keeps the reason (the safe direction), so make the request strictly earlier.
      await new Promise((r) => setTimeout(r, 5));
      await extractTasteProfile(db, fakeClaude([tool('record_taste_traits')]), 'local');
      expect(await readRebuildReason(db, 'local')).toBeNull();
    } finally {
      await close();
    }
  });

  it('keeps a reason that arrived while the run was in flight', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      const { client } = clientWithEdit(tool('record_taste_traits'), () =>
        setRebuildReason(db, 'local', 'title_deleted')
      );
      await extractTasteProfile(db, client, 'local');
      expect(await readRebuildReason(db, 'local')).toBe('title_deleted');
    } finally {
      await close();
    }
  });

  it('keeps a reason re-requested mid-run while one was already pending', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      await setRebuildReason(db, 'local', 'screen_enabled');
      await new Promise((r) => setTimeout(r, 5)); // the request strictly predates the run
      // The run observes 'screen_enabled'; a title is deleted while Claude is thinking. The
      // label stays 'screen_enabled' (first wins), but the build must not clear it.
      const { client } = clientWithEdit(tool('record_taste_traits'), () =>
        setRebuildReason(db, 'local', 'title_deleted')
      );
      await extractTasteProfile(db, client, 'local');
      expect(await readRebuildReason(db, 'local')).toBe('screen_enabled');
    } finally {
      await close();
    }
  });

  it('an incremental persist never clears a reason', async () => {
    const { db, close } = await makeTestDb();
    try {
      await setRebuildReason(db, 'local', 'screen_enabled');
      await persistProposedTraits(db, 'local', [], new Set(), 'update', utcnowTs(), 'screen_enabled');
      expect(await readRebuildReason(db, 'local')).toBe('screen_enabled');
    } finally {
      await close();
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest list lib/server/__tests__/profile-run-boundary.test.ts` (expect 7), then
`npx vitest run lib/server/__tests__/profile-run-boundary.test.ts`
Expected: FAIL.
- both "still pending" tests fail: `last_profiled_at` is the completion time, so book 5 is not pending;
- "stamps exactly" fails as a stamp mismatch (tests are outside `tsconfig` and Vitest does not type-check, so it is never a type error);
- "clears the reason" fails, because nothing clears it yet.

"Keeps a reason" and "incremental never clears" may already pass. They exist to catch the
over-eager implementation in Step 5.

- [ ] **Step 3: Change `markProfiled` and `persistProposedTraits`**

In `lib/server/profileBuild.ts`, extend its drizzle import from `import { eq, and } from
'drizzle-orm';` to `import { and, eq, isNull, lt, or } from 'drizzle-orm';`, then replace
`markProfiled` with:

```ts
/**
 * Twin of profile.mark_profiled — clears the 'dirty' state. Must run inside a tx.
 *
 * Stamps `runStartedAt`, the moment the builder began reading, NOT the completion time
 * (spec 2026-09-22 §5.6). A rating edited while Claude was thinking was not in the prompt,
 * so it must stay newer than last_profiled_at and keep the profile dirty. Stamping completion
 * silently marked such edits as profiled.
 *
 * A 'full' build clears `rebuild_reason`, but only if it still holds the value the build read
 * at its start (`observedRebuildReason`) AND no request arrived after the run started
 * (`rebuild_requested_at < runStartedAt`; profileMeta.ts#setRebuildReason stamps it on every
 * call). A request made mid-run describes a change this build may not have seen, so it must
 * survive to force the next rebuild, even when it repeats the reason already pending. A null
 * stamp (a reason written by hand, as in the real-flow check) counts as old.
 */
export async function markProfiled(
  tx: Db,
  kind: string,
  userId: string,
  runStartedAt: string,
  observedRebuildReason: string | null = null
): Promise<void> {
  const rows = await tx
    .select({ id: schema.profileMeta.id })
    .from(schema.profileMeta)
    .where(eq(schema.profileMeta.userId, userId));
  const stamp = { lastProfiledAt: runStartedAt, lastProfileKind: kind };
  if (rows[0]) {
    await tx.update(schema.profileMeta).set(stamp).where(eq(schema.profileMeta.id, rows[0].id));
  } else {
    await tx.insert(schema.profileMeta).values({ userId, ...stamp });
  }
  if (kind === 'full' && observedRebuildReason !== null) {
    await tx
      .update(schema.profileMeta)
      .set({ rebuildReason: null })
      .where(
        and(
          eq(schema.profileMeta.userId, userId),
          eq(schema.profileMeta.rebuildReason, observedRebuildReason),
          or(
            isNull(schema.profileMeta.rebuildRequestedAt),
            lt(schema.profileMeta.rebuildRequestedAt, runStartedAt)
          )
        )
      );
  }
}
```

Change `persistProposedTraits`'s signature and its `markProfiled` call:

```ts
export async function persistProposedTraits(
  db: Db,
  userId: string,
  traits: Record<string, unknown>[],
  validIds: Set<number>,
  kind: 'full' | 'update',
  runStartedAt: string,
  observedRebuildReason: string | null = null
): Promise<number> {
```

```ts
    await markProfiled(tx, kind, userId, runStartedAt, observedRebuildReason);
```

Add a sentence to its doc comment: `runStartedAt` is the caller's pre-read timestamp (see
markProfiled).

- [ ] **Step 4: Capture the run start in both builders**

`lib/server/profileBuild.ts`: add `import { readRebuildReason } from './profileMeta';`. In
`extractTasteProfile`, make these the first two statements of the body, before `buildTiers`:

```ts
  // Captured before the first read (spec §5.6): anything edited after this instant is not in
  // the prompt and must stay pending. The reason read here is the only one this build clears.
  const runStartedAt = utcnowTs();
  const observedRebuildReason = await readRebuildReason(db, userId);
```

and change its persist call to:

```ts
  const saved = await persistProposedTraits(
    db,
    userId,
    traits,
    validIds,
    'full',
    runStartedAt,
    observedRebuildReason
  );
```

`lib/server/profileUpdate.ts`: add `import { utcnowTs } from './serialize';`. Extend the
existing `./serialize` import instead if one exists: it already imports
`effectiveRating, pyFloat, pyJsonDumps, pyRepr`, so add `utcnowTs` to that list. In
`updateTasteProfile`, make the first statement of the body:

```ts
  // Before any read; see extractTasteProfile. The delegating branches below call
  // extractTasteProfile, which captures its own start.
  const runStartedAt = utcnowTs();
```

and change its persist call to:

```ts
  const saved = await persistProposedTraits(db, userId, traits, validIds, 'update', runStartedAt);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run lib/server/__tests__/profile-run-boundary.test.ts lib/server/__tests__/profile-build.test.ts lib/server/__tests__/profile-update.test.ts lib/server/__tests__/models.test.ts app/api/profile/update/route.test.ts`
Expected: PASS.

- [ ] **Step 6: Mutation-test the cutoff (load-bearing, spec §10)**

Temporarily change `markProfiled`'s stamp to
`const stamp = { lastProfiledAt: utcnowTs(), lastProfileKind: kind };` (add the `utcnowTs`
import if needed) and run:

Run: `npx vitest run lib/server/__tests__/profile-run-boundary.test.ts`
Expected: FAIL. At minimum both "still pending afterwards" tests and "stamps exactly" go red.
If either "still pending" test stays green, the test is blind; fix the test (not the code)
before continuing. Revert the mutation, re-run, and confirm PASS.

- [ ] **Step 7: Mutation-test the conditional clear**

Temporarily replace the `where(and(…eq(schema.profileMeta.rebuildReason, observedRebuildReason)))`
condition with `where(eq(schema.profileMeta.userId, userId))` and drop the
`observedRebuildReason !== null` guard (an unconditional clear on every full build). Run:

Run: `npx vitest run lib/server/__tests__/profile-run-boundary.test.ts`
Expected: FAIL on "keeps a reason that arrived while the run was in flight" and "keeps a reason
re-requested mid-run". Revert, re-run, confirm PASS.

Second mutation: remove only the `or(isNull(…rebuildRequestedAt), lt(…rebuildRequestedAt,
runStartedAt))` term from the clear's `and(...)`. Run the same command.
Expected: FAIL on "keeps a reason re-requested mid-run while one was already pending" (the
other in-flight test may stay green; the equality check still covers it). Revert, re-run, confirm
PASS. Confirm the tree has no leftover mutation: `git diff lib/server/profileBuild.ts` shows only
the intended Step 3–4 changes.

- [ ] **Step 8: Commit**

```bash
git add lib/server/profileBuild.ts lib/server/profileUpdate.ts \
  lib/server/__tests__/profile-run-boundary.test.ts
git commit -m "fix(profile): stamp last_profiled_at at run start so mid-run edits stay pending (#96)"
```

---

### Task 5: `rebuild_reason` makes the profile dirty and forces a full rebuild

**Files:**
- Modify: `lib/server/profileUpdate.ts` (`updateTasteProfile`)
- Modify: `app/api/profile/status/route.ts`
- Create: `app/api/profile/status/route.test.ts`
- Modify: `lib/api.ts` (`ProfileStatus`)
- Modify: `lib/server/__tests__/profile-run-boundary.test.ts` (append)

**Interfaces:**
- Consumes: `ensureProfileMeta` (now returns `rebuildReason`), `setRebuildReason` (Task 3).
- Produces: `GET /api/profile/status` response gains `rebuild_reason: string | null`; `dirty` is
  true while it is set. `ProfileStatus.rebuild_reason: string | null` in `lib/api.ts`.

- [ ] **Step 1: Write the failing escalation test**

Append to `lib/server/__tests__/profile-run-boundary.test.ts`:

```ts
describe('updateTasteProfile with a pending rebuild reason', () => {
  it('escalates to a full rebuild instead of revising, then clears the reason', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed); // proposed traits + changed books: normally incremental
      await setRebuildReason(db, 'local', 'screen_disabled');
      const client = fakeClaude([tool('record_taste_traits')]);

      const out = await updateTasteProfile(db, client, 'local');

      expect(out.mode).toBe('full');
      expect(client.calls[0].params.tool_choice).toEqual({
        type: 'tool',
        name: 'record_taste_traits',
      });
      expect(await readRebuildReason(db, 'local')).toBeNull();
    } finally {
      await close();
    }
  });

  it('escalates even when nothing else changed', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      // Move the cutoff past every seeded change and feedback timestamp.
      await db
        .update(schema.profileMeta)
        .set({ lastProfiledAt: '2999-01-01 00:00:00', recFeedbackUpdatedAt: null })
        .where(eq(schema.profileMeta.userId, 'local'));
      await setRebuildReason(db, 'local', 'title_deleted');
      const client = fakeClaude([tool('record_taste_traits')]);

      const out = await updateTasteProfile(db, client, 'local');

      expect(out.mode).toBe('full'); // not the "already up to date" early return
      expect(client.calls).toHaveLength(1);
    } finally {
      await close();
    }
  });
});
```

- [ ] **Step 2: Write the failing status route tests**

Create `app/api/profile/status/route.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeTestDb } from '@/lib/server/__tests__/helpers/pglite';
import { setupTestEnv } from '@/lib/server/__tests__/helpers/testEnv';
import { _setDbForTests, schema, type Db } from '@/lib/server/db';

setupTestEnv();
afterEach(() => vi.restoreAllMocks());

async function withDb(fn: (db: Db) => Promise<void>): Promise<void> {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const { db, close } = await makeTestDb();
  try {
    _setDbForTests(db);
    await fn(db);
  } finally {
    _setDbForTests(null);
    await close();
  }
}

async function getStatus() {
  const { GET } = await import('./route');
  const res = await GET(new Request('http://test/api/profile/status'));
  expect(res.status).toBe(200);
  return res.json();
}

describe('GET /api/profile/status', () => {
  it('is clean and reports a null rebuild_reason when nothing is pending', async () => {
    await withDb(async (db) => {
      await db
        .insert(schema.profileMeta)
        .values({ userId: 'local', lastProfiledAt: '2026-07-01 12:00:00' });
      const body = await getStatus();
      expect(body.dirty).toBe(false);
      expect(body.rebuild_reason).toBeNull();
    });
  });

  it('is dirty while a rebuild reason is pending, with nothing else changed', async () => {
    await withDb(async (db) => {
      await db.insert(schema.profileMeta).values({
        userId: 'local',
        lastProfiledAt: '2026-07-01 12:00:00',
        rebuildReason: 'title_deleted',
      });
      const body = await getStatus();
      expect(body.dirty).toBe(true);
      expect(body.rebuild_reason).toBe('title_deleted');
      expect(body.changed_books).toBe(0);
    });
  });

  it("ignores another user's rebuild reason and creates no row", async () => {
    await withDb(async (db) => {
      await db.insert(schema.profileMeta).values({
        userId: 'other',
        lastProfiledAt: '2026-07-01 12:00:00',
        rebuildReason: 'screen_enabled',
      });
      const body = await getStatus();
      expect(body.dirty).toBe(false);
      expect(body.rebuild_reason).toBeNull();
      const localRows = await db
        .select()
        .from(schema.profileMeta)
        .where(eq(schema.profileMeta.userId, 'local'));
      expect(localRows).toHaveLength(0);
    });
  });
});
```

Before running, check how `withApi` handlers are invoked with no second argument elsewhere
(`app/api/profile/update/route.test.ts` calls `POST(post())` with one argument). If `GET`'s type
demands a context argument, pass the same second argument that file's route tests use; do not
change `withApi`.

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest list app/api/profile/status/route.test.ts` (expect 3), then
`npx vitest run lib/server/__tests__/profile-run-boundary.test.ts app/api/profile/status/route.test.ts`
Expected: FAIL. Both escalation tests get `mode: 'update'` or the "already up to date" note. The
status tests fail on `rebuild_reason` being `undefined` and `dirty` being `false`.

- [ ] **Step 4: Escalate in `updateTasteProfile`**

In `lib/server/profileUpdate.ts`, directly after the existing block

```ts
  if (!existing.length || since === null) {
    return extractTasteProfile(db, client, userId, maxTokens);
  }
```

insert:

```ts
  // A pending rebuild reason (screen enabled/disabled, a title deleted — spec §5.6) is a change
  // the incremental prompt cannot express or retract. Only a full rebuild clears it, and it
  // takes precedence over the "already up to date" early return below.
  if (meta.rebuildReason !== null) {
    return extractTasteProfile(db, client, userId, maxTokens);
  }
```

- [ ] **Step 5: Report it from the status route**

In `app/api/profile/status/route.ts`, after the `enrichmentCorrectedDirty` computation add:

```ts
  // Spec §5.6: a pending full-rebuild reason keeps the profile dirty until a full rebuild
  // clears it. meta is read-only here; status never creates the profile_meta row.
  const rebuildReason = meta?.rebuildReason ?? null;
```

and change the response to:

```ts
  return Response.json({
    dirty:
      changed.length > 0 ||
      traitVerdictDirty ||
      recRejectDirty ||
      enrichmentCorrectedDirty ||
      rebuildReason !== null,
    changed_books: changed.length,
    changed_book_ids: changed.map((b) => b.id),
    last_profiled_at: tsToIso(since),
    last_profile_kind: meta?.lastProfileKind ?? null,
    rebuild_reason: rebuildReason,
  });
```

- [ ] **Step 6: Extend the client type**

In `lib/api.ts`, change `ProfileStatus` to:

```ts
/** Whether the taste profile is stale relative to in-app edits (GET /profile/status). */
export interface ProfileStatus {
  dirty: boolean;
  changed_books: number;
  changed_book_ids: number[];
  last_profiled_at: string | null;
  last_profile_kind: string | null;
  /** A pending full-rebuild reason (e.g. screen enabled); `dirty` is already true when set. */
  rebuild_reason: string | null;
}
```

`ReprofileBanner` and Home read only `dirty`, so no component changes. Its generic copy
("Ratings and edits since the last build aren't in your profile yet") still fits. Wave 8 may
tailor it.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run lib/server/__tests__/profile-run-boundary.test.ts app/api/profile/status/route.test.ts lib/server/__tests__/profile-update.test.ts`
Run: `npx jest components/__tests__/ReprofileBanner.test.tsx`
Expected: PASS for both.

- [ ] **Step 8: Mutation-test the escalation**

Temporarily delete the `if (meta.rebuildReason !== null)` block and run
`npx vitest run lib/server/__tests__/profile-run-boundary.test.ts`.
Expected: FAIL on both escalation tests. Revert and confirm PASS.

- [ ] **Step 9: Commit**

```bash
git add lib/server/profileUpdate.ts app/api/profile/status/route.ts \
  app/api/profile/status/route.test.ts lib/api.ts lib/server/__tests__/profile-run-boundary.test.ts
git commit -m "feat(screen): rebuild_reason dirties status and forces a full rebuild (#96)"
```

---

### Task 6: Full gate, real-flow verification, and the migration handoff

**Files:** none new. This task produces evidence, not code.

- [ ] **Step 1: Run the full gate**

Run each from the repository root and record the pass counts:

```bash
npm run test:server
npm test
npm run type-check
npm run lint
npm run format:check
npm run build
```

Expected: all exit 0. If `format:check` fails, run `npm run format` on the listed files only and
re-run. Confirm the pinned snapshot is untouched: `git diff --stat lib/server/__tests__/fixtures/`
prints nothing.

- [ ] **Step 2: Prepare an isolated copy and a scratch database**

Follow the procedure in the project memory note `marketing-screenshot-pipeline`. If it differs
from the commands below, prefer the note, and record what you ran. The invariants: no `.env`
file in the copy, a scratch Postgres, a local-mode dev server.

```bash
SCRATCH=/tmp/claude-1000/ss-w2-verify   # or the session scratchpad
# Copies tracked + untracked-but-not-ignored files only. Secrets files, node_modules and .next
# are gitignored, so they are never copied and the command never has to name them (the
# PreToolUse secrets guard denies any command whose text names one; do not rephrase around it).
mkdir -p "$SCRATCH"
git ls-files -z --cached --others --exclude-standard | rsync -a --from0 --files-from=- ./ "$SCRATCH/"
ls -a "$SCRATCH"   # names only; confirm no dot-env entry. If there is one: STOP, delete the copy.
# 55432 is taken by the shelfsprite-scratch container from the memory note when it is up.
docker ps --format '{{.Names}} {{.Ports}}' | grep 55433 && echo "STOP: port 55433 busy"
docker run -d --rm --name ss-w2-pg -e POSTGRES_PASSWORD=scratch -p 55433:5432 postgres:16
cd "$SCRATCH" && npm ci
DATABASE_URL=postgres://postgres:scratch@localhost:55433/postgres npm run db:migrate
```

Expected: the listing has no dot-env entry; the migration applies `0000`–`0007` cleanly. Confirm the column:

```bash
docker exec ss-w2-pg psql -U postgres -c "select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name='profile_meta' and column_name in ('rebuild_reason','rebuild_requested_at');"
```

Expected: `rebuild_reason | character varying | YES | (null)` and
`rebuild_requested_at | timestamp without time zone | YES | (null)`. Record what you actually
observe, not what this plan predicts.

- [ ] **Step 3: Start the dev server with one override**

```bash
cd "$SCRATCH" && DATABASE_URL=postgres://postgres:scratch@localhost:55433/postgres \
  ALLOW_LOCAL_AUTH=true ENCRYPTION_KEY="$(openssl rand -base64 32)" CRON_SECRET=scratch \
  MYLIBRARY_MODEL_REVEAL=claude-sonnet-5 PORT=3100 npm run dev
```

(Run it in the background; the throwaway `ENCRYPTION_KEY` only protects this scratch database.)

- [ ] **Step 4: Seed a library and give the app a key, without the agent ever seeing it**

In a browser at `http://localhost:3100`, run the setup wizard and import
`lib/server/__tests__/fixtures/sample_goodreads.csv`. Then ask Chase to paste his Anthropic key
into Settings → API key himself. The executor must not type, read or print it. If Chase is
unavailable, stop here and report that the Claude-dependent checks (Steps 5–6) are pending. Do
not mark the wave done.

- [ ] **Step 5: Real flow, part 1: the mid-run edit stays pending**

Start a full build and, while it runs, change a rating through the real feedback route:

```bash
curl -s -X POST localhost:3100/api/profile > /tmp/ss-w2-build.json &
sleep 2
BOOK=$(curl -s localhost:3100/api/books | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['id'])")
curl -s -X PATCH localhost:3100/api/books/$BOOK/feedback -H 'content-type: application/json' -d '{"rating": 2.5}'
wait
cat /tmp/ss-w2-build.json | head -c 400; echo
curl -s localhost:3100/api/profile/status
```

If `GET /api/books` returns an object rather than an array, adjust the one-liner to its actual
shape; do not guess. Expected: the build returns `"mode": "full"`, and the status shows
`"dirty": true` with `$BOOK` in `changed_book_ids`. If the build finished before the PATCH landed
(it printed before `sleep 2` ended), repeat with a shorter sleep. Record which attempt was valid.
Then open `/` in the browser and confirm the "Your taste has new evidence" banner is visible.

- [ ] **Step 6: Real flow, part 2: rebuild_reason and per-operation models**

```bash
docker exec ss-w2-pg psql -U postgres -c "update profile_meta set rebuild_reason='title_deleted' where user_id='local';"
curl -s localhost:3100/api/profile/status
curl -s -X POST localhost:3100/api/profile/update | head -c 300; echo
curl -s localhost:3100/api/profile/status
curl -s -X POST localhost:3100/api/profile/reveal-lines | head -c 300; echo
docker exec ss-w2-pg psql -U postgres -c "select operation, model from usage_events order by id;"
```

Expected:
- the first status shows `"dirty": true, "rebuild_reason": "title_deleted"`;
- the update returns `"mode": "full"`, and the second status shows `"rebuild_reason": null`;
- `usage_events` shows `profile_full` on `claude-sonnet-5` and `reveal_lines` on
  `claude-sonnet-5` (the override);
- any seed or archetype rows there stay on `claude-haiku-4-5-20251001`.

Check the reveal-lines route's method in `app/api/profile/reveal-lines/route.ts` before
calling it. Record what you actually observe.

- [ ] **Step 7: Tear down**

```bash
docker stop ss-w2-pg
rm -rf "$SCRATCH"
```

Stop the dev server.

- [ ] **Step 8: Hand the production migration to Chase**

Report this to Chase verbatim. Do not run it.

> Wave 2 adds one nullable column. It is backward compatible: the currently deployed code never
> selects it, so apply it **before** this branch deploys anywhere that shares the production
> database. The new code selects `rebuild_reason` on every `profile_meta` read and would 500
> without it. In your release window, against the known production `DATABASE_URL`:
>
> ```bash
> npm run db:migrate
> ```
>
> then verify:
>
> ```sql
> select column_name, data_type, is_nullable, column_default
> from information_schema.columns
> where table_name = 'profile_meta' and column_name = 'rebuild_reason';
> ```
>
> Expected: `rebuild_reason | character varying | YES | null`.

- [ ] **Step 9: Report**

Report the gate results with counts, the real-flow observations from Steps 5–6 (including any
retries), and the migration handoff. Do not claim the wave done if Step 4 stopped for a key.
