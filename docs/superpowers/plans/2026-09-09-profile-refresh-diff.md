# Profile Refresh Change Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a profile refresh, tell the reader which taste traits were added, dropped, or reworded, instead of silently dismissing the banner.

**Architecture:** The diff is computed server-side by snapshotting the user's `proposed` trait claims immediately before and after `updateTasteProfile` runs, from inside the `POST /api/profile/update` route handler. `updateTasteProfile` itself is not modified. The snapshot sits outside the function on purpose: `updateTasteProfile` has six branches, two of which delegate to the full `extractTasteProfile` rebuild and one of which returns early without calling Claude, and a before/after snapshot covers all of them uniformly. The diff is returned in the response body and rendered in place by `ReprofileBanner`. Nothing is persisted; there is no migration.

**Tech Stack:** TypeScript, Next.js App Router route handlers, drizzle-orm, Vitest (`lib/server/**`, `app/api/**`), Jest + React Testing Library (everything else), SWR.

**Spec:** No separate spec file. This work came through the bounded brainstorming path, so the design is inlined here and in GitHub issue #81. Read the "Design decisions already settled" section below before starting — it records choices that were made against measured data and must not be re-litigated.

**Issue:** #81 — `[feedback] When doing a profile refresh, highlight what actually changed`

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Two test runners with disjoint ownership.** `npm run test:server` (Vitest) owns exactly `lib/server/**` and `app/api/**`. `npm test` (Jest) owns everything else, including `components/**`. Running only one is not a complete pass.
- **Full gate, run from the repository root:** `npm run test:server`, `npm test`, `npm run type-check`, `npm run lint`, `npm run format:check`, `npm run build`.
- **Do not modify `lib/server/profileUpdate.ts` or `lib/server/profileBuild.ts`.** Both are faithful ports with documented Python-parity behavior. This feature is additive and sits outside them.
- **Do not add a migration.** The summary is in-session only. `lib/server/schema.ts` is not touched.
- **Do not touch `POST /api/profile` (the full-build route).** It backs the empty-state CTA and the setup wizard, where every trait is trivially "added." Only `POST /api/profile/update` gains the diff.
- **Reword threshold is `0.80`.** This value was calibrated against real claim pairs; see "Design decisions already settled." Do not change it without re-running the calibration.
- **Commit style:** plain messages, no `Co-Authored-By` trailer. End each commit message with the `Claude-Session:` line supplied in the session's attribution instructions. Do not open a PR until Task 4 passes.
- **Branch:** `fix/bug-81-profile-refresh-diff`. Commit subjects use `fix(profile): <subject> (#81)`.

---

## Design decisions already settled

These were decided with the user or measured directly. Treat them as fixed requirements.

**1. Surface: the banner only.** `components/ReprofileBanner.tsx` is mounted app-wide in `app/(main)/layout.tsx:13` and is the only component that calls `POST /profile/update`. The summary replaces the warning in that same slot. No `/profile` page changes, no persistence.

**2. Detail level: added, dropped, and reworded pairs.** Counts alone do not answer "what actually changed."

**3. Pairing uses containment-or-ratio, not `ratio()` alone.** A plain `ratio()` threshold was tried and measured, and it does not work. Real numbers from `lib/server/similarity.ts#ratio` over normalized claims:

```
0.6207  reword    | Avoids military SF >> Avoids military SF unless it's satirical
0.6275  distinct  | Avoids series fiction >> Avoids second-person narration
```

A genuine reword scores *below* a genuine non-pair, so no threshold separates them. `ratio()` is length-sensitive and a pure suffix extension — the most common reword shape — tanks the score. The fix is to score a pair as `1.0` when one normalized claim is a whole-word prefix or suffix of the other, and fall back to `ratio()` otherwise. With that scorer the seven sample rewords land at 0.8409–1.0 and the six genuine non-pairs at 0.6275 and below, so `0.80` sits in a clean gap.

**4. Pairing is gated on matching `polarity`, and this is not optional.** Measured polarity flips:

```
0.8852 | Rewards long series commitments >> Avoids long series commitments
0.8772 | Rewards dense, allusive prose   >> Avoids dense, allusive prose
0.8108 | Rewards military SF             >> Avoids military SF
```

All three clear the 0.80 threshold. Ungated, a reversal of the model's judgment about the reader would render as a mild reword. The snapshot therefore carries `polarity` alongside `claim`, and claims of different polarity are never compared.

**5. `protagonists` vs `antagonists` (0.9231) is allowed to pair.** It is the one same-polarity non-pair above threshold. Rendering it as `~ ...protagonists → ...antagonists` shows the reader the exact one-word change, which is better than an unexplained drop plus add. Do not add machinery to prevent it.

**6. Only `status = 'proposed'` rows participate.** `persistProposedTraits` (`lib/server/profileBuild.ts:257`) deletes and re-inserts only proposed rows, for both the `full` and `update` kinds. Traits the reader has confirmed or rejected are never touched by a refresh, so they cannot pollute the diff.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `lib/server/profileDiff.ts` | Create | Pure diff logic + the DB snapshot read. No Claude, no writes. |
| `lib/server/profileDiff.test.ts` | Create | Vitest coverage of the diff and the snapshot. |
| `app/api/profile/update/route.ts` | Modify | Wrap the existing `updateTasteProfile` call in before/after snapshots; merge `changes` into the response. |
| `app/api/profile/update/route.test.ts` | Create | Vitest coverage that the route returns `changes`. |
| `lib/api.ts` | Modify (`:558`) | Replace `Record<string, unknown>` with a real return type for `updateProfile`. |
| `components/ReprofileBanner.tsx` | Modify | Hold the summary in state, render it, allow dismissal. |
| `components/__tests__/ReprofileBanner.test.tsx` | Create | Jest coverage of the summary UI. |

---

## Handoff batching

This plan is written for a controller session dispatching one subagent per task. **Stop and hand off after Task 2.** A controller's cost is its context size multiplied by its turn count, and a session that runs all four tasks straight through ends at several times the per-turn cost of one that restarts once. Keep the `.superpowers/sdd/` ledger current after *every* task, not batched at the end — the handoff is only cheap because the next session reconstructs state from disk.

- **Batch A:** Task 1, Task 2 → hand off
- **Batch B:** Task 3, Task 4

---

### Task 1: The diff module

**Files:**
- Create: `lib/server/profileDiff.ts`
- Test: `lib/server/profileDiff.test.ts`

**Interfaces:**
- Consumes: `ratio` from `lib/server/similarity.ts`.
- Produces, relied on by Tasks 2 and 3:
  - `export interface ProposedClaim { claim: string; polarity: string }`
  - `export interface RewordedClaim { from: string; to: string }`
  - `export interface ProfileChanges { added: string[]; dropped: string[]; reworded: RewordedClaim[]; unchanged: number }`
  - `export const REWORD_THRESHOLD = 0.8`
  - `export function diffProposedClaims(before: ProposedClaim[], after: ProposedClaim[]): ProfileChanges`

- [ ] **Step 1: Write the failing test**

Create `lib/server/profileDiff.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { diffProposedClaims, type ProposedClaim } from './profileDiff';

const reward = (claim: string): ProposedClaim => ({ claim, polarity: 'reward' });
const aversion = (claim: string): ProposedClaim => ({ claim, polarity: 'aversion' });

describe('diffProposedClaims', () => {
  it('reports no changes when the claim sets match', () => {
    const traits = [reward('Rewards dense prose'), aversion('Avoids military SF')];
    expect(diffProposedClaims(traits, traits)).toEqual({
      added: [],
      dropped: [],
      reworded: [],
      unchanged: 2,
    });
  });

  it('treats claims as unchanged despite case and whitespace differences', () => {
    const before = [reward('Rewards  dense prose')];
    const after = [reward('rewards dense prose')];
    const out = diffProposedClaims(before, after);
    expect(out.unchanged).toBe(1);
    expect(out.added).toEqual([]);
    expect(out.dropped).toEqual([]);
  });

  it('lists a purely added claim', () => {
    const before = [reward('Rewards dense prose')];
    const after = [reward('Rewards dense prose'), reward('Rewards novellas')];
    const out = diffProposedClaims(before, after);
    expect(out.added).toEqual(['Rewards novellas']);
    expect(out.dropped).toEqual([]);
    expect(out.reworded).toEqual([]);
    expect(out.unchanged).toBe(1);
  });

  it('lists a purely dropped claim', () => {
    const before = [reward('Rewards dense prose'), reward('Rewards novellas')];
    const after = [reward('Rewards dense prose')];
    const out = diffProposedClaims(before, after);
    expect(out.added).toEqual([]);
    expect(out.dropped).toEqual(['Rewards novellas']);
    expect(out.unchanged).toBe(1);
  });

  it('pairs a suffix extension as a reword rather than a drop plus an add', () => {
    const before = [aversion('Avoids military SF')];
    const after = [aversion("Avoids military SF unless it's satirical")];
    const out = diffProposedClaims(before, after);
    expect(out.reworded).toEqual([
      { from: 'Avoids military SF', to: "Avoids military SF unless it's satirical" },
    ]);
    expect(out.added).toEqual([]);
    expect(out.dropped).toEqual([]);
  });

  it('pairs a mid-sentence rewrite that clears the ratio threshold', () => {
    const before = [reward('Rewards morally grey protagonists')];
    const after = [reward('Rewards morally ambiguous protagonists')];
    const out = diffProposedClaims(before, after);
    expect(out.reworded).toEqual([
      { from: 'Rewards morally grey protagonists', to: 'Rewards morally ambiguous protagonists' },
    ]);
  });

  it('does NOT pair two genuinely different claims below the threshold', () => {
    const before = [aversion('Avoids series fiction')];
    const after = [aversion('Avoids second-person narration')];
    const out = diffProposedClaims(before, after);
    expect(out.reworded).toEqual([]);
    expect(out.dropped).toEqual(['Avoids series fiction']);
    expect(out.added).toEqual(['Avoids second-person narration']);
  });

  it('does NOT pair a polarity flip, even though it clears the threshold', () => {
    const before = [reward('Rewards military SF')];
    const after = [aversion('Avoids military SF')];
    const out = diffProposedClaims(before, after);
    expect(out.reworded).toEqual([]);
    expect(out.dropped).toEqual(['Rewards military SF']);
    expect(out.added).toEqual(['Avoids military SF']);
  });

  it('pairs each claim at most once, taking the best score first', () => {
    const before = [reward('Rewards dense allusive prose')];
    const after = [
      reward('Rewards dense allusive prose in translation'),
      reward('Rewards dense, allusive prose'),
    ];
    const out = diffProposedClaims(before, after);
    // 'Rewards dense, allusive prose' scores higher, so it wins the single `before` claim.
    expect(out.reworded).toEqual([
      { from: 'Rewards dense allusive prose', to: 'Rewards dense, allusive prose' },
    ]);
    expect(out.added).toEqual(['Rewards dense allusive prose in translation']);
    expect(out.dropped).toEqual([]);
  });

  it('handles a first build, where everything is added', () => {
    const out = diffProposedClaims([], [reward('Rewards dense prose')]);
    expect(out.added).toEqual(['Rewards dense prose']);
    expect(out.dropped).toEqual([]);
    expect(out.reworded).toEqual([]);
    expect(out.unchanged).toBe(0);
  });

  it('collapses duplicate claims within a snapshot', () => {
    const before = [reward('Rewards dense prose'), reward('Rewards dense prose')];
    const after = [reward('Rewards dense prose')];
    const out = diffProposedClaims(before, after);
    expect(out.unchanged).toBe(1);
    expect(out.dropped).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:server -- lib/server/profileDiff.test.ts`
Expected: FAIL — cannot resolve `./profileDiff`.

- [ ] **Step 3: Write the implementation**

Create `lib/server/profileDiff.ts`:

```ts
/**
 * Diff of a user's PROPOSED taste-trait claims across a profile refresh, for the
 * post-refresh summary in ReprofileBanner (issue #81).
 *
 * Only `status = 'proposed'` rows participate: persistProposedTraits deletes and
 * re-inserts exactly those, so confirmed/rejected verdicts cannot pollute the diff.
 */
import { and, eq } from 'drizzle-orm';
import type { Db } from './db';
import * as schema from './schema';
import { ratio } from './similarity';

export interface ProposedClaim {
  claim: string;
  polarity: string;
}

export interface RewordedClaim {
  from: string;
  to: string;
}

export interface ProfileChanges {
  added: string[];
  dropped: string[];
  reworded: RewordedClaim[];
  unchanged: number;
}

/**
 * Minimum score for two claims to be reported as a reword rather than as a
 * separate drop and add.
 *
 * Calibrated, not guessed. Over sample claim pairs the seven genuine rewords score
 * 0.8409-1.0 and the six genuine non-pairs 0.6275 and below, so 0.80 sits in the gap.
 * A bare `ratio()` threshold does NOT work at any value: a suffix extension
 * ('Avoids military SF' -> "Avoids military SF unless it's satirical") scores 0.6207,
 * BELOW the 0.6275 of a genuine non-pair, because ratio() is length-sensitive. Hence
 * the containment rule in `claimSimilarity`.
 */
export const REWORD_THRESHOLD = 0.8;

/** Claims are compared case- and whitespace-insensitively; display keeps the original. */
function normalizeClaim(claim: string): string {
  return claim.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * True when `a` and `b` are the same claim with material added to one end -- the most
 * common reword shape, and the one ratio() scores worst. Whole-word only, so 'avoids
 * war' does not contain-match 'avoids warmth' (same reasoning as subjectHits in
 * recFilters.ts).
 */
function isWholeWordExtension(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (!short) return false;
  if (long === short) return true;
  if (long.startsWith(short) && long[short.length] === ' ') return true;
  if (long.endsWith(short) && long[long.length - short.length - 1] === ' ') return true;
  return false;
}

/** Reword score for two NORMALIZED claims. */
export function claimSimilarity(a: string, b: string): number {
  return isWholeWordExtension(a, b) ? 1 : ratio(a, b);
}

/** Deduplicate by normalized claim, keeping the first occurrence's display text. */
function byNormalized(claims: ProposedClaim[]): Map<string, ProposedClaim> {
  const out = new Map<string, ProposedClaim>();
  for (const c of claims) {
    const key = normalizeClaim(c.claim);
    if (!key) continue;
    if (!out.has(key)) out.set(key, c);
  }
  return out;
}

/**
 * Compare two snapshots of proposed claims.
 *
 * Exact (normalized) matches are `unchanged`. Leftovers are paired greedily by
 * descending similarity -- highest-scoring pair first, each claim used at most once --
 * and reported as `reworded`; whatever stays unpaired is `dropped` or `added`.
 *
 * Pairing NEVER crosses polarity. A flip ('Rewards military SF' -> 'Avoids military
 * SF') scores 0.8108 and would otherwise render as a mild reword, when it is in fact
 * the model reversing its judgment about the reader.
 */
export function diffProposedClaims(
  before: ProposedClaim[],
  after: ProposedClaim[]
): ProfileChanges {
  const beforeMap = byNormalized(before);
  const afterMap = byNormalized(after);

  let unchanged = 0;
  const droppedKeys: string[] = [];
  for (const key of beforeMap.keys()) {
    if (afterMap.has(key)) unchanged++;
    else droppedKeys.push(key);
  }
  const addedKeys = [...afterMap.keys()].filter((k) => !beforeMap.has(k));

  // Score every same-polarity leftover pair, best first. Trait counts are ~10, so the
  // O(n*m) scan is free. Ties break by input order so the result is deterministic.
  const scored: Array<{ score: number; d: number; a: number }> = [];
  for (let d = 0; d < droppedKeys.length; d++) {
    for (let a = 0; a < addedKeys.length; a++) {
      const dropped = beforeMap.get(droppedKeys[d])!;
      const added = afterMap.get(addedKeys[a])!;
      if (dropped.polarity !== added.polarity) continue;
      const score = claimSimilarity(droppedKeys[d], addedKeys[a]);
      if (score >= REWORD_THRESHOLD) scored.push({ score, d, a });
    }
  }
  scored.sort((x, y) => y.score - x.score || x.d - y.d || x.a - y.a);

  const usedDropped = new Set<number>();
  const usedAdded = new Set<number>();
  const reworded: RewordedClaim[] = [];
  for (const { d, a } of scored) {
    if (usedDropped.has(d) || usedAdded.has(a)) continue;
    usedDropped.add(d);
    usedAdded.add(a);
    reworded.push({
      from: beforeMap.get(droppedKeys[d])!.claim,
      to: afterMap.get(addedKeys[a])!.claim,
    });
  }

  return {
    added: addedKeys.filter((_, i) => !usedAdded.has(i)).map((k) => afterMap.get(k)!.claim),
    dropped: droppedKeys.filter((_, i) => !usedDropped.has(i)).map((k) => beforeMap.get(k)!.claim),
    reworded,
    unchanged,
  };
}

/** Read the user's current proposed claims. Cheap: two columns, no joins. */
export async function snapshotProposedClaims(db: Db, userId: string): Promise<ProposedClaim[]> {
  return db
    .select({ claim: schema.tasteTraits.claim, polarity: schema.tasteTraits.polarity })
    .from(schema.tasteTraits)
    .where(and(eq(schema.tasteTraits.userId, userId), eq(schema.tasteTraits.status, 'proposed')));
}
```

> **Do not add a shared `hasNoChanges` helper here for the banner to import.** This module
> imports drizzle and `schema.ts`, so anything the client pulls from it ships server code into
> the browser bundle — the same hazard `CLAUDE.md` calls out for `rating.ts` and `authMode.ts`.
> `ReprofileBanner` computes that check inline against its own `ProfileChangeSummary` type in
> Task 3, and the two types are deliberately declared separately for this reason.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:server -- lib/server/profileDiff.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/server/profileDiff.ts lib/server/profileDiff.test.ts
git commit -m "fix(profile): add proposed-trait diff with polarity-gated reword pairing (#81)"
```

---

### Task 2: Return the diff from the update route

**Files:**
- Modify: `app/api/profile/update/route.ts`
- Test: `app/api/profile/update/route.test.ts` (create)

**Interfaces:**
- Consumes: `snapshotProposedClaims`, `diffProposedClaims`, `ProfileChanges` from Task 1.
- Produces: `POST /api/profile/update` response body gains a `changes` key holding a `ProfileChanges`. Task 3 consumes this shape.

- [ ] **Step 1: Write the failing test**

Create `app/api/profile/update/route.test.ts`. Follow the existing harness in `app/api/goals/route.test.ts` — `setupTestEnv()`, `makeTestDb()`, `_setDbForTests`.

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeTestDb } from '@/lib/server/__tests__/helpers/pglite';
import { setupTestEnv } from '@/lib/server/__tests__/helpers/testEnv';
import { _setDbForTests, type Db } from '@/lib/server/db';

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

function post(): Request {
  return new Request('http://test/api/profile/update', { method: 'POST' });
}

vi.mock('@/lib/server/claude', () => ({
  resolveAnthropicKey: vi.fn(async () => 'test-key'),
  makeAnthropicClient: vi.fn(() => ({})),
}));

const updateTasteProfile = vi.hoisted(() => vi.fn());
vi.mock('@/lib/server/profileUpdate', () => ({ updateTasteProfile }));

describe('POST /api/profile/update', () => {
  it('reports the traits that changed across the refresh', async () => {
    await withDb(async (db) => {
      const { POST } = await import('./route');
      const trait = (claim: string, polarity: string) => ({
        userId: 'local',
        claim,
        polarity,
        inferenceConfidence: 0.8,
        status: 'proposed',
      });

      // Seed the "before" state, then have the mocked build swap one claim for a reword
      // and add a second, so the response has one of each category to assert on.
      const schema = await import('@/lib/server/schema');
      await db
        .insert(schema.tasteTraits)
        .values([trait('Avoids military SF', 'aversion'), trait('Rewards dense prose', 'reward')]);

      updateTasteProfile.mockImplementation(async () => {
        await db.delete(schema.tasteTraits);
        await db
          .insert(schema.tasteTraits)
          .values([
            trait("Avoids military SF unless it's satirical", 'aversion'),
            trait('Rewards novellas', 'reward'),
          ]);
        return { mode: 'update', traits_after: 2 };
      });

      const res = await POST(post());
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.mode).toBe('update');
      expect(body.changes.reworded).toEqual([
        { from: 'Avoids military SF', to: "Avoids military SF unless it's satirical" },
      ]);
      expect(body.changes.added).toEqual(['Rewards novellas']);
      expect(body.changes.dropped).toEqual(['Rewards dense prose']);
      expect(body.changes.unchanged).toBe(0);
    });
  });

  it('reports empty changes when the refresh moved nothing', async () => {
    await withDb(async (db) => {
      const { POST } = await import('./route');
      const schema = await import('@/lib/server/schema');
      await db.insert(schema.tasteTraits).values([
        {
          userId: 'local',
          claim: 'Rewards dense prose',
          polarity: 'reward',
          inferenceConfidence: 0.8,
          status: 'proposed',
        },
      ]);

      updateTasteProfile.mockImplementation(async () => ({
        mode: 'update',
        note: 'Profile already up to date — no rating/review changes since last build.',
      }));

      const res = await POST(post());
      const body = await res.json();
      expect(body.changes).toEqual({ added: [], dropped: [], reworded: [], unchanged: 1 });
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:server -- app/api/profile/update/route.test.ts`
Expected: FAIL — `body.changes` is `undefined`.

- [ ] **Step 3: Write the implementation**

Modify `app/api/profile/update/route.ts`. Add the import and wrap the existing call; leave `maxDuration` and the key-resolution logic exactly as they are.

```ts
import { withApi, ApiError } from '@/lib/server/http';
import { getDb } from '@/lib/server/db';
import { resolveAnthropicKey, makeAnthropicClient } from '@/lib/server/claude';
import { PROFILE_NO_KEY_MESSAGE } from '@/lib/server/claudeErrors';
import { updateTasteProfile } from '@/lib/server/profileUpdate';
import { snapshotProposedClaims, diffProposedClaims } from '@/lib/server/profileDiff';

// May delegate to the full builder, so it inherits that flow's ceiling.
export const maxDuration = 300;

/** Port of api.py::update_profile (909-916): RuntimeError -> 400. */
export const POST = withApi('/api/profile/update', async (_req, ctx) => {
  const db = getDb();
  const apiKey = await resolveAnthropicKey(db, ctx.user.userId);
  if (!apiKey) throw new ApiError(400, PROFILE_NO_KEY_MESSAGE);
  const client = makeAnthropicClient(apiKey);

  // Snapshot OUTSIDE updateTasteProfile: it has six branches, two delegating to the
  // full extractTasteProfile rebuild and one returning early without calling Claude.
  // A before/after snapshot reports the real outcome of every one of them (#81).
  const before = await snapshotProposedClaims(db, ctx.user.userId);
  const out = await updateTasteProfile(db, client, ctx.user.userId);
  ctx.timer.mark('claude');
  const after = await snapshotProposedClaims(db, ctx.user.userId);

  return Response.json({ ...out, changes: diffProposedClaims(before, after) });
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:server -- app/api/profile/update/route.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Run the whole server suite for regressions**

Run: `npm run test:server`
Expected: PASS. If a pre-existing profile test asserts on the exact shape of this response body, update it to allow the new `changes` key — do not remove the key.

- [ ] **Step 6: Commit**

```bash
git add app/api/profile/update/route.ts app/api/profile/update/route.test.ts
git commit -m "fix(profile): return a change summary from the refresh endpoint (#81)"
```

> **CONTROLLER: hand off here.** Update the `.superpowers/sdd/` ledger with Tasks 1–2 done, how they were verified, and that Task 3 is next. Then end the session rather than starting Task 3.

---

### Task 3: Render the summary in the banner

**Files:**
- Modify: `lib/api.ts:558`
- Modify: `components/ReprofileBanner.tsx`
- Test: `components/__tests__/ReprofileBanner.test.tsx` (create)

**Interfaces:**
- Consumes: the `changes` key on the `POST /profile/update` response from Task 2.
- Produces: `export interface ProfileChangeSummary` and `export interface ProfileUpdateResult` in `lib/api.ts`.

Note: this test lives under `components/`, so it is **Jest**, not Vitest. Follow the header convention in `components/__tests__/TasteHero.test.tsx` — the `@jest-environment jsdom` docblock is required.

- [ ] **Step 1: Add the client types**

In `lib/api.ts`, add these exported interfaces near the other response types, then change `updateProfile` at line 558 to use them:

```ts
export interface ProfileChangeSummary {
  added: string[];
  dropped: string[];
  reworded: { from: string; to: string }[];
  unchanged: number;
}

export interface ProfileUpdateResult {
  mode?: string;
  note?: string;
  changes: ProfileChangeSummary;
}
```

```ts
  updateProfile: () => post<ProfileUpdateResult>('/profile/update'),
```

- [ ] **Step 2: Write the failing test**

Create `components/__tests__/ReprofileBanner.test.tsx`:

```tsx
/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ReprofileBanner from '@/components/ReprofileBanner';

const mockUpdateProfile = jest.fn();
let mockStatus: { dirty: boolean } = { dirty: true };

jest.mock('swr', () => ({
  __esModule: true,
  default: () => ({ data: mockStatus, mutate: jest.fn() }),
}));

jest.mock('@/lib/api', () => ({
  api: {
    updateProfile: (...args: unknown[]) => mockUpdateProfile(...args),
    profileStatus: jest.fn(),
  },
  PROFILE_STATUS_KEY: '/profile/status',
}));

const noChanges = { added: [], dropped: [], reworded: [], unchanged: 4 };

beforeEach(() => {
  mockStatus = { dirty: true };
  mockUpdateProfile.mockReset();
});

it('shows the added, dropped and reworded traits after a refresh', async () => {
  mockUpdateProfile.mockResolvedValue({
    mode: 'update',
    changes: {
      added: ['Rewards novellas'],
      dropped: ['Avoids translated fiction'],
      reworded: [{ from: 'Avoids military SF', to: "Avoids military SF unless it's satirical" }],
      unchanged: 9,
    },
  });

  render(<ReprofileBanner />);
  fireEvent.click(screen.getByRole('button', { name: /update profile/i }));

  expect(await screen.findByText('Rewards novellas')).toBeInTheDocument();
  expect(screen.getByText('Avoids translated fiction')).toBeInTheDocument();
  expect(screen.getByText("Avoids military SF unless it's satirical")).toBeInTheDocument();
  expect(screen.getByText(/9 unchanged/i)).toBeInTheDocument();
});

it('keeps the summary visible after the dirty flag clears', async () => {
  mockUpdateProfile.mockResolvedValue({ mode: 'update', changes: { ...noChanges, added: ['X'] } });

  const { rerender } = render(<ReprofileBanner />);
  fireEvent.click(screen.getByRole('button', { name: /update profile/i }));
  expect(await screen.findByText('X')).toBeInTheDocument();

  // The refresh clears status.dirty; the summary must survive the re-render.
  mockStatus = { dirty: false };
  rerender(<ReprofileBanner />);
  expect(screen.getByText('X')).toBeInTheDocument();
});

it('says so plainly when nothing changed', async () => {
  mockUpdateProfile.mockResolvedValue({ mode: 'update', changes: noChanges });

  render(<ReprofileBanner />);
  fireEvent.click(screen.getByRole('button', { name: /update profile/i }));

  expect(await screen.findByText(/no changes/i)).toBeInTheDocument();
});

it('dismisses the summary', async () => {
  mockUpdateProfile.mockResolvedValue({ mode: 'update', changes: { ...noChanges, added: ['X'] } });

  render(<ReprofileBanner />);
  fireEvent.click(screen.getByRole('button', { name: /update profile/i }));
  expect(await screen.findByText('X')).toBeInTheDocument();

  mockStatus = { dirty: false };
  fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
  await waitFor(() => expect(screen.queryByText('X')).not.toBeInTheDocument());
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- components/__tests__/ReprofileBanner.test.tsx`
Expected: FAIL — no summary is rendered.

- [ ] **Step 4: Write the implementation**

Modify `components/ReprofileBanner.tsx`. Three changes: hold the result in state, widen the early-return guard, and render a summary branch.

Store the summary and keep the banner mounted while one exists:

```tsx
const [summary, setSummary] = useState<ProfileChangeSummary | null>(null);
```

```tsx
if (!status?.dirty && !summary) return null;
```

The widened guard is load-bearing. `status.dirty` flips to `false` as soon as the refresh succeeds, so the original `if (!status?.dirty) return null` would unmount the banner before the summary could be read.

Capture the result in `handleReprofile`:

```tsx
    try {
      const result = await api.updateProfile();
      setSummary(result.changes);
      await mutate();
    } catch (e) {
```

Then render the summary instead of the warning when one is present. Reuse the existing outer wrapper classes but swap the `warning` palette for `accent`, since this is a result and not a call to action:

```tsx
  if (summary) {
    const nothingChanged =
      summary.added.length === 0 && summary.dropped.length === 0 && summary.reworded.length === 0;

    return (
      <div className="border-b border-accent/30 bg-accent/10">
        <div className="mx-auto flex max-w-4xl flex-wrap items-start justify-between gap-2 px-4 py-2.5">
          <div className="space-y-1 text-sm text-text">
            <p className="font-semibold">
              {nothingChanged
                ? 'Profile refreshed — no changes.'
                : `Profile refreshed — ${summary.added.length} new, ${summary.dropped.length} dropped, ${summary.reworded.length} reworded, ${summary.unchanged} unchanged.`}
            </p>
            {nothingChanged ? (
              <p className="text-xs text-muted">
                Your taste traits already reflected everything in your library.
              </p>
            ) : (
              <ul className="space-y-0.5 text-xs">
                {summary.added.map((claim) => (
                  <li key={`a-${claim}`} className="text-success">
                    <span aria-hidden="true">+ </span>
                    {claim}
                  </li>
                ))}
                {summary.dropped.map((claim) => (
                  <li key={`d-${claim}`} className="text-danger">
                    <span aria-hidden="true">− </span>
                    {claim}
                  </li>
                ))}
                {summary.reworded.map((r) => (
                  <li key={`r-${r.from}`} className="text-muted">
                    <span aria-hidden="true">~ </span>
                    <span className="line-through">{r.from}</span>
                    <span aria-hidden="true"> → </span>
                    <span className="text-text">{r.to}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button
            type="button"
            onClick={() => setSummary(null)}
            className="rounded-md px-2 py-1 font-mono text-xs text-muted transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            Dismiss
          </button>
        </div>
      </div>
    );
  }
```

Place this block after the `if (!status?.dirty && !summary) return null;` guard and before the existing warning-banner `return`. Import `type ProfileChangeSummary` from `@/lib/api`.

The `success`, `danger`, `accent` and `muted` tokens are all defined in `app/globals.css:20-29` and already used as `text-success` / `text-danger` elsewhere in the codebase, so these class names need no further checking.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- components/__tests__/ReprofileBanner.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add lib/api.ts components/ReprofileBanner.tsx components/__tests__/ReprofileBanner.test.tsx
git commit -m "fix(profile): show what changed after a profile refresh (#81)"
```

---

### Task 4: Full gate, browser verification, and PR

**Files:** none created; this task is verification.

- [ ] **Step 1: Run the complete gate**

Run each from the repository root and confirm each passes before moving on:

```bash
npm run test:server
npm test
npm run type-check
npm run lint
npm run format:check
npm run build
```

`npm run build` is not optional — it is the only gate that catches Next segment-config and prerender failures, and this task modified a route handler that carries `maxDuration`.

- [ ] **Step 2: Verify in the browser**

Tests alone do not count as verification here. Exercise the real flow:

1. Start the app with `npm run dev`.
2. Sign in and go to any page under `app/(main)/` so `ReprofileBanner` is mounted.
3. Change a rating on `/library` so `profileStatus.dirty` becomes true and the warning banner appears.
4. Click **Update profile**.
5. Confirm the banner turns into the change summary, that the listed claims match what `/profile` now shows, and that **Dismiss** clears it.
6. Refresh with nothing changed and confirm the "no changes" copy renders rather than an empty list.

If a real Claude call is not wanted for this, the `isolated-local-env` skill is stale and documents the retired Python backend — do not follow it. Ask the user how they want the refresh exercised instead.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin fix/bug-81-profile-refresh-diff
```

Open the PR with `Closes #81` at the top of the body, so merging closes the issue.

- [ ] **Step 4: Confirm the PR exists**

Run `gh pr view --json number,url,state` and confirm it reports an open PR. Do not report completion before this returns successfully.
