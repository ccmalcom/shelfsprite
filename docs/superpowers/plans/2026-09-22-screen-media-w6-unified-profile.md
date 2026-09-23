# ScreenSprite wave 6: unified taste profile implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the taste profile draw on books **and** films/TV when ScreenSprite is enabled, while
the books-only path stays byte-identical. Also: cite titles as typed evidence, keep the profile
incremental, and let a user opt out cleanly.

**Architecture:** The profile keeps one entry point per build kind (`extractTasteProfile`,
`updateTasteProfile`). Each reads `screen_toggled_at` first and decides the **variant**.
- **Screen variant:** screen enabled and at least one eligible title. It uses a new prompt module
  (`screenProfilePrompts.ts`) that appends `SCREEN DATA (JSON)` built by `screenTiers.ts`, plus
  tools that add `exhibit_titles`/`contrast_titles`.
- **Book variant:** today's code path, pinned by a new byte-for-byte golden test that is recorded
  *before* any change.

Three things are shared across both variants:
- `persistProposedTraits` gains an options object. It validates title ids against the titles
  actually sent, drops screen-variant traits with no valid exhibit, and runs a
  `screen_toggled_at` guard inside its transaction.
- `deriveArchetype` and `generateRevealLines` get the same guard.
- Opt-out (`screenOptOut.ts`) deletes title-citing traits and the archetype in one transaction.

**Tech Stack:** TypeScript, Next.js App Router route handlers, drizzle-orm (Postgres; PGlite in
tests), Vitest (`lib/server/**`, `app/api/**`).

**Spec:** `docs/superpowers/specs/2026-09-22-screen-media-design.md` — this wave implements §5
(all subsections), the server side of §7.7, and the §10 load-bearing tests for §5. Read the plan
index first: `docs/superpowers/plans/2026-09-22-screen-media-00-index.md`. Its "Cross-wave
contract" fixes `screenTiers.ts`, `screenProfile.ts`, `screenOptOut.ts`, the trait and signal
columns and the routes this wave owns.

**Issue:** #96. **Branch:** `feat/screen-media`.

**Preconditions (waves 2, 4, 5 have landed).** Before Task 1, confirm each of these with `grep`.
If any is missing, stop and report; do not recreate another wave's work.

- `lib/server/models.ts` exports `modelFor`; `profileModel()` still exists in `profileBuild.ts`.
- `lib/server/profileBuild.ts`:
  - `persistProposedTraits(db, userId, traits, validIds, kind, runStartedAt, observedRebuildReason = null)`
    and `markProfiled(tx, kind, userId, runStartedAt, observedRebuildReason = null)` exist.
  - `extractTasteProfile` begins with `const runStartedAt = utcnowTs();` and
    `const observedRebuildReason = await readRebuildReason(db, userId);`.
- `lib/server/profileUpdate.ts`:
  - `updateTasteProfile` begins with `const runStartedAt = utcnowTs();`.
  - It escalates with `if (meta.rebuildReason !== null) { return extractTasteProfile(…) }`.
- `lib/server/profileMeta.ts` exports `setRebuildReason`, `readRebuildReason`, `type RebuildReason`.
- `app/api/profile/status/route.ts` returns `rebuild_reason`.
- `lib/server/schema.ts` has these tables and columns:
  - tables `titles`, `titleEnrichment`, `titleRecommendations`;
  - `userSettings.screenEnabled` and `.screenToggledAt`;
  - `tasteTraits.exhibitTitleIds` and `.contrastTitleIds`;
  - `tasteSignal.targetTitleId`.
- `lib/server/__tests__/helpers/pglite.ts` creates those tables and columns.
- `lib/server/titles.ts` exports `TitleRow`, `TitleEnrichmentRow`, `effectiveTitleRating`,
  `effectiveTitleReview` and `isTitleProfileEvidence`.
- `lib/server/screenSettings.ts` exports `isScreenEnabled`, `requireScreenEnabled`,
  `readScreenToggledAt`, `setScreenEnabled` and `SCREEN_DISABLED_MESSAGE`.
- `app/api/settings/screen/route.ts` exists with `GET` and `PUT`.

```bash
grep -n "export function modelFor" lib/server/models.ts
grep -n "observedRebuildReason" lib/server/profileBuild.ts
grep -n "rebuildReason !== null" lib/server/profileUpdate.ts
grep -n "export async function setRebuildReason\|export async function readRebuildReason" lib/server/profileMeta.ts
grep -n "exhibitTitleIds\|targetTitleId\|screenToggledAt\|export const titles\b\|export const titleEnrichment\|export const titleRecommendations" lib/server/schema.ts
grep -n "exhibit_title_ids\|target_title_id\|screen_toggled_at\|create table titles\|create table title_enrichment\|create table title_recommendations\|rebuild_reason" lib/server/__tests__/helpers/pglite.ts
grep -n "export" lib/server/titles.ts lib/server/screenSettings.ts
ls app/api/settings/screen/route.ts
```

---

## Global Constraints

Every task's requirements implicitly include this section. Copied from the plan index; the
first block is wave-specific.

**Wave 6 specific**

- **Books-only byte identity (spec §5.1) is the top risk.** When screen is disabled, or enabled
  with no eligible title, these must be byte-identical to today's:
  - the full and update prompts;
  - both system prompts (`PROFILE_SYSTEM`, `REVISE_SYSTEM`);
  - both tool definitions (`PROFILE_TOOL`, `REVISE_TOOL`);
  - `tool_choice`, `model` and `max_tokens`.

  Task 1 records a golden **before any code changes** and every later task must keep it green.
  **Never re-record the golden after Task 1.** If it goes red, the code is wrong.
- **Do not edit `buildProfilePrompt`, `buildUpdatePrompt`, `PROFILE_SYSTEM`, `REVISE_SYSTEM`,
  `TRAIT_INPUT_SCHEMA`, `PROFILE_TOOL`, `REVISE_TOOL` or `bookPayload`.** The screen variant has
  its own copies in `lib/server/screenProfilePrompts.ts`.
- **`db.ts` uses `max: 1`.** Never touch `db` inside an open transaction (use the `tx`), and
  never make a Claude call inside a transaction. Reads first, Claude call, then one write
  transaction.
- **Operation names stay `profile_full` / `profile_update`** for both variants (usage reporting).
- **Book ids and title ids are separate namespaces.** Title ids are validated only against
  titles actually transmitted in that prompt (spec §5.4), and only eligible titles may be cited.

**From the index (every wave)**

- **Two test runners with disjoint ownership.** `npm run test:server` (Vitest) owns exactly
  `lib/server/**` and `app/api/**`; `npm test` (Jest) owns everything else. Before naming a single
  test file as a gate, confirm the runner sees it: `npx vitest list <path>`. A gate that matches
  zero tests exits 0.
- **Full gate at the end of the wave**, from the repository root: `npm run test:server`,
  `npm test`, `npm run type-check`, `npm run lint`, `npm run format:check`, `npm run build`.
- **Real-flow verification before the wave is called done** (spec §10). Use an isolated local
  run, following the procedure in the project memory note `marketing-screenshot-pipeline`:
  - a scratch Postgres in Docker;
  - a local-mode dev server (`ALLOW_LOCAL_AUTH=true`);
  - **no `.env` file in scope**.

  Never point a verification run at the production database. Record what you actually observe,
  not what this plan predicts.
- **Secrets.** Never open, print, or name the contents of `.env*` files; check presence only.
- **Ratings.** `numeric(2,1)` with `mode: 'number'`. `0` on an API mutation means "clear".
- **Wire format.** API JSON is snake_case. Prompt payloads use `pyJsonDumps` over ordered `Map`s;
  never `JSON.stringify` a prompt payload.
- **Tenancy.** Every query on a user-owned table filters by `user_id`. Another user's ids answer
  404, never 403.
- **No schema change in this wave.** Wave 4 added every column this wave uses. If one is missing,
  stop and report.
- **Copy** says ScreenSprite; code says `screen`.
- **Git.** Work on `feat/screen-media`. Chase commits manually by default. A "Commit" step runs
  only when Chase has authorized commits for this execution session; otherwise stage the listed
  paths and leave them. Commit messages:
  - plain, with no `Co-Authored-By` trailer;
  - ending with the `Claude-Session:` line from the session's attribution instructions;
  - subject `feat(screen): … (#96)`.
- **Next.js here is not the Next.js you know.** Before writing route code, read the relevant
  guide in `node_modules/next/dist/docs/`.

---

## Review Focus

These are the inputs the spec implies but no happy-path test exercises, most likely first. Each
is pinned by a test in the task named.

1. **Screen off, or on with nothing eligible.** A user may have rated titles but ScreenSprite
   disabled, or have it enabled with only a watchlist. They expect today's book profile, byte for
   byte, with no favourite-film line leaking in. *(Task 1: golden cases (a) and (b); Task 7:
   case (c).)*
2. **ScreenSprite toggled while a build, archetype or reveal run is in flight.** The user expects
   the run to write nothing: no traits citing a medium they just removed, and no cleared
   `rebuild_reason`. *(Tasks 6, 7 and 10: a Claude stub flips `screen_toggled_at` mid-call.)*
3. **A cited title that stops being evidence.** Examples: moved to `want`, its rating cleared, or
   excluded. It must be visible in the update prompt with its current status, and no trait may
   keep citing it. *(Task 7.)*
4. **Evidence in the wrong namespace or not sent.** Examples: a title id in `exhibits`, a book id
   in `exhibit_titles`, or a title the volume cap left out. Such a trait must not be persisted as
   if it had evidence. *(Task 6.)*
5. **Opt-out with mixed evidence, and a repeated opt-out.**
   - A confirmed trait citing one book and one film is deleted.
   - A confirmed book-only trait survives.
   - Disabling an already-disabled ScreenSprite changes nothing. It must not bump
     `screen_toggled_at`, which would needlessly kill an in-flight run.

   *(Task 9.)*
6. **A 400-title library.** Exactly 300 titles are sent, and reviewed/dropped, favourite and
   extreme-rated titles are kept first. Totals report the uncapped counts. *(Task 2.)*

---

## Design decisions made in this plan

The spec left these open; each is fixed here and pinned by a test.

1. **Favourite titles get their own feedback line.** It reads "all-time favorite films and
   shows", after the favourite-books line, and appears only in the screen variant. That is how
   this plan reads spec §5.2 "join the favorites line". A separate line keeps the book line's
   bytes untouched.
2. **Title signal and favourite labels** render as `Arrival (2016 film)` /
   `Severance (2022 TV series)`; without a year, `Arrival (film)`.
3. **Only eligible titles may be cited.** The update prompt still *sends* changed ineligible
   titles (spec §5.5: "no longer evidence" must be visible), each with `rating` and `status`.
   Only eligible ones are valid citations.
4. **The update path escalates when titles changed but none is eligible.** This covers screen
   enabled but every title a want, unrated or excluded. `updateTasteProfile` runs a full
   (book-variant) rebuild.

   The status route reports those titles as changed. A no-op here would leave the profile dirty
   forever, and the book-variant incremental prompt cannot retract a stale title citation.
5. **The opt-out preview's "confirmed" count includes `edited` traits.** Both are user-locked
   claims the user would lose.
6. **A superseded run answers `409`** with `PROFILE_RUN_SUPERSEDED_MESSAGE` and writes nothing.
   The same message covers profile, archetype and reveal.
7. **Title-kind taste signals require ScreenSprite enabled** (403 otherwise). While disabled,
   no screen data enters any profile build (spec §3.1).
8. **The screen-variant result object** adds `variant: 'screen'`, `rated_titles` and
   `screen_tiers` (full), or `changed_titles` and `titles_sent` (update). Book-variant result
   objects are unchanged.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `lib/server/__tests__/profile-books-golden.test.ts` | Create | Byte-identity golden for the book variant (spec §5.1). |
| `lib/server/__tests__/fixtures/claude/profile-books-golden.json` | Create (recorded once) | The recorded book-variant request params. Prettier-ignored directory. |
| `lib/server/__tests__/helpers/screenProfileFixtures.ts` | Create | Test helpers: enable screen, insert titles/enrichment, a Claude stub that flips `screen_toggled_at`. |
| `lib/server/claudeErrors.ts` | Modify | `NO_RATED_EVIDENCE_MESSAGE`, `PROFILE_RUN_SUPERSEDED_MESSAGE`. |
| `lib/server/screenTiers.ts` | Create | SCREEN DATA: per-medium ordered tiers, title payload, volume cap, counts. |
| `lib/server/screenProfile.ts` | Create | `screenVariantActive`, `titlesChangedSince`, `assertScreenToggleUnchanged`. |
| `lib/server/profileFeedback.ts` | Modify | Opt-in title signals and favourite titles for the screen variant. |
| `lib/server/screenProfilePrompts.ts` | Create | Screen-variant system prompts, tools, full and update prompt builders. |
| `lib/server/profileBuild.ts` | Modify | `persistProposedTraits` options (title evidence, toggle guard); screen-variant full build; guard on the book path. |
| `lib/server/profileUpdate.ts` | Modify | Titles in change detection, screen-variant revise, escalation rules, guard. |
| `app/api/profile/status/route.ts` | Modify | `changed_titles`, `changed_title_ids`; titles dirty the profile. |
| `lib/server/traits.ts` | Modify | `exhibit_title_ids`, `contrast_title_ids` on the wire. |
| `lib/server/screenOptOut.ts` | Create | `previewScreenOptOut`, `disableScreen`. |
| `app/api/settings/screen/route.ts` | Modify | `PUT {enabled:false}` calls `disableScreen`. |
| `app/api/settings/screen/opt-out-preview/route.ts` | Create | `GET` → `{ traits, confirmed }`. |
| `lib/server/archetypeDerive.ts`, `lib/server/revealLines.ts` | Modify | Toggle guard inside their persisting transaction. |
| `app/api/taste-signal/route.ts` | Modify | `target_kind: 'title'` + `target_title_id`, ownership, mismatch 422s. |
| `lib/server/export.ts` | Modify only if wave 4 did not | `target_title_id` in exported signals. |
| Tests | Create | `screen-tiers`, `screen-profile`, `profile-feedback-titles`, `screen-profile-prompts`, `profile-build-screen`, `profile-update-screen`, `traits-out`, `screen-opt-out`, `screen-toggle-guard`, `export-title-signals` (all `lib/server/__tests__/`); `app/api/profile/status/route.test.ts`; `app/api/settings/screen/opt-out.test.ts`; `app/api/taste-signal/route.test.ts`. |

---

## Handoff batching

This plan is written for a controller session that dispatches one subagent per task. **Stop and
hand off after Task 4, and again after Task 7.** Keep the `.superpowers/sdd/` ledger current
after every task. The handoff is only cheap because the next session reconstructs state from
disk.

- **Batch A:** Tasks 1–4 (golden, tiers, change detection, feedback) → hand off
- **Batch B:** Tasks 5–7 (prompts, full build, update) → hand off
- **Batch C:** Tasks 8–12 (status and wire, opt-out, guards, signals, gate and real flow)

---

### Task 1: Record the books-only golden, then pin it

**Files:**
- Create: `lib/server/__tests__/helpers/screenProfileFixtures.ts`
- Create: `lib/server/__tests__/profile-books-golden.test.ts`
- Create (recorded): `lib/server/__tests__/fixtures/claude/profile-books-golden.json`

**Interfaces:**
- Consumes: `extractTasteProfile`, `updateTasteProfile` (as wave 2 left them), `loadSeed`,
  `makeTestDb`, `fakeClaude`, `setupTestEnv`, the wave 4 schema.
- Produces, relied on by Tasks 2–11:
  - `lib/server/__tests__/helpers/screenProfileFixtures.ts`:
    - `export const TOGGLED_AT = '2026-07-05 10:00:00'`
    - `export async function setScreen(db: Db, enabled: boolean, userId?: string, toggledAt?: string): Promise<void>`
    - `export async function insertTitle(db: Db, values: Partial<typeof schema.titles.$inferInsert> & { title: string }): Promise<number>`
    - `export async function insertTitleEnrichment(db: Db, titleId: number, values?: Partial<typeof schema.titleEnrichment.$inferInsert>): Promise<void>`
    - `export async function setLastProfiledAt(db: Db, at: string, userId?: string): Promise<void>`
    - `export interface ScreenLibraryIds { arrival: number; dune: number; severance: number; cats: number; tenet: number; old: number; excluded: number; otherUsers: number }`
    - `export async function seedScreenLibrary(db: Db): Promise<ScreenLibraryIds>`
    - `export function toggleFlippingClient(db: Db, response: ClaudeMessage, userId?: string): ClaudeClient & { calls: Record<string, unknown>[] }`
    - `export function toolResponse(name: string, input: Record<string, unknown>): ClaudeMessage`
  - The golden file `profile-books-golden.json` with keys `full` and `update`.

This task must run **before any other code change in this wave**. The golden records wave 2's
code as it stands.

- [ ] **Step 1: Write the fixtures helper**

Create `lib/server/__tests__/helpers/screenProfileFixtures.ts`:

```ts
import { eq } from 'drizzle-orm';
import { schema, type Db } from '../../db';
import type { ClaudeClient, ClaudeMessage } from '../../claude';

/** A fixed toggle stamp, so tests can compare `screen_toggled_at` exactly. */
export const TOGGLED_AT = '2026-07-05 10:00:00';

/** Upserts the user's settings row with the ScreenSprite flag and toggle stamp. */
export async function setScreen(
  db: Db,
  enabled: boolean,
  userId = 'local',
  toggledAt: string = TOGGLED_AT
): Promise<void> {
  const rows = await db
    .select({ id: schema.userSettings.id })
    .from(schema.userSettings)
    .where(eq(schema.userSettings.userId, userId));
  if (rows[0]) {
    await db
      .update(schema.userSettings)
      .set({ screenEnabled: enabled, screenToggledAt: toggledAt })
      .where(eq(schema.userSettings.id, rows[0].id));
  } else {
    await db
      .insert(schema.userSettings)
      .values({ userId, screenEnabled: enabled, screenToggledAt: toggledAt });
  }
}

type TitleInsert = typeof schema.titles.$inferInsert;
type TitleEnrichmentInsert = typeof schema.titleEnrichment.$inferInsert;

/** Inserts one title (defaults: local user, watched movie from 2016) and returns its id. */
export async function insertTitle(
  db: Db,
  values: Partial<TitleInsert> & { title: string }
): Promise<number> {
  const [row] = await db
    .insert(schema.titles)
    .values({ userId: 'local', mediaType: 'movie', status: 'watched', year: 2016, ...values })
    .returning({ id: schema.titles.id });
  return row.id;
}

/**
 * Inserts a title_enrichment row. resolvedAt defaults to BEFORE the seed's last_profiled_at
 * (2026-07-01 12:00), so an enrichment row alone never makes a title "changed" unless a test
 * says so.
 */
export async function insertTitleEnrichment(
  db: Db,
  titleId: number,
  values: Partial<TitleEnrichmentInsert> = {}
): Promise<void> {
  await db.insert(schema.titleEnrichment).values({
    titleId,
    resolutionConfidence: 1,
    confidenceLabel: 'HIGH',
    matchMethod: 'exact',
    identitySource: 'auto',
    resolvedAt: '2026-06-01 00:00:00',
    ...values,
  });
}

export async function setLastProfiledAt(db: Db, at: string, userId = 'local'): Promise<void> {
  await db
    .update(schema.profileMeta)
    .set({ lastProfiledAt: at })
    .where(eq(schema.profileMeta.userId, userId));
}

export interface ScreenLibraryIds {
  arrival: number;
  dune: number;
  severance: number;
  cats: number;
  tenet: number;
  old: number;
  excluded: number;
  otherUsers: number;
}

/**
 * A small screen library covering every eligibility case. No title carries feedback_updated_at,
 * so none counts as "changed" until a test stamps one.
 *   arrival   movie, watched, letterboxd 5, enriched (director, based_on)  -> tier 5
 *   dune      movie, watched, letterboxd 4 / app 4.5, app review           -> tier 4.5
 *   severance tv, watching, app 4, enriched (creator)                      -> tv tier 4
 *   cats      movie, dropped, unrated, letterboxd review                   -> dropped
 *   tenet     movie, want                                                  -> not evidence
 *   old       movie, watched, unrated                                      -> not evidence
 *   excluded  movie, watched, 5, exclude_from_profile                      -> not evidence
 *   otherUsers another tenant's 5-star film                                -> never visible
 */
export async function seedScreenLibrary(db: Db): Promise<ScreenLibraryIds> {
  const arrival = await insertTitle(db, {
    title: 'Arrival',
    year: 2016,
    letterboxdRating: 5,
    lastWatchedOn: '2024-03-01',
  });
  await insertTitleEnrichment(db, arrival, {
    genres: ['science fiction film', 'drama film'],
    directors: ['Denis Villeneuve'],
    basedOn: [{ qid: 'Q7621031', title: 'Story of Your Life', author: 'Ted Chiang' }],
  });
  const dune = await insertTitle(db, {
    title: 'Dune',
    year: 2021,
    letterboxdRating: 4,
    appRating: 4.5,
    appReview: 'Loved the sound.',
    lastWatchedOn: '2023-11-02',
  });
  await insertTitleEnrichment(db, dune, {
    genres: ['science fiction film'],
    directors: ['Denis Villeneuve'],
  });
  const severance = await insertTitle(db, {
    title: 'Severance',
    year: 2022,
    mediaType: 'tv',
    status: 'watching',
    appRating: 4,
  });
  await insertTitleEnrichment(db, severance, {
    genres: ['thriller television series'],
    creators: ['Dan Erickson'],
  });
  const cats = await insertTitle(db, {
    title: 'Cats',
    year: 2019,
    status: 'dropped',
    letterboxdReview: 'Walked out.',
  });
  const tenet = await insertTitle(db, { title: 'Tenet', year: 2020, status: 'want' });
  const old = await insertTitle(db, { title: 'Old', year: 2021 });
  const excluded = await insertTitle(db, {
    title: 'Excluded Film',
    year: 2010,
    letterboxdRating: 5,
    excludeFromProfile: true,
  });
  const otherUsers = await insertTitle(db, {
    userId: 'other',
    title: 'Other Tenant Film',
    year: 2015,
    letterboxdRating: 5,
  });
  return { arrival, dune, severance, cats, tenet, old, excluded, otherUsers };
}

export function toolResponse(name: string, input: Record<string, unknown>): ClaudeMessage {
  return {
    content: [{ type: 'tool_use', name, input }],
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

/**
 * A Claude stub that simulates the user toggling ScreenSprite WHILE the model is thinking:
 * every create() call re-stamps the user's screen_toggled_at, then returns `response`.
 * Used to prove that a superseded run writes nothing (spec §5.7).
 */
export function toggleFlippingClient(
  db: Db,
  response: ClaudeMessage,
  userId = 'local'
): ClaudeClient & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    messages: {
      async create(params: Record<string, unknown>) {
        calls.push(params);
        await db
          .update(schema.userSettings)
          .set({ screenToggledAt: '2026-09-01 00:00:00' })
          .where(eq(schema.userSettings.userId, userId));
        return response;
      },
    },
  };
}
```

- [ ] **Step 2: Write the golden test**

Create `lib/server/__tests__/profile-books-golden.test.ts`:

```ts
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
    expect(String(golden.update.system)).toContain("evolving taste profile");
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
});
```

- [ ] **Step 3: Confirm the runner sees the file**

Run: `npx vitest list lib/server/__tests__/profile-books-golden.test.ts`
Expected: 3 tests listed.

- [ ] **Step 4: Record the golden (once, from the unmodified code)**

First confirm nothing in this wave has touched the profile code yet:

Run: `git status --short lib/server/profileBuild.ts lib/server/profileUpdate.ts lib/server/profileFeedback.ts lib/server/profileTiers.ts`
Expected: no output. If any file shows as modified, stop. The golden must come from the
code as waves 2–5 left it.

Run: `WRITE_PROFILE_GOLDEN=1 npx vitest run lib/server/__tests__/profile-books-golden.test.ts`
Expected: PASS (3 tests). `lib/server/__tests__/fixtures/claude/profile-books-golden.json` now
exists.

Check what was recorded:

Run: `node -e "const g=require('./lib/server/__tests__/fixtures/claude/profile-books-golden.json');for(const k of ['full','update'])console.log(k,g[k].model,g[k].max_tokens,g[k].tools[0].name,g[k].messages[0].content.length)"`
Expected: `full claude-sonnet-5 3000 record_taste_traits <n>` and
`update claude-sonnet-5 3000 revise_taste_traits <n>`. Record the actual lengths in the ledger.

- [ ] **Step 5: Run it in compare mode**

Run: `npx vitest run lib/server/__tests__/profile-books-golden.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Mutation-test the golden (load-bearing, spec §10)**

In `lib/server/profileBuild.ts`, temporarily change `'You are a literary taste analyst.'` to
`'You are a literary taste analyzer.'` in `PROFILE_SYSTEM`.

Run: `npx vitest run lib/server/__tests__/profile-books-golden.test.ts`
Expected: FAIL on all three tests; the `full` comparison shows the one-word diff.

Revert, then temporarily change `pyJsonDumps(tiers)` in `buildProfilePrompt` to
`pyJsonDumps(tiers) + ' '`. Run again. Expected: FAIL. Revert both, re-run, and confirm PASS.
`git diff lib/server/profileBuild.ts` must be empty.

- [ ] **Step 7: Commit**

```bash
git add lib/server/__tests__/helpers/screenProfileFixtures.ts lib/server/__tests__/profile-books-golden.test.ts lib/server/__tests__/fixtures/claude/profile-books-golden.json
git commit -m "test(profile): pin books-only profile requests with a golden (#96)"
```

---

### Task 2: `screenTiers.ts`, the SCREEN DATA payload and its volume cap

**Files:**
- Create: `lib/server/screenTiers.ts`
- Test: `lib/server/__tests__/screen-tiers.test.ts`

**Interfaces:**
- Consumes: `tierFor`, `type Tiers` from `profileTiers.ts`; `TitleRow`, `TitleEnrichmentRow`,
  `effectiveTitleRating`, `effectiveTitleReview`, `isTitleProfileEvidence` from `titles.ts`.
- Produces, relied on by Tasks 5–7 and by wave 8's reveal flow only through the traits:
  - `export const SCREEN_TIER_KEYS: readonly ['5', '4.5', '4', '3.5', '3', '<=2', 'dropped', 'rejected']`
  - `export const SCREEN_MEDIA: readonly ['movie', 'tv']`
  - `export const SCREEN_TITLE_CAP = 300`, `export const SCREEN_REJECTED_CAP = 50`
  - `export type ScreenTiers = Map<string, Tiers>` (keys `movie`, `tv`)
  - `export type ScreenTierCounts = Map<string, Map<string, number>>`
  - `export interface ScreenTierBuild { tiers: ScreenTiers; sent: ScreenTierCounts; total: ScreenTierCounts }`
  - `export function titlePayload(row: TitleRow, enr: TitleEnrichmentRow | null): Record<string, unknown>`
  - `export function screenTierFor(row: TitleRow): string | null`
  - `export async function buildScreenTiersWithCounts(db: Db, userId: string): Promise<ScreenTierBuild>`
  - `export async function buildScreenTiers(db: Db, userId: string): Promise<ScreenTiers>` (contract name)
  - `export function sentTitleIds(tiers: ScreenTiers): Set<number>`

- [ ] **Step 1: Write the failing test**

Create `lib/server/__tests__/screen-tiers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers/pglite';
import { schema, type Db } from '../db';
import {
  buildScreenTiers,
  buildScreenTiersWithCounts,
  SCREEN_TIER_KEYS,
  sentTitleIds,
} from '../screenTiers';
import { seedScreenLibrary } from './helpers/screenProfileFixtures';

async function withDb(fn: (db: Db) => Promise<void>): Promise<void> {
  const { db, close } = await makeTestDb();
  try {
    await fn(db);
  } finally {
    await close();
  }
}

function ids(list: Record<string, unknown>[]): unknown[] {
  return list.map((p) => p.id);
}

describe('buildScreenTiers', () => {
  it('emits both media, each with the eight tiers in prompt order', async () => {
    await withDb(async (db) => {
      const tiers = await buildScreenTiers(db, 'local');
      expect([...tiers.keys()]).toEqual(['movie', 'tv']);
      for (const medium of tiers.values()) {
        expect([...medium.keys()]).toEqual([...SCREEN_TIER_KEYS]);
      }
    });
  });

  it('places only eligible titles, per medium, and never another tenant', async () => {
    await withDb(async (db) => {
      const t = await seedScreenLibrary(db);
      const tiers = await buildScreenTiers(db, 'local');
      const movie = tiers.get('movie')!;
      const tv = tiers.get('tv')!;
      expect(ids(movie.get('5')!)).toEqual([t.arrival]);
      expect(ids(movie.get('4.5')!)).toEqual([t.dune]); // app_rating wins over letterboxd
      expect(ids(movie.get('dropped')!)).toEqual([t.cats]); // dropped: evidence even unrated
      expect(ids(tv.get('4')!)).toEqual([t.severance]);
      const all = [...movie.values(), ...tv.values()].flat().map((p) => p.id);
      expect(all).not.toContain(t.tenet); // want
      expect(all).not.toContain(t.old); // watched, unrated
      expect(all).not.toContain(t.excluded); // exclude_from_profile
      expect(all).not.toContain(t.otherUsers); // tenancy
      expect(sentTitleIds(tiers)).toEqual(new Set([t.arrival, t.dune, t.cats, t.severance]));
    });
  });

  it('carries the payload fields in the spec §5.2 key order', async () => {
    await withDb(async (db) => {
      const t = await seedScreenLibrary(db);
      const tiers = await buildScreenTiers(db, 'local');
      const arrival = tiers.get('movie')!.get('5')![0];
      expect(Object.keys(arrival)).toEqual([
        'id',
        'type',
        'title',
        'year',
        'genres',
        'directors',
        'based_on',
        'watched_year',
      ]);
      expect(arrival).toEqual({
        id: t.arrival,
        type: 'movie',
        title: 'Arrival',
        year: 2016,
        genres: ['science fiction film', 'drama film'],
        directors: ['Denis Villeneuve'],
        based_on: ['Story of Your Life by Ted Chiang'],
        watched_year: 2024,
      });

      // TV carries creators, not directors.
      const severance = tiers.get('tv')!.get('4')![0];
      expect(Object.keys(severance)).toEqual([
        'id',
        'type',
        'title',
        'year',
        'genres',
        'creators',
        'based_on',
        'watched_year',
      ]);
      expect(severance.creators).toEqual(['Dan Erickson']);

      // review is appended only when present; the app review wins over Letterboxd's.
      const dune = tiers.get('movie')!.get('4.5')![0];
      expect(Object.keys(dune).at(-1)).toBe('review');
      expect(dune.review).toBe('Loved the sound.');
      const cats = tiers.get('movie')!.get('dropped')![0];
      expect(cats.review).toBe('Walked out.');
      expect(cats.genres).toEqual([]); // no enrichment row
      expect(cats.directors).toEqual([]);
    });
  });

  it('trims a review to 1000 characters and caps genres at 8', async () => {
    await withDb(async (db) => {
      const [row] = await db
        .insert(schema.titles)
        .values({
          userId: 'local',
          mediaType: 'movie',
          status: 'watched',
          title: 'Long',
          year: 2000,
          letterboxdRating: 3,
          letterboxdReview: `  ${'x'.repeat(1200)}  `,
        })
        .returning({ id: schema.titles.id });
      await db.insert(schema.titleEnrichment).values({
        titleId: row.id,
        resolutionConfidence: 1,
        confidenceLabel: 'HIGH',
        identitySource: 'auto',
        genres: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
      });
      const payload = (await buildScreenTiers(db, 'local')).get('movie')!.get('3')![0];
      expect(String(payload.review)).toHaveLength(1000);
      expect(payload.genres).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    });
  });

  it('adds rejected screen recommendations that carry a note, per medium', async () => {
    await withDb(async (db) => {
      const rec = (over: Partial<typeof schema.titleRecommendations.$inferInsert>) => ({
        userId: 'local',
        runId: 'r1',
        rank: 1,
        mediaType: 'movie',
        mediaFilter: 'both',
        title: 'X',
        score: 0.5,
        status: 'rejected',
        ...over,
      });
      await db.insert(schema.titleRecommendations).values([
        rec({ title: 'Solaris', year: 1972, userNote: 'Too slow.' }),
        rec({ title: 'No Note', year: 2001 }),
        rec({ title: 'Served', year: 2002, status: 'served', userNote: 'n/a' }),
        rec({ title: 'Lost', year: 2004, mediaType: 'tv', userNote: 'Never ends.' }),
        rec({ userId: 'other', title: 'Theirs', year: 2003, userNote: 'Not mine.' }),
      ]);
      const tiers = await buildScreenTiers(db, 'local');
      expect(tiers.get('movie')!.get('rejected')).toEqual([
        { title: 'Solaris', year: 1972, note: 'Too slow.' },
      ]);
      expect(tiers.get('tv')!.get('rejected')).toEqual([
        { title: 'Lost', year: 2004, note: 'Never ends.' },
      ]);
    });
  });
});

describe('volume cap (spec §5.3)', () => {
  it('sends 300 titles, keeping reviewed, favourite and extreme ones first', async () => {
    await withDb(async (db) => {
      const base = { userId: 'local', mediaType: 'movie', status: 'watched', year: 2000 };
      const values: (typeof schema.titles.$inferInsert)[] = [];
      for (let i = 0; i < 10; i++) {
        values.push({
          ...base,
          title: `Reviewed ${i}`,
          letterboxdRating: 4,
          letterboxdReview: 'Good.',
          lastWatchedOn: '2001-01-01',
        });
      }
      for (let i = 0; i < 5; i++) {
        values.push({
          ...base,
          title: `Favorite ${i}`,
          letterboxdRating: 3,
          isFavorite: true,
          lastWatchedOn: '2001-01-01',
        });
      }
      for (let i = 0; i < 5; i++) {
        values.push({ ...base, title: `Loved ${i}`, letterboxdRating: 5 }); // no date: nulls last
      }
      for (let i = 0; i < 290; i++) {
        const month = String(1 + Math.floor(i / 28)).padStart(2, '0');
        const day = String(1 + (i % 28)).padStart(2, '0');
        values.push({
          ...base,
          title: `Plain ${i}`,
          letterboxdRating: 3.5,
          lastWatchedOn: `2020-${month}-${day}`,
        });
      }
      await db.insert(schema.titles).values(values);

      const { tiers, sent, total } = await buildScreenTiersWithCounts(db, 'local');
      const movie = tiers.get('movie')!;
      const sentCount = [...movie.values()].reduce((n, list) => n + list.length, 0);
      expect(sentCount).toBe(300);

      expect(movie.get('4')!).toHaveLength(10); // every reviewed title
      expect(movie.get('3')!).toHaveLength(5); // every favourite
      expect(movie.get('5')!).toHaveLength(5); // every 5-star, despite no watch date
      expect(movie.get('3.5')!).toHaveLength(280);

      // The ten oldest plain titles are the ones cut (310 eligible - 300).
      const plainTitles = movie.get('3.5')!.map((p) => p.title);
      for (let i = 0; i < 10; i++) expect(plainTitles).not.toContain(`Plain ${i}`);
      expect(plainTitles).toContain('Plain 10');

      // Within a tier, payloads are in id order regardless of selection order.
      const plainIds = movie.get('3.5')!.map((p) => p.id as number);
      expect(plainIds).toEqual([...plainIds].sort((a, b) => a - b));

      expect(sent.get('movie')!.get('3.5')).toBe(280);
      expect(total.get('movie')!.get('3.5')).toBe(290);
      expect(total.get('movie')!.get('4')).toBe(10);
    });
  });

  it('sends the 50 most recent rejected recommendations, in id order', async () => {
    await withDb(async (db) => {
      const rows = Array.from({ length: 55 }, (_, i) => ({
        userId: 'local',
        runId: 'r1',
        rank: i + 1,
        mediaType: 'movie',
        mediaFilter: 'both',
        title: `Rejected ${i}`,
        score: 0.1,
        status: 'rejected',
        userNote: 'no',
      }));
      await db.insert(schema.titleRecommendations).values(rows);
      const { tiers, sent, total } = await buildScreenTiersWithCounts(db, 'local');
      const rejected = tiers.get('movie')!.get('rejected')!;
      expect(rejected).toHaveLength(50);
      expect(rejected[0].title).toBe('Rejected 5');
      expect(rejected.at(-1)!.title).toBe('Rejected 54');
      expect(sent.get('movie')!.get('rejected')).toBe(50);
      expect(total.get('movie')!.get('rejected')).toBe(55);
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest list lib/server/__tests__/screen-tiers.test.ts` (expect 7), then
`npx vitest run lib/server/__tests__/screen-tiers.test.ts`
Expected: FAIL — `Cannot find module '../screenTiers'`.

- [ ] **Step 3: Implement `screenTiers.ts`**

Create `lib/server/screenTiers.ts`:

```ts
/**
 * SCREEN DATA for the unified taste profile (spec 2026-09-22 §5.2–§5.3): the twin of
 * profileTiers.ts for films and TV, under the same rules. Every mapping is a Map (V8 would
 * reorder integer-like keys and change the prompt bytes), payload key order is fixed, and every
 * query whose rows reach the prompt carries an explicit ORDER BY.
 *
 * Tiers are separate per medium because rating habits differ between Goodreads and Letterboxd.
 */
import { and, asc, desc, eq, isNotNull } from 'drizzle-orm';
import { schema, type Db } from './db';
import { tierFor, type Tiers } from './profileTiers';
import {
  effectiveTitleRating,
  effectiveTitleReview,
  isTitleProfileEvidence,
  type TitleEnrichmentRow,
  type TitleRow,
} from './titles';

export const SCREEN_TIER_KEYS = ['5', '4.5', '4', '3.5', '3', '<=2', 'dropped', 'rejected'] as const;
export const SCREEN_MEDIA = ['movie', 'tv'] as const;
/** Hard cap on titles sent to the profile prompt (spec §5.3). No movie/TV quota. */
export const SCREEN_TITLE_CAP = 300;
/** Most recent rejected screen recommendations sent (spec §5.3). */
export const SCREEN_REJECTED_CAP = 50;
const REVIEW_MAX = 1000;
const GENRES_MAX = 8;

export type ScreenTiers = Map<string, Tiers>;
export type ScreenTierCounts = Map<string, Map<string, number>>;

export interface ScreenTierBuild {
  tiers: ScreenTiers;
  /** Per medium and tier: how many entries the prompt carries. */
  sent: ScreenTierCounts;
  /** Per medium and tier: how many exist before the volume cap. */
  total: ScreenTierCounts;
}

function emptyTiers(): Tiers {
  return new Map(SCREEN_TIER_KEYS.map((k) => [k, [] as Record<string, unknown>[]]));
}

function emptyCounts(): ScreenTierCounts {
  return new Map(SCREEN_MEDIA.map((m) => [m, new Map(SCREEN_TIER_KEYS.map((k) => [k, 0]))]));
}

function bump(counts: ScreenTierCounts, medium: string, tier: string): void {
  const byTier = counts.get(medium)!;
  byTier.set(tier, (byTier.get(tier) ?? 0) + 1);
}

function mediumOf(mediaType: string): 'movie' | 'tv' {
  return mediaType === 'tv' ? 'tv' : 'movie';
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function basedOnLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue;
    const { title, author } = item as { title?: unknown; author?: unknown };
    if (typeof title !== 'string' || !title) continue;
    out.push(typeof author === 'string' && author ? `${title} by ${author}` : title);
  }
  return out;
}

function reviewText(row: TitleRow): string | null {
  const review = effectiveTitleReview(row);
  if (review === null) return null;
  const trimmed = review.trim();
  return trimmed ? trimmed : null;
}

/**
 * Spec §5.2 per-title payload. Key order is load-bearing (it becomes prompt JSON): id, type,
 * title, year, genres, directors (films) or creators (TV), based_on, watched_year, and review
 * only when present.
 */
export function titlePayload(
  row: TitleRow,
  enr: TitleEnrichmentRow | null
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    id: row.id,
    type: row.mediaType,
    title: row.title,
    year: row.year,
    genres: enr ? strings(enr.genres).slice(0, GENRES_MAX) : [],
  };
  if (row.mediaType === 'tv') payload.creators = enr ? strings(enr.creators) : [];
  else payload.directors = enr ? strings(enr.directors) : [];
  payload.based_on = enr ? basedOnLabels(enr.basedOn) : [];
  payload.watched_year = row.lastWatchedOn ? Number(row.lastWatchedOn.slice(0, 4)) : null;
  const review = reviewText(row);
  if (review !== null) payload.review = review.slice(0, REVIEW_MAX);
  return payload;
}

/** The tier of an eligible title: `dropped` wins over any rating, as DNF does for books. */
export function screenTierFor(row: TitleRow): string | null {
  if (row.status === 'dropped') return 'dropped';
  const rating = effectiveTitleRating(row);
  return rating === null ? null : tierFor(rating);
}

/** Spec §5.3 priority groups: reviewed or dropped, then favourites, then 5 and <=2, then rest. */
function priorityGroup(row: TitleRow): number {
  if (row.status === 'dropped' || reviewText(row) !== null) return 0;
  if (row.isFavorite) return 1;
  const tier = screenTierFor(row);
  if (tier === '5' || tier === '<=2') return 2;
  return 3;
}

/** Group, then most recent last_watched_on (nulls last), then id. */
function capOrder(a: TitleRow, b: TitleRow): number {
  const byGroup = priorityGroup(a) - priorityGroup(b);
  if (byGroup !== 0) return byGroup;
  const da = a.lastWatchedOn;
  const dbDate = b.lastWatchedOn;
  if (da !== dbDate) {
    if (da === null) return 1;
    if (dbDate === null) return -1;
    return da < dbDate ? 1 : -1;
  }
  return a.id - b.id;
}

export async function buildScreenTiersWithCounts(
  db: Db,
  userId: string
): Promise<ScreenTierBuild> {
  const tiers: ScreenTiers = new Map(SCREEN_MEDIA.map((m) => [m, emptyTiers()]));
  const sent = emptyCounts();
  const total = emptyCounts();

  const rows = await db
    .select({ title: schema.titles, enrichment: schema.titleEnrichment })
    .from(schema.titles)
    .leftJoin(schema.titleEnrichment, eq(schema.titleEnrichment.titleId, schema.titles.id))
    .where(eq(schema.titles.userId, userId))
    .orderBy(asc(schema.titles.id));

  const eligible = rows.filter(
    ({ title }) => isTitleProfileEvidence(title) && screenTierFor(title) !== null
  );
  for (const { title } of eligible) bump(total, mediumOf(title.mediaType), screenTierFor(title)!);

  const selected = [...eligible]
    .sort((a, b) => capOrder(a.title, b.title))
    .slice(0, SCREEN_TITLE_CAP)
    .sort((a, b) => a.title.id - b.title.id);
  for (const { title, enrichment } of selected) {
    const medium = mediumOf(title.mediaType);
    const tier = screenTierFor(title)!;
    tiers.get(medium)!.get(tier)!.push(titlePayload(title, enrichment));
    bump(sent, medium, tier);
  }

  const rejected = await db
    .select({
      id: schema.titleRecommendations.id,
      mediaType: schema.titleRecommendations.mediaType,
      title: schema.titleRecommendations.title,
      year: schema.titleRecommendations.year,
      userNote: schema.titleRecommendations.userNote,
    })
    .from(schema.titleRecommendations)
    .where(
      and(
        eq(schema.titleRecommendations.userId, userId),
        eq(schema.titleRecommendations.status, 'rejected'),
        isNotNull(schema.titleRecommendations.userNote)
      )
    )
    .orderBy(desc(schema.titleRecommendations.id));
  for (const rec of rejected) bump(total, mediumOf(rec.mediaType), 'rejected');
  for (const rec of rejected.slice(0, SCREEN_REJECTED_CAP).reverse()) {
    const medium = mediumOf(rec.mediaType);
    tiers.get(medium)!.get('rejected')!.push({ title: rec.title, year: rec.year, note: rec.userNote });
    bump(sent, medium, 'rejected');
  }

  return { tiers, sent, total };
}

export async function buildScreenTiers(db: Db, userId: string): Promise<ScreenTiers> {
  return (await buildScreenTiersWithCounts(db, userId)).tiers;
}

/** Ids of the titles a build actually sent: the only title ids a full build may cite (§5.4). */
export function sentTitleIds(tiers: ScreenTiers): Set<number> {
  const out = new Set<number>();
  for (const medium of tiers.values()) {
    for (const [tier, list] of medium) {
      if (tier === 'rejected') continue;
      for (const payload of list) if (typeof payload.id === 'number') out.add(payload.id);
    }
  }
  return out;
}
```

If `tsc` reports that `titles.mediaType` is typed as a union rather than `string`, keep the
code; `mediumOf` accepts both.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/server/__tests__/screen-tiers.test.ts lib/server/__tests__/profile-books-golden.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/server/screenTiers.ts lib/server/__tests__/screen-tiers.test.ts
git commit -m "feat(screen): build per-medium screen tiers for the taste profile (#96)"
```

---

### Task 3: `screenProfile.ts`: variant choice, title change detection, toggle guard

**Files:**
- Modify: `lib/server/claudeErrors.ts`
- Create: `lib/server/screenProfile.ts`
- Test: `lib/server/__tests__/screen-profile.test.ts`

**Interfaces:**
- Consumes: `isScreenEnabled` (wave 4), `isTitleProfileEvidence`, `TitleRow`.
- Produces, relied on by Tasks 6–10 and wave 7 (`titlesChangedSince` feeds the screen rec gate):
  - `export const NO_RATED_EVIDENCE_MESSAGE` and `export const PROFILE_RUN_SUPERSEDED_MESSAGE`
    in `claudeErrors.ts`
  - `export async function screenVariantActive(db: Db, userId: string): Promise<boolean>`
  - `export async function titlesChangedSince(db: Db, since: string | null, userId: string): Promise<TitleRow[]>`
  - `export async function assertScreenToggleUnchanged(tx: Db, userId: string, expected: string | null): Promise<void>`
    — throws `ApiError(409, PROFILE_RUN_SUPERSEDED_MESSAGE)`. Typed `Db` because a drizzle
    transaction is passed the same way `markProfiled(tx: Db, …)` already accepts one.

- [ ] **Step 1: Write the failing test**

Create `lib/server/__tests__/screen-profile.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers/pglite';
import { type Db } from '../db';
import { ApiError } from '../errors';
import { PROFILE_RUN_SUPERSEDED_MESSAGE } from '../claudeErrors';
import {
  assertScreenToggleUnchanged,
  screenVariantActive,
  titlesChangedSince,
} from '../screenProfile';
import {
  insertTitle,
  insertTitleEnrichment,
  setScreen,
  TOGGLED_AT,
} from './helpers/screenProfileFixtures';

async function withDb(fn: (db: Db) => Promise<void>): Promise<void> {
  const { db, close } = await makeTestDb();
  try {
    await fn(db);
  } finally {
    await close();
  }
}

describe('screenVariantActive', () => {
  it('is false while ScreenSprite is disabled, even with eligible titles', async () => {
    await withDb(async (db) => {
      await setScreen(db, false);
      await insertTitle(db, { title: 'Arrival', letterboxdRating: 5 });
      expect(await screenVariantActive(db, 'local')).toBe(false);
    });
  });

  it('is false when enabled with no eligible title', async () => {
    await withDb(async (db) => {
      await setScreen(db, true);
      await insertTitle(db, { title: 'Tenet', status: 'want' });
      await insertTitle(db, { title: 'Old' }); // watched, unrated
      await insertTitle(db, { title: 'Hidden', letterboxdRating: 5, excludeFromProfile: true });
      expect(await screenVariantActive(db, 'local')).toBe(false);
    });
  });

  it('is true when enabled with a rated title or an unrated dropped one', async () => {
    await withDb(async (db) => {
      await setScreen(db, true);
      await insertTitle(db, { title: 'Cats', status: 'dropped' });
      expect(await screenVariantActive(db, 'local')).toBe(true);
    });
  });

  it("never counts another tenant's titles", async () => {
    await withDb(async (db) => {
      await setScreen(db, true);
      await insertTitle(db, { userId: 'other', title: 'Theirs', letterboxdRating: 5 });
      expect(await screenVariantActive(db, 'local')).toBe(false);
    });
  });
});

describe('titlesChangedSince (spec §5.5: no eligibility filter)', () => {
  it('returns titles whose feedback or enrichment moved after the cutoff, in id order', async () => {
    await withDb(async (db) => {
      const since = '2026-07-01 12:00:00';
      const rated = await insertTitle(db, {
        title: 'Rated',
        letterboxdRating: 4,
        feedbackUpdatedAt: '2026-07-02 00:00:00',
      });
      await insertTitle(db, {
        title: 'Before',
        letterboxdRating: 4,
        feedbackUpdatedAt: '2026-06-30 00:00:00',
      });
      const enriched = await insertTitle(db, { title: 'Enriched', letterboxdRating: 3 });
      await insertTitleEnrichment(db, enriched, { resolvedAt: '2026-07-03 00:00:00' });
      const stale = await insertTitle(db, { title: 'Stale enrichment', letterboxdRating: 3 });
      await insertTitleEnrichment(db, stale, { resolvedAt: '2026-06-03 00:00:00' });
      const want = await insertTitle(db, {
        title: 'Want',
        status: 'want',
        feedbackUpdatedAt: '2026-07-04 00:00:00',
      });
      await insertTitle(db, {
        userId: 'other',
        title: 'Theirs',
        feedbackUpdatedAt: '2026-07-05 00:00:00',
      });

      const changed = await titlesChangedSince(db, since, 'local');
      expect(changed.map((t) => t.id)).toEqual([rated, enriched, want]);
    });
  });

  it('treats a null cutoff as "every title with feedback or enrichment"', async () => {
    await withDb(async (db) => {
      const a = await insertTitle(db, { title: 'A', feedbackUpdatedAt: '2026-01-01 00:00:00' });
      const b = await insertTitle(db, { title: 'B' });
      await insertTitleEnrichment(db, b);
      await insertTitle(db, { title: 'C' });
      const changed = await titlesChangedSince(db, null, 'local');
      expect(changed.map((t) => t.id)).toEqual([a, b]);
    });
  });
});

describe('assertScreenToggleUnchanged', () => {
  it('passes when the stamp is unchanged, including a user with no settings row', async () => {
    await withDb(async (db) => {
      await expect(assertScreenToggleUnchanged(db, 'local', null)).resolves.toBeUndefined();
      await setScreen(db, true);
      await expect(assertScreenToggleUnchanged(db, 'local', TOGGLED_AT)).resolves.toBeUndefined();
    });
  });

  it('throws a 409 when ScreenSprite was toggled after the run began', async () => {
    await withDb(async (db) => {
      await setScreen(db, true);
      const err = await assertScreenToggleUnchanged(db, 'local', null).catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(409);
      expect((err as ApiError).message).toBe(PROFILE_RUN_SUPERSEDED_MESSAGE);
    });
  });
});
```

Check how `ApiError` exposes its status before relying on `.status`:
`sed -n 1,14p lib/server/errors.ts`. If the field has another name, use that name in both the
test and the implementation.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest list lib/server/__tests__/screen-profile.test.ts` (expect 8), then
`npx vitest run lib/server/__tests__/screen-profile.test.ts`
Expected: FAIL — `Cannot find module '../screenProfile'`.

- [ ] **Step 3: Add the two messages**

Append to `lib/server/claudeErrors.ts`:

```ts
/** The screen-variant profile guard (spec 2026-09-22 §5.2): either medium counts. */
export const NO_RATED_EVIDENCE_MESSAGE = 'No rated books or titles found. Rate something first.';

/**
 * A profile, archetype or reveal run whose screen_toggled_at changed mid-run (spec §5.7)
 * writes nothing and answers 409 with this message.
 */
export const PROFILE_RUN_SUPERSEDED_MESSAGE =
  'ScreenSprite was turned on or off while this was running, so nothing was saved. ' +
  'Run it again.';
```

- [ ] **Step 4: Implement `screenProfile.ts`**

Create `lib/server/screenProfile.ts`:

```ts
/**
 * Unified-profile plumbing shared by the builders, the status route and the screen
 * recommender (spec 2026-09-22 §5): which prompt variant runs, which titles changed, and the
 * screen_toggled_at guard that makes an opt-in/opt-out supersede an in-flight run.
 */
import { and, asc, eq, gt, isNotNull, or } from 'drizzle-orm';
import { schema, type Db } from './db';
import { ApiError } from './errors';
import { PROFILE_RUN_SUPERSEDED_MESSAGE } from './claudeErrors';
import { isScreenEnabled } from './screenSettings';
import { isTitleProfileEvidence, type TitleRow } from './titles';

/**
 * The screen variant runs only when ScreenSprite is enabled AND at least one title is profile
 * evidence (spec §5.1–§5.2). Otherwise the book variant runs, byte-identical to before.
 */
export async function screenVariantActive(db: Db, userId: string): Promise<boolean> {
  if (!(await isScreenEnabled(db, userId))) return false;
  const rows = await db.select().from(schema.titles).where(eq(schema.titles.userId, userId));
  return rows.some((row) => isTitleProfileEvidence(row));
}

/**
 * Titles changed since the last profile build (spec §5.5). Deliberately NOT filtered by
 * eligibility, unlike booksChangedSince: a title that stopped being evidence must reach the
 * model so the citation can be retracted. A title whose enrichment resolved after the cutoff
 * counts as changed. ORDER BY id keeps the prompt's changed-id list deterministic.
 */
export async function titlesChangedSince(
  db: Db,
  since: string | null,
  userId: string
): Promise<TitleRow[]> {
  const changed =
    since === null
      ? or(isNotNull(schema.titles.feedbackUpdatedAt), isNotNull(schema.titleEnrichment.id))
      : or(
          gt(schema.titles.feedbackUpdatedAt, since),
          gt(schema.titleEnrichment.resolvedAt, since)
        );
  const rows = await db
    .select({ title: schema.titles })
    .from(schema.titles)
    .leftJoin(schema.titleEnrichment, eq(schema.titleEnrichment.titleId, schema.titles.id))
    .where(and(eq(schema.titles.userId, userId), changed))
    .orderBy(asc(schema.titles.id));
  return rows.map((row) => row.title);
}

/**
 * Spec §5.7: profile, archetype and reveal writes compare screen_toggled_at INSIDE their
 * persisting transaction against the value read at run start. A mismatch throws, which rolls the
 * transaction back, so a superseded run writes nothing. Pass the transaction, never the outer db.
 */
export async function assertScreenToggleUnchanged(
  tx: Db,
  userId: string,
  expected: string | null
): Promise<void> {
  const rows = await tx
    .select({ toggledAt: schema.userSettings.screenToggledAt })
    .from(schema.userSettings)
    .where(eq(schema.userSettings.userId, userId));
  const actual = rows[0]?.toggledAt ?? null;
  if (actual !== expected) throw new ApiError(409, PROFILE_RUN_SUPERSEDED_MESSAGE);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run lib/server/__tests__/screen-profile.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/server/claudeErrors.ts lib/server/screenProfile.ts lib/server/__tests__/screen-profile.test.ts
git commit -m "feat(screen): detect changed titles and guard profile runs against toggles (#96)"
```

---

### Task 4: Title signals and favourite titles in the feedback context (screen variant only)

**Files:**
- Modify: `lib/server/profileFeedback.ts`
- Test: `lib/server/__tests__/profile-feedback-titles.test.ts`

**Interfaces:**
- Consumes: `schema.tasteSignal.targetTitleId`, `schema.titles`.
- Produces, relied on by Tasks 5–7:
  - `FeedbackContext` gains `favorite_titles?: string[]` (present only when titles were requested).
  - `export interface FeedbackOptions { titles?: boolean }`
  - `feedbackContext(db: Db, userId: string, opts?: FeedbackOptions): Promise<FeedbackContext>`
    — without `opts.titles` its output and queries are exactly today's.
  - `feedbackBlock` renders a favourite-films line only when `favorite_titles` is non-empty.

- [ ] **Step 1: Write the failing test**

Create `lib/server/__tests__/profile-feedback-titles.test.ts`:

```ts
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
```

Book 1 in `seed.json` is *Dune* by Frank Herbert. Confirm this before running:
`node -e "const s=require('./lib/server/__tests__/fixtures/seed.json');console.log(s.books[0].title,s.books[0].author)"`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest list lib/server/__tests__/profile-feedback-titles.test.ts` (expect 3), then
`npx vitest run lib/server/__tests__/profile-feedback-titles.test.ts`
Expected: FAIL — the second test gets no title labels and `favorite_titles` is undefined.

- [ ] **Step 3: Extend `profileFeedback.ts`**

In `lib/server/profileFeedback.ts`:

1. Extend the `FeedbackContext` interface with a trailing optional field:

```ts
  /**
   * Screen variant only (spec 2026-09-22 §5.2): the user's favourite films and shows. Absent
   * (not empty) in the book variant, so the book prompt stays byte-identical.
   */
  favorite_titles?: string[];
```

2. Add below the existing `label` helper:

```ts
export interface FeedbackOptions {
  /** Read title-targeted signals and favourite titles (screen variant only, spec §5.9). */
  titles?: boolean;
}

function titleLabel(t: { title: string; year: number | null; mediaType: string }): string {
  const kind = t.mediaType === 'tv' ? 'TV series' : 'film';
  return t.year !== null ? `${t.title} (${t.year} ${kind})` : `${t.title} (${kind})`;
}
```

3. Change the signature to
   `export async function feedbackContext(db: Db, userId: string, opts: FeedbackOptions = {}): Promise<FeedbackContext> {`
   and replace the block from `const signals = await db` through the end of the
   `for (const sig of signals)` loop with:

```ts
  const signals = await db
    .select({
      targetBookId: schema.tasteSignal.targetBookId,
      targetTitleId: schema.tasteSignal.targetTitleId,
      targetKind: schema.tasteSignal.targetKind,
      direction: schema.tasteSignal.direction,
    })
    .from(schema.tasteSignal)
    .where(
      and(
        eq(schema.tasteSignal.userId, userId),
        opts.titles
          ? inArray(schema.tasteSignal.targetKind, ['book', 'title'])
          : eq(schema.tasteSignal.targetKind, 'book')
      )
    )
    .orderBy(asc(schema.tasteSignal.id));

  // Python resolves each signal's book with its own userId-scoped query; batching
  // into one IN(...) is equivalent because the map is keyed by id and scoped the same.
  const bookIds = [
    ...new Set(
      signals
        .filter((s) => s.targetKind === 'book')
        .map((s) => s.targetBookId)
        .filter((id): id is number => id != null)
    ),
  ];
  const labels = new Map<number, string>();
  if (bookIds.length) {
    const books = await db
      .select({ id: schema.books.id, title: schema.books.title, author: schema.books.author })
      .from(schema.books)
      .where(and(eq(schema.books.userId, userId), inArray(schema.books.id, bookIds)));
    for (const b of books) labels.set(b.id, label(b.title, b.author));
  }

  // Screen variant only. Scoped by userId, so another tenant's title id resolves to nothing.
  const titleIds = [
    ...new Set(
      signals
        .filter((s) => s.targetKind === 'title')
        .map((s) => s.targetTitleId)
        .filter((id): id is number => id != null)
    ),
  ];
  const titleLabels = new Map<number, string>();
  if (titleIds.length) {
    const titles = await db
      .select({
        id: schema.titles.id,
        title: schema.titles.title,
        year: schema.titles.year,
        mediaType: schema.titles.mediaType,
      })
      .from(schema.titles)
      .where(and(eq(schema.titles.userId, userId), inArray(schema.titles.id, titleIds)));
    for (const t of titles) titleLabels.set(t.id, titleLabel(t));
  }

  const more_like: string[] = [];
  const less_like: string[] = [];
  for (const sig of signals) {
    const l =
      sig.targetKind === 'title'
        ? sig.targetTitleId != null
          ? titleLabels.get(sig.targetTitleId)
          : undefined
        : sig.targetBookId != null
          ? labels.get(sig.targetBookId)
          : undefined;
    if (l === undefined) continue;
    if (sig.direction === 'more') more_like.push(l);
    else if (sig.direction === 'less') less_like.push(l);
  }
```

4. Replace the final `return { … }` with:

```ts
  const context: FeedbackContext = {
    confirmed,
    edited,
    rejected,
    downweighted,
    more_like,
    less_like,
    favorites,
    directive_text,
  };
  if (opts.titles) {
    const favoriteTitles = await db
      .select({
        title: schema.titles.title,
        year: schema.titles.year,
        mediaType: schema.titles.mediaType,
      })
      .from(schema.titles)
      .where(and(eq(schema.titles.userId, userId), eq(schema.titles.isFavorite, true)))
      .orderBy(asc(schema.titles.id));
    context.favorite_titles = favoriteTitles.map(titleLabel);
  }
  return context;
```

5. In `feedbackBlock`, directly after the existing `if (feedback.favorites.length) { … }` block,
   add:

```ts
  if (feedback.favorite_titles?.length) {
    lines.push(
      "The following are the user's all-time favorite films and shows — weight these " +
        'as the strongest possible positive signal when deriving taste traits: ' +
        feedback.favorite_titles.join('; ')
    );
  }
```

If `tsc` rejects `titleLabel(t)` because `mediaType` is a narrower union than `string`, widen the
helper's parameter type to `{ title: string; year: number | null; mediaType: string | null }`.
Do not cast at the call site.

- [ ] **Step 4: Run the tests to verify they pass and the book path is unchanged**

Run: `npx vitest run lib/server/__tests__/profile-feedback-titles.test.ts lib/server/__tests__/profile-books-golden.test.ts lib/server/__tests__/profile-build.test.ts lib/server/__tests__/profile-update.test.ts`
Expected: PASS. The golden staying green proves the book variant's feedback block is
unchanged.

- [ ] **Step 5: Commit**

```bash
git add lib/server/profileFeedback.ts lib/server/__tests__/profile-feedback-titles.test.ts
git commit -m "feat(screen): read title signals and favourite titles in the screen profile (#96)"
```

**Handoff point (end of Batch A).** Update the ledger, then hand off.

---

### Task 5: Screen-variant prompts and tools

**Files:**
- Create: `lib/server/screenProfilePrompts.ts`
- Test: `lib/server/__tests__/screen-profile-prompts.test.ts`

**Interfaces:**
- Consumes: `pyJsonDumps`, `pyRepr` (`serialize.ts`); `feedbackBlock`, `FeedbackContext`;
  `Tiers`; `ScreenTierBuild`.
- Produces, relied on by Tasks 6–7:
  - `export const SCREEN_PROFILE_SYSTEM: string`, `export const SCREEN_REVISE_SYSTEM: string`
  - `export const SCREEN_TRAIT_INPUT_SCHEMA` (adds `exhibit_titles`, `contrast_titles`)
  - `export const SCREEN_PROFILE_TOOL` (name `record_taste_traits`),
    `export const SCREEN_REVISE_TOOL` (name `revise_taste_traits`)
  - `export function buildScreenProfilePrompt(tiers: Tiers, screen: ScreenTierBuild, feedback: FeedbackContext | null): string`
  - `export function buildScreenUpdatePrompt(currentTraits: Record<string, unknown>[], booksMeta: Map<string, Record<string, unknown>>, titlesMeta: Map<string, Record<string, unknown>>, changedIds: number[], changedTitleIds: number[], feedback: FeedbackContext | null): string`

This module must **not** import `profileBuild.ts` or `profileUpdate.ts`: both import it, and a
cycle would load a half-initialized module.

- [ ] **Step 1: Write the failing test**

Create `lib/server/__tests__/screen-profile-prompts.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  buildScreenProfilePrompt,
  buildScreenUpdatePrompt,
  SCREEN_PROFILE_SYSTEM,
  SCREEN_PROFILE_TOOL,
  SCREEN_REVISE_SYSTEM,
  SCREEN_REVISE_TOOL,
  SCREEN_TRAIT_INPUT_SCHEMA,
} from '../screenProfilePrompts';
import { PROFILE_SYSTEM, PROFILE_TOOL, TRAIT_INPUT_SCHEMA } from '../profileBuild';
import { REVISE_SYSTEM } from '../profileUpdate';
import { pyFloat } from '../serialize';
import type { ScreenTierBuild } from '../screenTiers';
import type { Tiers } from '../profileTiers';

const KEYS = ['5', '4.5', '4', '3.5', '3', '<=2', 'dropped', 'rejected'];

function counts(over: Record<string, number> = {}): Map<string, number> {
  return new Map(KEYS.map((k) => [k, over[k] ?? 0]));
}

function build(): ScreenTierBuild {
  const movie: Tiers = new Map(KEYS.map((k) => [k, [] as Record<string, unknown>[]]));
  movie.get('5')!.push({ id: 7, type: 'movie', title: 'Arrival', year: 2016 });
  const tv: Tiers = new Map(KEYS.map((k) => [k, [] as Record<string, unknown>[]]));
  return {
    tiers: new Map([
      ['movie', movie],
      ['tv', tv],
    ]),
    sent: new Map([
      ['movie', counts({ '5': 1 })],
      ['tv', counts()],
    ]),
    total: new Map([
      ['movie', counts({ '5': 4 })],
      ['tv', counts()],
    ]),
  };
}

const bookTiers: Tiers = new Map([
  ['5', [{ id: 1, title: 'Dune' }]],
  ['4.5', []],
  ['4', []],
  ['3.5', []],
  ['3', []],
  ['<=2', []],
  ['dnf', []],
  ['rejected', []],
]);

describe('screen tools', () => {
  it('keep the book tool names but add the title evidence fields', () => {
    expect(SCREEN_PROFILE_TOOL.name).toBe('record_taste_traits');
    expect(SCREEN_REVISE_TOOL.name).toBe('revise_taste_traits');
    const item = SCREEN_TRAIT_INPUT_SCHEMA.properties.traits.items;
    expect(item.required).toEqual([
      'claim',
      'polarity',
      'exhibits',
      'contrasts',
      'exhibit_titles',
      'contrast_titles',
      'inference_confidence',
    ]);
    expect(Object.keys(item.properties)).toEqual(item.required);
    expect(SCREEN_PROFILE_TOOL.input_schema).toBe(SCREEN_TRAIT_INPUT_SCHEMA);
    expect(SCREEN_REVISE_TOOL.input_schema).toBe(SCREEN_TRAIT_INPUT_SCHEMA);
  });

  it('never alias or mutate the book definitions', () => {
    expect(SCREEN_PROFILE_SYSTEM).not.toBe(PROFILE_SYSTEM);
    expect(SCREEN_REVISE_SYSTEM).not.toBe(REVISE_SYSTEM);
    expect(SCREEN_TRAIT_INPUT_SCHEMA).not.toBe(TRAIT_INPUT_SCHEMA);
    expect(PROFILE_TOOL.input_schema).toBe(TRAIT_INPUT_SCHEMA);
    expect(Object.keys(TRAIT_INPUT_SCHEMA.properties.traits.items.properties)).toEqual([
      'claim',
      'polarity',
      'exhibits',
      'contrasts',
      'inference_confidence',
    ]);
  });
});

describe('buildScreenProfilePrompt', () => {
  it('appends SCREEN DATA after LIBRARY DATA and before the feedback block', () => {
    const prompt = buildScreenProfilePrompt(bookTiers, build(), {
      confirmed: ['Locked claim.'],
      edited: [],
      rejected: [],
      downweighted: [],
      more_like: [],
      less_like: [],
      favorites: [],
      directive_text: null,
      favorite_titles: ['Arrival (2016 film)'],
    });
    const lib = prompt.indexOf('LIBRARY DATA (JSON):\n{"5": [{"id": 1, "title": "Dune"}]');
    const screen = prompt.indexOf(
      '\n\nSCREEN DATA (JSON):\n{"movie": {"5": [{"id": 7, "type": "movie", "title": "Arrival", "year": 2016}]'
    );
    const feedback = prompt.indexOf('\n\n## User Feedback\n');
    expect(lib).toBeGreaterThan(0);
    expect(screen).toBeGreaterThan(lib);
    expect(feedback).toBeGreaterThan(screen);
    expect(prompt).toContain('favorite films and shows');
  });

  it('states book tier sizes, and screen tier sizes as sent and in total', () => {
    const prompt = buildScreenProfilePrompt(bookTiers, build(), null);
    expect(prompt).toContain(
      "Book tier sizes: {'5': 1, '4.5': 0, '4': 0, '3.5': 0, '3': 0, '<=2': 0, 'dnf': 0, 'rejected': 0}."
    );
    expect(prompt).toContain(
      "Screen tier sizes as sent: {'movie': {'5': 1, '4.5': 0, '4': 0, '3.5': 0, '3': 0, '<=2': 0, 'dropped': 0, 'rejected': 0}, 'tv': {"
    );
    expect(prompt).toContain("Screen tier sizes in total, before the volume cap: {'movie': {'5': 4,");
    expect(prompt).toContain('record_taste_traits');
    expect(prompt).not.toContain('## User Feedback');
  });
});

describe('buildScreenUpdatePrompt', () => {
  it('renders both changed-id lists as Python list reprs and both maps in insertion order', () => {
    const titlesMeta = new Map<string, Record<string, unknown>>([
      ['9', { id: 9, title: 'Tenet', rating: null, status: 'want' }],
      ['7', { id: 7, title: 'Arrival', rating: 5, status: 'watched' }],
    ]);
    const prompt = buildScreenUpdatePrompt(
      [
        {
          id: 1,
          claim: 'A.',
          polarity: 'reward',
          inference_confidence: pyFloat(1),
          exhibits: [1],
          contrasts: [],
          exhibit_titles: [7],
          contrast_titles: [],
        },
      ],
      new Map([['1', { id: 1, title: 'Dune' }]]),
      titlesMeta,
      [2, 3],
      [9, 7],
      null
    );
    expect(prompt).toContain('CHANGED BOOK IDS (the edits driving this update): [2, 3]\n');
    expect(prompt).toContain('CHANGED TITLE IDS (the edits driving this update): [9, 7]\n\n');
    expect(prompt).toContain('"inference_confidence": 1.0');
    expect(prompt).toContain('"exhibit_titles": [7], "contrast_titles": []');
    expect(prompt).toContain(
      'TITLES (id -> metadata; the only titles you may cite) (JSON):\n{"9": {"id": 9'
    );
    expect(prompt.indexOf('"9": {')).toBeLessThan(prompt.indexOf('"7": {'));
    expect(prompt).toContain('revise_taste_traits');
  });
});
```

If `tsc` complains that `SCREEN_TRAIT_INPUT_SCHEMA.properties.traits.items.required` is not
typed as an array, keep the `as const`-free literal (below) and cast the read only in the test:
`const item = SCREEN_TRAIT_INPUT_SCHEMA.properties.traits.items as { required: string[]; properties: Record<string, unknown> };`.
Do the same for the `TRAIT_INPUT_SCHEMA` read.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest list lib/server/__tests__/screen-profile-prompts.test.ts` (expect 5), then
`npx vitest run lib/server/__tests__/screen-profile-prompts.test.ts`
Expected: FAIL — `Cannot find module '../screenProfilePrompts'`.

- [ ] **Step 3: Implement `screenProfilePrompts.ts`**

Create `lib/server/screenProfilePrompts.ts`:

```ts
/**
 * The screen variant of the taste-profile prompts and tools (spec 2026-09-22 §5.2, §5.4, §5.5).
 *
 * These are deliberate COPIES of profileBuild.ts / profileUpdate.ts's book prompts, edited for two
 * media. The book prompts are pinned byte-for-byte by profile-books-golden.test.ts and must never
 * be edited to serve the screen variant. Tool NAMES are shared (record_taste_traits,
 * revise_taste_traits), so toolInput and persistence treat both variants alike; the schemas
 * differ by the two title fields.
 *
 * Must not import profileBuild.ts or profileUpdate.ts: both import this module.
 */
import { feedbackBlock, type FeedbackContext } from './profileFeedback';
import type { Tiers } from './profileTiers';
import type { ScreenTierBuild } from './screenTiers';
import { pyJsonDumps, pyRepr } from './serialize';

const ID_ARRAY = { type: 'array', items: { type: 'integer' } };

export const SCREEN_TRAIT_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    traits: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: {
            type: 'string',
            description:
              'A specific, falsifiable claim about what drives this ' +
              "person's ratings, e.g. 'Rewards dense political " +
              "world-building over fast plotting.' Avoid generic " +
              'genre statements. When the evidence spans books and ' +
              'films or shows, phrase the claim medium-neutrally.',
          },
          polarity: {
            type: 'string',
            enum: ['reward', 'aversion'],
            description:
              "'reward' = trait associated with higher ratings; " +
              "'aversion' = trait shared by lower-rated items.",
          },
          exhibits: {
            ...ID_ARRAY,
            description:
              'Book ids (from LIBRARY DATA only) that EXHIBIT the trait: ' +
              "for a 'reward', the high-rated books showing it; for an " +
              "'aversion', the low-rated or DNF books showing it. May be " +
              'empty when the trait rests on films or shows alone.',
          },
          contrasts: {
            ...ID_ARRAY,
            description:
              'Book ids (from LIBRARY DATA only) that anchor the CONTRAST — ' +
              'the counter-examples that make the distinction sharp. May be empty.',
          },
          exhibit_titles: {
            ...ID_ARRAY,
            description:
              'Title ids (from SCREEN DATA only) of films and shows that ' +
              'EXHIBIT the trait, under the same polarity rule as ' +
              "`exhibits`: high-rated for a 'reward', low-rated or dropped " +
              "for an 'aversion'. May be empty when the trait rests on books " +
              'alone, but every trait needs at least one exhibit in ' +
              '`exhibits` or `exhibit_titles`.',
          },
          contrast_titles: {
            ...ID_ARRAY,
            description:
              'Title ids (from SCREEN DATA only) that anchor the CONTRAST. May be empty.',
          },
          inference_confidence: {
            type: 'number',
            description: '0..1 — how strongly the evidence supports the claim.',
          },
        },
        required: [
          'claim',
          'polarity',
          'exhibits',
          'contrasts',
          'exhibit_titles',
          'contrast_titles',
          'inference_confidence',
        ],
      },
    },
  },
  required: ['traits'],
};

export const SCREEN_PROFILE_TOOL = {
  name: 'record_taste_traits',
  description:
    "Record the taste traits inferred from the person's rated books, films and TV shows. " +
    'Each trait must distinguish rating tiers and cite the book ids and/or title ids that ' +
    'support it.',
  input_schema: SCREEN_TRAIT_INPUT_SCHEMA,
};

export const SCREEN_REVISE_TOOL = {
  name: 'revise_taste_traits',
  description:
    "Return the REVISED full taste-trait set after accounting for the person's " +
    'latest rating, review and watch-status changes. Keep traits that still hold (adjusting ' +
    'confidence or evidence as warranted), drop traits the new evidence contradicts, and add ' +
    'new traits the changes reveal. Cite only book ids and title ids present in the provided ' +
    'data, each in its own field.',
  input_schema: SCREEN_TRAIT_INPUT_SCHEMA,
};

export const SCREEN_PROFILE_SYSTEM =
  "You are a taste analyst. You infer what drives a specific person's ratings of books, " +
  'films and TV shows from their library metadata. You reason about CONTRAST between rating ' +
  'tiers, never asserting a trait without citing the books or titles that evidence it. You ' +
  'only cite book ids and title ids that appear in the provided data, each in its own field.';

export const SCREEN_REVISE_SYSTEM =
  "You are a taste analyst maintaining a person's evolving taste profile across books, films " +
  'and TV shows. You are given the profile you previously inferred plus the most recent ' +
  'rating, review and watch-status changes. You make the SMALLEST revision that honors the ' +
  'new evidence: keep what still holds, adjust confidence where the new data strengthens or ' +
  'weakens a claim, retire claims the new evidence contradicts, and add genuinely new traits. ' +
  "Review text is the person's own words — weight it above metadata inference. Cite only book " +
  'ids and title ids that appear in the provided data, each in its own field.';

function bookTierCounts(tiers: Tiers): Map<string, number> {
  return new Map([...tiers.entries()].map(([k, v]) => [k, v.length]));
}

/** Full-build prompt, screen variant: the book prompt's structure plus SCREEN DATA. */
export function buildScreenProfilePrompt(
  tiers: Tiers,
  screen: ScreenTierBuild,
  feedback: FeedbackContext | null
): string {
  return (
    "Below is a person's library in two media: books (LIBRARY DATA) and films and TV shows " +
    '(SCREEN DATA), each grouped by star rating and status. Books carry enriched metadata ' +
    '(subjects, year, length, series); films and shows carry genres, directors or creators, ' +
    'and the works they are based on. Most items have no review text, so reason mainly from ' +
    'metadata + the rating tiers — but where an item carries a `review` field, those are the ' +
    "person's own words: treat them as the strongest, most direct signal, above any metadata " +
    'inference.\n\n' +
    `Book tier sizes: ${pyRepr(bookTierCounts(tiers))}. ` +
    `Screen tier sizes as sent: ${pyRepr(screen.sent)}. ` +
    `Screen tier sizes in total, before the volume cap: ${pyRepr(screen.total)}. ` +
    "Note the heavy positive skew — 'loved it' has low discriminative power, so focus on what " +
    'is genuinely distinguishing.\n\n' +
    'Books are rated on Goodreads or in ShelfSprite and films and shows on Letterboxd, and ' +
    'rating habits differ between the two. Compare tiers within a medium; do not treat a ' +
    '4-star film and a 4-star book as equally loved.\n\n' +
    'The `dnf` book tier and the `dropped` screen tiers contain books the person abandoned ' +
    'before finishing and films or shows they stopped watching. Treat these as the strongest ' +
    'possible aversion signal, even stronger than 1-2 star ratings. Any `review` field on them ' +
    'is direct first-person evidence explaining why they quit.\n\n' +
    "Each medium's `rejected` tier contains items the person explicitly skipped when " +
    'recommended, with a note explaining why. These are direct first-person statements of ' +
    "aversion — treat each `note` as reliable testimony about what this person does NOT want, " +
    'and use them to sharpen aversion traits.\n\n' +
    "Infer the person's taste traits. Prioritize, in order:\n" +
    '  1. What separates the 5-star items from the 4-star items, within each medium?\n' +
    '  2. What do the lowest-rated items (<=2 and 3), DNF books, dropped titles, and rejected ' +
    "recommendations share? (these are 'aversion' traits)\n" +
    '  3. Cross-cutting rewards visible across the high tiers — including patterns that hold ' +
    'across books AND films or shows.\n\n' +
    'Evidence may span media: a trait may cite books, titles, or both. When its evidence spans ' +
    'both media, phrase the claim medium-neutrally ("stories", "worlds", "characters") rather ' +
    'than as a claim about novels or films alone.\n\n' +
    'For EACH trait, split the evidence into four fields. Book ids and title ids are separate ' +
    'namespaces: book ids come only from LIBRARY DATA and go only in `exhibits`/`contrasts`; ' +
    'title ids come only from SCREEN DATA and go only in `exhibit_titles`/`contrast_titles`.\n' +
    '  - `exhibits` and `exhibit_titles`: the books and titles that SHOW the trait. These MUST ' +
    "match the polarity — an aversion's exhibits are LOW-rated (or DNF, or dropped), a reward's " +
    "exhibits are HIGH-rated. Never put high-rated items in an aversion's exhibits, in either " +
    'medium.\n' +
    '  - `contrasts` and `contrast_titles`: the counter-examples that sharpen the distinction. ' +
    'May be empty.\n' +
    '  - Every trait needs at least one exhibit in `exhibits` or `exhibit_titles`.\n\n' +
    'Temporal context: The `read_year` field shows when each book was read (or added to the ' +
    'shelf) and `watched_year` when each film or show was last watched. Tastes evolve, so ' +
    'weight this accordingly:\n' +
    '  - Recent reads and watches (2020+) are the strongest signal of current preferences.\n' +
    '  - Mid-era ones (2015-2019) are relevant but may reflect a transitional period.\n' +
    '  - Older ones (pre-2015) may reflect a different life stage entirely — for example, a ' +
    "heavy YA phase in one's teens is not necessarily a current preference.\n" +
    '  - A title with no `watched_year` has no known watch date; do not treat it as old.\n' +
    '  - Lower `inference_confidence` for traits supported only by older items unless those ' +
    'same traits are echoed in more recent ones. If a trait is consistent across all eras, ' +
    'call it an enduring preference (and note that in the claim).\n' +
    '  IMPORTANT EXCEPTION — do NOT apply temporal discounting to traits rooted in values or ' +
    'representation (e.g. LGBTQ+ themes, feminist perspectives, racial or political identity ' +
    "in fiction). A person's core values rarely regress with age: the absence of such themes " +
    'in recent items more likely reflects what was available than a shift in preferences. If ' +
    'a value-based trait is consistent across any era of the library, treat it as enduring ' +
    'regardless of when those items were read or watched. Only downweight it if recent items ' +
    'actively contradict it.\n\n' +
    'Quality rules:\n' +
    '  - Use ONLY book ids from LIBRARY DATA and title ids from SCREEN DATA.\n' +
    '  - Make claims specific and falsifiable, not generic genre labels ("drama film" is not a ' +
    'trait).\n' +
    "  - Do NOT force an item into a trait it doesn't fit just to pad the evidence.\n" +
    "  - Keep traits DISTINCT — don't emit two traits describing the same pattern.\n" +
    '  - Distinguish genuine taste from mechanical rating drift (e.g. later books in a long ' +
    'series, or later films in a franchise, slipping a star is fatigue, not a standalone taste ' +
    'trait).\n' +
    '  - Lower your inference_confidence when a trait rests on very few items.\n' +
    '  - Aim for 6-12 traits. Record them with the record_taste_traits tool.\n\n' +
    'LIBRARY DATA (JSON):\n' +
    pyJsonDumps(tiers) +
    '\n\nSCREEN DATA (JSON):\n' +
    pyJsonDumps(screen.tiers) +
    feedbackBlock(feedback)
  );
}

/** Incremental prompt, screen variant: changed and cited books AND titles (spec §5.5). */
export function buildScreenUpdatePrompt(
  currentTraits: Record<string, unknown>[],
  booksMeta: Map<string, Record<string, unknown>>,
  titlesMeta: Map<string, Record<string, unknown>>,
  changedIds: number[],
  changedTitleIds: number[],
  feedback: FeedbackContext | null
): string {
  return (
    'The person has updated some ratings, reviews or watch statuses since this profile was ' +
    'last built. Revise the profile accordingly — do NOT re-derive it from scratch.\n\n' +
    'You are NOT given the whole library, only the items needed to reason about the change: ' +
    'the books and titles that changed, plus the books and titles the current traits already ' +
    'cite. Cite book ids only from the BOOKS map and title ids only from the TITLES map below; ' +
    'the two id namespaces are separate.\n\n' +
    'Each title carries its current `rating` and `status`. A title whose status is `want`, or ' +
    'that is `watched`/`watching` with no rating, is not evidence: remove it from every trait ' +
    'that cites it and do not cite it. A `dropped` title is aversion evidence even unrated.\n\n' +
    'How to revise:\n' +
    '  - Keep traits that still hold. Raise/lower `inference_confidence` if the new evidence ' +
    'strengthens or weakens them, and add/remove cited ids as fitting.\n' +
    '  - Drop a trait whose evidence the changes now contradict (e.g. the person re-rated its ' +
    'key exhibit, or a new review states the opposite).\n' +
    '  - Add new traits the changes reveal — especially anything stated outright in a review.\n' +
    '  - A new/edited `review` is direct testimony; prefer it over metadata guesses.\n' +
    '  - When a trait now spans books and titles, phrase it medium-neutrally.\n' +
    '  - Every trait needs at least one exhibit in `exhibits` or `exhibit_titles`.\n' +
    '  - Return the COMPLETE revised trait set (the unchanged traits too), 6-12 traits, via the ' +
    'revise_taste_traits tool.\n\n' +
    `CHANGED BOOK IDS (the edits driving this update): ${pyRepr(changedIds)}\n` +
    `CHANGED TITLE IDS (the edits driving this update): ${pyRepr(changedTitleIds)}\n\n` +
    'CURRENT TRAITS (JSON):\n' +
    pyJsonDumps(currentTraits) +
    '\n\nBOOKS (id -> metadata; the only books you may cite) (JSON):\n' +
    pyJsonDumps(booksMeta) +
    '\n\nTITLES (id -> metadata; the only titles you may cite) (JSON):\n' +
    pyJsonDumps(titlesMeta) +
    feedbackBlock(feedback)
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/server/__tests__/screen-profile-prompts.test.ts lib/server/__tests__/profile-books-golden.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/server/screenProfilePrompts.ts lib/server/__tests__/screen-profile-prompts.test.ts
git commit -m "feat(screen): add screen-variant taste profile prompts and tools (#96)"
```

---

### Task 6: Full build, screen variant and the guarded persist

**Files:**
- Modify: `lib/server/profileBuild.ts`
- Test: `lib/server/__tests__/profile-build-screen.test.ts`

**Interfaces:**
- Consumes:
  - Task 2: `buildScreenTiersWithCounts`, `sentTitleIds`.
  - Task 3: `screenVariantActive`, `assertScreenToggleUnchanged`.
  - Task 4: `feedbackContext(db, userId, { titles: true })`.
  - Task 5: the screen prompt and tool exports.
  - Wave 4: `readScreenToggledAt`.
- Produces, relied on by Task 7:
  - `export interface PersistOptions { validTitleIds?: Set<number>; expectedScreenToggledAt?: string | null }`
  - `persistProposedTraits(db, userId, traits, validIds, kind, runStartedAt, observedRebuildReason = null, opts: PersistOptions = {})`
  - `extractTasteProfile(db, client, userId, maxTokens)`: same signature. It picks the variant
    itself. Screen-variant results carry `variant: 'screen'`, `rated_titles` and `screen_tiers`.

- [ ] **Step 1: Write the failing test**

Create `lib/server/__tests__/profile-build-screen.test.ts`:

```ts
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

async function withScreen(fn: (db: Db, t: Awaited<ReturnType<typeof seedScreenLibrary>>) => Promise<void>) {
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
            trait({ claim: 'Avoids spectacle musicals.', polarity: 'aversion', exhibit_titles: [t.cats] }),
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
```

The book-variant guard test relies on `seed.json` giving the `local` user a `user_settings` row,
which it does (id 1). `toggleFlippingClient` updates that row's `screen_toggled_at` from `null`
to a timestamp.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest list lib/server/__tests__/profile-build-screen.test.ts` (expect 6), then
`npx vitest run lib/server/__tests__/profile-build-screen.test.ts`
Expected: FAIL. The book prompt is sent (no `SCREEN DATA`), `variant` is undefined, the
title-only user gets the no-rated-books 400, and both guard tests resolve instead of
rejecting.

- [ ] **Step 3: Extend `persistProposedTraits`**

In `lib/server/profileBuild.ts`, add these imports:

```ts
import { readScreenToggledAt } from './screenSettings';
import { assertScreenToggleUnchanged, screenVariantActive } from './screenProfile';
import { buildScreenTiersWithCounts, sentTitleIds, type ScreenTierBuild } from './screenTiers';
import {
  buildScreenProfilePrompt,
  SCREEN_PROFILE_SYSTEM,
  SCREEN_PROFILE_TOOL,
} from './screenProfilePrompts';
import { NO_RATED_BOOKS_MESSAGE, NO_RATED_EVIDENCE_MESSAGE } from './claudeErrors';
```

(Merge the `claudeErrors` import into the existing one rather than duplicating it.)

Add above `persistProposedTraits`:

```ts
export interface PersistOptions {
  /**
   * Screen variant only (spec 2026-09-22 §5.4): validate exhibit_titles/contrast_titles against
   * the titles this prompt actually carried, and drop a trait with no valid exhibit in either
   * medium. Absent for the book variant, whose persistence rules are untouched.
   */
  validTitleIds?: Set<number>;
  /**
   * screen_toggled_at as read at run start. When provided, the persisting transaction
   * re-reads it first and writes nothing (409) if it changed (spec §5.7).
   */
  expectedScreenToggledAt?: string | null;
}
```

Change the signature to add a trailing parameter after wave 2's `observedRebuildReason`:

```ts
export async function persistProposedTraits(
  db: Db,
  userId: string,
  traits: Record<string, unknown>[],
  validIds: Set<number>,
  kind: 'full' | 'update',
  runStartedAt: string,
  observedRebuildReason: string | null = null,
  opts: PersistOptions = {}
): Promise<number> {
```

and replace its transaction body (everything inside `db.transaction(async (tx) => { … })`) with:

```ts
    // Spec §5.7: a ScreenSprite toggle after this run began supersedes it. Checked first,
    // inside the transaction, so the throw rolls back every write below.
    if (opts.expectedScreenToggledAt !== undefined) {
      await assertScreenToggleUnchanged(tx, userId, opts.expectedScreenToggledAt);
    }

    await tx
      .delete(schema.tasteTraits)
      .where(and(eq(schema.tasteTraits.userId, userId), eq(schema.tasteTraits.status, 'proposed')));

    let n = 0;
    for (const t of traits) {
      const exhibits = asIdList(t.exhibits, validIds);
      const contrasts = asIdList(t.contrasts, validIds);
      const titleEvidence = opts.validTitleIds
        ? {
            exhibitTitleIds: asIdList(t.exhibit_titles, opts.validTitleIds),
            contrastTitleIds: asIdList(t.contrast_titles, opts.validTitleIds),
          }
        : null;
      // Screen variant only: a trait with no valid exhibit in either medium is dropped.
      if (titleEvidence && exhibits.length === 0 && titleEvidence.exhibitTitleIds.length === 0) {
        continue;
      }
      await tx.insert(schema.tasteTraits).values({
        userId,
        claim: String(t.claim ?? '').trim(),
        // Python's `t.get("polarity", "reward")` returns None on an explicit `null`
        // polarity, which would violate the NOT NULL column — Node's `?? 'reward'`
        // falls back instead. Deliberately safer, not a bug to reconcile with Python.
        polarity: String(t.polarity ?? 'reward'),
        exhibits,
        contrasts,
        ...(titleEvidence ?? {}),
        inferenceConfidence: Number(t.inference_confidence ?? 0.0),
        status: 'proposed',
      });
      n++;
    }
    await markProfiled(tx, kind, userId, runStartedAt, observedRebuildReason);
    return n;
```

- [ ] **Step 4: Route `extractTasteProfile` through the variant and guard the book path**

Replace `extractTasteProfile` with the following. The book branch is wave 2's body, unchanged
except for the two marked lines. If wave 2's body differs from this in anything other than those
two lines, keep wave 2's text and apply only the marked changes.

```ts
export async function extractTasteProfile(
  db: Db,
  client: ClaudeClient,
  userId: string,
  maxTokens: number = PROFILE_MAX_TOKENS
): Promise<Record<string, unknown>> {
  // Captured before the first read (spec §5.6): anything edited after this instant is not in
  // the prompt and must stay pending. The reason read here is the only one this build clears.
  const runStartedAt = utcnowTs();
  const observedRebuildReason = await readRebuildReason(db, userId);
  // [wave 6] Read at run start: a ScreenSprite toggle after this supersedes the run (§5.7).
  const screenToggledAt = await readScreenToggledAt(db, userId);
  // [wave 6] Screen variant when enabled with eligible titles; otherwise the book variant,
  // byte-identical to before (spec §5.1, pinned by profile-books-golden.test.ts).
  if (await screenVariantActive(db, userId)) {
    return extractScreenTasteProfile(db, client, userId, maxTokens, {
      runStartedAt,
      observedRebuildReason,
      screenToggledAt,
    });
  }

  const tiers = await buildTiers(db, userId);
  let totalRated = 0;
  for (const [k, v] of tiers) if (k !== 'rejected') totalRated += v.length;
  if (totalRated === 0) throw new ApiError(400, NO_RATED_BOOKS_MESSAGE);

  const feedback = await feedbackContext(db, userId);
  const prompt = buildProfilePrompt(tiers, feedback);
  const model = profileModel();

  const message = await trackedCreate(
    client,
    db,
    { userId, operation: 'profile_full' },
    {
      model,
      max_tokens: maxTokens,
      system: PROFILE_SYSTEM,
      tools: [PROFILE_TOOL],
      tool_choice: { type: 'tool', name: 'record_taste_traits' },
      messages: [{ role: 'user', content: prompt }],
    }
  );

  // Python breaks on the FIRST tool_use block regardless of its name.
  const input = toolInput(message, '');
  let traits = (Array.isArray(input?.traits) ? input.traits : []) as Record<string, unknown>[];

  traits = removeRejectedClaims(traits, feedback.rejected);
  traits = removeRejectedClaims(traits, [...feedback.confirmed, ...feedback.edited]);

  const validIds = new Set<number>();
  for (const [, list] of tiers) {
    for (const b of list) {
      if (typeof b.id === 'number') validIds.add(b.id);
    }
  }

  const saved = await persistProposedTraits(
    db,
    userId,
    traits,
    validIds,
    'full',
    runStartedAt,
    observedRebuildReason,
    { expectedScreenToggledAt: screenToggledAt } // [wave 6]
  );

  // Deliberately a plain object, not a Map: this becomes the `tiers` field of the
  // HTTP response body via JSON.stringify, and V8 emits key order 3,4,5,<=2,dnf,
  // rejected instead of Python's dict-literal insertion order 5,4,3,<=2,dnf,rejected.
  // Every consumer reads this JSON by key, never by position, so the deviation is
  // harmless — unlike the Claude PROMPT payloads above (`tiers`, `booksMeta`), where
  // key order is semantically significant and a Map is mandatory.
  const tierCounts: Record<string, number> = {};
  for (const [k, v] of tiers) tierCounts[k] = v.length;

  return {
    mode: 'full',
    rated_books: totalRated,
    tiers: tierCounts,
    traits_saved: saved,
    model,
  };
}

interface ScreenRunContext {
  runStartedAt: string;
  observedRebuildReason: string | null;
  screenToggledAt: string | null;
}

function screenCountsOut(build: ScreenTierBuild): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [medium, tiers] of build.tiers) {
    out[medium] = {};
    for (const [k, v] of tiers) out[medium][k] = v.length;
  }
  return out;
}

/**
 * The screen variant of the full build (spec 2026-09-22 §5.2–§5.4). Same shape as the book
 * build: reads first, one Claude call with no transaction open, then one guarded write
 * transaction. Title ids are valid only if this prompt actually sent them.
 */
async function extractScreenTasteProfile(
  db: Db,
  client: ClaudeClient,
  userId: string,
  maxTokens: number,
  run: ScreenRunContext
): Promise<Record<string, unknown>> {
  const tiers = await buildTiers(db, userId);
  const screen = await buildScreenTiersWithCounts(db, userId);

  let ratedBooks = 0;
  for (const [k, v] of tiers) if (k !== 'rejected') ratedBooks += v.length;
  let ratedTitles = 0;
  for (const medium of screen.tiers.values()) {
    for (const [k, v] of medium) if (k !== 'rejected') ratedTitles += v.length;
  }
  if (ratedBooks + ratedTitles === 0) throw new ApiError(400, NO_RATED_EVIDENCE_MESSAGE);

  const feedback = await feedbackContext(db, userId, { titles: true });
  const prompt = buildScreenProfilePrompt(tiers, screen, feedback);
  const model = profileModel();

  const message = await trackedCreate(
    client,
    db,
    { userId, operation: 'profile_full' },
    {
      model,
      max_tokens: maxTokens,
      system: SCREEN_PROFILE_SYSTEM,
      tools: [SCREEN_PROFILE_TOOL],
      tool_choice: { type: 'tool', name: 'record_taste_traits' },
      messages: [{ role: 'user', content: prompt }],
    }
  );

  const input = toolInput(message, '');
  let traits = (Array.isArray(input?.traits) ? input.traits : []) as Record<string, unknown>[];
  traits = removeRejectedClaims(traits, feedback.rejected);
  traits = removeRejectedClaims(traits, [...feedback.confirmed, ...feedback.edited]);

  const validIds = new Set<number>();
  for (const [, list] of tiers) {
    for (const b of list) if (typeof b.id === 'number') validIds.add(b.id);
  }

  const saved = await persistProposedTraits(
    db,
    userId,
    traits,
    validIds,
    'full',
    run.runStartedAt,
    run.observedRebuildReason,
    { validTitleIds: sentTitleIds(screen.tiers), expectedScreenToggledAt: run.screenToggledAt }
  );

  const tierCounts: Record<string, number> = {};
  for (const [k, v] of tiers) tierCounts[k] = v.length;

  return {
    mode: 'full',
    variant: 'screen',
    rated_books: ratedBooks,
    rated_titles: ratedTitles,
    tiers: tierCounts,
    screen_tiers: screenCountsOut(screen),
    traits_saved: saved,
    model,
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run lib/server/__tests__/profile-build-screen.test.ts lib/server/__tests__/profile-books-golden.test.ts lib/server/__tests__/profile-build.test.ts lib/server/__tests__/profile-update.test.ts lib/server/__tests__/profile-run-boundary.test.ts`
Expected: PASS. The golden and the wave 2 run-boundary tests stay green.

- [ ] **Step 6: Mutation-test the guard and the variant switch (load-bearing, spec §10)**

1. Comment out the `assertScreenToggleUnchanged` call in `persistProposedTraits`.
   Run: `npx vitest run lib/server/__tests__/profile-build-screen.test.ts`
   Expected: FAIL on both guard tests. Revert.
2. In `screenProfile.ts`, temporarily make `screenVariantActive` return
   `isScreenEnabled(db, userId)` (drop the eligibility check).
   Run: `npx vitest run lib/server/__tests__/profile-books-golden.test.ts`
   Expected: FAIL on "enabled but no title is eligible". Revert.
3. Replace `sentTitleIds(screen.tiers)` with
   `new Set((await db.select({ id: schema.titles.id }).from(schema.titles)).map((r) => r.id))`
   (every title of every user).
   Run: `npx vitest run lib/server/__tests__/profile-build-screen.test.ts`
   Expected: FAIL on "validated against the titles actually sent". Revert.

After each revert, re-run and confirm PASS. `git diff lib/server/screenProfile.ts` must be
empty.

- [ ] **Step 7: Commit**

```bash
git add lib/server/profileBuild.ts lib/server/__tests__/profile-build-screen.test.ts
git commit -m "feat(screen): build the unified taste profile from books and titles (#96)"
```

---

### Task 7: Incremental update, screen variant

**Files:**
- Modify: `lib/server/profileUpdate.ts`
- Modify: `lib/server/__tests__/profile-books-golden.test.ts` (add case (c))
- Test: `lib/server/__tests__/profile-update-screen.test.ts`

**Interfaces:**
- Consumes:
  - Task 2: `titlePayload`.
  - Task 3: `screenVariantActive`, `titlesChangedSince`.
  - Task 5: `buildScreenUpdatePrompt`, `SCREEN_REVISE_SYSTEM`, `SCREEN_REVISE_TOOL`.
  - Task 6: `persistProposedTraits` with `PersistOptions`.
  - Wave 4: `isScreenEnabled`, `readScreenToggledAt`, `effectiveTitleRating`,
    `isTitleProfileEvidence`.
- Produces:
  - `export interface ScreenUpdateInputs extends UpdateInputs { titlesMeta: Map<string, Record<string, unknown>>; changedTitleIds: number[]; validTitleIds: Set<number> }`
  - `export async function collectScreenUpdateInputs(db: Db, userId: string, since: string | null): Promise<ScreenUpdateInputs>`
  - `updateTasteProfile`: same signature. Screen results carry `variant: 'screen'`,
    `changed_titles` and `titles_sent`.

The escalation table after this task (the first matching row wins):

| Condition | Outcome |
|---|---|
| no proposed traits, or never profiled | full build (picks its own variant) |
| `rebuild_reason` set (wave 2) | full build |
| `enrichment_corrected_at` after last build | full build |
| screen enabled, titles changed, variant **not** active | full build (book variant) |
| no changed book ids and no changed title ids, nothing changed, no feedback | "already up to date" |
| no changed book ids and no changed title ids, no feedback | full build (exclusion-only changes) |
| otherwise | incremental update in the active variant |

- [ ] **Step 1: Write the failing test**

Create `lib/server/__tests__/profile-update-screen.test.ts`:

```ts
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

async function stamp(db: Db, titleId: number, values: Partial<typeof schema.titles.$inferInsert> = {}) {
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
        .where(and(eq(schema.tasteTraits.userId, 'local'), eq(schema.tasteTraits.status, 'proposed')));
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
```

Add case (c) to `lib/server/__tests__/profile-books-golden.test.ts`, inside the `describe`, after
the third `it`:

```ts
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
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest list lib/server/__tests__/profile-update-screen.test.ts` (expect 6), then
`npx vitest run lib/server/__tests__/profile-update-screen.test.ts lib/server/__tests__/profile-books-golden.test.ts`
Expected: FAIL.
- The book revise tool and prompt are sent.
- Title-only changes read as "already up to date".
- Case (c) returns the update golden instead of the full one.

- [ ] **Step 3: Implement `collectScreenUpdateInputs`**

In `lib/server/profileUpdate.ts`, add these imports:

```ts
import { readScreenToggledAt, isScreenEnabled } from './screenSettings';
import { screenVariantActive, titlesChangedSince } from './screenProfile';
import { titlePayload } from './screenTiers';
import { effectiveTitleRating, isTitleProfileEvidence } from './titles';
import {
  buildScreenUpdatePrompt,
  SCREEN_REVISE_SYSTEM,
  SCREEN_REVISE_TOOL,
} from './screenProfilePrompts';
```

Add after `collectUpdateInputs`:

```ts
export interface ScreenUpdateInputs extends UpdateInputs {
  titlesMeta: Map<string, Record<string, unknown>>;
  changedTitleIds: number[];
  /** Only these title ids may be cited: sent in titlesMeta AND still profile evidence. */
  validTitleIds: Set<number>;
}

/**
 * The screen variant's incremental payloads (spec 2026-09-22 §5.5): the book inputs, the current
 * traits with their title citations, and a TITLES map of changed + already-cited titles with
 * their current rating and status. A changed title that is no longer evidence is still SENT, so
 * the model can see the retraction, but it is not a valid citation. Excluded titles are neither
 * sent nor citable.
 */
export async function collectScreenUpdateInputs(
  db: Db,
  userId: string,
  since: string | null
): Promise<ScreenUpdateInputs> {
  const base = await collectUpdateInputs(db, userId, since);

  const refs = await db
    .select({
      id: schema.tasteTraits.id,
      exhibitTitleIds: schema.tasteTraits.exhibitTitleIds,
      contrastTitleIds: schema.tasteTraits.contrastTitleIds,
    })
    .from(schema.tasteTraits)
    .where(and(eq(schema.tasteTraits.userId, userId), eq(schema.tasteTraits.status, 'proposed')))
    .orderBy(asc(schema.tasteTraits.id));
  const refsById = new Map(refs.map((r) => [r.id, r]));
  const currentTraits = base.currentTraits.map((t) => {
    const r = refsById.get(t.id as number);
    return {
      ...t,
      exhibit_titles: (r?.exhibitTitleIds as number[] | null) ?? [],
      contrast_titles: (r?.contrastTitleIds as number[] | null) ?? [],
    };
  });

  const changed = await titlesChangedSince(db, since, userId);
  const changedTitleIds = changed.filter((t) => !t.excludeFromProfile).map((t) => t.id);

  const cited = new Set<number>();
  for (const r of refs) {
    for (const i of (r.exhibitTitleIds as number[] | null) ?? []) cited.add(i);
    for (const i of (r.contrastTitleIds as number[] | null) ?? []) cited.add(i);
  }
  const wantedIds = [...new Set([...cited, ...changedTitleIds])];

  const titlesMeta = new Map<string, Record<string, unknown>>();
  const validTitleIds = new Set<number>();
  if (wantedIds.length) {
    const rows = await db
      .select({ title: schema.titles, enrichment: schema.titleEnrichment })
      .from(schema.titles)
      .leftJoin(schema.titleEnrichment, eq(schema.titleEnrichment.titleId, schema.titles.id))
      .where(
        and(
          eq(schema.titles.userId, userId),
          inArray(schema.titles.id, wantedIds),
          eq(schema.titles.excludeFromProfile, false)
        )
      )
      .orderBy(asc(schema.titles.id));
    for (const { title, enrichment } of rows) {
      const payload = titlePayload(title, enrichment);
      payload.rating = effectiveTitleRating(title);
      payload.status = title.status;
      titlesMeta.set(String(title.id), payload);
      if (isTitleProfileEvidence(title)) validTitleIds.add(title.id);
    }
  }

  return { ...base, currentTraits, titlesMeta, changedTitleIds, validTitleIds };
}
```

- [ ] **Step 4: Rewrite `updateTasteProfile`**

Replace `updateTasteProfile` with the following. Lines marked `[wave 6]` are new; everything
else is wave 2's function. If wave 2's text differs anywhere else, keep wave 2's text and apply
only the `[wave 6]` changes.

```ts
export async function updateTasteProfile(
  db: Db,
  client: ClaudeClient,
  userId: string,
  maxTokens: number = PROFILE_MAX_TOKENS
): Promise<Record<string, unknown>> {
  // Before any read; see extractTasteProfile. The delegating branches below call
  // extractTasteProfile, which captures its own start.
  const runStartedAt = utcnowTs();
  // [wave 6] Read at run start: a ScreenSprite toggle after this supersedes the run (§5.7).
  const screenToggledAt = await readScreenToggledAt(db, userId);
  const model = profileModel();

  const existing = await db
    .select({ id: schema.tasteTraits.id })
    .from(schema.tasteTraits)
    .where(and(eq(schema.tasteTraits.userId, userId), eq(schema.tasteTraits.status, 'proposed')));

  // Python's get_profile_meta creates the row on first use and commits it.
  const meta = await ensureProfileMeta(db, userId);
  const since = meta.lastProfiledAt;

  if (!existing.length || since === null) {
    return extractTasteProfile(db, client, userId, maxTokens);
  }

  // A pending rebuild reason (screen enabled/disabled, a title deleted — spec §5.6) is a change
  // the incremental prompt cannot express or retract. Only a full rebuild clears it, and it
  // takes precedence over the "already up to date" early return below.
  if (meta.rebuildReason !== null) {
    return extractTasteProfile(db, client, userId, maxTokens);
  }

  const changed = await booksChangedSince(db, since, userId);
  const changedIds = changed.filter((b) => !b.excludeFromProfile).map((b) => b.id);

  // [wave 6] Spec §5.5: titles changed since the last build, eligible or not. Only while
  // ScreenSprite is enabled; a disabled user's titles never enter a profile build.
  const screenEnabled = await isScreenEnabled(db, userId);
  const changedTitles = screenEnabled ? await titlesChangedSince(db, since, userId) : [];
  const screenActive = screenEnabled && (await screenVariantActive(db, userId));
  const changedTitleIds = changedTitles.filter((t) => !t.excludeFromProfile).map((t) => t.id);

  const traitVerdicts = await db
    .select({ id: schema.tasteTraits.id })
    .from(schema.tasteTraits)
    .where(
      and(eq(schema.tasteTraits.userId, userId), gt(schema.tasteTraits.verdictUpdatedAt, since))
    )
    .limit(1);
  const newSignals = await db
    .select({ id: schema.tasteSignal.id })
    .from(schema.tasteSignal)
    .where(and(eq(schema.tasteSignal.userId, userId), gt(schema.tasteSignal.createdAt, since)))
    .limit(1);
  const hasFeedbackSince =
    traitVerdicts.length > 0 ||
    newSignals.length > 0 ||
    (meta.recFeedbackUpdatedAt !== null && meta.recFeedbackUpdatedAt > since);

  // A LOW-confidence match correction changes metadata without touching feedback
  // timestamps, so it never shows up in `changed`; force a full rebuild.
  if (meta.enrichmentCorrectedAt !== null && meta.enrichmentCorrectedAt > since) {
    return extractTasteProfile(db, client, userId, maxTokens);
  }

  // [wave 6] Titles changed but none is evidence any more (all want, unrated or excluded).
  // The book-variant update prompt cannot retract a title citation, and the status route
  // reports these titles as changed, so a no-op would leave the profile dirty forever.
  if (!screenActive && changedTitles.length > 0) {
    return extractTasteProfile(db, client, userId, maxTokens);
  }

  if (!changedIds.length && !changedTitleIds.length) {
    if (!changed.length && !changedTitles.length && !hasFeedbackSince) {
      return {
        mode: 'update',
        changed_books: 0,
        traits_before: existing.length,
        traits_after: existing.length,
        note: 'Profile already up to date — no rating/review changes since last build.',
        model,
      };
    }
    if (!hasFeedbackSince) {
      // Only exclusion toggles changed; the incremental prompt cannot re-derive
      // their (removed) metadata signal.
      return extractTasteProfile(db, client, userId, maxTokens);
    }
    // Feedback-only update: fall through with empty changed lists.
  }

  // [wave 6] The screen variant revises with titles; the book path below is unchanged.
  if (screenActive) {
    return reviseScreenProfile(db, client, userId, maxTokens, {
      since,
      traitsBefore: existing.length,
      runStartedAt,
      screenToggledAt,
      model,
    });
  }

  const inputs = await collectUpdateInputs(db, userId, since);
  const feedback = await feedbackContext(db, userId);
  const prompt = buildUpdatePrompt(
    inputs.currentTraits,
    inputs.booksMeta,
    inputs.changedIds,
    feedback
  );

  const message = await trackedCreate(
    client,
    db,
    { userId, operation: 'profile_update' },
    {
      model,
      max_tokens: maxTokens,
      system: REVISE_SYSTEM,
      tools: [REVISE_TOOL],
      tool_choice: { type: 'tool', name: 'revise_taste_traits' },
      messages: [{ role: 'user', content: prompt }],
    }
  );

  const input = toolInput(message, '');
  let traits = (Array.isArray(input?.traits) ? input.traits : []) as Record<string, unknown>[];
  traits = removeRejectedClaims(traits, feedback.rejected);
  traits = removeRejectedClaims(traits, [...feedback.confirmed, ...feedback.edited]);

  // Unlike the full build, valid ids come from books_meta, not the tiers.
  const validIds = new Set<number>([...inputs.booksMeta.keys()].map((k) => Number(k)));

  const saved = await persistProposedTraits(
    db,
    userId,
    traits,
    validIds,
    'update',
    runStartedAt,
    null,
    { expectedScreenToggledAt: screenToggledAt } // [wave 6]
  );

  return {
    mode: 'update',
    changed_books: inputs.changedIds.length,
    books_sent: inputs.booksMeta.size,
    traits_before: existing.length,
    traits_after: saved,
    model,
  };
}

interface ScreenReviseRun {
  since: string;
  traitsBefore: number;
  runStartedAt: string;
  screenToggledAt: string | null;
  model: string;
}

/** [wave 6] The screen variant of the incremental revise (spec §5.4–§5.5). */
async function reviseScreenProfile(
  db: Db,
  client: ClaudeClient,
  userId: string,
  maxTokens: number,
  run: ScreenReviseRun
): Promise<Record<string, unknown>> {
  const inputs = await collectScreenUpdateInputs(db, userId, run.since);
  const feedback = await feedbackContext(db, userId, { titles: true });
  const prompt = buildScreenUpdatePrompt(
    inputs.currentTraits,
    inputs.booksMeta,
    inputs.titlesMeta,
    inputs.changedIds,
    inputs.changedTitleIds,
    feedback
  );

  const message = await trackedCreate(
    client,
    db,
    { userId, operation: 'profile_update' },
    {
      model: run.model,
      max_tokens: maxTokens,
      system: SCREEN_REVISE_SYSTEM,
      tools: [SCREEN_REVISE_TOOL],
      tool_choice: { type: 'tool', name: 'revise_taste_traits' },
      messages: [{ role: 'user', content: prompt }],
    }
  );

  const input = toolInput(message, '');
  let traits = (Array.isArray(input?.traits) ? input.traits : []) as Record<string, unknown>[];
  traits = removeRejectedClaims(traits, feedback.rejected);
  traits = removeRejectedClaims(traits, [...feedback.confirmed, ...feedback.edited]);

  const validIds = new Set<number>([...inputs.booksMeta.keys()].map((k) => Number(k)));
  const saved = await persistProposedTraits(
    db,
    userId,
    traits,
    validIds,
    'update',
    run.runStartedAt,
    null,
    { validTitleIds: inputs.validTitleIds, expectedScreenToggledAt: run.screenToggledAt }
  );

  return {
    mode: 'update',
    variant: 'screen',
    changed_books: inputs.changedIds.length,
    changed_titles: inputs.changedTitleIds.length,
    books_sent: inputs.booksMeta.size,
    titles_sent: inputs.titlesMeta.size,
    traits_before: run.traitsBefore,
    traits_after: saved,
    model: run.model,
  };
}
```

Wave 2's `updateTasteProfile` persist call passes no `observedRebuildReason` (an update never
clears a reason), which is why `null` is passed positionally here.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run lib/server/__tests__/profile-update-screen.test.ts lib/server/__tests__/profile-books-golden.test.ts lib/server/__tests__/profile-update.test.ts lib/server/__tests__/profile-run-boundary.test.ts app/api/profile/update/route.test.ts`
Expected: PASS, with the golden at 4 tests.

- [ ] **Step 6: Mutation-test the start-of-run cutoff for titles (load-bearing, spec §10)**

In `reviseScreenProfile`, temporarily pass `utcnowTs()` instead of `run.runStartedAt` to
`persistProposedTraits`.
Run: `npx vitest run lib/server/__tests__/profile-update-screen.test.ts`
Expected: FAIL on "keeps a title edited during the run pending". Revert, re-run, and confirm
PASS.

Then temporarily delete the `if (!screenActive && changedTitles.length > 0)` block.
Run: `npx vitest run lib/server/__tests__/profile-books-golden.test.ts`
Expected: FAIL on case (c). Revert and confirm PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/server/profileUpdate.ts lib/server/__tests__/profile-update-screen.test.ts lib/server/__tests__/profile-books-golden.test.ts
git commit -m "feat(screen): revise the unified profile incrementally with changed titles (#96)"
```

**Handoff point (end of Batch B).** Update the ledger, then hand off.

---

### Task 8: Profile status reports titles; traits carry title ids on the wire

**Files:**
- Modify: `app/api/profile/status/route.ts`
- Modify: `lib/server/traits.ts`
- Test: `app/api/profile/status/route.test.ts`, `lib/server/__tests__/traits-out.test.ts`

**Interfaces:**
- Consumes: `isScreenEnabled`, `titlesChangedSince`.
- Produces (wire; wave 8 consumes):
  - `GET /api/profile/status` adds `changed_titles: number` and `changed_title_ids: number[]`.
    `dirty` is true when titles changed while ScreenSprite is enabled.
  - `traitOut(t)` adds `exhibit_title_ids: number[]` and `contrast_title_ids: number[]` (never
    null), after `contrasts`.

- [ ] **Step 1: Write the failing tests**

Create `app/api/profile/status/route.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeTestDb, loadSeed, type Seed } from '@/lib/server/__tests__/helpers/pglite';
import { setupTestEnv } from '@/lib/server/__tests__/helpers/testEnv';
import seedJson from '@/lib/server/__tests__/fixtures/seed.json';
import { _setDbForTests, type Db } from '@/lib/server/db';
import {
  insertTitle,
  setLastProfiledAt,
  setScreen,
} from '@/lib/server/__tests__/helpers/screenProfileFixtures';

setupTestEnv();
afterEach(() => vi.restoreAllMocks());

async function withDb(fn: (db: Db) => Promise<void>): Promise<void> {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const { db, close } = await makeTestDb();
  try {
    await loadSeed(db, seedJson as Seed);
    // After every seeded book change, verdict and rec feedback: a clean baseline.
    await setLastProfiledAt(db, '2026-08-01 00:00:00');
    _setDbForTests(db);
    await fn(db);
  } finally {
    _setDbForTests(null);
    await close();
  }
}

async function status() {
  const { GET } = await import('./route');
  const res = await GET(new Request('http://test/api/profile/status'));
  expect(res.status).toBe(200);
  return res.json();
}

describe('GET /api/profile/status with titles', () => {
  it('is clean when nothing changed', async () => {
    await withDb(async () => {
      const body = await status();
      expect(body.dirty).toBe(false);
      expect(body.changed_titles).toBe(0);
      expect(body.changed_title_ids).toEqual([]);
    });
  });

  it('reports titles changed since the last build while ScreenSprite is enabled', async () => {
    await withDb(async (db) => {
      await setScreen(db, true);
      const want = await insertTitle(db, {
        title: 'Tenet',
        status: 'want',
        feedbackUpdatedAt: '2026-08-02 00:00:00',
      });
      await insertTitle(db, {
        userId: 'other',
        title: 'Theirs',
        feedbackUpdatedAt: '2026-08-02 00:00:00',
      });
      const body = await status();
      expect(body.dirty).toBe(true);
      expect(body.changed_titles).toBe(1);
      expect(body.changed_title_ids).toEqual([want]);
    });
  });

  it('ignores titles while ScreenSprite is disabled', async () => {
    await withDb(async (db) => {
      await setScreen(db, false);
      await insertTitle(db, { title: 'Arrival', feedbackUpdatedAt: '2026-08-02 00:00:00' });
      const body = await status();
      expect(body.dirty).toBe(false);
      expect(body.changed_titles).toBe(0);
    });
  });
});
```

Create `lib/server/__tests__/traits-out.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { traitOut, type TraitRow } from '../traits';

const base: TraitRow = {
  id: 1,
  userId: 'local',
  claim: 'A.',
  polarity: 'reward',
  exhibits: [1],
  contrasts: null,
  inferenceConfidence: 0.5,
  status: 'proposed',
  userNote: null,
  createdAt: '2026-07-01 12:00:00',
  userWeight: 1,
  verdictUpdatedAt: null,
  revealLine: null,
  exhibitTitleIds: null,
  contrastTitleIds: null,
};

describe('traitOut title evidence', () => {
  it('always emits title id arrays, empty when the column is null', () => {
    const out = traitOut(base);
    expect(out.exhibit_title_ids).toEqual([]);
    expect(out.contrast_title_ids).toEqual([]);
    const keys = Object.keys(out);
    expect(keys.indexOf('exhibit_title_ids')).toBe(keys.indexOf('contrasts') + 1);
  });

  it('passes stored title ids through', () => {
    const out = traitOut({ ...base, exhibitTitleIds: [7], contrastTitleIds: [9] });
    expect(out.exhibit_title_ids).toEqual([7]);
    expect(out.contrast_title_ids).toEqual([9]);
  });
});
```

If `tsc` reports that `TraitRow` needs further columns wave 4 added, add them to `base` with
their null or default value.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest list app/api/profile/status/route.test.ts lib/server/__tests__/traits-out.test.ts` (expect 5), then
`npx vitest run app/api/profile/status/route.test.ts lib/server/__tests__/traits-out.test.ts`
Expected: FAIL — `changed_titles` and `exhibit_title_ids` are undefined.

- [ ] **Step 3: Implement**

In `app/api/profile/status/route.ts`, add the imports:

```ts
import { isScreenEnabled } from '@/lib/server/screenSettings';
import { titlesChangedSince } from '@/lib/server/screenProfile';
```

After the existing `changed` computation (the `candidates.filter(…)` block), add:

```ts
  // Spec 2026-09-22 §5.5 / §7.7: every title rating, review, status, favourite, exclusion or
  // re-resolved enrichment since the last build dirties the profile, but only while ScreenSprite
  // is enabled (a disabled user's titles never enter a build). updateTasteProfile applies the
  // same rule, so a dirty status always has an update that clears it.
  const screenEnabled = await isScreenEnabled(db, userId);
  const changedTitles = screenEnabled ? await titlesChangedSince(db, since, userId) : [];
```

Change the response to add the title terms. Keep wave 2's `rebuildReason` lines exactly as they
are:

```ts
  return Response.json({
    dirty:
      changed.length > 0 ||
      changedTitles.length > 0 ||
      traitVerdictDirty ||
      recRejectDirty ||
      enrichmentCorrectedDirty ||
      rebuildReason !== null,
    changed_books: changed.length,
    changed_book_ids: changed.map((b) => b.id),
    changed_titles: changedTitles.length,
    changed_title_ids: changedTitles.map((t) => t.id),
    last_profiled_at: tsToIso(since),
    last_profile_kind: meta?.lastProfileKind ?? null,
    rebuild_reason: rebuildReason,
  });
```

In `lib/server/traits.ts`, add after `contrasts: t.contrasts,`:

```ts
    // Spec 2026-09-22 §5.4: typed title evidence, a separate id namespace from `exhibits`.
    exhibit_title_ids: (t.exhibitTitleIds as number[] | null) ?? [],
    contrast_title_ids: (t.contrastTitleIds as number[] | null) ?? [],
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run app/api/profile/status/route.test.ts lib/server/__tests__/traits-out.test.ts lib/server/__tests__/profile-run-boundary.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/api/profile/status/route.ts app/api/profile/status/route.test.ts lib/server/traits.ts lib/server/__tests__/traits-out.test.ts
git commit -m "feat(screen): report changed titles and title evidence on the profile API (#96)"
```

---

### Task 9: Opt-out deletes title-citing traits and the archetype

**Files:**
- Create: `lib/server/screenOptOut.ts`
- Modify: `app/api/settings/screen/route.ts` (wave 4's)
- Create: `app/api/settings/screen/opt-out-preview/route.ts`
- Test: `lib/server/__tests__/screen-opt-out.test.ts`, `app/api/settings/screen/opt-out.test.ts`

**Interfaces:**
- Consumes: `setRebuildReason` (wave 2), `setScreenEnabled(tx, userId, false)` (wave 4; flips the
  flag and stamps `screen_toggled_at`).
- Produces (contract; wave 8 consumes):
  - `export async function previewScreenOptOut(db: Db, userId: string): Promise<{ traits: number; confirmed: number }>`
  - `export async function disableScreen(db: Db, userId: string): Promise<{ traits_removed: number }>`
  - `GET /api/settings/screen/opt-out-preview` → `{ traits, confirmed }`
  - `PUT /api/settings/screen` `{ enabled: false }`: wave 4's response body plus
    `traits_removed`.

- [ ] **Step 1: Write the failing tests**

Create `lib/server/__tests__/screen-opt-out.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { makeTestDb, loadSeed, type Seed } from './helpers/pglite';
import seedJson from './fixtures/seed.json';
import { schema, type Db } from '../db';
import { disableScreen, previewScreenOptOut } from '../screenOptOut';
import { setScreen, TOGGLED_AT } from './helpers/screenProfileFixtures';

async function withSeed(fn: (db: Db) => Promise<void>): Promise<void> {
  const { db, close } = await makeTestDb();
  try {
    await loadSeed(db, seedJson as Seed); // traits 1-4 (local, book-only), 101 (other)
    await setScreen(db, true);
    await setScreen(db, true, 'other');
    const t = (over: Partial<typeof schema.tasteTraits.$inferInsert>) => ({
      userId: 'local',
      claim: 'x',
      polarity: 'reward',
      inferenceConfidence: 0.5,
      status: 'proposed',
      ...over,
    });
    await db.insert(schema.tasteTraits).values([
      t({ claim: 'Mixed confirmed', status: 'confirmed', exhibits: [1], exhibitTitleIds: [7] }),
      t({ claim: 'Title-only proposed', exhibitTitleIds: [8] }),
      t({ claim: 'Edited, contrast title only', status: 'edited', exhibits: [2], contrastTitleIds: [9] }),
      t({ claim: 'Rejected, titles', status: 'rejected', exhibitTitleIds: [7] }),
      t({ claim: 'Empty title arrays', exhibits: [3], exhibitTitleIds: [], contrastTitleIds: [] }),
      t({ userId: 'other', claim: 'Other tenant, titles', exhibitTitleIds: [7] }),
    ]);
    await fn(db);
  } finally {
    await close();
  }
}

async function claims(db: Db, userId: string): Promise<string[]> {
  const rows = await db
    .select({ claim: schema.tasteTraits.claim })
    .from(schema.tasteTraits)
    .where(eq(schema.tasteTraits.userId, userId))
    .orderBy(asc(schema.tasteTraits.id));
  return rows.map((r) => r.claim);
}

describe('previewScreenOptOut', () => {
  it('counts title-citing traits of any status, and the user-locked ones among them', async () => {
    await withSeed(async (db) => {
      expect(await previewScreenOptOut(db, 'local')).toEqual({ traits: 4, confirmed: 2 });
    });
  });
});

describe('disableScreen (spec §5.7)', () => {
  it('deletes every title-citing trait, clears the archetype, and marks a rebuild', async () => {
    await withSeed(async (db) => {
      const out = await disableScreen(db, 'local');
      expect(out).toEqual({ traits_removed: 4 });

      const remaining = await claims(db, 'local');
      expect(remaining).not.toContain('Mixed confirmed');
      expect(remaining).not.toContain('Title-only proposed');
      expect(remaining).not.toContain('Edited, contrast title only');
      expect(remaining).not.toContain('Rejected, titles');
      expect(remaining).toContain('Empty title arrays');
      // Book-only traits, confirmed ones included, are untouched.
      expect(remaining).toContain('Values competence and problem-solving protagonists.');
      expect(await claims(db, 'other')).toContain('Other tenant, titles');

      const archetypes = await db.select().from(schema.readerArchetypes);
      expect(archetypes.map((a) => a.userId)).toEqual(['other']);

      const [meta] = await db
        .select()
        .from(schema.profileMeta)
        .where(eq(schema.profileMeta.userId, 'local'));
      expect(meta.rebuildReason).toBe('screen_disabled');

      const [settings] = await db
        .select()
        .from(schema.userSettings)
        .where(eq(schema.userSettings.userId, 'local'));
      expect(settings.screenEnabled).toBe(false);
      expect(settings.screenToggledAt).not.toBe(TOGGLED_AT);
    });
  });

  it('is a no-op when ScreenSprite is already disabled: the toggle stamp does not move', async () => {
    await withSeed(async (db) => {
      await setScreen(db, false);
      const out = await disableScreen(db, 'local');
      expect(out).toEqual({ traits_removed: 0 });
      expect(await claims(db, 'local')).toContain('Mixed confirmed');
      const [settings] = await db
        .select()
        .from(schema.userSettings)
        .where(eq(schema.userSettings.userId, 'local'));
      expect(settings.screenToggledAt).toBe(TOGGLED_AT);
    });
  });
});
```

The seed's `reader_archetypes` has one row for `local` and one for `other`, and its trait 2 is
the confirmed *"Values competence and problem-solving protagonists."* Confirm both before
running:
`node -e "const s=require('./lib/server/__tests__/fixtures/seed.json');console.log(s.reader_archetypes.map(r=>r.user_id),s.taste_traits[1].claim)"`.

Create `app/api/settings/screen/opt-out.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeTestDb, loadSeed, type Seed } from '@/lib/server/__tests__/helpers/pglite';
import { setupTestEnv } from '@/lib/server/__tests__/helpers/testEnv';
import seedJson from '@/lib/server/__tests__/fixtures/seed.json';
import { _setDbForTests, schema, type Db } from '@/lib/server/db';
import { setScreen } from '@/lib/server/__tests__/helpers/screenProfileFixtures';

setupTestEnv();
afterEach(() => vi.restoreAllMocks());

async function withDb(fn: (db: Db) => Promise<void>): Promise<void> {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const { db, close } = await makeTestDb();
  try {
    await loadSeed(db, seedJson as Seed);
    await setScreen(db, true);
    await db.insert(schema.tasteTraits).values({
      userId: 'local',
      claim: 'Cites a film',
      polarity: 'reward',
      inferenceConfidence: 0.5,
      status: 'confirmed',
      exhibitTitleIds: [7],
    });
    _setDbForTests(db);
    await fn(db);
  } finally {
    _setDbForTests(null);
    await close();
  }
}

describe('ScreenSprite opt-out routes', () => {
  it('GET /api/settings/screen/opt-out-preview counts what will be removed', async () => {
    await withDb(async () => {
      const { GET } = await import('./opt-out-preview/route');
      const res = await GET(new Request('http://test/api/settings/screen/opt-out-preview'));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ traits: 1, confirmed: 1 });
    });
  });

  it('PUT {enabled:false} runs the opt-out and reports traits_removed', async () => {
    await withDb(async (db) => {
      const { PUT } = await import('./route');
      const res = await PUT(
        new Request('http://test/api/settings/screen', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: false }),
        })
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.enabled).toBe(false);
      expect(body.traits_removed).toBe(1);
      const left = await db
        .select()
        .from(schema.tasteTraits)
        .where(eq(schema.tasteTraits.claim, 'Cites a film'));
      expect(left).toEqual([]);
    });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest list lib/server/__tests__/screen-opt-out.test.ts app/api/settings/screen/opt-out.test.ts` (expect 5), then
`npx vitest run lib/server/__tests__/screen-opt-out.test.ts app/api/settings/screen/opt-out.test.ts`
Expected: FAIL. `../screenOptOut` and `./opt-out-preview/route` do not exist, and the PUT
leaves the trait in place.

- [ ] **Step 3: Implement `screenOptOut.ts`**

Create `lib/server/screenOptOut.ts`:

```ts
/**
 * ScreenSprite opt-out (spec 2026-09-22 §5.7). Disabling deletes every trait with at least one
 * title reference (any status, including confirmed, edited and mixed-evidence), clears the stored
 * archetype, sets rebuild_reason, and stamps screen_toggled_at — one transaction. The stamp is
 * what makes an in-flight profile, archetype or reveal run write nothing (screenProfile.ts).
 *
 * Deletion was chosen over "mark for reassessment": opt-out is rare, deletion is deterministic,
 * and the cost is disclosed first through previewScreenOptOut. Titles themselves are kept, so
 * re-enabling restores the library.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { schema, type Db } from './db';
import { setRebuildReason } from './profileMeta';
import { setScreenEnabled } from './screenSettings';

interface TraitRefs {
  id: number;
  status: string;
  exhibitTitleIds: unknown;
  contrastTitleIds: unknown;
}

function citesTitles(t: TraitRefs): boolean {
  const ex = Array.isArray(t.exhibitTitleIds) ? t.exhibitTitleIds : [];
  const co = Array.isArray(t.contrastTitleIds) ? t.contrastTitleIds : [];
  return ex.length > 0 || co.length > 0;
}

async function traitRefs(db: Db, userId: string): Promise<TraitRefs[]> {
  return db
    .select({
      id: schema.tasteTraits.id,
      status: schema.tasteTraits.status,
      exhibitTitleIds: schema.tasteTraits.exhibitTitleIds,
      contrastTitleIds: schema.tasteTraits.contrastTitleIds,
    })
    .from(schema.tasteTraits)
    .where(eq(schema.tasteTraits.userId, userId));
}

/**
 * What disabling would remove: "N traits drew on your viewing history and will be removed,
 * including M you confirmed." M counts confirmed AND edited traits: both are claims the user
 * locked in and would lose.
 */
export async function previewScreenOptOut(
  db: Db,
  userId: string
): Promise<{ traits: number; confirmed: number }> {
  const citing = (await traitRefs(db, userId)).filter(citesTitles);
  return {
    traits: citing.length,
    confirmed: citing.filter((t) => t.status === 'confirmed' || t.status === 'edited').length,
  };
}

/**
 * Disables ScreenSprite for the user. A no-op when it is already disabled: re-stamping
 * screen_toggled_at would needlessly supersede an in-flight run.
 */
export async function disableScreen(
  db: Db,
  userId: string
): Promise<{ traits_removed: number }> {
  return db.transaction(async (tx) => {
    const settings = await tx
      .select({ id: schema.userSettings.id, enabled: schema.userSettings.screenEnabled })
      .from(schema.userSettings)
      .where(eq(schema.userSettings.userId, userId));
    if (!settings[0]?.enabled) return { traits_removed: 0 };

    const ids = (await traitRefs(tx, userId)).filter(citesTitles).map((t) => t.id);
    if (ids.length) {
      await tx
        .delete(schema.tasteTraits)
        .where(and(eq(schema.tasteTraits.userId, userId), inArray(schema.tasteTraits.id, ids)));
    }
    await tx.delete(schema.readerArchetypes).where(eq(schema.readerArchetypes.userId, userId));
    await setRebuildReason(tx, userId, 'screen_disabled');
    // Wave 4's helper: flips the flag and stamps screen_toggled_at, which is what supersedes
    // any in-flight profile, archetype or reveal run.
    await setScreenEnabled(tx, userId, false);

    return { traits_removed: ids.length };
  });
}
```

`traitRefs(tx, …)` passes a transaction where `Db` is typed. This is the same pattern as
`markProfiled(tx: Db, …)`. If `tsc` rejects it here, change `traitRefs`'s parameter type to
`Pick<Db, 'select'>`.

- [ ] **Step 4: Add the preview route**

Create `app/api/settings/screen/opt-out-preview/route.ts`:

```ts
import { withApi } from '@/lib/server/http';
import { getDb } from '@/lib/server/db';
import { previewScreenOptOut } from '@/lib/server/screenOptOut';

/**
 * Spec 2026-09-22 §5.7 / §7.4: what disabling ScreenSprite would remove, for the confirmation
 * ("N traits drew on your viewing history and will be removed, including M you confirmed").
 */
export const GET = withApi('/api/settings/screen/opt-out-preview', async (_req, ctx) => {
  const db = getDb();
  const preview = await previewScreenOptOut(db, ctx.user.userId);
  ctx.timer.mark('db');
  return Response.json(preview);
});
```

- [ ] **Step 5: Route `PUT {enabled:false}` through `disableScreen`**

Open `app/api/settings/screen/route.ts` (wave 4) and read its `PUT` handler. Wave 4 has no
disable branch: it runs one `db.transaction((tx) => setScreenEnabled(tx, ...))` for both
values, then returns `screenState()`. Add the import:

```ts
import { disableScreen } from '@/lib/server/screenOptOut';
```

and insert this early return immediately **before** the existing `await db.transaction(...)`
line, then update wave 4's comment above that line to say it now handles enabling only:

```ts
  if (!parsed.data.enabled) {
    // Spec §5.7 opt-out: deletes title-citing traits and the archetype, sets rebuild_reason
    // and stamps screen_toggled_at, in one transaction (lib/server/screenOptOut.ts).
    const { traits_removed } = await disableScreen(db, ctx.user.userId);
    const state = await screenState(db, ctx.user.userId);
    ctx.timer.mark('db');
    return Response.json({ ...state, traits_removed });
  }
```

The enable path (the existing transaction, `screenState()` and response) stays untouched.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run lib/server/__tests__/screen-opt-out.test.ts app/api/settings/screen/`
Expected: PASS, including every existing wave 4 test in that directory.

- [ ] **Step 7: Mutation-test the opt-out (load-bearing, spec §10)**

1. In `disableScreen`, temporarily replace `.filter(citesTitles)` with nothing (delete every
   trait).
   Run: `npx vitest run lib/server/__tests__/screen-opt-out.test.ts`
   Expected: FAIL (book-only and "Empty title arrays" traits vanish). Revert.
2. Temporarily make `citesTitles` read only `exhibitTitleIds`.
   Expected: FAIL ("Edited, contrast title only" survives). Revert.
3. Temporarily delete the `if (!settings[0]?.enabled)` early return.
   Expected: FAIL on the no-op test. Revert and confirm PASS.

- [ ] **Step 8: Commit**

```bash
git add lib/server/screenOptOut.ts lib/server/__tests__/screen-opt-out.test.ts app/api/settings/screen/route.ts app/api/settings/screen/opt-out-preview/route.ts app/api/settings/screen/opt-out.test.ts
git commit -m "feat(screen): opting out removes title-citing traits and the archetype (#96)"
```

---

### Task 10: Toggle guard on archetype and reveal-line writes

**Files:**
- Modify: `lib/server/archetypeDerive.ts`, `lib/server/revealLines.ts`
- Test: `lib/server/__tests__/screen-toggle-guard.test.ts`

**Interfaces:**
- Consumes: `readScreenToggledAt` (wave 4), `assertScreenToggleUnchanged` (Task 3).
- Produces: `deriveArchetype` and `generateRevealLines` keep their signatures. Each throws
  `ApiError(409, PROFILE_RUN_SUPERSEDED_MESSAGE)` and writes nothing when `screen_toggled_at`
  changed after it began. Their routes surface that 409 through `withApi` unchanged.

- [ ] **Step 1: Write the failing test**

Create `lib/server/__tests__/screen-toggle-guard.test.ts`:

```ts
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
      const err = await deriveArchetype(db, toggleFlippingClient(db, archetypeResponse()), 'local').catch(
        (e) => e
      );
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
```

Seed trait 3 has `reveal_line: null`, and the seed has an archetype row for `local`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest list lib/server/__tests__/screen-toggle-guard.test.ts` (expect 4), then
`npx vitest run lib/server/__tests__/screen-toggle-guard.test.ts`
Expected: FAIL. Both "toggled mid-run" tests resolve and write.

- [ ] **Step 3: Implement the guards**

In `lib/server/archetypeDerive.ts`, add the imports:

```ts
import { readScreenToggledAt } from './screenSettings';
import { assertScreenToggleUnchanged } from './screenProfile';
```

As the first statement of `deriveArchetype`'s body, add:

```ts
  // Spec 2026-09-22 §5.7: an archetype derived from traits a ScreenSprite toggle has since
  // deleted must not land. Read now, re-checked inside the write transaction.
  const screenToggledAt = await readScreenToggledAt(db, userId);
```

As the first statement inside its `db.transaction(async (tx) => { … })`, add:

```ts
    await assertScreenToggleUnchanged(tx, userId, screenToggledAt);
```

In `lib/server/revealLines.ts`, add the same two imports. As the first statement of
`generateRevealLines`'s body, before the `pending` query, add:

```ts
  // Spec 2026-09-22 §5.7: see archetypeDerive.ts. Read now, re-checked inside the write.
  const screenToggledAt = await readScreenToggledAt(db, userId);
```

As the first statement inside its `db.transaction(async (tx) => { … })`, add:

```ts
    await assertScreenToggleUnchanged(tx, userId, screenToggledAt);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/server/__tests__/screen-toggle-guard.test.ts lib/server/archetype.test.ts`
Then run every existing test that exercises either module:
`grep -rl "deriveArchetype\|generateRevealLines\|reveal-lines\|profile/archetype" lib/server app/api --include=*.test.ts | xargs npx vitest run`
Expected: PASS.

- [ ] **Step 5: Mutation-test**

Comment out the `assertScreenToggleUnchanged` line in `revealLines.ts`. Run the Task 10 test.
Expected: FAIL on the reveal "toggled mid-run" test. Revert, then do the same for
`archetypeDerive.ts`. Revert both and confirm PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/server/archetypeDerive.ts lib/server/revealLines.ts lib/server/__tests__/screen-toggle-guard.test.ts
git commit -m "feat(screen): archetype and reveal writes yield to a ScreenSprite toggle (#96)"
```

---

### Task 11: Title-targeted taste signals

**Files:**
- Modify: `app/api/taste-signal/route.ts`
- Modify (only if wave 4 did not): `lib/server/export.ts`
- Test: `app/api/taste-signal/route.test.ts`, `lib/server/__tests__/export-title-signals.test.ts`

**Interfaces:**
- Consumes: `requireScreenEnabled` (wave 4), `schema.titles`, `schema.tasteSignal.targetTitleId`.
- Produces (wire; wave 8 consumes):
  - `POST /api/taste-signal` accepts `target_kind: 'title'` with `target_title_id`.
  - Its response adds `target_title_id`.
  - Rejections:

    | Condition | Status |
    |---|---|
    | `target_title_id` with a non-title kind | 422 |
    | title kind without `target_title_id` | 422 |
    | title kind with `target_book_id` | 422 |
    | ScreenSprite disabled | 403 |
    | another user's or a missing title | 404 |

- [ ] **Step 1: Write the failing tests**

Create `app/api/taste-signal/route.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeTestDb, loadSeed, type Seed } from '@/lib/server/__tests__/helpers/pglite';
import { setupTestEnv } from '@/lib/server/__tests__/helpers/testEnv';
import seedJson from '@/lib/server/__tests__/fixtures/seed.json';
import { _setDbForTests, schema, type Db } from '@/lib/server/db';
import { insertTitle, setScreen } from '@/lib/server/__tests__/helpers/screenProfileFixtures';

setupTestEnv();
afterEach(() => vi.restoreAllMocks());

async function withDb(fn: (db: Db) => Promise<void>): Promise<void> {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const { db, close } = await makeTestDb();
  try {
    await loadSeed(db, seedJson as Seed);
    _setDbForTests(db);
    await fn(db);
  } finally {
    _setDbForTests(null);
    await close();
  }
}

async function post(body: unknown): Promise<Response> {
  const { POST } = await import('./route');
  return POST(
    new Request('http://test/api/taste-signal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

describe('POST /api/taste-signal, title kind', () => {
  it('records a title signal and dirties the profile', async () => {
    await withDb(async (db) => {
      await setScreen(db, true);
      const arrival = await insertTitle(db, { title: 'Arrival', letterboxdRating: 5 });
      const res = await post({ direction: 'more', target_kind: 'title', target_title_id: arrival });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body).toMatchObject({
        direction: 'more',
        target_kind: 'title',
        target_title_id: arrival,
        target_book_id: null,
      });
      const [meta] = await db
        .select()
        .from(schema.profileMeta)
        .where(eq(schema.profileMeta.userId, 'local'));
      expect(meta.recFeedbackUpdatedAt).not.toBe('2026-07-10 12:00:00');
    });
  });

  it("answers 404 for another user's title and for a missing one", async () => {
    await withDb(async (db) => {
      await setScreen(db, true);
      const theirs = await insertTitle(db, { userId: 'other', title: 'Theirs' });
      expect((await post({ direction: 'more', target_kind: 'title', target_title_id: theirs })).status).toBe(404);
      expect((await post({ direction: 'more', target_kind: 'title', target_title_id: 99999 })).status).toBe(404);
    });
  });

  it('answers 403 while ScreenSprite is disabled', async () => {
    await withDb(async (db) => {
      await setScreen(db, false);
      const arrival = await insertTitle(db, { title: 'Arrival' });
      expect((await post({ direction: 'more', target_kind: 'title', target_title_id: arrival })).status).toBe(403);
    });
  });

  it('rejects mismatched target fields with 422', async () => {
    await withDb(async (db) => {
      await setScreen(db, true);
      const arrival = await insertTitle(db, { title: 'Arrival' });
      expect((await post({ direction: 'more', target_kind: 'title' })).status).toBe(422);
      expect(
        (await post({ direction: 'more', target_kind: 'title', target_title_id: arrival, target_book_id: 1 })).status
      ).toBe(422);
      expect(
        (await post({ direction: 'more', target_kind: 'book', target_book_id: 1, target_title_id: arrival })).status
      ).toBe(422);
    });
  });

  it('leaves book signals as they were, with target_title_id null in the response', async () => {
    await withDb(async () => {
      const res = await post({ direction: 'less', target_kind: 'book', target_book_id: 1 });
      expect(res.status).toBe(201);
      expect((await res.json()).target_title_id).toBeNull();
    });
  });
});
```

Create `lib/server/__tests__/export-title-signals.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { exportJsonText } from '../export';
import type { schema } from '../db';

describe('JSON export of title-targeted signals (spec §3.6 / §5.9)', () => {
  it('includes target_title_id on every exported signal', () => {
    const signal = {
      id: 1,
      userId: 'local',
      direction: 'more',
      targetKind: 'title',
      targetBookId: null,
      targetTitleId: 7,
      snapshot: null,
      createdAt: '2026-07-01 12:00:00',
    } as typeof schema.tasteSignal.$inferSelect;
    // Wave 4 moves title-targeted signals out of the top-level taste_signals and writes the
    // screen section only when the fourth argument is non-null, so pass an empty one.
    const text = exportJsonText([], [signal], new Date('2026-09-22T00:00:00Z'), {
      titles: [],
      recommendations: [],
    });
    const parsed = JSON.parse(text);
    expect(parsed.taste_signals).toEqual([]);
    expect(parsed.screen.taste_signals[0]).toMatchObject({
      target_kind: 'title',
      target_title_id: 7,
    });
  });
});
```

This call matches wave 4's signature (`exportJsonText(books, signals, now, screen = null)`). If
the landed signature differs, adapt the arguments, keep both assertions, and record the
adaptation in the ledger.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest list app/api/taste-signal/route.test.ts lib/server/__tests__/export-title-signals.test.ts` (expect 6), then
`npx vitest run app/api/taste-signal/route.test.ts lib/server/__tests__/export-title-signals.test.ts`
Expected: the route tests FAIL, because `target_kind: 'title'` is a 422 from the enum. The
export test may already PASS if wave 4 exported `target_title_id`. That is fine; it then guards
wave 4's work.

- [ ] **Step 3: Rewrite the taste-signal route**

Replace `app/api/taste-signal/route.ts` with:

```ts
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { utcnowTs, tsToIso } from '@/lib/server/serialize';
import { ensureProfileMeta } from '@/lib/server/profileMeta';
import { requireScreenEnabled } from '@/lib/server/screenSettings';

const Body = z.object({
  direction: z.enum(['more', 'less']), // Pydantic Literal → schema-level 422 (string-detail deviation)
  target_kind: z.enum(['book', 'rec', 'title']),
  target_book_id: z.number().int().nullish(),
  target_title_id: z.number().int().nullish(),
  snapshot: z.record(z.string(), z.unknown()).nullish(),
});

/** Port of library.py::record_taste_signal via api.py::post_taste_signal. Persists a
 *  more/less-like-this steering signal and dirties the profile (bumps
 *  ProfileMeta.rec_feedback_updated_at) so the next build incorporates it. Title-kind
 *  signals (spec 2026-09-22 §5.9) are read by the screen-variant profile only. */
export const POST = withApi('/api/taste-signal', async (req, ctx) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError(
      422,
      `validation error: ${parsed.error.issues[0]?.message ?? 'invalid body'}`
    );
  }
  const b = parsed.data;
  const db = getDb();

  if (b.target_title_id != null && b.target_kind !== 'title') {
    throw new ApiError(422, 'target_title_id is only valid for title-kind signals');
  }

  if (b.target_kind === 'book') {
    if (b.target_book_id == null) {
      throw new ApiError(422, 'target_book_id is required for book-kind signals');
    }
    const rows = await db
      .select()
      .from(schema.books)
      .where(and(eq(schema.books.id, b.target_book_id), eq(schema.books.userId, ctx.user.userId)));
    // NOTE: no trailing period — this 404 comes from record_taste_signal, unlike library.py's.
    if (!rows[0]) throw new ApiError(404, `Book ${b.target_book_id} not found`);
  } else if (b.target_kind === 'rec') {
    // Python `if not snapshot` — empty object is falsy too.
    if (!b.snapshot || Object.keys(b.snapshot).length === 0) {
      throw new ApiError(422, 'snapshot is required for rec-kind signals');
    }
  } else {
    if (b.target_title_id == null) {
      throw new ApiError(422, 'target_title_id is required for title-kind signals');
    }
    if (b.target_book_id != null) {
      throw new ApiError(422, 'target_book_id is not valid for title-kind signals');
    }
    await requireScreenEnabled(db, ctx.user.userId);
    const rows = await db
      .select({ id: schema.titles.id })
      .from(schema.titles)
      .where(
        and(eq(schema.titles.id, b.target_title_id), eq(schema.titles.userId, ctx.user.userId))
      );
    if (!rows[0]) throw new ApiError(404, `Title ${b.target_title_id} not found`);
  }

  const signal = await db.transaction(async (tx) => {
    const [signal] = await tx
      .insert(schema.tasteSignal)
      .values({
        userId: ctx.user.userId,
        direction: b.direction,
        targetKind: b.target_kind,
        targetBookId: b.target_book_id ?? null,
        targetTitleId: b.target_title_id ?? null,
        snapshot: b.snapshot ?? null,
        createdAt: utcnowTs(),
      })
      .returning();

    const meta = await ensureProfileMeta(tx, ctx.user.userId);
    await tx
      .update(schema.profileMeta)
      .set({ recFeedbackUpdatedAt: utcnowTs() })
      .where(eq(schema.profileMeta.id, meta.id));
    return signal;
  });

  ctx.timer.mark('db');
  return Response.json(
    {
      id: signal.id,
      direction: signal.direction,
      target_kind: signal.targetKind,
      target_book_id: signal.targetBookId,
      target_title_id: signal.targetTitleId,
      snapshot: signal.snapshot,
      created_at: tsToIso(signal.createdAt),
    },
    { status: 201 }
  );
});
```

- [ ] **Step 4: Export `target_title_id` if wave 4 did not**

Run: `grep -n "target_title_id" lib/server/export.ts`
If it prints a line, skip this step. Otherwise, in `exportJsonText`'s `taste_signals` mapping,
add after `target_book_id: signal.targetBookId,`:

```ts
      target_title_id: signal.targetTitleId,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run app/api/taste-signal/route.test.ts lib/server/__tests__/export-title-signals.test.ts lib/server/__tests__/import-export-routes.test.ts lib/server/__tests__/profile-feedback-titles.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/api/taste-signal/route.ts app/api/taste-signal/route.test.ts lib/server/__tests__/export-title-signals.test.ts lib/server/export.ts
git commit -m "feat(screen): accept more/less-like signals on titles (#96)"
```

(`git add lib/server/export.ts` is a no-op when Step 4 was skipped.)

---

### Task 12: Full gate and real-flow verification

**Files:** none changed, unless a gate fails. Then fix the owning task's code and re-run.

- [ ] **Step 1: Run the full gate**

Run each, from the repository root:

```bash
npm run test:server
npm test
npm run type-check
npm run lint
npm run format:check
npm run build
```

Expected: all pass. Record the Vitest pass count by extracting it, not by slicing output:
`npm run test:server 2>&1 | grep -E "Tests +[0-9]+"`.

- [ ] **Step 2: Re-run the load-bearing mutations as a batch**

Repeat one mutation from each of these, confirm each goes red, then revert:
- Task 1 Step 6: the golden.
- Task 6 Step 6.1: the persist guard.
- Task 7 Step 6: the title cutoff.
- Task 9 Step 7.1: the opt-out filter.

Finish with `git diff --stat`, which must show no stray edits.

- [ ] **Step 3: Real-flow verification against an isolated local run**

Follow the procedure in the project memory note `marketing-screenshot-pipeline`:
- a scratch Postgres in Docker;
- `npm run db:migrate` against that scratch `DATABASE_URL`;
- a local-mode dev server (`ALLOW_LOCAL_AUTH=true`) with **no `.env` file in scope**.

Never read or print a `.env` file.

Set it up exactly as wave 5 Task 15 Step 4 does:

```bash
# 1. A copy of the working tree with no secrets file in scope. Beside the repository, not in
# /tmp: Turbopack rejects a node_modules symlink pointing outside the inferred workspace root
# when the copy is in /tmp. If it still rejects the link here, run `npm ci` in the copy (no sudo).
VERIFY="$HOME/Documents/Code/shelfsprite-w6-verify"
# Tracked + untracked-but-not-ignored files only; secrets files, .next and node_modules are
# gitignored, so the command never names them.
mkdir -p "$VERIFY"
git ls-files -z --cached --others --exclude-standard | rsync -a --from0 --files-from=- ./ "$VERIFY"/
ln -sfn "$PWD/node_modules" "$VERIFY/node_modules"
ls -a "$VERIFY"   # names only; confirm no dot-env entry. If there is one: STOP, delete the copy.

# 2. Scratch Postgres on 55436 (waves 2, 4, 5, 7, 8 use 55433, 55434, 55435, 55437, 55438)
docker ps --format '{{.Names}} {{.Ports}}' | grep 55436 && echo "STOP: port 55436 busy"
docker run -d --name ss-w6-pg -e POSTGRES_PASSWORD=postgres -p 55436:5432 postgres:17
export VERIFY_DB=postgres://postgres:postgres@localhost:55436/postgres
cd "$VERIFY" && DATABASE_URL=$VERIFY_DB npm run db:migrate

# 3. Dev server. CRON_SECRET is a throwaway local value, needed for the tick dispatch.
cd "$VERIFY" && DATABASE_URL=$VERIFY_DB ALLOW_LOCAL_AUTH=true CRON_SECRET=local-verify-secret \
  npx next dev -p 3100
```

Wave 4 checks in no Letterboxd ZIP (its fixture is a `zipSync` builder in a test file), so
build one. Resolution needs real titles:

```bash
python3 - <<'PY'
import zipfile
files = {
  "watched.csv": "Date,Name,Year,Letterboxd URI\n2024-01-05,Forrest Gump,1994,https://boxd.it/aaa1\n2024-01-06,Her,2013,https://boxd.it/aaa2\n2024-01-07,Spirited Away,2001,https://boxd.it/aaa3\n2024-01-08,Chernobyl,2019,https://boxd.it/aaa4\n",
  "ratings.csv": "Date,Name,Year,Letterboxd URI,Rating\n2024-01-05,Forrest Gump,1994,https://boxd.it/aaa1,4\n2024-01-07,Spirited Away,2001,https://boxd.it/aaa3,5\n",
}
with zipfile.ZipFile("/tmp/shelfsprite-w6-letterboxd.zip", "w", zipfile.ZIP_DEFLATED) as z:
    for name, text in files.items():
        z.writestr(name, text.encode("utf-8"))
PY
```

**What the executor can verify alone** (no Anthropic key needed; `curl` against
`http://localhost:3100`, local mode needs no auth header):

1. Import a book library with a real-shaped CSV: `POST /api/import` with
   `lib/server/__tests__/fixtures/sample_goodreads.csv`.
2. Import the ZIP:
   `curl -s -F file=@/tmp/shelfsprite-w6-letterboxd.zip http://localhost:3100/api/screen/import`.
   Let the screen enrichment job finish: poll `GET /api/screen/enrich/active`, then
   `GET /api/enrich/status/<job_id>` until `status` is `done` (Monitor with an until-loop, not
   a foreground sleep).
3. `GET /api/profile/status`. Expect `dirty: true`, `rebuild_reason: "screen_enabled"`, and
   non-empty `changed_title_ids`. Record the body.
4. `PATCH /api/screen/titles/<id>` with `{ "rating": 3.5 }` on one title, then
   `GET /api/profile/status`. The id appears in `changed_title_ids`.
5. `POST /api/taste-signal` with `{"direction":"more","target_kind":"title","target_title_id":<id>}`
   returns 201. The same call with a missing id returns 404.
6. `GET /api/settings/screen/opt-out-preview` returns `{ traits, confirmed }`.
7. Insert one trait citing a title directly in the scratch database. For example:

   ```sql
   insert into taste_traits (user_id, claim, polarity, inference_confidence, status, exhibit_title_ids)
   values ('local','Real-flow probe','reward',0.5,'confirmed','[<id>]');
   ```

   Then:
   - `GET /api/settings/screen/opt-out-preview` shows `traits` ≥ 1 and `confirmed` ≥ 1.
   - `PUT /api/settings/screen` with `{"enabled":false}` returns `traits_removed` ≥ 1.
   - `GET /api/profile` no longer lists the probe.
   - `GET /api/profile/archetype` returns 404.
   - `GET /api/profile/status` shows `rebuild_reason: "screen_disabled"`.
8. With ScreenSprite disabled, `POST /api/taste-signal` of title kind returns 403.
9. `PUT /api/settings/screen` with `{"enabled":true}` re-enables it. The titles are still
   there (`GET /api/screen/titles`).

**What needs Chase:** the Claude calls. `POST /api/profile` and `POST /api/profile/update`
need a real Anthropic key, and so does their byte-level behaviour against the real model. Ask
Chase to start the dev server with the key exported **in his own shell**. The executor never
reads, prints or writes it. With the server running that way:

10. With ScreenSprite enabled, `POST /api/profile`. Expect `variant: "screen"` and
    `rated_titles` > 0. `GET /api/profile` shows at least one trait with a non-empty
    `exhibit_title_ids`, and every cited title id belongs to a real, eligible title. Check with
    `GET /api/screen/titles`.
11. Change one title rating, then `POST /api/profile/update`. Expect `mode: "update"`,
    `variant: "screen"`, and `changed_titles` ≥ 1.
12. Disable ScreenSprite and `POST /api/profile`. The response has no `variant` key (book
    variant), and no trait cites a title.

If Chase has not provided a key-bearing server, record in the ledger: "Steps 10–12 not run:
need an Anthropic key in Chase's shell." Do not call the wave done. Report it as "verified up
to the Claude calls; Claude steps pending Chase".

- [ ] **Step 4: Record what was observed**

In the ledger, write the actual response bodies (trimmed) for steps 3, 6, 7 and, if run,
10–12. Note any divergence from this plan's predictions. Record what you actually observed, not
what this plan predicts.

Clean up: stop the dev server, `docker rm -f ss-w6-pg`, and
`rm -rf "$VERIFY" /tmp/shelfsprite-w6-letterboxd.zip`.

- [ ] **Step 5: Tell Chase what is his to do**

This wave adds no migration. Report:
- the gate results;
- which real-flow steps ran;
- whether steps 10–12 are waiting on him;
- the list of commits (or the staged paths, if commits were not authorized).
