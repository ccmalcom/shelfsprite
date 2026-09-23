# ScreenSprite Wave 7 — Screen Recommendations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reader with ScreenSprite enabled can run `POST /api/screen/recommend` (Both | Movies | TV) and get real Wikidata-backed films and series, reranked and explained by Claude, persisted as a run they can read back and act on (want to watch / already watched / not for me).

**Architecture:** Two-stage, like the book recommender (`recommendRun.ts`), but on the screen catalog. `screenSignal.ts` reads the unified taste profile, loved books, loved titles and every owned identity. `screenAssemble.ts` runs three Stage 1 pools against Wikidata through a small injectable `ScreenCatalogPort` (the only code that touches wave 5's catalog client). The pools are the metadata pool, the adaptation bridge with its series hop, and Claude comparable-title seeds resolved by title plus year. It then merges, floors, hydrates, filters and caps them. `screenRecPrompts.ts` holds the seed and rerank tools. `screenRecommendRun.ts` enforces the gate and the §6.4 time budget, and it validates every citation. It persists to `title_recommendations` in one transaction. Three routes expose it. Claude never adds a candidate.

**Tech Stack:** TypeScript, Next.js App Router route handlers, drizzle-orm, Zod, Wikidata SPARQL (WDQS), TVmaze, Anthropic SDK (`@anthropic-ai/sdk` 0.115, `RequestOptions.signal`), Vitest + PGlite.

**Spec:** `docs/superpowers/specs/2026-09-22-screen-media-design.md` — §6 (all of it), §2.1 finding 7, §3.2, §4.3, §7.9, §10. **Index and cross-wave contract:** `docs/superpowers/plans/2026-09-22-screen-media-00-index.md`. Read the index, then this plan, then spec §6.

**Issue:** #96. **Branch:** `feat/screen-media`.

---

## Global Constraints

Every task's requirements implicitly include this section. The first block is copied verbatim from the index; the second is specific to this wave.

- **Two test runners with disjoint ownership.** `npm run test:server` (Vitest) owns exactly `lib/server/**` and `app/api/**`; `npm test` (Jest) owns everything else. Before naming a single test file as a gate, confirm the runner sees it: `npx vitest list <path>` or `npx jest --listTests <path>`. A gate that matches zero tests exits 0.
- **Full gate at the end of every wave**, from the repository root: `npm run test:server`, `npm test`, `npm run type-check`, `npm run lint`, `npm run format:check`, `npm run build`. `npm run build` is the only gate that catches Next segment-config and prerender failures.
- **Real-flow verification before a wave is called done** (spec §10). Tests alone never close a wave. Use an isolated local run: a scratch Postgres in Docker plus a local-mode dev server (`ALLOW_LOCAL_AUTH=true`) with **no `.env` file in scope**, following the procedure recorded in the project memory note `marketing-screenshot-pipeline`. Never point a verification run at the production database. Record what you actually observe, not what a plan predicts.
- **Secrets.** Never open, print, or name the contents of `.env*` files; check presence only. Never ask Codex to inspect them.
- **Ratings.** `numeric(2,1)` with drizzle `mode: 'number'` on every rating column. `0` on an API mutation means "clear". The manual `isValidRating` guard owns the 422 message; do not move the grid rule into Zod.
- **Wire format.** API JSON is snake_case. Prompt payloads use `pyJsonDumps` over ordered `Map`s (`lib/server/serialize.ts`); never `JSON.stringify` a prompt payload.
- **Long-running routes** export the literal `export const maxDuration = 300;` — never an imported binding. Every new one is added to `app/api/enrich/enrich-max-duration.test.ts`.
- **Tenancy.** Every query on a user-owned table filters by `user_id`; every route test includes a second user whose ids are rejected (404, never 403 that leaks existence).
- **Schema changes.** None in this wave. `title_recommendations`, `titles`, `title_enrichment`, `taste_signal.target_title_id` and `user_settings.screen_enabled` all landed in wave 4. If a task seems to need a column, stop and report.
- **`.tsx` string literals are ASCII-only.** (No `.tsx` in this wave.)
- **Copy.** User-facing copy says **ScreenSprite**; code, routes, tables and settings keys say `screen`.
- **Git.** Work on `feat/screen-media`. Chase commits manually by default: a "Commit" step runs only when Chase has authorized commits for that execution session; otherwise stage the listed paths and leave them. Plain commit messages, no `Co-Authored-By` trailer; end each with the `Claude-Session:` line from the session's attribution instructions. Subject: `feat(screen): … (#96)`.
- **Next.js here is not the Next.js you know.** Before writing a route file, read `node_modules/next/dist/docs/` for route handlers and segment config.

Wave 7 specifics:

- **The LLM is not the recommender.** Every candidate that reaches the reranker came from a Wikidata query or a TVmaze lookup in Stage 1. Claude's seeds are *lookup inputs*, never candidates. A cited index outside the candidate list is dropped.
- **Popularity floor for every pool:** an English Wikipedia article **and** at least 10 sitelinks (`POPULARITY_MIN_SITELINKS = 10`). Enforced inside every SPARQL query **and** re-checked in `mergeHits`.
- **TV candidates must cross-walk:** a series with no TVmaze ID (Wikidata P8600) never enters the pool.
- **Every label read uses `en` and `mul`.** Every exact-label SPARQL match uses both `@en` and `@mul` (spec §2.1 finding 2a).
- **Catalog calls are sequential.** Do not `Promise.all` them. Wave 5's per-host throttles assume serial calls.
- **No catalog call or Claude call runs inside a transaction.** `db.ts` uses `max: 1`, so touching `db` inside an open transaction deadlocks. Read, call out, then write in one transaction (the `recommendRun.ts` pattern).
- **Models:** seed calls use `modelFor('seed')`, rerank calls `modelFor('rerank')` (wave 2). Usage operations: `screen_rec_seed`, `screen_rec_rank`.
- **Fixtures are synthetic.** Never use Chase's real Letterboxd export or ShelfSprite backup in a test.

---

## Review Focus

Five conditions the spec implies that a person using this will hit and that no happy-path test exercises. Each line names the owning task, which adds the test that pins it.

1. **Accepting a recommendation must not block the next run.** Accepting creates a `want` title with a fresh `title_enrichment` row, which wave 6's `titlesChangedSince` reports as changed. The gate must only block on changes that are profile evidence (rated, dropped or favorite), mirroring `booksChangedSince`. Otherwise the reader is told to re-profile after every "Want to watch". → Task 8, test `a want-only change does not block`.
2. **Book titles with quotes, backslashes or newlines must not break or inject into SPARQL.** A loved book titled `The "Real" Story\` with a newline must produce a syntactically valid query in which the title survives as one literal. → Task 4, test `escapes user text`.
3. **A slow seed call must not fail the run.** When the seed model exceeds 45 s, its request is aborted and the run is still served from the metadata and adaptation pools, with `seed_timed_out: true`. → Task 8, test `seed timeout still serves a run`.
4. **Acting on the same recommendation twice, or on one that matches a title the reader already rated, never overwrites anything.** The existing title comes back unchanged (rating, status and review untouched) and no duplicate row appears. → Task 10, tests `accepting twice is idempotent` and `an existing rated title is returned unchanged`.
5. **A rerank whose picks all cite invalid indices mints no run**, and the previous run stays the latest one (issue #64). → Task 8, test `no surviving picks mints no run`; Task 9 checks that `GET` still returns the earlier run.

---

## What this wave consumes (verify in Task 1)

Waves 2, 4, 5 and 6 have landed. This plan relies on exactly these exports from them. Task 1's first step checks each one. **If any is missing or its shape differs, stop and report.** Do not adapt call sites silently; the only sanctioned adaptation point is `defaultScreenCatalogPort` (Task 5), and only for the wave 5 function signatures.

| Export | From | Used as |
|---|---|---|
| `modelFor(op)` | `lib/server/models.ts` (w2) | `modelFor('seed')`, `modelFor('rerank')` |
| `readRebuildReason(db, userId)` | `lib/server/profileMeta.ts` (w2) | gate |
| `schema.titles`, `schema.titleEnrichment`, `schema.titleRecommendations`; `userSettings.screenEnabled`; `tasteSignal.targetTitleId` | `lib/server/schema.ts` (w4) | reads and writes |
| the same tables in `lib/server/__tests__/helpers/pglite.ts` | w4 | tests |
| `requireScreenEnabled(db, userId)` | `lib/server/screenSettings.ts` (w4) | 403 gate |
| `TitleRow`, `effectiveTitleRating`, `isTitleProfileEvidence`, `normalizeTitleKey`, `titleOut` | `lib/server/titles.ts` (w4) | signal, gate, feedback |
| `CatalogResult<T>`, `Deadline`, `wikidataSparql(db, query, deadline)`, `tvmazeSingleSearch(db, query, deadline)` | `lib/server/screenCatalog.ts` (w5) | port adapter only |
| `ScreenCandidate`, `fetchScreenMetadata(db, qids, deadline)` | `lib/server/screenEnrichment.ts` (w5) | hydration, feedback |
| `titleVariants(title)` | `lib/server/screenMatch.ts` (w5) | seed lookup |
| `titlesChangedSince(db, since, userId)` | `lib/server/screenProfile.ts` (w6) | gate |

Assumed field types on `ScreenCandidate`, which Task 1 confirms: `media_type: 'movie' | 'tv'`; `title: string`; `year: number | null`; `wikidata_qid: string | null`; `tvmaze_id: number | null`; `image_url`, `description`, `description_url`, `wikipedia_page`, `original_language: string | null`; `description_source: 'wikipedia' | 'tvmaze' | null`; `genres`, `directors`, `creators`, `writers`, `countries`, `main_subjects: string[]`; `based_on: { qid: string; title: string | null; author: string | null }[]`; `series`, `production_companies: { qid: string; label: string | null }[]`; `sitelinks: number`. (`tvmazeSingleSearch` is a plain `export function` returning a promise, not `async`; wave 5 Task 4.)

---

## Design decisions this plan makes (spec left them open)

1. **Gate change filter.** Title changes block a run only when the changed title has an effective rating, is `dropped`, or is a favorite, the same predicate `booksChangedSince` applies to books. Spec §6.2 says rec feedback "does not block the server gate". Without this filter the `want` row created by accepting a rec would block. See Review Focus 1.
2. **Seed movies resolve with a local copy of the §4.3 Stage A query** (exact `en`/`mul` label or alias + any P577 year, film class, best by sitelinks). It does not go through wave 5's `resolveMovies`, which is shaped for persisting library titles with confidence labels. The query is the spike's `books_only.py` lookup plus the popularity floor. That lookup resolved 20 of 20 book-derived seeds. Title variants come from wave 5's `titleVariants`.
3. **TV seeds check the year.** A TVmaze `singlesearch` hit whose premiere year differs from the seed's year by more than one is dropped. The spike did not check the year. This is a cheap guard against a same-named older show.
4. **The adaptation bridge queries both the series-stripped title and its pre-colon part**, as the spike did (`bridge_final.py`: `{t, t.split(':')[0]}`). The spike's 49-book / 102-candidate yield was measured with both. The author token-set check guards against the looser pre-colon match.
5. **Pool cap shares.** Of the 60 slots, seeds get a reserved `SEED_RESERVE_SHARE` (0.3, from `recAssemble.ts`). Adaptation candidates are capped at a 0.4 share (`ADAPTATION_MAX_SHARE`) so metadata candidates keep room. Multi-pool candidates go first, then seeds, adaptation, metadata, and a backfill. Hydration is capped at 90 candidates (`HYDRATE_CAP`) to bound Wikipedia summary fetches.
6. **Director/creator cap** keys on the first listed director (films) or creator (series), lowercased, at 2 per person, the same "first author" keying as `applyAuthorCaps`.
7. **Directive mapping** reuses `authorExcluded` and `subjectExcluded` from `exclusions.ts`, so screen exclusions match exactly as book exclusions do. That includes the inherited surname quirk. Languages map through `languageCode()`, which accepts an ISO 639-1 code or an English language label ("French", "Mandarin Chinese"). Unknown values pass.
8. **Feedback re-fetches metadata.** When accepting or marking already-watched, the route fetches the candidate's full metadata through `fetchScreenMetadata`, outside the transaction. That call is usually a `catalog_cache` hit from the run. The new `title_enrichment` row therefore carries directors, attribution and a description source. If the fetch fails, it falls back to the fields stored on the recommendation row.
9. **Feedback stamps `rec_feedback_updated_at` on every call** (spec §6.7), not only on rejects as the book route does.
10. **The new title from an accepted rec leaves `feedback_updated_at` null.** Creating a `want` or unrated `watched` row is not a rating change.
11. **Rate limit:** `RATE_LIMITS.screenRecommend = { limit: 3, windowSeconds: 60 }`. Each run spends two Claude calls and up to about 20 Wikimedia queries.
12. **Recording fixtures at the port level.** The fixture test (Task 11) records `ScreenCatalogPort` calls: query text to rows, show name to TVmaze show, QID to candidate. It does not record raw HTTP. This keeps the fixture independent of how wave 5 transports SPARQL (GET or POST), which the URL-keyed `installHttpReplay` cannot distinguish. Wave 5 owns the HTTP-level tests of its client.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `lib/server/anthropic.ts` | Modify | `trackedCreate` forwards optional request options (`signal`). |
| `lib/server/claude.ts` | Modify | `ClaudeClient.messages.create` accepts an optional options argument. |
| `lib/server/__tests__/helpers/fakeClaude.ts` | Modify | Records the options argument. |
| `lib/server/recSignal.ts` | Modify | Extract `loadTraitPayloads` and `loadDirective` (behavior-preserving) so the screen signal reads traits and the directive exactly as books do. |
| `lib/server/claudeErrors.ts` | Modify | Screen gate and timeout messages. |
| `lib/server/screenSignal.ts` | Create | `buildScreenSignal`: traits, loved books, loved titles, favorites, owned identity sets, owned list, rejected screen recs, title more/less-like, directive. |
| `lib/server/screenSparql.ts` | Create | Pure SPARQL builders and row readers for every pool, with escaping. |
| `lib/server/screenAssemble.ts` | Create | `ScreenCatalogPort`, the three pools, merge/floor/dedup, cap, hydrate, filters, `assembleScreenPool`. |
| `lib/server/screenRecPrompts.ts` | Create | Seed and rerank tools, systems and prompt builders; prompt-evidence id sets. |
| `lib/server/screenRecommendRun.ts` | Create | `runScreenRecommend`: gate, time budget, seeds, retrieval, rerank, #64, persistence. |
| `lib/server/screenRecs.ts` | Create | `titleRecOut`, `SCREEN_REJECT_REASONS`, `MEDIA_FILTERS`, `ensureScreenTitle`, feedback port seam. |
| `lib/server/ratelimit.ts` | Modify | `RATE_LIMITS.screenRecommend`. |
| `app/api/screen/recommend/route.ts` | Create | `POST`, literal `maxDuration = 300`. |
| `app/api/screen/recommendations/route.ts` | Create | `GET` latest run across filters. |
| `app/api/screen/recommendations/[id]/feedback/route.ts` | Create | `POST` accepted / already_watched / rejected. |
| `app/api/enrich/enrich-max-duration.test.ts` | Modify | Add `../screen/recommend/route.ts`. |
| `lib/server/__tests__/helpers/screenRecFixtures.ts` | Create | Synthetic screen library seeding, fake catalog port, row helpers. |
| `lib/server/__tests__/anthropic.test.ts` | Modify | Options forwarding test. |
| `lib/server/__tests__/rec-signal.test.ts` | Modify | `loadTraitPayloads` / `loadDirective` tests. |
| `lib/server/__tests__/screen-signal.test.ts` | Create | |
| `lib/server/__tests__/screen-sparql.test.ts` | Create | |
| `lib/server/__tests__/screen-pools.test.ts` | Create | |
| `lib/server/__tests__/screen-assemble.test.ts` | Create | |
| `lib/server/__tests__/screen-rec-prompts.test.ts` | Create | |
| `lib/server/__tests__/screen-recommend-run.test.ts` | Create | |
| `lib/server/__tests__/screen-recommend-routes.test.ts` | Create | |
| `lib/server/__tests__/screen-rec-feedback-route.test.ts` | Create | |
| `lib/server/__tests__/screen-recommend-fixture.test.ts` | Create | Record/replay integration test. |
| `lib/server/__tests__/fixtures/screen/recommend-port.json` | Create (controller-recorded) | Recorded port traffic. |
| `lib/server/__tests__/fixtures/screen/recommend-set.ts` | Create | The pool run and record/replay ports, shared by the recorder and the test (no vitest imports). |
| `scripts/record-screen-rec-fixture.ts` | Create | Controller-run recorder for `recommend-port.json`. |
| `docs/architecture.md`, `docs/conventions.md` | Modify | Screen recommender modules and invariants (Task 12). |

---

## Handoff batching

A controller's cost is its context size multiplied by its turn count. **Stop and hand off after Task 4 and after Task 8.** Keep the `.superpowers/sdd/` ledger current after every task, because the next session rebuilds its state from disk.

- **Batch A:** Tasks 1–4 (plumbing, signal, SPARQL) → hand off
- **Batch B:** Tasks 5–8 (pools, assembly, prompts, orchestration) → hand off
- **Batch C:** Tasks 9–12 (routes, feedback, recorded fixture, gates and real flow)

Task 11 Steps 1–3 need network access, so they are **controller steps**. A sandboxed implementer (Codex) cannot record fixtures.

---
### Task 1: Contract check and abortable Claude calls

The §6.4 budget needs the seed call aborted at 45 s. The installed SDK (`node_modules/@anthropic-ai/sdk`, 0.115) declares `messages.create(params, options?: RequestOptions)`, and `RequestOptions` includes `signal?: AbortSignal` (`internal/request-options.d.ts`, around line 91). This was verified while planning; re-check it in Step 2. `trackedCreate` and `ClaudeClient` currently drop that second argument.

**Files:**
- Modify: `lib/server/anthropic.ts` (the `MessagesClient` interface and `trackedCreate`, about lines 79–99)
- Modify: `lib/server/claude.ts:40-42` (`ClaudeClient`)
- Modify: `lib/server/__tests__/helpers/fakeClaude.ts`
- Test: `lib/server/__tests__/anthropic.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (Tasks 8, 11 rely on these):
  - `export interface RequestOptionsLike { signal?: AbortSignal }` in `lib/server/anthropic.ts`
  - `trackedCreate(client, db, meta, params, requestOptions?: RequestOptionsLike)`. With no fifth argument it calls `client.messages.create(params)` with exactly one argument, as today.
  - `ClaudeClient.messages.create(params: Record<string, unknown>, options?: RequestOptionsLike): Promise<ClaudeMessage>`
  - `RecordedCall { params: Record<string, unknown>; options?: RequestOptionsLike }` in `fakeClaude.ts`

- [ ] **Step 1: Verify every consumed export exists** (see "What this wave consumes")

Run each command and record its output in the ledger:

```bash
grep -n "export function modelFor" lib/server/models.ts
grep -n "export async function readRebuildReason" lib/server/profileMeta.ts
grep -n "export const titles = \|export const titleEnrichment = \|export const titleRecommendations = \|screenEnabled\|targetTitleId" lib/server/schema.ts
grep -n "create table titles\|create table title_enrichment\|create table title_recommendations\|screen_enabled\|target_title_id" lib/server/__tests__/helpers/pglite.ts
grep -n "export async function requireScreenEnabled" lib/server/screenSettings.ts
grep -n "export type TitleRow\|export function effectiveTitleRating\|export function isTitleProfileEvidence\|export function normalizeTitleKey\|export function titleOut" lib/server/titles.ts
grep -n "export type CatalogResult\|export interface Deadline\|export async function wikidataSparql\|export function tvmazeSingleSearch" lib/server/screenCatalog.ts
grep -n "export interface ScreenCandidate\|export async function fetchScreenMetadata" lib/server/screenEnrichment.ts
grep -n "export function titleVariants" lib/server/screenMatch.ts
grep -n "export async function titlesChangedSince" lib/server/screenProfile.ts
```

Expected: every command prints at least one line. If any prints nothing, **stop and report which export is missing**; later tasks cannot be written against it.

Then read the actual signatures of `wikidataSparql`, `tvmazeSingleSearch` and `fetchScreenMetadata`, and the `ScreenCandidate` field types:

```bash
grep -n -A12 "export async function wikidataSparql\|export function tvmazeSingleSearch\|export interface TvmazeShow" lib/server/screenCatalog.ts
grep -n -A30 "export interface ScreenCandidate" lib/server/screenEnrichment.ts
```

Record in the ledger:
- (a) the element type of the `wikidataSparql` result. This plan assumes WDQS `results.bindings` rows: `Record<string, { value: string }>`.
- (b) the `tvmazeSingleSearch` result value, which this plan assumes carries `id: number`, `name: string` and `premiered: string | null`.
- (c) any `ScreenCandidate` field whose type differs from the list under "What this wave consumes".

If (a) or (b) differ, adapt **only** `defaultScreenCatalogPort` in Task 5. If (c) differs, stop and report.

- [ ] **Step 2: Confirm the SDK option**

```bash
grep -n "signal?: AbortSignal" node_modules/@anthropic-ai/sdk/internal/request-options.d.ts
grep -n "create(params: MessageCreateParamsNonStreaming, options?: RequestOptions)" node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts
```

Expected: one line each. If not, stop and report; the seed abort design depends on it.

- [ ] **Step 3: Write the failing test**

Append to `lib/server/__tests__/anthropic.test.ts`, inside `describe('trackedCreate', …)`, after the existing test:

```ts
  it('forwards request options only when given, so existing callers still pass one argument', async () => {
    const calls: unknown[][] = [];
    const client = {
      messages: {
        create: async (...args: unknown[]) => {
          calls.push(args);
          return { content: [], usage: null };
        },
      },
    };
    const controller = new AbortController();
    await trackedCreate(
      client,
      db,
      { userId: 'u3', operation: 'screen_rec_seed' },
      { model: 'claude-haiku-4-5-20251001' },
      { signal: controller.signal }
    );
    await trackedCreate(
      client,
      db,
      { userId: 'u3', operation: 'screen_rec_seed' },
      { model: 'claude-haiku-4-5-20251001' }
    );
    expect(calls[0]).toHaveLength(2);
    expect((calls[0][1] as { signal: AbortSignal }).signal).toBe(controller.signal);
    expect(calls[1]).toHaveLength(1);
  });
```

- [ ] **Step 4: Run it and see it fail**

Run: `npx vitest run lib/server/__tests__/anthropic.test.ts -t "forwards request options"`
Expected: FAIL. `calls[0]` has length 1, and tsc-in-vitest may also flag the extra argument.

- [ ] **Step 5: Implement**

In `lib/server/anthropic.ts`, replace the `MessagesClient` interface and `trackedCreate` with:

```ts
/** The subset of the SDK's per-request options this app uses. */
export interface RequestOptionsLike {
  signal?: AbortSignal;
}

interface MessagesClient {
  messages: {
    create: (params: Record<string, unknown>, options?: RequestOptionsLike) => Promise<unknown>;
  };
}

export async function trackedCreate<T extends MessagesClient>(
  client: T,
  db: Db,
  meta: { userId: string; operation: string },
  params: { model: string } & Record<string, unknown>,
  // Optional and forwarded ONLY when given: every existing caller (and every test that
  // asserts `create` was called with exactly the params) keeps its one-argument call.
  requestOptions?: RequestOptionsLike
): Promise<Awaited<ReturnType<T['messages']['create']>>> {
  const pending = requestOptions
    ? client.messages.create(params, requestOptions)
    : client.messages.create(params);
  const message = (await pending) as Awaited<ReturnType<T['messages']['create']>>;
  const usage = (message as { usage?: UsageLike | null })?.usage ?? null;
  await recordUsage(db, {
    userId: meta.userId,
    model: params.model,
    operation: meta.operation,
    usage,
  });
  return message;
}
```

In `lib/server/claude.ts`, replace the `ClaudeClient` interface with:

```ts
export interface ClaudeClient {
  messages: {
    create(
      params: Record<string, unknown>,
      options?: { signal?: AbortSignal }
    ): Promise<ClaudeMessage>;
  };
}
```

In `lib/server/__tests__/helpers/fakeClaude.ts`, replace the file body with:

```ts
import type { ClaudeClient, ClaudeMessage } from '../../claude';

export interface RecordedCall {
  params: Record<string, unknown>;
  /** The per-request options (e.g. an AbortSignal), when the caller passed any. */
  options?: { signal?: AbortSignal };
}

/** Injectable Claude client. Records every create() call for prompt-parity
 *  assertions and returns queued responses in order. Never touches the network. */
export function fakeClaude(responses: ClaudeMessage[]): ClaudeClient & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let i = 0;
  return {
    calls,
    messages: {
      async create(params: Record<string, unknown>, options?: { signal?: AbortSignal }) {
        calls.push(options === undefined ? { params } : { params, options });
        if (i >= responses.length) throw new Error(`fakeClaude: no queued response #${i}`);
        return responses[i++];
      },
    },
  };
}
```

`calls.push({ params })` keeps the old object shape when there are no options, so existing `toEqual` assertions on `calls` do not change.

- [ ] **Step 6: Run the test and the suites that use these seams**

Run: `npx vitest run lib/server/__tests__/anthropic.test.ts lib/server/__tests__/recommend-run.test.ts lib/server/__tests__/profile-build.test.ts && npm run type-check`
Expected: PASS, and `tsc` clean.

- [ ] **Step 7: Commit**

```bash
git add lib/server/anthropic.ts lib/server/claude.ts lib/server/__tests__/helpers/fakeClaude.ts lib/server/__tests__/anthropic.test.ts
git commit -m "feat(screen): let trackedCreate forward an abort signal (#96)"
```

---

### Task 2: Shared trait and directive loading

Spec §6.2 says the screen signal uses "non-rejected traits with weight and status (reusing the book signal's trait loading)". This task extracts that code and the directive read from `buildSignal` without changing its behavior. `recommend-run.test.ts` pins the exact rerank prompt built from it, so any drift goes red.

**Files:**
- Modify: `lib/server/recSignal.ts` (the trait block, about lines 200–215, and the directive block, about lines 250–268, inside `buildSignal`)
- Test: `lib/server/__tests__/rec-signal.test.ts`

**Interfaces:**
- Produces:
  - `export async function loadTraitPayloads(db: Db, userId: string): Promise<TraitPayload[]>`
  - `export interface DirectiveSignal { directive_text: string | null; directive_constraints: Record<string, unknown> }`
  - `export async function loadDirective(db: Db, userId: string): Promise<DirectiveSignal>`

- [ ] **Step 1: Write the failing test**

Append to `lib/server/__tests__/rec-signal.test.ts`. Also add `loadDirective, loadTraitPayloads` to the existing import from `'../recSignal'`, and add `import { schema } from '../db';`:

```ts
describe('loadTraitPayloads / loadDirective', () => {
  test('returns only this user, drops rejected traits, orders by confidence then id', async () => {
    const { db, close } = await makeTestDb();
    try {
      await db.insert(schema.tasteTraits).values([
        { userId: 'local', claim: 'low', polarity: 'reward', inferenceConfidence: 0.2, status: 'proposed' },
        { userId: 'local', claim: 'high', polarity: 'aversion', inferenceConfidence: 0.9, status: 'confirmed', userWeight: 0.5 },
        { userId: 'local', claim: 'dead', polarity: 'reward', inferenceConfidence: 0.95, status: 'rejected' },
        { userId: 'other', claim: 'theirs', polarity: 'reward', inferenceConfidence: 0.99, status: 'proposed' },
      ]);
      const traits = await loadTraitPayloads(db, 'local');
      expect(traits.map((t) => t.claim)).toEqual(['high', 'low']);
      expect(traits[0]).toMatchObject({ polarity: 'aversion', status: 'confirmed' });
      expect(isPyFloat(traits[0].user_weight)).toBe(true);
    } finally {
      await close();
    }
  });

  test('ignores an empty directive row and reads a populated one', async () => {
    const { db, close } = await makeTestDb();
    try {
      await db.insert(schema.userDirective).values({ userId: 'local', nlText: null, constraints: {} });
      expect(await loadDirective(db, 'local')).toEqual({ directive_text: null, directive_constraints: {} });
      await db
        .update(schema.userDirective)
        .set({ nlText: 'No horror.', constraints: { exclude_subjects: ['horror'] } });
      expect(await loadDirective(db, 'local')).toEqual({
        directive_text: 'No horror.',
        directive_constraints: { exclude_subjects: ['horror'] },
      });
      expect(await loadDirective(db, 'other')).toEqual({ directive_text: null, directive_constraints: {} });
    } finally {
      await close();
    }
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run lib/server/__tests__/rec-signal.test.ts -t "loadTraitPayloads"`
Expected: FAIL, "loadTraitPayloads is not a function" or a missing export.

- [ ] **Step 3: Implement the extraction**

In `lib/server/recSignal.ts`, add these two functions above `buildSignal`:

```ts
/**
 * Every non-rejected trait with its weight and status, confidence desc then id. Shared by
 * buildSignal and the screen signal (screenSignal.ts, spec §6.2), which must read traits
 * exactly as the book recommender does.
 */
export async function loadTraitPayloads(db: Db, userId: string): Promise<TraitPayload[]> {
  const traitRows = await db
    .select()
    .from(schema.tasteTraits)
    .where(eq(schema.tasteTraits.userId, userId))
    .orderBy(desc(schema.tasteTraits.inferenceConfidence), asc(schema.tasteTraits.id));

  // Rejected traits are dead to the reranker -- excluded entirely. Each survivor
  // carries its user_weight + status so stage 2 can weight its influence.
  return traitRows
    .filter((t) => (t.status || 'proposed') !== REJECTED_STATUS)
    .map((t) => ({
      id: t.id,
      claim: t.claim,
      polarity: t.polarity,
      // pyFloat so json.dumps parity holds: Python renders 1.0, JSON.stringify renders 1.
      confidence: pyFloat(round2(t.inferenceConfidence)),
      user_weight: pyFloat(t.userWeight ?? 1.0),
      status: t.status || 'proposed',
    }));
}

export interface DirectiveSignal {
  directive_text: string | null;
  directive_constraints: Record<string, unknown>;
}

/** The reader's standing directive, shared by buildSignal and the screen signal. */
export async function loadDirective(db: Db, userId: string): Promise<DirectiveSignal> {
  const directiveRows = await db
    .select()
    .from(schema.userDirective)
    .where(eq(schema.userDirective.userId, userId));
  const directive = directiveRows[0];
  const storedConstraints = (directive?.constraints as Record<string, unknown> | null) ?? null;
  // Python: `if directive is not None and (directive.nl_text or directive.constraints)`.
  // `{}` is FALSY in Python, so a row with no text and empty constraints is ignored
  // entirely -- `!storedConstraints` would not reproduce that in JS.
  if (
    directive &&
    (directive.nlText || (storedConstraints && Object.keys(storedConstraints).length > 0))
  ) {
    return { directive_text: directive.nlText, directive_constraints: storedConstraints ?? {} };
  }
  return { directive_text: null, directive_constraints: {} };
}
```

In `buildSignal`, replace the whole trait block (from `const traitRows = await db` through the end of the `const traits: TraitPayload[] = …;` statement) with:

```ts
  const traits = await loadTraitPayloads(db, userId);
```

Replace the whole directive block (from `const directiveRows = await db` through the closing `}` of the `if (directive && …)` statement, including the `let directive_text` and `let directive_constraints` declarations) with:

```ts
  const { directive_text, directive_constraints } = await loadDirective(db, userId);
```

The returned object literal keeps its `traits`, `directive_text` and `directive_constraints` keys unchanged.

- [ ] **Step 4: Run the new tests and the snapshot suites that pin `buildSignal`**

Run: `npx vitest run lib/server/__tests__/rec-signal.test.ts lib/server/__tests__/recommend-run.test.ts lib/server/__tests__/rec-book-signal.test.ts lib/server/__tests__/similar-run.test.ts lib/server/__tests__/discover-run.test.ts`
Expected: PASS. If `recommend-run.test.ts`'s prompt snapshot fails, the extraction changed behavior. Revert it and diff the two blocks line by line; do not edit the snapshot.

- [ ] **Step 5: Commit**

```bash
git add lib/server/recSignal.ts lib/server/__tests__/rec-signal.test.ts
git commit -m "feat(screen): share trait and directive loading with the screen signal (#96)"
```

---

### Task 3: The screen signal

**Files:**
- Create: `lib/server/screenSignal.ts`
- Create: `lib/server/__tests__/helpers/screenRecFixtures.ts` (seeding half; Task 5 adds the fake port)
- Test: `lib/server/__tests__/screen-signal.test.ts`

**Interfaces:**
- Consumes: `loadTraitPayloads`, `loadDirective`, `mostCommon`, `LOVED_MIN`, `TraitPayload` from `recSignal.ts` (Task 2); `effectiveRating` (`serialize.ts`); `effectiveTitleRating`, `isTitleProfileEvidence`, `normalizeTitleKey` (w4 `titles.ts`); `schema.titles`, `schema.titleEnrichment`, `schema.titleRecommendations`, `schema.tasteSignal.targetTitleId`.
- Produces (Tasks 5–8 rely on these exact names):

```ts
export type MediaType = 'movie' | 'tv';
export const TOP_GENRES = 8;
export const TOP_PEOPLE = 6;
export const OWNED_LIST_CAP = 800;
export const REJECTED_LIST_CAP = 100;
export interface ScreenLovedBook { id: number; title: string; author: string | null; additional_authors: string[]; rating: number; read_year: number | null }
export interface ScreenLovedTitle { id: number; type: MediaType; title: string; year: number | null; rating: number; genres: string[]; people: string[]; wikidata_qid: string | null; watched_year: number | null }
export interface FavoriteBook { id: number; title: string; author: string | null }
export interface FavoriteTitle { id: number; type: MediaType; title: string; year: number | null }
export interface ScreenRejectedNote { title: string; year: number | null; type: MediaType; note: string }
export interface ScreenSignal {
  traits: TraitPayload[];
  loved_books: ScreenLovedBook[];      // ALL loved books, loved order
  loved_titles: ScreenLovedTitle[];    // ALL loved titles, loved order
  favorite_books: FavoriteBook[];
  favorite_titles: FavoriteTitle[];
  top_genres: string[];
  top_people: string[];
  original_languages: string[];
  owned_qids: Set<string>;             // every title's QID incl. want + rejected screen recs
  owned_tvmaze_ids: Set<number>;
  owned_keys: Set<string>;             // normalizeTitleKey(title, year)
  owned_list: string[];                // "Title (Year)", most recently watched first, capped
  rejected_list: string[];
  rejected_with_notes: ScreenRejectedNote[];
  more_like_titles: string[];
  less_like_titles: string[];
  reject_reason_counts: Map<string, number>;
  directive_text: string | null;
  directive_constraints: Record<string, unknown>;
}
export function titleLabel(title: string, year: number | null): string;
export async function buildScreenSignal(db: Db, userId: string): Promise<ScreenSignal>;
```

- [ ] **Step 1: Write the seeding helper**

Create `lib/server/__tests__/helpers/screenRecFixtures.ts`:

```ts
/**
 * Synthetic ScreenSprite library for wave 7 tests. Never shaped from a real export.
 *
 * Owner 'local': screen enabled, profiled at PROFILED_AT, with
 *   books  1 Leviathan Wakes (5, loved)   2 All Systems Red (4.5, loved, favorite)
 *          3 A Book I Disliked (2)        -- and 'other' owns book 4 (Dune)
 *   titles 1 Forrest Gump (movie, 4.5, Q134773)   2 Toy Story (movie, 5, favorite, Q171048)
 *          3 Arrival (movie, want, Q900003)       4 Severance (tv, 4, tvmaze 44778, Q900004)
 *          -- and 'other' owns title 5 (Heat, Q900099)
 *   traits 1 proposed   2 rejected   -- and 'other' owns trait 3
 * All enrichment resolved and all feedback stamped BEFORE PROFILED_AT, so the gate is clean.
 */
import { schema, type Db } from '../../db';

export const PROFILED_AT = '2026-09-10 00:00:00';
export const BEFORE = '2026-09-01 00:00:00';
export const AFTER = '2026-09-15 00:00:00';

export async function seedScreenLibrary(db: Db, opts: { enabled?: boolean } = {}): Promise<void> {
  await db.insert(schema.userSettings).values([
    { userId: 'local', screenEnabled: opts.enabled ?? true },
    { userId: 'other', screenEnabled: true },
  ]);
  await db.insert(schema.books).values([
    {
      userId: 'local',
      title: 'Leviathan Wakes (The Expanse, #1)',
      author: 'James S.A. Corey',
      goodreadsRating: 5,
      exclusiveShelf: 'read',
      dateRead: '2024-05-01',
      source: 'goodreads',
    },
    {
      userId: 'local',
      title: 'All Systems Red (The Murderbot Diaries, #1)',
      author: 'Martha Wells',
      goodreadsRating: 4.5,
      exclusiveShelf: 'read',
      dateRead: '2023-02-01',
      isFavorite: true,
      source: 'goodreads',
    },
    {
      userId: 'local',
      title: 'A Book I Disliked',
      author: 'Some Author',
      goodreadsRating: 2,
      exclusiveShelf: 'read',
      source: 'goodreads',
    },
    { userId: 'other', title: 'Dune', author: 'Frank Herbert', goodreadsRating: 5, source: 'goodreads' },
  ]);
  await db.insert(schema.titles).values([
    {
      userId: 'local',
      mediaType: 'movie',
      title: 'Forrest Gump',
      year: 1994,
      status: 'watched',
      letterboxdRating: 4.5,
      wikidataQid: 'Q134773',
      lastWatchedOn: '2025-01-02',
      feedbackUpdatedAt: BEFORE,
    },
    {
      userId: 'local',
      mediaType: 'movie',
      title: 'Toy Story',
      year: 1995,
      status: 'watched',
      letterboxdRating: 5,
      wikidataQid: 'Q171048',
      isFavorite: true,
      lastWatchedOn: '2024-03-03',
      feedbackUpdatedAt: BEFORE,
    },
    { userId: 'local', mediaType: 'movie', title: 'Arrival', year: 2016, status: 'want', wikidataQid: 'Q900003' },
    {
      userId: 'local',
      mediaType: 'tv',
      title: 'Severance',
      year: 2022,
      status: 'watched',
      appRating: 4,
      tvmazeId: 44778,
      lastWatchedOn: '2025-06-01',
      feedbackUpdatedAt: BEFORE,
    },
    {
      userId: 'other',
      mediaType: 'movie',
      title: 'Heat',
      year: 1995,
      status: 'watched',
      letterboxdRating: 5,
      wikidataQid: 'Q900099',
    },
  ]);
  const enr = (titleId: number, extra: Record<string, unknown>) => ({
    titleId,
    resolutionConfidence: 1,
    confidenceLabel: 'HIGH',
    matchMethod: 'test',
    identitySource: 'auto',
    resolvedAt: BEFORE,
    genres: [],
    directors: [],
    creators: [],
    ...extra,
  });
  await db.insert(schema.titleEnrichment).values([
    enr(1, { wikidataQid: 'Q134773', genres: ['drama film'], directors: ['Robert Zemeckis'], originalLanguage: 'English' }),
    enr(2, { wikidataQid: 'Q171048', genres: ['animated film', 'comedy film'], directors: ['John Lasseter'], originalLanguage: 'English' }),
    enr(3, { wikidataQid: 'Q900003', genres: ['science fiction film'] }),
    enr(4, { wikidataQid: 'Q900004', tvmazeId: 44778, genres: ['drama television series'], creators: ['Dan Erickson'], originalLanguage: 'English' }),
    enr(5, { wikidataQid: 'Q900099', genres: ['crime film'] }),
  ]);
  await db.insert(schema.tasteTraits).values([
    { userId: 'local', claim: 'Rewards slow-burn mysteries', polarity: 'reward', exhibits: [1], contrasts: [], exhibitTitleIds: [4], inferenceConfidence: 0.8, status: 'proposed' },
    { userId: 'local', claim: 'Rejected claim', polarity: 'reward', exhibits: [], contrasts: [], inferenceConfidence: 0.9, status: 'rejected' },
    { userId: 'other', claim: 'Their trait', polarity: 'reward', exhibits: [], contrasts: [], inferenceConfidence: 0.9, status: 'proposed' },
  ]);
  await db.insert(schema.profileMeta).values([{ userId: 'local', lastProfiledAt: PROFILED_AT }]);
}
```

If a column name in this helper does not compile, the wave 4 contract changed. Stop and report; do not rename it here.

- [ ] **Step 2: Write the failing test**

Create `lib/server/__tests__/screen-signal.test.ts`:

```ts
import { describe, test, expect } from 'vitest';
import { makeTestDb } from './helpers/pglite';
import { seedScreenLibrary } from './helpers/screenRecFixtures';
import { schema } from '../db';
import { buildScreenSignal, OWNED_LIST_CAP, titleLabel } from '../screenSignal';
import { normalizeTitleKey } from '../titles';

describe('buildScreenSignal', () => {
  test('reads loved books and titles, favorites and traits for this user only', async () => {
    const { db, close } = await makeTestDb();
    try {
      await seedScreenLibrary(db);
      const s = await buildScreenSignal(db, 'local');

      expect(s.loved_books.map((b) => b.id)).toEqual([1, 2]);
      expect(s.loved_books[0]).toMatchObject({ title: 'Leviathan Wakes (The Expanse, #1)', author: 'James S.A. Corey', rating: 5, read_year: 2024 });
      expect(s.favorite_books).toEqual([{ id: 2, title: 'All Systems Red (The Murderbot Diaries, #1)', author: 'Martha Wells' }]);

      // Loved = profile evidence with effective rating >= 4; want (Arrival) is never loved.
      expect(s.loved_titles.map((t) => t.id)).toEqual([2, 1, 4]);
      expect(s.loved_titles[2]).toMatchObject({ type: 'tv', wikidata_qid: 'Q900004', people: ['Dan Erickson'] });
      expect(s.favorite_titles).toEqual([{ id: 2, type: 'movie', title: 'Toy Story', year: 1995 }]);

      expect(s.traits.map((t) => t.id)).toEqual([1]);
      expect(s.top_genres).toContain('animated film');
      expect(s.original_languages).toEqual(['English']);
    } finally {
      await close();
    }
  });

  test('owned identity covers every status, including want, and never another user', async () => {
    const { db, close } = await makeTestDb();
    try {
      await seedScreenLibrary(db);
      const s = await buildScreenSignal(db, 'local');
      expect([...s.owned_qids].sort()).toEqual(['Q134773', 'Q171048', 'Q900003', 'Q900004']);
      expect([...s.owned_tvmaze_ids]).toEqual([44778]);
      expect(s.owned_keys.has(normalizeTitleKey('Arrival', 2016))).toBe(true);
      expect(s.owned_qids.has('Q900099')).toBe(false);
      // Most recently watched first; never-watched rows last.
      expect(s.owned_list).toEqual(['Severance (2022)', 'Forrest Gump (1994)', 'Toy Story (1995)', 'Arrival (2016)']);
    } finally {
      await close();
    }
  });

  test('rejected screen recs join the owned sets and carry their notes', async () => {
    const { db, close } = await makeTestDb();
    try {
      await seedScreenLibrary(db);
      await db.insert(schema.titleRecommendations).values([
        { userId: 'local', runId: 'r1', rank: 1, mediaType: 'movie', mediaFilter: 'both', title: 'Heat', year: 1995, wikidataQid: 'Q900050', score: 0.5, status: 'rejected', userNote: 'Too long', rejectReasons: ['too_long'] },
        { userId: 'other', runId: 'r2', rank: 1, mediaType: 'movie', mediaFilter: 'both', title: 'Other Rejected', year: 2000, wikidataQid: 'Q900051', score: 0.5, status: 'rejected' },
      ]);
      const s = await buildScreenSignal(db, 'local');
      expect(s.owned_qids.has('Q900050')).toBe(true);
      expect(s.owned_qids.has('Q900051')).toBe(false);
      expect(s.rejected_list).toEqual(['Heat (1995)']);
      expect(s.rejected_with_notes).toEqual([{ title: 'Heat', year: 1995, type: 'movie', note: 'Too long' }]);
      expect([...s.reject_reason_counts]).toEqual([['too_long', 1]]);
    } finally {
      await close();
    }
  });

  test('title more/less-like signals resolve to labels, scoped to this user', async () => {
    const { db, close } = await makeTestDb();
    try {
      await seedScreenLibrary(db);
      await db.insert(schema.tasteSignal).values([
        { userId: 'local', direction: 'more', targetKind: 'title', targetTitleId: 4 },
        { userId: 'local', direction: 'less', targetKind: 'title', targetTitleId: 1 },
        { userId: 'local', direction: 'more', targetKind: 'title', targetTitleId: 5 }, // other user's title
      ]);
      const s = await buildScreenSignal(db, 'local');
      expect(s.more_like_titles).toEqual(['Severance (2022)']);
      expect(s.less_like_titles).toEqual(['Forrest Gump (1994)']);
    } finally {
      await close();
    }
  });

  test('the owned list is capped', async () => {
    const { db, close } = await makeTestDb();
    try {
      await seedScreenLibrary(db);
      const many = Array.from({ length: OWNED_LIST_CAP + 5 }, (_, i) => ({
        userId: 'local',
        mediaType: 'movie',
        title: `Filler ${i}`,
        year: 2000,
        status: 'want',
      }));
      await db.insert(schema.titles).values(many);
      const s = await buildScreenSignal(db, 'local');
      expect(s.owned_list).toHaveLength(OWNED_LIST_CAP);
      expect(titleLabel('Untitled', null)).toBe('Untitled');
    } finally {
      await close();
    }
  });
});
```

- [ ] **Step 3: Run it and see it fail**

Run: `npx vitest run lib/server/__tests__/screen-signal.test.ts`
Expected: FAIL. `Cannot find module '../screenSignal'`.

- [ ] **Step 4: Implement**

Create `lib/server/screenSignal.ts`:

```ts
/**
 * The screen recommender's single read of the reader (spec §6.2). Mirrors recSignal.ts:
 * every query carries an explicit ORDER BY so prompts are deterministic.
 *
 * Two deliberate differences from the book signal:
 *  - It reads BOTH media. A book-built profile with no rated films is enough (spec §6.2:
 *    "No loved-titles requirement").
 *  - Owned identity covers every title status, `want` included, plus every rejected
 *    screen recommendation, keyed three ways: QID, TVmaze id and normalizeTitleKey.
 */
import { and, asc, desc, eq } from 'drizzle-orm';
import { schema, type Db } from './db';
import {
  LOVED_MIN,
  loadDirective,
  loadTraitPayloads,
  mostCommon,
  type TraitPayload,
} from './recSignal';
import { effectiveRating } from './serialize';
import { effectiveTitleRating, isTitleProfileEvidence, normalizeTitleKey } from './titles';

export type MediaType = 'movie' | 'tv';

export const TOP_GENRES = 8;
export const TOP_PEOPLE = 6;
/** Spec §6.3 / index decision 1: the seed prompt lists up to this many owned titles. */
export const OWNED_LIST_CAP = 800;
export const REJECTED_LIST_CAP = 100;

export interface ScreenLovedBook {
  id: number;
  title: string;
  author: string | null;
  additional_authors: string[];
  rating: number;
  read_year: number | null;
}

export interface ScreenLovedTitle {
  id: number;
  type: MediaType;
  title: string;
  year: number | null;
  rating: number;
  genres: string[];
  people: string[];
  wikidata_qid: string | null;
  watched_year: number | null;
}

export interface FavoriteBook {
  id: number;
  title: string;
  author: string | null;
}

export interface FavoriteTitle {
  id: number;
  type: MediaType;
  title: string;
  year: number | null;
}

export interface ScreenRejectedNote {
  title: string;
  year: number | null;
  type: MediaType;
  note: string;
}

export interface ScreenSignal {
  traits: TraitPayload[];
  loved_books: ScreenLovedBook[];
  loved_titles: ScreenLovedTitle[];
  favorite_books: FavoriteBook[];
  favorite_titles: FavoriteTitle[];
  top_genres: string[];
  top_people: string[];
  original_languages: string[];
  owned_qids: Set<string>;
  owned_tvmaze_ids: Set<number>;
  owned_keys: Set<string>;
  owned_list: string[];
  rejected_list: string[];
  rejected_with_notes: ScreenRejectedNote[];
  more_like_titles: string[];
  less_like_titles: string[];
  reject_reason_counts: Map<string, number>;
  directive_text: string | null;
  directive_constraints: Record<string, unknown>;
}

const REJECTED_STATUS = 'rejected';

function stringList(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    : [];
}

function yearOf(date: string | null): number | null {
  return date ? Number(date.slice(0, 4)) : null;
}

function asMediaType(v: string): MediaType {
  return v === 'tv' ? 'tv' : 'movie';
}

export function titleLabel(title: string, year: number | null): string {
  return year === null ? title : `${title} (${year})`;
}

export async function buildScreenSignal(db: Db, userId: string): Promise<ScreenSignal> {
  // --- books: loved (for the adaptation bridge and the prompts) and favorites ---
  const bookRows = await db
    .select()
    .from(schema.books)
    .where(eq(schema.books.userId, userId))
    .orderBy(asc(schema.books.id));
  const loved_books: ScreenLovedBook[] = [];
  const favorite_books: FavoriteBook[] = [];
  for (const b of bookRows) {
    if (b.isFavorite) favorite_books.push({ id: b.id, title: b.title, author: b.author });
    if (b.excludeFromProfile) continue;
    const rating = effectiveRating(b.appRating, b.goodreadsRating);
    if (rating === null || rating < LOVED_MIN) continue;
    loved_books.push({
      id: b.id,
      title: b.title,
      author: b.author,
      additional_authors: (b.additionalAuthors ?? '')
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean),
      rating,
      read_year: yearOf(b.dateRead ?? b.dateAdded),
    });
  }
  loved_books.sort(
    (x, y) => y.rating - x.rating || (y.read_year ?? 0) - (x.read_year ?? 0) || x.id - y.id
  );

  // --- titles: owned identity, loved titles, favorites, aggregates ---
  const titleRows = await db
    .select({ t: schema.titles, e: schema.titleEnrichment })
    .from(schema.titles)
    // 1:1 -- title_enrichment.title_id carries a unique index.
    .leftJoin(schema.titleEnrichment, eq(schema.titleEnrichment.titleId, schema.titles.id))
    .where(eq(schema.titles.userId, userId))
    .orderBy(asc(schema.titles.id));

  const owned_qids = new Set<string>();
  const owned_tvmaze_ids = new Set<number>();
  const owned_keys = new Set<string>();
  const loved_titles: ScreenLovedTitle[] = [];
  const favorite_titles: FavoriteTitle[] = [];
  const genreCounts = new Map<string, number>();
  const peopleCounts = new Map<string, number>();
  const languages: string[] = [];
  const titleById = new Map<number, { title: string; year: number | null }>();

  for (const { t, e } of titleRows) {
    const type = asMediaType(t.mediaType);
    titleById.set(t.id, { title: t.title, year: t.year });
    for (const qid of [t.wikidataQid, e?.wikidataQid ?? null]) if (qid) owned_qids.add(qid);
    for (const id of [t.tvmazeId, e?.tvmazeId ?? null]) if (id !== null) owned_tvmaze_ids.add(id);
    owned_keys.add(normalizeTitleKey(t.title, t.year));
    if (t.isFavorite) favorite_titles.push({ id: t.id, type, title: t.title, year: t.year });

    const rating = effectiveTitleRating(t);
    if (!isTitleProfileEvidence(t) || rating === null) continue;
    const lang = e?.originalLanguage ?? null;
    if (lang && !languages.includes(lang)) languages.push(lang);
    if (rating < LOVED_MIN) continue;

    const genres = stringList(e?.genres);
    const people = stringList(type === 'movie' ? e?.directors : e?.creators);
    for (const g of genres) genreCounts.set(g, (genreCounts.get(g) ?? 0) + 1);
    for (const p of people) peopleCounts.set(p, (peopleCounts.get(p) ?? 0) + 1);
    loved_titles.push({
      id: t.id,
      type,
      title: t.title,
      year: t.year,
      rating,
      genres: genres.slice(0, 8),
      people: people.slice(0, 3),
      wikidata_qid: t.wikidataQid ?? e?.wikidataQid ?? null,
      watched_year: yearOf(t.lastWatchedOn),
    });
  }
  loved_titles.sort(
    (x, y) =>
      y.rating - x.rating || (y.watched_year ?? 0) - (x.watched_year ?? 0) || x.id - y.id
  );

  // Most recently watched first; never-watched (want) rows after, newest added first.
  const owned_list: string[] = [];
  const seenLabels = new Set<string>();
  const byRecency = [...titleRows].sort((a, b) => {
    const aw = a.t.lastWatchedOn ?? '';
    const bw = b.t.lastWatchedOn ?? '';
    if (aw !== bw) return aw < bw ? 1 : -1;
    if (a.t.createdAt !== b.t.createdAt) return a.t.createdAt < b.t.createdAt ? 1 : -1;
    return b.t.id - a.t.id;
  });
  for (const { t } of byRecency) {
    if (owned_list.length >= OWNED_LIST_CAP) break;
    const label = titleLabel(t.title, t.year);
    if (seenLabels.has(label)) continue;
    seenLabels.add(label);
    owned_list.push(label);
  }

  // --- rejected screen recommendations: excluded from retrieval, testimony for the rerank ---
  const rejected = await db
    .select()
    .from(schema.titleRecommendations)
    .where(
      and(
        eq(schema.titleRecommendations.userId, userId),
        eq(schema.titleRecommendations.status, REJECTED_STATUS)
      )
    )
    .orderBy(asc(schema.titleRecommendations.id));
  const rejected_list: string[] = [];
  const rejected_with_notes: ScreenRejectedNote[] = [];
  const reject_reason_counts = new Map<string, number>();
  for (const r of rejected) {
    if (r.wikidataQid) owned_qids.add(r.wikidataQid);
    if (r.tvmazeId !== null) owned_tvmaze_ids.add(r.tvmazeId);
    owned_keys.add(normalizeTitleKey(r.title, r.year));
    if (rejected_list.length < REJECTED_LIST_CAP) rejected_list.push(titleLabel(r.title, r.year));
    if (r.userNote) {
      rejected_with_notes.push({
        title: r.title,
        year: r.year,
        type: asMediaType(r.mediaType),
        note: r.userNote,
      });
    }
    for (const reason of stringList(r.rejectReasons)) {
      reject_reason_counts.set(reason, (reject_reason_counts.get(reason) ?? 0) + 1);
    }
  }

  // --- title more/less-like signals (wave 6 writes target_kind = 'title') ---
  const signalRows = await db
    .select()
    .from(schema.tasteSignal)
    .where(and(eq(schema.tasteSignal.userId, userId), eq(schema.tasteSignal.targetKind, 'title')))
    .orderBy(asc(schema.tasteSignal.id));
  const more_like_titles: string[] = [];
  const less_like_titles: string[] = [];
  for (const sig of signalRows) {
    if (sig.targetTitleId === null) continue;
    // titleById is built from the user-scoped query above: another user's id never resolves.
    const target = titleById.get(sig.targetTitleId);
    if (!target) continue;
    const label = titleLabel(target.title, target.year);
    if (sig.direction === 'more') more_like_titles.push(label);
    else if (sig.direction === 'less') less_like_titles.push(label);
  }

  const traits = await loadTraitPayloads(db, userId);
  const { directive_text, directive_constraints } = await loadDirective(db, userId);

  return {
    traits,
    loved_books,
    loved_titles,
    favorite_books,
    favorite_titles,
    top_genres: mostCommon(genreCounts, TOP_GENRES),
    top_people: mostCommon(peopleCounts, TOP_PEOPLE),
    original_languages: languages,
    owned_qids,
    owned_tvmaze_ids,
    owned_keys,
    owned_list,
    rejected_list,
    rejected_with_notes,
    more_like_titles,
    less_like_titles,
    reject_reason_counts,
    directive_text,
    directive_constraints,
  };
}
```

`desc` is imported for symmetry with `recSignal.ts`. If lint flags it as unused, remove it from the import.

- [ ] **Step 5: Run the test**

Run: `npx vitest run lib/server/__tests__/screen-signal.test.ts`
Expected: PASS.

If the owned-list order assertion fails only because of `createdAt` ties, the seed inserted all rows within the same millisecond, and Arrival (never watched) must still be last. Check that the recency sort puts `''` (null) watch dates last. Fix the code, not the expected order.

- [ ] **Step 6: Mutation check (tenancy is load-bearing, spec §10)**

Temporarily delete `eq(schema.titles.userId, userId)` from the title query. Replace it with `sql\`true\``, importing `sql`. Run the test: `owned qids … never another user` must go red. Revert.

- [ ] **Step 7: Commit**

```bash
git add lib/server/screenSignal.ts lib/server/__tests__/helpers/screenRecFixtures.ts lib/server/__tests__/screen-signal.test.ts
git commit -m "feat(screen): build the screen recommendation signal (#96)"
```

---

### Task 4: SPARQL builders

Pure functions. Each one ports a query the spike ran against live WDQS on 2026-09-22 (`pool_meta.py`, `pool_tv.py`, `bridge_final.py`, `books_only.py`, `pool_tv.py`'s crosswalk). Every query adds the popularity floor and starts with a `# screen:<name>` comment line. The comment is a valid SPARQL comment, and the fake catalog port in later tests keys on it.

**Files:**
- Create: `lib/server/screenSparql.ts`
- Test: `lib/server/__tests__/screen-sparql.test.ts`

**Interfaces:**
- Produces (Tasks 5, 11):

```ts
export type SparqlRow = Record<string, { value: string } | undefined>;
export const POPULARITY_MIN_SITELINKS = 10;
export const FILM_CLASS = 'Q11424';
export const TV_SERIES_CLASS = 'Q5398426';
export const LOVED_PEOPLE_LIMIT = 150;
export const LOVED_GENRES_LIMIT = 40;
export function sparqlString(s: string): string;
export function isQid(v: string): boolean;
export function qidRef(qid: string): string;           // throws on a non-QID
export function qidOf(uri: string | undefined): string | null;
export function rowStr(row: SparqlRow, key: string): string | null;
export function rowInt(row: SparqlRow, key: string): number | null;
export function rowLabel(row: SparqlRow): string | null; // ?len, else ?lmul
export function lovedPeopleQuery(lovedQids: string[]): string;   // # screen:loved-people   -> ?p ?n
export function lovedGenresQuery(lovedQids: string[]): string;   // # screen:loved-genres   -> ?g ?n
export function metadataQuery(kind: 'movie' | 'tv', people: string[], genres: string[]): string;
                                                         // # screen:metadata-movie | metadata-tv -> ?f ?np ?ng ?nsl ?tvm ?len ?lmul ?yr
export interface AdaptationInput { variant: string; surname: string }
export function adaptationQuery(inputs: AdaptationInput[]): string;
                                                         // # screen:adaptation -> ?title ?an ?via ?src ?adapt ?kind ?tvm ?sl ?len ?lmul ?yr
export interface LabelYear { label: string; year: number }
export function seedMovieQuery(lookups: LabelYear[]): string;   // # screen:seed-movie -> ?name ?y ?q ?sl ?len ?lmul
export function tvmazeCrosswalkQuery(ids: number[]): string;    // # screen:tv-crosswalk -> ?s ?tvm ?sl ?len ?lmul ?yr
```

- [ ] **Step 1: Write the failing test**

Create `lib/server/__tests__/screen-sparql.test.ts`:

```ts
import { describe, test, expect } from 'vitest';
import {
  adaptationQuery,
  isQid,
  lovedGenresQuery,
  lovedPeopleQuery,
  metadataQuery,
  POPULARITY_MIN_SITELINKS,
  qidOf,
  qidRef,
  rowInt,
  rowLabel,
  seedMovieQuery,
  sparqlString,
  tvmazeCrosswalkQuery,
} from '../screenSparql';

const FLOOR = `FILTER(?sl >= ${POPULARITY_MIN_SITELINKS})`;
const ENWIKI = 'schema:isPartOf <https://en.wikipedia.org/>';

describe('escaping', () => {
  test('escapes user text: quotes, backslashes and newlines stay inside one literal', () => {
    const nasty = 'The "Real" Story\\\n} UNION { ?x ?y ?z';
    const lit = sparqlString(nasty);
    expect(lit.startsWith('"') && lit.endsWith('"')).toBe(true);
    expect(lit).toBe('"The \\"Real\\" Story\\\\\\n} UNION { ?x ?y ?z"');
    // The only unescaped quotes are the delimiters.
    expect(lit.slice(1, -1).replace(/\\\\|\\"/g, '')).not.toContain('"');
    expect(lit).not.toContain('\n');
    const q = adaptationQuery([{ variant: nasty, surname: 'o"brien' }]);
    expect(q).toContain(`(${lit}@en "o\\"brien")`);
  });

  test('qidRef rejects anything that is not a QID', () => {
    expect(qidRef('Q42')).toBe('wd:Q42');
    expect(() => qidRef('Q42 } ?x')).toThrow();
    expect(() => qidRef('P31')).toThrow();
    expect(isQid('Q0')).toBe(false);
    expect(qidOf('http://www.wikidata.org/entity/Q171048')).toBe('Q171048');
    expect(qidOf('http://www.wikidata.org/entity/P50')).toBeNull();
    expect(qidOf(undefined)).toBeNull();
  });

  test('row readers', () => {
    expect(rowInt({ n: { value: '12' } }, 'n')).toBe(12);
    expect(rowInt({ n: { value: 'x' } }, 'n')).toBeNull();
    expect(rowLabel({ lmul: { value: 'Toy Story' } })).toBe('Toy Story');
    expect(rowLabel({ len: { value: 'A' }, lmul: { value: 'B' } })).toBe('A');
  });
});

describe('queries', () => {
  test('loved people and genres aggregate over the loved QIDs', () => {
    const p = lovedPeopleQuery(['Q1', 'Q2']);
    expect(p.startsWith('# screen:loved-people\n')).toBe(true);
    expect(p).toContain('VALUES ?loved { wd:Q1 wd:Q2 }');
    expect(p).toContain('?loved wdt:P57|wdt:P58|wdt:P170 ?p .');
    expect(p).toContain('LIMIT 150');
    const g = lovedGenresQuery(['Q1']);
    expect(g.startsWith('# screen:loved-genres\n')).toBe(true);
    expect(g).toContain('?loved wdt:P136 ?g .');
    expect(g).toContain('LIMIT 40');
  });

  test('metadata queries require a person AND a genre, the class, and the floor', () => {
    const m = metadataQuery('movie', ['Q10'], ['Q20']);
    expect(m.startsWith('# screen:metadata-movie\n')).toBe(true);
    expect(m).toContain('?f wdt:P57|wdt:P58 ?p ; wdt:P136 ?g ; wdt:P31/wdt:P279* wd:Q11424 .');
    expect(m).toContain(FLOOR);
    expect(m).toContain(ENWIKI);
    expect(m).not.toContain('P8600');
    const t = metadataQuery('tv', ['Q10'], ['Q20']);
    expect(t.startsWith('# screen:metadata-tv\n')).toBe(true);
    expect(t).toContain('wdt:P170|wdt:P58|wdt:P57 ?p');
    expect(t).toContain('wd:Q5398426');
    expect(t).toContain('?f wdt:P8600 ?tvm0 .'); // TV must cross-walk: not OPTIONAL
  });

  test('the adaptation query matches the work or its series, en/mul, with the floor', () => {
    const q = adaptationQuery([{ variant: 'Leviathan Wakes', surname: 'corey' }]);
    expect(q.startsWith('# screen:adaptation\n')).toBe(true);
    expect(q).toContain('("Leviathan Wakes"@en "corey") ("Leviathan Wakes"@mul "corey")');
    expect(q).toContain('?work wdt:P179 ?ser . ?adapt wdt:P144 ?ser .');
    expect(q).toContain('FILTER(LANG(?an) IN ("en", "mul") && CONTAINS(LCASE(?an), ?surname))');
    expect(q).toContain(FLOOR);
    expect(q).toContain(ENWIKI);
    expect(q).toContain('OPTIONAL { ?adapt wdt:P8600 ?tvm }');
  });

  test('the seed movie lookup is exact label + year over en and mul', () => {
    const q = seedMovieQuery([{ label: 'Moon', year: 2009 }]);
    expect(q.startsWith('# screen:seed-movie\n')).toBe(true);
    expect(q).toContain('("Moon"@en 2009) ("Moon"@mul 2009)');
    expect(q).toContain('FILTER(YEAR(?d) = ?y)');
    expect(q).toContain(FLOOR);
    expect(() => seedMovieQuery([{ label: 'X', year: 2009.5 }])).toThrow();
  });

  test('the TV crosswalk keys on P8600 string ids', () => {
    const q = tvmazeCrosswalkQuery([44778, 1]);
    expect(q.startsWith('# screen:tv-crosswalk\n')).toBe(true);
    expect(q).toContain('VALUES ?tvm { "44778" "1" }');
    expect(q).toContain('?s wdt:P8600 ?tvm .');
    expect(q).toContain(FLOOR);
    expect(() => tvmazeCrosswalkQuery([1.5])).toThrow();
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run lib/server/__tests__/screen-sparql.test.ts`
Expected: FAIL. `Cannot find module '../screenSparql'`.

- [ ] **Step 3: Implement**

Create `lib/server/screenSparql.ts`:

```ts
/**
 * SPARQL for screen recommendation retrieval (spec §6.3), ported from the queries the
 * 2026-09-22 spike ran against live WDQS: pool_meta.py and pool_tv.py (metadata pool),
 * bridge_final.py (adaptation bridge with the series hop), books_only.py (seed film lookup)
 * and pool_tv.py's P8600 crosswalk. Pure string builders and row readers: no network.
 *
 * Every query adds the popularity floor the spike found necessary: an English Wikipedia
 * article and >= 10 sitelinks ("Talk 2 Me" at 0 sitelinks and *Bikini Frankenstein* both fell
 * below it). Every label read is en or mul (spec §2.1 finding 2a).
 *
 * INJECTION: book titles and Claude's seed titles are untrusted text. Every literal goes
 * through sparqlString -- JSON string escaping is valid SPARQL STRING_LITERAL2 (it escapes
 * `"` and `\`, and emits \n, \r, \uXXXX for control characters) -- and every entity through
 * qidRef, which throws on anything that is not a QID. Nothing is interpolated raw.
 *
 * Each query starts with a `# screen:<name>` comment. It is a legal SPARQL comment and the
 * key the test fake catalog port matches on.
 */
export type SparqlRow = Record<string, { value: string } | undefined>;

export const POPULARITY_MIN_SITELINKS = 10;
export const FILM_CLASS = 'Q11424';
export const TV_SERIES_CLASS = 'Q5398426';
/** pool_meta.py: the 150 most common people and 40 most common genres of loved titles. */
export const LOVED_PEOPLE_LIMIT = 150;
export const LOVED_GENRES_LIMIT = 40;

const QID_RE = /^Q[1-9]\d*$/;

export function sparqlString(s: string): string {
  return JSON.stringify(s);
}

export function isQid(v: string): boolean {
  return QID_RE.test(v);
}

export function qidRef(qid: string): string {
  if (!isQid(qid)) throw new Error(`not a Wikidata QID: ${qid}`);
  return `wd:${qid}`;
}

export function qidOf(uri: string | undefined): string | null {
  if (!uri) return null;
  const id = uri.slice(uri.lastIndexOf('/') + 1);
  return isQid(id) ? id : null;
}

export function rowStr(row: SparqlRow, key: string): string | null {
  const v = row[key]?.value;
  return v === undefined || v === '' ? null : v;
}

export function rowInt(row: SparqlRow, key: string): number | null {
  const v = rowStr(row, key);
  if (v === null) return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

/** The English label, else the `mul` one (famous items often carry only `mul`). */
export function rowLabel(row: SparqlRow): string | null {
  return rowStr(row, 'len') ?? rowStr(row, 'lmul');
}

function floor(v: string): string {
  return (
    `?${v} wikibase:sitelinks ?sl . FILTER(?sl >= ${POPULARITY_MIN_SITELINKS})\n` +
    `  ?art schema:about ?${v} ; schema:isPartOf <https://en.wikipedia.org/> .`
  );
}

function labels(v: string, en: string, mul: string): string {
  return (
    `OPTIONAL { ?${v} rdfs:label ?${en} FILTER(LANG(?${en}) = "en") }\n` +
    `  OPTIONAL { ?${v} rdfs:label ?${mul} FILTER(LANG(?${mul}) = "mul") }`
  );
}

function values(qids: string[]): string {
  return qids.map(qidRef).join(' ');
}

function assertInteger(n: number, what: string): void {
  if (!Number.isInteger(n)) throw new Error(`${what} must be an integer: ${n}`);
}

export function lovedPeopleQuery(lovedQids: string[]): string {
  return `# screen:loved-people
SELECT ?p (COUNT(DISTINCT ?loved) AS ?n) WHERE {
  VALUES ?loved { ${values(lovedQids)} }
  ?loved wdt:P57|wdt:P58|wdt:P170 ?p .
} GROUP BY ?p ORDER BY DESC(?n) ?p LIMIT ${LOVED_PEOPLE_LIMIT}`;
}

export function lovedGenresQuery(lovedQids: string[]): string {
  return `# screen:loved-genres
SELECT ?g (COUNT(DISTINCT ?loved) AS ?n) WHERE {
  VALUES ?loved { ${values(lovedQids)} }
  ?loved wdt:P136 ?g .
} GROUP BY ?g ORDER BY DESC(?n) ?g LIMIT ${LOVED_GENRES_LIMIT}`;
}

/**
 * Films (director or screenwriter) or series (creator, screenwriter or director) sharing a
 * person AND a genre with the loved titles, counted for ranking (spec §6.3: shared people,
 * then genres, then sitelinks). Series must carry a TVmaze id: `?f wdt:P8600 ?tvm0` is a
 * required triple, not OPTIONAL, so an uncross-walked show never comes back.
 */
export function metadataQuery(kind: 'movie' | 'tv', people: string[], genres: string[]): string {
  const peopleProps = kind === 'movie' ? 'wdt:P57|wdt:P58' : 'wdt:P170|wdt:P58|wdt:P57';
  const cls = kind === 'movie' ? FILM_CLASS : TV_SERIES_CLASS;
  const crosswalk = kind === 'tv' ? '\n  ?f wdt:P8600 ?tvm0 .' : '';
  const dateProps = kind === 'movie' ? 'wdt:P577' : 'wdt:P580|wdt:P577';
  return `# screen:metadata-${kind}
SELECT ?f (COUNT(DISTINCT ?p) AS ?np) (COUNT(DISTINCT ?g) AS ?ng) (SAMPLE(?sl) AS ?nsl) (SAMPLE(?tvm0) AS ?tvm) (SAMPLE(?len0) AS ?len) (SAMPLE(?lmul0) AS ?lmul) (MIN(YEAR(?d)) AS ?yr) WHERE {
  VALUES ?p { ${values(people)} }
  VALUES ?g { ${values(genres)} }
  ?f ${peopleProps} ?p ; wdt:P136 ?g ; wdt:P31/wdt:P279* wd:${cls} .${crosswalk}
  ${floor('f')}
  ${labels('f', 'len0', 'lmul0')}
  OPTIONAL { ?f ${dateProps} ?d }
} GROUP BY ?f`;
}

export interface AdaptationInput {
  variant: string;
  surname: string;
}

/**
 * bridge_final.py plus the floor: films and series based on (P144) the loved book's work
 * item OR that work's series item (P179). The series hop produced 41 of 102 bridge
 * candidates in the spike. The author label is restricted to en/mul here; the full
 * order-insensitive token-set comparison happens in screenAssemble.ts.
 */
export function adaptationQuery(inputs: AdaptationInput[]): string {
  const rows = inputs
    .flatMap(({ variant, surname }) =>
      ['@en', '@mul'].map((tag) => `(${sparqlString(variant)}${tag} ${sparqlString(surname)})`)
    )
    .join(' ');
  return `# screen:adaptation
SELECT DISTINCT ?title ?an ?via ?src ?adapt ?kind ?tvm ?sl ?len ?lmul ?yr WHERE {
  VALUES (?title ?surname) { ${rows} }
  ?work rdfs:label|skos:altLabel ?title ; wdt:P50 ?author .
  ?author rdfs:label ?an . FILTER(LANG(?an) IN ("en", "mul") && CONTAINS(LCASE(?an), ?surname))
  { ?adapt wdt:P144 ?work . BIND("work" AS ?via) BIND(?work AS ?src) }
  UNION { ?work wdt:P179 ?ser . ?adapt wdt:P144 ?ser . BIND("series" AS ?via) BIND(?ser AS ?src) }
  ${floor('adapt')}
  { ?adapt wdt:P31/wdt:P279* wd:${FILM_CLASS} . BIND("movie" AS ?kind) }
  UNION { ?adapt wdt:P31/wdt:P279* wd:${TV_SERIES_CLASS} . BIND("tv" AS ?kind) }
  OPTIONAL { ?adapt wdt:P8600 ?tvm }
  ${labels('adapt', 'len', 'lmul')}
  OPTIONAL { ?adapt wdt:P577|wdt:P580 ?d . BIND(YEAR(?d) AS ?yr) }
}`;
}

export interface LabelYear {
  label: string;
  year: number;
}

/** books_only.py plus the floor: an exact en/mul label or alias, a film, any P577 year. */
export function seedMovieQuery(lookups: LabelYear[]): string {
  for (const { year } of lookups) assertInteger(year, 'seed year');
  const rows = lookups
    .flatMap(({ label, year }) => ['@en', '@mul'].map((tag) => `(${sparqlString(label)}${tag} ${year})`))
    .join(' ');
  return `# screen:seed-movie
SELECT ?name ?y ?q ?sl ?len ?lmul WHERE {
  VALUES (?name ?y) { ${rows} }
  { ?q rdfs:label ?name } UNION { ?q skos:altLabel ?name }
  ?q wdt:P31/wdt:P279* wd:${FILM_CLASS} ; wdt:P577 ?d .
  FILTER(YEAR(?d) = ?y)
  ${floor('q')}
  ${labels('q', 'len', 'lmul')}
}`;
}

/** pool_tv.py's crosswalk plus the floor: TVmaze id -> Wikidata series (P8600). */
export function tvmazeCrosswalkQuery(ids: number[]): string {
  for (const id of ids) assertInteger(id, 'TVmaze id');
  const vals = ids.map((id) => sparqlString(String(id))).join(' ');
  return `# screen:tv-crosswalk
SELECT ?s ?tvm ?sl ?len ?lmul ?yr WHERE {
  VALUES ?tvm { ${vals} }
  ?s wdt:P8600 ?tvm .
  ${floor('s')}
  ${labels('s', 'len', 'lmul')}
  OPTIONAL { ?s wdt:P580|wdt:P577 ?d . BIND(YEAR(?d) AS ?yr) }
}`;
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run lib/server/__tests__/screen-sparql.test.ts`
Expected: PASS.

- [ ] **Step 5: Controller-only smoke check against live WDQS** (skip it in a sandbox without network, and say so in the ledger)

These builders are ports of queries that ran live, but string edits can break syntax. Run each builder once against WDQS with small real inputs. Use the app's User-Agent string from `lib/server/screenCatalog.ts`; it contains no personal data.

```bash
npx tsx -e "
import { lovedPeopleQuery, metadataQuery, adaptationQuery, seedMovieQuery, tvmazeCrosswalkQuery } from './lib/server/screenSparql';
const qs = {
  people: lovedPeopleQuery(['Q134773','Q171048']),
  meta: metadataQuery('movie', ['Q187364'], ['Q130232']),
  bridge: adaptationQuery([{ variant: 'Leviathan Wakes', surname: 'corey' }]),
  seed: seedMovieQuery([{ label: 'Moon', year: 2009 }]),
  xw: tvmazeCrosswalkQuery([44778]),
};
for (const [k, q] of Object.entries(qs)) {
  const r = await fetch('https://query.wikidata.org/sparql', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/sparql-results+json', 'user-agent': 'ShelfSprite/1.0 (https://shelfsprite.app)' }, body: new URLSearchParams({ query: q }) });
  const j = r.ok ? await r.json() : null;
  console.log(k, r.status, j ? j.results.bindings.length : await r.text());
  await new Promise((res) => setTimeout(res, 1500));
}
"
```

Expected: HTTP 200 for all five. `bridge` should return at least one row (*The Expanse*), and `seed` at least one (*Moon*, 2009). Record the counts you actually see. A 400 is a syntax error in the builder: fix the builder and add a test for the fixed fragment.

- [ ] **Step 6: Commit**

```bash
git add lib/server/screenSparql.ts lib/server/__tests__/screen-sparql.test.ts
git commit -m "feat(screen): SPARQL builders for screen retrieval (#96)"
```

**Hand off here (end of Batch A).**

---
### Task 5: The catalog port and the three Stage 1 pools

**Files:**
- Create: `lib/server/screenAssemble.ts` (port, pools; Task 6 appends assembly)
- Modify: `lib/server/__tests__/helpers/screenRecFixtures.ts` (append the fake port)
- Test: `lib/server/__tests__/screen-pools.test.ts`

**Interfaces:**
- Consumes: Task 4's builders and row readers; `ScreenSignal`, `ScreenLovedBook`, `MediaType` (Task 3); wave 5's `CatalogResult`, `Deadline`, `wikidataSparql`, `tvmazeSingleSearch`, `fetchScreenMetadata`, `ScreenCandidate`, `titleVariants`.
- Produces (Tasks 6, 8, 10, 11):

```ts
export type MediaFilter = 'both' | 'movie' | 'tv';
export type RetrievalPool = 'adaptation' | 'metadata' | 'claude_seed';
export interface TvmazeHit { id: number; name: string; premiered: string | null }
export interface ScreenCatalogPort {
  sparql(query: string): Promise<CatalogResult<SparqlRow[]>>;
  tvmazeSingleSearch(name: string): Promise<CatalogResult<TvmazeHit>>;
  fetchMetadata(qids: string[]): Promise<CatalogResult<Map<string, ScreenCandidate>>>;
}
export function defaultScreenCatalogPort(db: Db, deadline: Deadline): ScreenCatalogPort;
export interface AdaptationProvenance { book_id: number; book_title: string; source_qid: string; via: 'work' | 'series' }
export interface PoolHit { qid: string; media_type: MediaType; tvmaze_id: number | null; label: string | null; year: number | null; sitelinks: number; enwiki: boolean; pool: RetrievalPool; seed_reason: string; adaptation: AdaptationProvenance | null }
export interface SeedProposal { title: string; media_type: MediaType; year: number; reason: string }
export function allows(filter: MediaFilter, type: MediaType): boolean;
export function stripSeriesSuffix(title: string): string;
export function bookTitleVariants(title: string): string[];
export function authorTokens(name: string): string;
export function querySurname(author: string): string;
export async function metadataPool(port, signal, filter, deadline): Promise<PoolHit[]>;
export async function adaptationPool(port, signal, filter, deadline): Promise<PoolHit[]>;
export async function seedPool(port, seeds: SeedProposal[], deadline): Promise<PoolHit[]>;
```

- [ ] **Step 1: Append the fake port to the fixtures helper**

Append to `lib/server/__tests__/helpers/screenRecFixtures.ts`, and add these imports at the top of the file:

```ts
import type { ScreenCandidate } from '../../screenEnrichment';
import type { ScreenCatalogPort, TvmazeHit } from '../../screenAssemble';
import type { SparqlRow } from '../../screenSparql';
```

```ts
export const wd = (qid: string) => ({ value: `http://www.wikidata.org/entity/${qid}` });
export const lit = (v: string | number) => ({ value: String(v) });

/** A full ScreenCandidate with empty metadata, overridable per field. */
export function candidate(
  partial: Partial<ScreenCandidate> & { title: string; wikidata_qid: string }
): ScreenCandidate {
  return {
    media_type: 'movie',
    year: null,
    tvmaze_id: null,
    image_url: null,
    description: null,
    description_source: null,
    description_url: null,
    wikipedia_page: null,
    genres: [],
    directors: [],
    creators: [],
    writers: [],
    countries: [],
    original_language: null,
    based_on: [],
    main_subjects: [],
    series: [],
    production_companies: [],
    sitelinks: 50,
    ...partial,
  };
}

export interface FakePortScript {
  /** Keyed by the query's `# screen:<name>` marker; 'retryable' simulates a transport failure. */
  sparql?: Record<string, SparqlRow[] | 'retryable'>;
  tvmaze?: Record<string, TvmazeHit>;
  metadata?: Record<string, ScreenCandidate>;
  metadataRetryable?: boolean;
}

export type FakePort = ScreenCatalogPort & {
  queries: string[];
  tvmazeCalls: string[];
  metadataCalls: string[][];
};

export function fakeScreenPort(script: FakePortScript = {}): FakePort {
  const queries: string[] = [];
  const tvmazeCalls: string[] = [];
  const metadataCalls: string[][] = [];
  return {
    queries,
    tvmazeCalls,
    metadataCalls,
    async sparql(query) {
      queries.push(query);
      const marker = /^# screen:([a-z-]+)/.exec(query)?.[1] ?? '';
      const rows = script.sparql?.[marker];
      if (rows === 'retryable') return { kind: 'retryable', reason: 'fake transport failure' };
      if (!rows) return { kind: 'empty' };
      return { kind: 'ok', value: rows };
    },
    async tvmazeSingleSearch(name) {
      tvmazeCalls.push(name);
      const hit = script.tvmaze?.[name];
      return hit ? { kind: 'ok', value: hit } : { kind: 'empty' };
    },
    async fetchMetadata(qids) {
      metadataCalls.push([...qids]);
      if (script.metadataRetryable) return { kind: 'retryable', reason: 'fake transport failure' };
      const out = new Map<string, ScreenCandidate>();
      for (const q of qids) {
        const c = script.metadata?.[q];
        if (c) out.set(q, c);
      }
      return { kind: 'ok', value: out };
    },
  };
}

export const OPEN_DEADLINE = { remainingMs: () => 60_000 };
export const SPENT_DEADLINE = { remainingMs: () => 0 };
```

- [ ] **Step 2: Write the failing test**

Create `lib/server/__tests__/screen-pools.test.ts`:

```ts
import { describe, test, expect } from 'vitest';
import {
  adaptationPool,
  authorTokens,
  bookTitleVariants,
  metadataPool,
  querySurname,
  seedPool,
  stripSeriesSuffix,
} from '../screenAssemble';
import type { ScreenLovedBook, ScreenLovedTitle } from '../screenSignal';
import { fakeScreenPort, lit, OPEN_DEADLINE, SPENT_DEADLINE, wd } from './helpers/screenRecFixtures';

const owned = { owned_qids: new Set(['Q134773']), owned_tvmaze_ids: new Set([44778]) };

function lovedTitle(id: number, qid: string | null): ScreenLovedTitle {
  return { id, type: 'movie', title: `T${id}`, year: 2000, rating: 5, genres: [], people: [], wikidata_qid: qid, watched_year: null };
}

function book(id: number, title: string, author: string | null, extra: string[] = []): ScreenLovedBook {
  return { id, title, author, additional_authors: extra, rating: 5, read_year: 2024 };
}

describe('title and author helpers', () => {
  test('strip the Goodreads series suffix and add the pre-colon variant', () => {
    expect(stripSeriesSuffix('Leviathan Wakes (The Expanse, #1)')).toBe('Leviathan Wakes');
    expect(stripSeriesSuffix('Golden Son (Red Rising Saga, #2)')).toBe('Golden Son');
    expect(stripSeriesSuffix('Piranesi')).toBe('Piranesi');
    expect(bookTitleVariants('Shōgun: A Novel of Japan (Asian Saga, #1)')).toEqual(['Shōgun: A Novel of Japan', 'Shōgun']);
    expect(bookTitleVariants('三体')).toEqual(['三体']);
  });

  test('author matching is an order-insensitive token set', () => {
    expect(authorTokens('Liu Cixin')).toBe(authorTokens('Cixin Liu'));
    expect(authorTokens('James S.A. Corey')).toBe(authorTokens('James S. A. Corey'));
    expect(authorTokens('Stephen King')).not.toBe(authorTokens('Stifn King'));
    expect(querySurname('James S.A. Corey')).toBe('corey');
  });
});

describe('metadataPool', () => {
  const rows = [
    { f: wd('Q5001'), np: lit(1), ng: lit(3), nsl: lit(40), len: lit('Film A'), yr: lit(2001) },
    { f: wd('Q5002'), np: lit(2), ng: lit(1), nsl: lit(20), lmul: lit('Film B'), yr: lit(2002) },
    { f: wd('Q134773'), np: lit(5), ng: lit(5), nsl: lit(99), len: lit('Forrest Gump'), yr: lit(1994) },
  ];

  test('ranks by shared people, then genres, then sitelinks, dropping owned films', async () => {
    const port = fakeScreenPort({
      sparql: {
        'loved-people': [{ p: wd('Q10'), n: lit(2) }],
        'loved-genres': [{ g: wd('Q20'), n: lit(2) }],
        'metadata-movie': rows,
      },
    });
    const hits = await metadataPool(port, { ...owned, loved_titles: [lovedTitle(1, 'Q1'), lovedTitle(2, null)] }, 'movie', OPEN_DEADLINE);
    expect(hits.map((h) => h.qid)).toEqual(['Q5002', 'Q5001']);
    expect(hits[0]).toMatchObject({ media_type: 'movie', label: 'Film B', year: 2002, sitelinks: 20, pool: 'metadata', seed_reason: 'metadata:people=2;genres=1' });
    expect(port.queries.some((q) => q.startsWith('# screen:metadata-tv'))).toBe(false);
    expect(port.queries[0]).toContain('VALUES ?loved { wd:Q1 }');
  });

  test('series hits carry their TVmaze id; no loved QIDs means no queries at all', async () => {
    const port = fakeScreenPort({
      sparql: {
        'loved-people': [{ p: wd('Q10'), n: lit(1) }],
        'loved-genres': [{ g: wd('Q20'), n: lit(1) }],
        'metadata-tv': [{ f: wd('Q6001'), np: lit(1), ng: lit(1), nsl: lit(30), tvm: lit(123), len: lit('Show'), yr: lit(2019) }],
      },
    });
    const hits = await metadataPool(port, { ...owned, loved_titles: [lovedTitle(1, 'Q1')] }, 'tv', OPEN_DEADLINE);
    expect(hits).toEqual([expect.objectContaining({ qid: 'Q6001', media_type: 'tv', tvmaze_id: 123 })]);

    const empty = fakeScreenPort();
    expect(await metadataPool(empty, { ...owned, loved_titles: [lovedTitle(1, null)] }, 'both', OPEN_DEADLINE)).toEqual([]);
    expect(empty.queries).toEqual([]);
  });

  test('a spent deadline or a retryable failure yields nothing, never a throw', async () => {
    const port = fakeScreenPort({ sparql: { 'loved-people': 'retryable' } });
    expect(await metadataPool(port, { ...owned, loved_titles: [lovedTitle(1, 'Q1')] }, 'both', OPEN_DEADLINE)).toEqual([]);
    const spent = fakeScreenPort();
    expect(await metadataPool(spent, { ...owned, loved_titles: [lovedTitle(1, 'Q1')] }, 'both', SPENT_DEADLINE)).toEqual([]);
    expect(spent.queries).toEqual([]);
  });
});

describe('adaptationPool', () => {
  const adaptRow = (o: { title: string; an: string; qid: string; kind: 'movie' | 'tv'; sl: number; via?: string; src?: string; tvm?: number; label?: string }) => ({
    title: lit(o.title),
    an: lit(o.an),
    via: lit(o.via ?? 'work'),
    src: wd(o.src ?? 'Q7000'),
    adapt: wd(o.qid),
    kind: lit(o.kind),
    sl: lit(o.sl),
    ...(o.tvm === undefined ? {} : { tvm: lit(o.tvm) }),
    len: lit(o.label ?? o.qid),
    yr: lit(2015),
  });

  test('matches work or series, checks the author token set, requires a TVmaze id for series', async () => {
    const port = fakeScreenPort({
      sparql: {
        adaptation: [
          adaptRow({ title: 'Leviathan Wakes', an: 'James S. A. Corey', qid: 'Q8001', kind: 'tv', sl: 60, via: 'series', src: 'Q7001', tvm: 1825, label: 'The Expanse' }),
          adaptRow({ title: 'Leviathan Wakes', an: 'James S. A. Corey', qid: 'Q8002', kind: 'tv', sl: 55 }), // no tvm
          adaptRow({ title: 'Leviathan Wakes', an: 'Somebody Else Corey', qid: 'Q8003', kind: 'movie', sl: 50 }),
          adaptRow({ title: 'All Systems Red', an: 'Martha Wells', qid: 'Q8004', kind: 'tv', sl: 30, via: 'series', tvm: 60000, label: 'Murderbot' }),
        ],
      },
    });
    const signal = {
      ...owned,
      loved_books: [
        book(1, 'Leviathan Wakes (The Expanse, #1)', 'James S.A. Corey'),
        book(2, 'All Systems Red (The Murderbot Diaries, #1)', 'Martha Wells'),
        book(3, 'Anonymous Book', null),
      ],
    };
    const hits = await adaptationPool(port, signal, 'both', OPEN_DEADLINE);
    expect(hits.map((h) => h.qid)).toEqual(['Q8001', 'Q8004']);
    expect(hits[0]).toMatchObject({
      media_type: 'tv',
      tvmaze_id: 1825,
      label: 'The Expanse',
      pool: 'adaptation',
      seed_reason: 'adaptation:series=Q7001;book=1',
      adaptation: { book_id: 1, book_title: 'Leviathan Wakes (The Expanse, #1)', source_qid: 'Q7001', via: 'series' },
    });
    expect(port.queries[0]).toContain('("Leviathan Wakes"@en "corey")');
    expect(port.queries[0]).not.toContain('The Expanse, #1');
    expect(port.queries[0]).not.toContain('Anonymous Book');
  });

  test('caps three per book by sitelinks and never repeats a candidate across books', async () => {
    const rows = [1, 2, 3, 4].map((n) => adaptRow({ title: 'Dune', an: 'Frank Herbert', qid: `Q90${n}`, kind: 'movie', sl: 10 * n }));
    rows.push(adaptRow({ title: 'Dune Messiah', an: 'Frank Herbert', qid: 'Q904', kind: 'movie', sl: 40 }));
    rows.push(adaptRow({ title: 'Dune Messiah', an: 'Frank Herbert', qid: 'Q905', kind: 'movie', sl: 15 }));
    const port = fakeScreenPort({ sparql: { adaptation: rows } });
    const hits = await adaptationPool(
      port,
      { ...owned, loved_books: [book(1, 'Dune', 'Frank Herbert'), book(2, 'Dune Messiah', 'Frank Herbert')] },
      'movie',
      OPEN_DEADLINE
    );
    expect(hits.map((h) => [h.qid, h.adaptation?.book_id])).toEqual([
      ['Q904', 1],
      ['Q903', 1],
      ['Q902', 1],
      ['Q905', 2],
    ]);
  });

  test('matches an additional author and honors the media filter', async () => {
    const port = fakeScreenPort({
      sparql: { adaptation: [adaptRow({ title: 'Good Omens', an: 'Neil Gaiman', qid: 'Q9500', kind: 'tv', sl: 80, tvm: 5 })] },
    });
    const signal = { ...owned, loved_books: [book(1, 'Good Omens', 'Terry Pratchett', ['Neil Gaiman'])] };
    expect((await adaptationPool(port, signal, 'both', OPEN_DEADLINE)).map((h) => h.qid)).toEqual(['Q9500']);
    expect(await adaptationPool(port, signal, 'movie', OPEN_DEADLINE)).toEqual([]);
  });
});

describe('seedPool', () => {
  test('resolves films by exact label + year (best sitelinks) and shows via TVmaze + crosswalk', async () => {
    const port = fakeScreenPort({
      sparql: {
        'seed-movie': [
          { name: lit('Moon'), y: lit(2009), q: wd('Q11001'), sl: lit(12), len: lit('Moon') },
          { name: lit('Moon'), y: lit(2009), q: wd('Q11002'), sl: lit(70), len: lit('Moon') },
        ],
        'tv-crosswalk': [{ s: wd('Q12001'), tvm: lit(1825), sl: lit(60), len: lit('The Expanse') }],
      },
      tvmaze: {
        'The Expanse': { id: 1825, name: 'The Expanse', premiered: '2015-12-14' },
        'Old Show': { id: 77, name: 'Old Show', premiered: '1990-01-01' },
        'Not Crosswalked': { id: 999, name: 'Not Crosswalked', premiered: '2020-01-01' },
      },
    });
    const hits = await seedPool(
      port,
      [
        { title: 'Moon', media_type: 'movie', year: 2009, reason: 'quiet isolation sci-fi' },
        { title: 'The Expanse', media_type: 'tv', year: 2015, reason: 'loved the books' },
        { title: 'Old Show', media_type: 'tv', year: 2021, reason: 'wrong year' },
        { title: 'Not Crosswalked', media_type: 'tv', year: 2020, reason: 'no P8600' },
      ],
      OPEN_DEADLINE
    );
    expect(hits.map((h) => [h.qid, h.media_type, h.tvmaze_id])).toEqual([
      ['Q11002', 'movie', null],
      ['Q12001', 'tv', 1825],
    ]);
    expect(hits[0].seed_reason).toBe('seed:quiet isolation sci-fi');
    expect(port.tvmazeCalls).toEqual(['The Expanse', 'Old Show', 'Not Crosswalked']);
  });

  test('a spent deadline makes no calls', async () => {
    const port = fakeScreenPort();
    expect(await seedPool(port, [{ title: 'X', media_type: 'tv', year: 2020, reason: '' }], SPENT_DEADLINE)).toEqual([]);
    expect(port.tvmazeCalls).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it and see it fail**

Run: `npx vitest run lib/server/__tests__/screen-pools.test.ts`
Expected: FAIL. `Cannot find module '../screenAssemble'`.

- [ ] **Step 4: Implement**

Create `lib/server/screenAssemble.ts`:

```ts
/**
 * Stage 1 retrieval for screen recommendations (spec §6.3). Three pools, all real catalog
 * items: a metadata pool (people + genre overlap with loved titles), an adaptation bridge
 * (films and series based on a loved book's work or its series) and Claude's comparable
 * titles resolved by exact title + year. Claude never contributes a candidate directly.
 *
 * Every catalog call goes through ScreenCatalogPort, whose only production implementation
 * (defaultScreenCatalogPort) wraps wave 5's client. Tests inject a fake. Calls are made
 * SEQUENTIALLY: wave 5's per-host throttles assume serial calls.
 *
 * Failure is never fatal here. A retryable transport failure or a spent deadline yields an
 * empty pool; the run serves whatever the other pools found.
 */
import type { Db } from './db';
import { logDebug } from './log';
import {
  tvmazeSingleSearch,
  wikidataSparql,
  type CatalogResult,
  type Deadline,
} from './screenCatalog';
import { fetchScreenMetadata, type ScreenCandidate } from './screenEnrichment';
import { titleVariants } from './screenMatch';
import type { MediaType, ScreenLovedBook, ScreenSignal } from './screenSignal';
import {
  adaptationQuery,
  lovedGenresQuery,
  lovedPeopleQuery,
  metadataQuery,
  qidOf,
  rowInt,
  rowLabel,
  rowStr,
  seedMovieQuery,
  tvmazeCrosswalkQuery,
  type AdaptationInput,
  type LabelYear,
  type SparqlRow,
} from './screenSparql';

export type MediaFilter = 'both' | 'movie' | 'tv';
export type RetrievalPool = 'adaptation' | 'metadata' | 'claude_seed';

/** Loved titles fed to the people/genre aggregation (most loved first). */
export const METADATA_LOVED_CAP = 100;
/** Per medium, after ranking. The spike kept the top 60 films; series are thinner. */
export const METADATA_POOL_LIMIT = 80;
/** Spec §6.3: at most 3 candidates per book, each candidate once however many books hit it. */
export const ADAPTATIONS_PER_BOOK = 3;
/** Input tuples per adaptation query, as in the spike (bridge_final.py). */
export const ADAPTATION_BATCH = 60;
export const SEED_MOVIE_BATCH = 20;
/** A TVmaze hit whose premiere year is further than this from the seed's year is dropped. */
export const SEED_TV_YEAR_TOLERANCE = 1;

export interface TvmazeHit {
  id: number;
  name: string;
  premiered: string | null;
}

export interface ScreenCatalogPort {
  sparql(query: string): Promise<CatalogResult<SparqlRow[]>>;
  tvmazeSingleSearch(name: string): Promise<CatalogResult<TvmazeHit>>;
  fetchMetadata(qids: string[]): Promise<CatalogResult<Map<string, ScreenCandidate>>>;
}

/**
 * The ONLY place wave 7 touches wave 5's client signatures. If Task 1's contract check found
 * a different result shape, adapt it here and nowhere else.
 */
export function defaultScreenCatalogPort(db: Db, deadline: Deadline): ScreenCatalogPort {
  return {
    sparql: (query) => wikidataSparql(db, query, deadline),
    tvmazeSingleSearch: async (name) => {
      const res = await tvmazeSingleSearch(db, name, deadline);
      if (res.kind !== 'ok') return res;
      return {
        kind: 'ok',
        value: { id: res.value.id, name: res.value.name, premiered: res.value.premiered ?? null },
      };
    },
    fetchMetadata: (qids) => fetchScreenMetadata(db, qids, deadline),
  };
}

export interface AdaptationProvenance {
  book_id: number;
  book_title: string;
  source_qid: string;
  via: 'work' | 'series';
}

export interface PoolHit {
  qid: string;
  media_type: MediaType;
  tvmaze_id: number | null;
  label: string | null;
  year: number | null;
  sitelinks: number;
  /** Has an English Wikipedia article. Every pool query requires one, so hits carry true. */
  enwiki: boolean;
  pool: RetrievalPool;
  seed_reason: string;
  adaptation: AdaptationProvenance | null;
}

export interface SeedProposal {
  title: string;
  media_type: MediaType;
  year: number;
  reason: string;
}

export function allows(filter: MediaFilter, type: MediaType): boolean {
  return filter === 'both' || filter === type;
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function yearOfDate(date: string | null): number | null {
  if (!date) return null;
  const y = Number(date.slice(0, 4));
  return Number.isInteger(y) ? y : null;
}

async function rowsOf(
  port: ScreenCatalogPort,
  query: string,
  deadline: Deadline,
  what: string
): Promise<SparqlRow[]> {
  if (deadline.remainingMs() <= 0) return [];
  const res = await port.sparql(query);
  if (res.kind === 'ok') return res.value;
  if (res.kind === 'retryable') {
    logDebug('screen-recommend', `${what} query skipped`, { reason: res.reason });
  }
  return [];
}

// --- metadata pool ---------------------------------------------------------------------

/**
 * pool_meta.py / pool_tv.py: the most common people and genres of the loved titles, then
 * films and series sharing a person AND a genre, ranked by shared people, then genres, then
 * sitelinks. Owned titles are dropped BEFORE the per-medium limit so they cannot crowd it.
 */
export async function metadataPool(
  port: ScreenCatalogPort,
  signal: Pick<ScreenSignal, 'loved_titles' | 'owned_qids' | 'owned_tvmaze_ids'>,
  filter: MediaFilter,
  deadline: Deadline
): Promise<PoolHit[]> {
  const loved = uniq(
    signal.loved_titles
      .map((t) => t.wikidata_qid)
      .filter((q): q is string => q !== null && /^Q[1-9]\d*$/.test(q))
  ).slice(0, METADATA_LOVED_CAP);
  if (!loved.length) return [];

  const people = (await rowsOf(port, lovedPeopleQuery(loved), deadline, 'loved people'))
    .map((r) => qidOf(r.p?.value))
    .filter((q): q is string => q !== null);
  if (!people.length) return [];
  const genres = (await rowsOf(port, lovedGenresQuery(loved), deadline, 'loved genres'))
    .map((r) => qidOf(r.g?.value))
    .filter((q): q is string => q !== null);
  if (!genres.length) return [];

  const hits: PoolHit[] = [];
  for (const kind of ['movie', 'tv'] as const) {
    if (!allows(filter, kind)) continue;
    const rows = await rowsOf(port, metadataQuery(kind, people, genres), deadline, `metadata ${kind}`);
    const ranked = rows
      .map((r) => ({
        qid: qidOf(r.f?.value),
        np: rowInt(r, 'np') ?? 0,
        ng: rowInt(r, 'ng') ?? 0,
        sl: rowInt(r, 'nsl') ?? 0,
        tvm: rowInt(r, 'tvm'),
        label: rowLabel(r),
        year: rowInt(r, 'yr'),
      }))
      .filter(
        (x): x is typeof x & { qid: string } =>
          x.qid !== null &&
          !signal.owned_qids.has(x.qid) &&
          !(x.tvm !== null && signal.owned_tvmaze_ids.has(x.tvm))
      )
      .sort((a, b) => b.np - a.np || b.ng - a.ng || b.sl - a.sl || (a.qid < b.qid ? -1 : 1))
      .slice(0, METADATA_POOL_LIMIT);
    for (const x of ranked) {
      hits.push({
        qid: x.qid,
        media_type: kind,
        tvmaze_id: kind === 'tv' ? x.tvm : null,
        label: x.label,
        year: x.year,
        sitelinks: x.sl,
        enwiki: true,
        pool: 'metadata',
        seed_reason: `metadata:people=${x.np};genres=${x.ng}`,
        adaptation: null,
      });
    }
  }
  return hits;
}

// --- adaptation bridge --------------------------------------------------------------------

/** Goodreads appends the series as a trailing parenthetical with a '#': "(The Expanse, #1)". */
export function stripSeriesSuffix(title: string): string {
  return title.replace(/\s*\([^)]*#[^)]*\)\s*$/u, '').trim();
}

/** The series-stripped full title and its pre-colon part (bridge_final.py). Unicode-safe. */
export function bookTitleVariants(title: string): string[] {
  const base = stripSeriesSuffix(title.normalize('NFC'));
  const pre = base.split(':')[0].trim();
  return uniq([base, pre].filter((v) => v !== ''));
}

/**
 * An order-insensitive token set, so "Liu Cixin" matches "Cixin Liu" (spec §6.3). Letters of
 * any script are kept (\p{L}); JS's \w is ASCII-only and would erase non-Latin names.
 */
export function authorTokens(name: string): string {
  return uniq(
    name
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean)
  )
    .sort()
    .join(' ');
}

/** The spike's coarse SPARQL pre-filter: the author's last whitespace token, lowercased. */
export function querySurname(author: string): string {
  const parts = author.trim().toLowerCase().split(/\s+/);
  return parts[parts.length - 1] ?? '';
}

interface FoundAdaptation {
  qid: string;
  kind: MediaType;
  tvm: number | null;
  sl: number;
  label: string | null;
  year: number | null;
  via: 'work' | 'series';
  src: string;
}

export async function adaptationPool(
  port: ScreenCatalogPort,
  signal: Pick<ScreenSignal, 'loved_books' | 'owned_qids' | 'owned_tvmaze_ids'>,
  filter: MediaFilter,
  deadline: Deadline
): Promise<PoolHit[]> {
  const inputs: AdaptationInput[] = [];
  const inputKeys = new Set<string>();
  const booksByVariant = new Map<string, ScreenLovedBook[]>();
  for (const book of signal.loved_books) {
    if (!book.author) continue; // nothing to match an adaptation's source author against
    const surname = querySurname(book.author);
    for (const variant of bookTitleVariants(book.title)) {
      const list = booksByVariant.get(variant) ?? [];
      if (!list.includes(book)) list.push(book);
      booksByVariant.set(variant, list);
      const key = `${variant}\u0000${surname}`;
      if (!inputKeys.has(key)) {
        inputKeys.add(key);
        inputs.push({ variant, surname });
      }
    }
  }

  const rows: SparqlRow[] = [];
  for (let i = 0; i < inputs.length; i += ADAPTATION_BATCH) {
    rows.push(
      ...(await rowsOf(port, adaptationQuery(inputs.slice(i, i + ADAPTATION_BATCH)), deadline, 'adaptation'))
    );
  }

  const perBook = new Map<number, Map<string, FoundAdaptation>>();
  for (const r of rows) {
    const variant = rowStr(r, 'title');
    const an = rowStr(r, 'an');
    const qid = qidOf(r.adapt?.value);
    const src = qidOf(r.src?.value);
    const kind = rowStr(r, 'kind');
    const via = rowStr(r, 'via');
    if (!variant || !an || !qid || !src) continue;
    if ((kind !== 'movie' && kind !== 'tv') || (via !== 'work' && via !== 'series')) continue;
    const tvm = rowInt(r, 'tvm');
    if (kind === 'tv' && tvm === null) continue; // spec §6.3: series must cross-walk to TVmaze
    if (!allows(filter, kind)) continue;
    const anTokens = authorTokens(an);
    const year = rowInt(r, 'yr');
    for (const book of booksByVariant.get(variant) ?? []) {
      const names = [book.author as string, ...book.additional_authors];
      if (!names.some((n) => authorTokens(n) === anTokens)) continue;
      const found = perBook.get(book.id) ?? new Map<string, FoundAdaptation>();
      perBook.set(book.id, found);
      const prev = found.get(qid);
      if (!prev) {
        found.set(qid, { qid, kind, tvm, sl: rowInt(r, 'sl') ?? 0, label: rowLabel(r), year, via, src });
        continue;
      }
      // One row per (date, label) combination comes back; keep the earliest year, any label,
      // and prefer the direct work over the series hop for provenance.
      if (year !== null && (prev.year === null || year < prev.year)) prev.year = year;
      if (!prev.label) prev.label = rowLabel(r);
      if (via === 'work' && prev.via === 'series') {
        prev.via = 'work';
        prev.src = src;
      }
    }
  }

  const taken = new Set<string>();
  const hits: PoolHit[] = [];
  for (const book of signal.loved_books) {
    const found = perBook.get(book.id);
    if (!found) continue;
    const ranked = [...found.values()]
      .filter(
        (f) =>
          !taken.has(f.qid) &&
          !signal.owned_qids.has(f.qid) &&
          !(f.tvm !== null && signal.owned_tvmaze_ids.has(f.tvm))
      )
      .sort((a, b) => b.sl - a.sl || (a.qid < b.qid ? -1 : 1))
      .slice(0, ADAPTATIONS_PER_BOOK);
    for (const f of ranked) {
      taken.add(f.qid);
      hits.push({
        qid: f.qid,
        media_type: f.kind,
        tvmaze_id: f.kind === 'tv' ? f.tvm : null,
        label: f.label,
        year: f.year,
        sitelinks: f.sl,
        enwiki: true,
        pool: 'adaptation',
        seed_reason: `adaptation:${f.via}=${f.src};book=${book.id}`,
        adaptation: { book_id: book.id, book_title: book.title, source_qid: f.src, via: f.via },
      });
    }
  }
  return hits;
}

// --- Claude comparable-title seeds ----------------------------------------------------------

function seedReason(s: SeedProposal): string {
  return s.reason ? `seed:${s.reason}` : `seed:${s.title} (${s.year})`;
}

/**
 * Films resolve by exact en/mul label or alias (every titleVariants form) + any P577 year,
 * best by sitelinks. Series resolve through TVmaze singlesearch, a +/-1 premiere-year check,
 * then the P8600 crosswalk; an uncross-walked show is dropped (spec §6.3). Hits keep the
 * proposal order.
 */
export async function seedPool(
  port: ScreenCatalogPort,
  seeds: SeedProposal[],
  deadline: Deadline
): Promise<PoolHit[]> {
  const byIndex = new Map<number, PoolHit>();

  const films = seeds.map((s, i) => ({ s, i })).filter(({ s }) => s.media_type === 'movie');
  for (let b = 0; b < films.length; b += SEED_MOVIE_BATCH) {
    const lookups: LabelYear[] = [];
    const owners = new Map<string, number[]>();
    for (const { s, i } of films.slice(b, b + SEED_MOVIE_BATCH)) {
      for (const label of titleVariants(s.title)) {
        const key = `${label}\u0000${s.year}`;
        const list = owners.get(key);
        if (list) {
          if (!list.includes(i)) list.push(i);
        } else {
          owners.set(key, [i]);
          lookups.push({ label, year: s.year });
        }
      }
    }
    for (const row of await rowsOf(port, seedMovieQuery(lookups), deadline, 'seed film')) {
      const name = rowStr(row, 'name');
      const y = rowInt(row, 'y');
      const qid = qidOf(row.q?.value);
      if (name === null || y === null || !qid) continue;
      const sl = rowInt(row, 'sl') ?? 0;
      for (const i of owners.get(`${name}\u0000${y}`) ?? []) {
        const prev = byIndex.get(i);
        if (prev && prev.sitelinks >= sl) continue;
        byIndex.set(i, {
          qid,
          media_type: 'movie',
          tvmaze_id: null,
          label: rowLabel(row) ?? name,
          year: y,
          sitelinks: sl,
          enwiki: true,
          pool: 'claude_seed',
          seed_reason: seedReason(seeds[i]),
          adaptation: null,
        });
      }
    }
  }

  const shows: Array<{ i: number; hit: TvmazeHit; year: number }> = [];
  for (const [i, s] of seeds.entries()) {
    if (s.media_type !== 'tv') continue;
    if (deadline.remainingMs() <= 0) break;
    const res = await port.tvmazeSingleSearch(s.title);
    if (res.kind !== 'ok') continue;
    const premiered = yearOfDate(res.value.premiered);
    if (premiered !== null && Math.abs(premiered - s.year) > SEED_TV_YEAR_TOLERANCE) continue;
    shows.push({ i, hit: res.value, year: premiered ?? s.year });
  }
  if (shows.length) {
    const crosswalk = new Map<number, { qid: string; sl: number; label: string | null }>();
    const ids = uniq(shows.map((x) => x.hit.id));
    for (const row of await rowsOf(port, tvmazeCrosswalkQuery(ids), deadline, 'tv crosswalk')) {
      const tvm = rowInt(row, 'tvm');
      const qid = qidOf(row.s?.value);
      if (tvm === null || !qid) continue;
      const sl = rowInt(row, 'sl') ?? 0;
      const prev = crosswalk.get(tvm);
      if (!prev || sl > prev.sl) crosswalk.set(tvm, { qid, sl, label: rowLabel(row) });
    }
    for (const { i, hit, year } of shows) {
      const xw = crosswalk.get(hit.id);
      if (!xw) continue;
      byIndex.set(i, {
        qid: xw.qid,
        media_type: 'tv',
        tvmaze_id: hit.id,
        label: xw.label ?? hit.name,
        year,
        sitelinks: xw.sl,
        enwiki: true,
        pool: 'claude_seed',
        seed_reason: seedReason(seeds[i]),
        adaptation: null,
      });
    }
  }

  return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, h]) => h);
}
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run lib/server/__tests__/screen-pools.test.ts && npm run type-check`
Expected: PASS. If `tsc` rejects `defaultScreenCatalogPort`, the wave 5 signatures differ from the ones Task 1 recorded. Adapt only that function, and note the adaptation in the ledger.

The film-seed test assumes `titleVariants('Moon')` includes `'Moon'`. If wave 5's `titleVariants` does not return the title as given, stop and report; the spec (§4.3) says it does.

- [ ] **Step 6: Mutation check**

Delete the line `if (kind === 'tv' && tvm === null) continue;` in `adaptationPool` and run the test. `requires a TVmaze id for series` must go red. Revert.

- [ ] **Step 7: Commit**

```bash
git add lib/server/screenAssemble.ts lib/server/__tests__/helpers/screenRecFixtures.ts lib/server/__tests__/screen-pools.test.ts
git commit -m "feat(screen): metadata, adaptation and seed retrieval pools (#96)"
```

---

### Task 6: Merge, cap, hydrate and filter

**Files:**
- Modify: `lib/server/screenAssemble.ts` (append)
- Test: `lib/server/__tests__/screen-assemble.test.ts`

**Interfaces:**
- Consumes: Task 5's types; `SEED_RESERVE_SHARE` from `recAssemble.ts`; `authorExcluded`, `subjectExcluded` from `exclusions.ts`; `pyRoundHalfEven` (`serialize.ts`); `normalizeTitleKey` (w4); `POPULARITY_MIN_SITELINKS` (Task 4).
- Produces (Tasks 7, 8):

```ts
export const SCREEN_MAX_CANDIDATES = 60;
export const HYDRATE_CAP = 90;
export const ADAPTATION_MAX_SHARE = 0.4;
export const MAX_PER_PERSON = 2;
export type RetrievalPoolLabel = RetrievalPool | 'multiple';
export interface MergedHit extends Omit<PoolHit, 'pool'> { retrieval_pool: RetrievalPoolLabel }
export interface ScreenPoolCandidate extends ScreenCandidate { retrieval_pool: RetrievalPoolLabel; seed_reason: string; adaptation: AdaptationProvenance | null }
export function passesFloor(h: { sitelinks: number; enwiki: boolean }): boolean;
export function mergeHits(pools: PoolHit[][], owned: Pick<ScreenSignal, 'owned_qids' | 'owned_tvmaze_ids' | 'owned_keys'>): MergedHit[];
export function capHits<T extends { retrieval_pool: RetrievalPoolLabel }>(hits: T[], cap: number): T[];
export async function hydrate(port: ScreenCatalogPort, hits: MergedHit[], deadline: Deadline): Promise<ScreenPoolCandidate[]>;
export function languageCode(value: string | null): string | null;
export function applyScreenDirective(cands: ScreenPoolCandidate[], constraints: Record<string, unknown>): ScreenPoolCandidate[];
export function applyPersonCap(cands: ScreenPoolCandidate[]): ScreenPoolCandidate[];
export async function assembleScreenPool(port: ScreenCatalogPort, pools: PoolHit[][], signal: Pick<ScreenSignal, 'owned_qids' | 'owned_tvmaze_ids' | 'owned_keys' | 'directive_constraints'>, mediaFilter: MediaFilter, deadline: Deadline): Promise<ScreenPoolCandidate[]>;
```

- [ ] **Step 1: Write the failing test**

Create `lib/server/__tests__/screen-assemble.test.ts`:

```ts
import { describe, test, expect } from 'vitest';
import {
  applyPersonCap,
  applyScreenDirective,
  assembleScreenPool,
  capHits,
  hydrate,
  languageCode,
  mergeHits,
  type MergedHit,
  type PoolHit,
  type ScreenPoolCandidate,
} from '../screenAssemble';
import { normalizeTitleKey } from '../titles';
import { candidate, fakeScreenPort, OPEN_DEADLINE } from './helpers/screenRecFixtures';

function hit(qid: string, over: Partial<PoolHit> = {}): PoolHit {
  return { qid, media_type: 'movie', tvmaze_id: null, label: `Film ${qid}`, year: 2010, sitelinks: 20, enwiki: true, pool: 'metadata', seed_reason: 'metadata:people=1;genres=1', adaptation: null, ...over };
}

const noOwned = { owned_qids: new Set<string>(), owned_tvmaze_ids: new Set<number>(), owned_keys: new Set<string>() };

function cand(qid: string, over: Partial<ScreenPoolCandidate> = {}): ScreenPoolCandidate {
  return { ...candidate({ title: `Film ${qid}`, wikidata_qid: qid, year: 2010 }), retrieval_pool: 'metadata', seed_reason: '', adaptation: null, ...over };
}

describe('mergeHits', () => {
  test('applies the popularity floor, the TV crosswalk rule and every owned key', () => {
    const merged = mergeHits(
      [
        [
          hit('Q1', { sitelinks: 9 }),
          hit('Q2', { enwiki: false }),
          hit('Q3', { media_type: 'tv', tvmaze_id: null }),
          hit('Q4'),
          hit('Q5', { media_type: 'tv', tvmaze_id: 50 }),
          hit('Q6', { label: 'Arrival', year: 2016 }),
          hit('Q7'),
        ],
      ],
      { owned_qids: new Set(['Q4']), owned_tvmaze_ids: new Set([50]), owned_keys: new Set([normalizeTitleKey('Arrival', 2016)]) }
    );
    expect(merged.map((m) => m.qid)).toEqual(['Q7']);
  });

  test('a candidate in two pools is "multiple" and keeps its adaptation provenance', () => {
    const adaptation = { book_id: 1, book_title: 'Dune', source_qid: 'Q70', via: 'work' as const };
    const merged = mergeHits(
      [[hit('Q1', { pool: 'adaptation', adaptation, seed_reason: 'adaptation:work=Q70;book=1' })], [hit('Q1', { pool: 'claude_seed' })], [hit('Q2', { pool: 'claude_seed' })]],
      noOwned
    );
    expect(merged).toEqual([
      expect.objectContaining({ qid: 'Q1', retrieval_pool: 'multiple', adaptation, seed_reason: 'adaptation:work=Q70;book=1' }),
      expect.objectContaining({ qid: 'Q2', retrieval_pool: 'claude_seed' }),
    ]);
  });

  test('a second item with the same title and year is dropped', () => {
    const merged = mergeHits([[hit('Q1', { label: 'Solaris', year: 1972 }), hit('Q2', { label: 'Solaris', year: 1972 })]], noOwned);
    expect(merged.map((m) => m.qid)).toEqual(['Q1']);
  });
});

describe('capHits', () => {
  const mk = (n: number, pool: MergedHit['retrieval_pool']) =>
    Array.from({ length: n }, (_, i) => ({ ...hit(`Q${pool}${i}`), retrieval_pool: pool }) as unknown as MergedHit);

  test('under the cap is untouched', () => {
    const hits = mk(5, 'metadata');
    expect(capHits(hits, 60)).toBe(hits);
  });

  test('multiple first, then the seed reserve, adaptation share, metadata, backfill', () => {
    const hits = [...mk(40, 'metadata'), ...mk(30, 'adaptation'), ...mk(25, 'claude_seed'), ...mk(2, 'multiple')];
    const out = capHits(hits, 60);
    const count = (p: string) => out.filter((h) => h.retrieval_pool === p).length;
    expect(out).toHaveLength(60);
    expect(count('multiple')).toBe(2);
    expect(count('claude_seed')).toBe(18); // round(60 * 0.3)
    expect(count('adaptation')).toBe(24); // round(60 * 0.4)
    expect(count('metadata')).toBe(16);
  });

  test('slack is backfilled from leftover adaptation, then seeds', () => {
    const out = capHits([...mk(2, 'metadata'), ...mk(40, 'adaptation'), ...mk(40, 'claude_seed')], 60);
    expect(out).toHaveLength(60);
    expect(out.filter((h) => h.retrieval_pool === 'adaptation').length).toBe(40);
  });
});

describe('hydrate', () => {
  test('uses fetched metadata, falls back to the pool label, drops what has no title', async () => {
    const merged: MergedHit[] = [
      { ...hit('Q1'), retrieval_pool: 'metadata' } as unknown as MergedHit,
      { ...hit('Q2', { label: 'Label Only' }), retrieval_pool: 'metadata' } as unknown as MergedHit,
      { ...hit('Q3', { label: null }), retrieval_pool: 'metadata' } as unknown as MergedHit,
      { ...hit('Q4', { media_type: 'tv', tvmaze_id: 77 }), retrieval_pool: 'claude_seed' } as unknown as MergedHit,
    ];
    const port = fakeScreenPort({
      metadata: {
        Q1: candidate({ title: 'Real Title', wikidata_qid: 'Q1', year: 2011, genres: ['drama film'], image_url: 'https://upload.wikimedia.org/x.jpg' }),
        Q4: candidate({ title: 'A Show', wikidata_qid: 'Q4', media_type: 'tv', tvmaze_id: null }),
      },
    });
    const out = await hydrate(port, merged, OPEN_DEADLINE);
    expect(port.metadataCalls).toEqual([['Q1', 'Q2', 'Q3', 'Q4']]);
    expect(out.map((c) => [c.wikidata_qid, c.title, c.year])).toEqual([
      ['Q1', 'Real Title', 2011],
      ['Q2', 'Label Only', 2010],
      ['Q4', 'A Show', 2010],
    ]);
    expect(out[0].genres).toEqual(['drama film']);
    expect(out[2]).toMatchObject({ media_type: 'tv', tvmaze_id: 77 });
  });

  test('a retryable metadata failure still serves minimal candidates', async () => {
    const out = await hydrate(fakeScreenPort({ metadataRetryable: true }), [{ ...hit('Q1'), retrieval_pool: 'metadata' } as unknown as MergedHit], OPEN_DEADLINE);
    expect(out).toEqual([expect.objectContaining({ wikidata_qid: 'Q1', title: 'Film Q1', genres: [], sitelinks: 20 })]);
  });
});

describe('filters', () => {
  test('languageCode accepts ISO codes and English labels; unknown is null', () => {
    expect(languageCode('fr')).toBe('fr');
    expect(languageCode('French')).toBe('fr');
    expect(languageCode('Mandarin Chinese')).toBe('zh');
    expect(languageCode('English language')).toBe('en');
    expect(languageCode('Klingon')).toBeNull();
    expect(languageCode(null)).toBeNull();
  });

  test('the directive maps years, subjects, source authors and languages; missing values pass', () => {
    const cands = [
      cand('Q1', { year: 1985 }),
      cand('Q2', { genres: ['horror film'] }),
      cand('Q3', { main_subjects: ['war'] }),
      cand('Q4', { based_on: [{ qid: 'Q9', title: 'It', author: 'Stephen King' }] }),
      cand('Q5', { original_language: 'Japanese' }),
      cand('Q6', { year: null, original_language: 'Klingon' }),
      cand('Q7', { original_language: 'en' }),
    ];
    const out = applyScreenDirective(cands, {
      min_year: 1990,
      exclude_subjects: ['horror', 'war'],
      exclude_authors: ['king'],
      languages: ['en'],
    });
    expect(out.map((c) => c.wikidata_qid)).toEqual(['Q6', 'Q7']);
    expect(applyScreenDirective(cands, {})).toBe(cands);
  });

  test('at most two per first-listed director or creator', () => {
    const out = applyPersonCap([
      cand('Q1', { directors: ['Denis Villeneuve'] }),
      cand('Q2', { directors: ['denis villeneuve '] }),
      cand('Q3', { directors: ['Denis Villeneuve'] }),
      cand('Q4', { media_type: 'tv', creators: ['Denis Villeneuve'] }),
      cand('Q5', {}),
    ]);
    expect(out.map((c) => c.wikidata_qid)).toEqual(['Q1', 'Q2', 'Q5']);
  });
});

describe('assembleScreenPool', () => {
  test('media filter, owned re-check after hydration, cap', async () => {
    const port = fakeScreenPort({
      metadata: {
        Q1: candidate({ title: 'Toy Story', wikidata_qid: 'Q1', year: 1995 }),
        Q2: candidate({ title: 'New Film', wikidata_qid: 'Q2', year: 2020 }),
      },
    });
    const out = await assembleScreenPool(
      port,
      [[hit('Q1', { label: 'Toy Story (film)', year: 1995 }), hit('Q2'), hit('Q3', { media_type: 'tv', tvmaze_id: 3 })]],
      { ...noOwned, owned_keys: new Set([normalizeTitleKey('Toy Story', 1995)]), directive_constraints: {} },
      'movie',
      OPEN_DEADLINE
    );
    expect(out.map((c) => c.wikidata_qid)).toEqual(['Q2']);
    expect(port.metadataCalls).toEqual([['Q1', 'Q2']]);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run lib/server/__tests__/screen-assemble.test.ts`
Expected: FAIL. The exports `mergeHits`, `capHits` and the rest are missing.

- [ ] **Step 3: Implement**

Add these imports at the top of `lib/server/screenAssemble.ts`:

```ts
import { authorExcluded, subjectExcluded } from './exclusions';
import { SEED_RESERVE_SHARE } from './recAssemble';
import { POPULARITY_MIN_SITELINKS } from './screenSparql';
import { pyRoundHalfEven } from './serialize';
import { normalizeTitleKey } from './titles';
```

(Merge `POPULARITY_MIN_SITELINKS` into the existing `./screenSparql` import.) Then append:

```ts
// --- assembly ------------------------------------------------------------------------------

/** Spec §6.3: the pool handed to the reranker is capped at 60 (token budget). */
export const SCREEN_MAX_CANDIDATES = 60;
/** Wikipedia summaries cost one fetch each; hydrate at most this many before filtering. */
export const HYDRATE_CAP = 90;
/** Adaptation candidates may take at most this share of the cap, so metadata keeps room. */
export const ADAPTATION_MAX_SHARE = 0.4;
/** Spec §6.3: cap 2 per director or creator. */
export const MAX_PER_PERSON = 2;

export type RetrievalPoolLabel = RetrievalPool | 'multiple';

export interface MergedHit extends Omit<PoolHit, 'pool'> {
  retrieval_pool: RetrievalPoolLabel;
}

export interface ScreenPoolCandidate extends ScreenCandidate {
  retrieval_pool: RetrievalPoolLabel;
  seed_reason: string;
  adaptation: AdaptationProvenance | null;
}

export function passesFloor(h: { sitelinks: number; enwiki: boolean }): boolean {
  return h.enwiki && h.sitelinks >= POPULARITY_MIN_SITELINKS;
}

/**
 * Merge the pools in the given order (the first pool's reason wins), dropping anything below
 * the popularity floor, any series without a TVmaze id, anything the reader owns or rejected
 * (by QID, TVmaze id or normalized title + year), and a second item with the same title + year.
 * The floor is enforced in every query too; this re-check keeps a future query edit honest.
 */
export function mergeHits(
  pools: PoolHit[][],
  owned: Pick<ScreenSignal, 'owned_qids' | 'owned_tvmaze_ids' | 'owned_keys'>
): MergedHit[] {
  const byQid = new Map<string, MergedHit & { pools: Set<RetrievalPool> }>();
  const keys = new Set<string>();
  for (const pool of pools) {
    for (const h of pool) {
      if (!passesFloor(h)) continue;
      if (h.media_type === 'tv' && h.tvmaze_id === null) continue;
      if (owned.owned_qids.has(h.qid)) continue;
      if (h.tvmaze_id !== null && owned.owned_tvmaze_ids.has(h.tvmaze_id)) continue;
      const key = h.label ? normalizeTitleKey(h.label, h.year) : null;
      if (key && owned.owned_keys.has(key)) continue;

      const existing = byQid.get(h.qid);
      if (existing) {
        existing.pools.add(h.pool);
        if (!existing.adaptation && h.adaptation) existing.adaptation = h.adaptation;
        if (!existing.label && h.label) existing.label = h.label;
        if (existing.year === null && h.year !== null) existing.year = h.year;
        continue;
      }
      if (key && keys.has(key)) continue;
      if (key) keys.add(key);
      const { pool, ...rest } = h;
      byQid.set(h.qid, { ...rest, retrieval_pool: pool, pools: new Set([pool]) });
    }
  }
  return [...byQid.values()].map(({ pools, ...rest }) => ({
    ...rest,
    retrieval_pool: pools.size > 1 ? 'multiple' : rest.retrieval_pool,
  }));
}

/**
 * capPool's screen twin (recAssemble.ts): multi-pool candidates first (most grounded), then a
 * reserved seed share (SEED_RESERVE_SHARE -- we paid for those seeds), then adaptation up to
 * ADAPTATION_MAX_SHARE, then metadata, then leftover adaptation and seeds as backfill.
 */
export function capHits<T extends { retrieval_pool: RetrievalPoolLabel }>(hits: T[], cap: number): T[] {
  if (hits.length <= cap) return hits;
  const of = (p: RetrievalPoolLabel) => hits.filter((h) => h.retrieval_pool === p);
  const multiple = of('multiple');
  const adaptation = of('adaptation');
  const seed = of('claude_seed');
  const meta = of('metadata');

  let chosen = multiple.slice(0, cap);
  if (chosen.length >= cap) return chosen;
  const seedQuota = Math.min(seed.length, pyRoundHalfEven(cap * SEED_RESERVE_SHARE), cap - chosen.length);
  chosen = chosen.concat(seed.slice(0, seedQuota));
  const adaptQuota = Math.min(
    adaptation.length,
    pyRoundHalfEven(cap * ADAPTATION_MAX_SHARE),
    cap - chosen.length
  );
  chosen = chosen.concat(adaptation.slice(0, adaptQuota));
  chosen = chosen.concat(meta.slice(0, cap - chosen.length));
  if (chosen.length < cap) chosen = chosen.concat(adaptation.slice(adaptQuota, adaptQuota + cap - chosen.length));
  if (chosen.length < cap) chosen = chosen.concat(seed.slice(seedQuota, seedQuota + cap - chosen.length));
  return chosen.slice(0, cap);
}

function minimalCandidate(h: MergedHit, title: string): ScreenCandidate {
  return {
    media_type: h.media_type,
    title,
    year: h.year,
    wikidata_qid: h.qid,
    tvmaze_id: h.tvmaze_id,
    image_url: null,
    description: null,
    description_source: null,
    description_url: null,
    wikipedia_page: null,
    genres: [],
    directors: [],
    creators: [],
    writers: [],
    countries: [],
    original_language: null,
    based_on: [],
    main_subjects: [],
    series: [],
    production_companies: [],
    sitelinks: h.sitelinks,
  };
}

/**
 * One fetchScreenMetadata call for the whole capped list (wave 5 batches wbgetentities and
 * Wikipedia summaries, cached in catalog_cache). A retryable failure degrades to minimal
 * candidates; a hit with neither metadata nor a label is dropped (nothing to show or rank).
 */
export async function hydrate(
  port: ScreenCatalogPort,
  hits: MergedHit[],
  deadline: Deadline
): Promise<ScreenPoolCandidate[]> {
  let meta = new Map<string, ScreenCandidate>();
  if (hits.length && deadline.remainingMs() > 0) {
    const res = await port.fetchMetadata(hits.map((h) => h.qid));
    if (res.kind === 'ok') meta = res.value;
    else if (res.kind === 'retryable') {
      logDebug('screen-recommend', 'metadata hydration skipped', { reason: res.reason });
    }
  }
  const out: ScreenPoolCandidate[] = [];
  for (const h of hits) {
    const m = meta.get(h.qid);
    const title = m?.title || h.label;
    if (!title) continue;
    const base = m ?? minimalCandidate(h, title);
    out.push({
      ...base,
      media_type: h.media_type,
      title,
      year: base.year ?? h.year,
      wikidata_qid: h.qid,
      tvmaze_id: h.media_type === 'tv' ? (h.tvmaze_id ?? base.tvmaze_id) : null,
      sitelinks: base.sitelinks ?? h.sitelinks,
      retrieval_pool: h.retrieval_pool,
      seed_reason: h.seed_reason,
      adaptation: h.adaptation,
    });
  }
  return out;
}

/** English labels Wikidata uses for P364 (original language), mapped to ISO 639-1. */
const LANGUAGE_CODES: Record<string, string> = {
  arabic: 'ar', bengali: 'bn', cantonese: 'zh', chinese: 'zh', czech: 'cs', danish: 'da',
  dutch: 'nl', english: 'en', finnish: 'fi', french: 'fr', german: 'de', greek: 'el',
  hebrew: 'he', hindi: 'hi', hungarian: 'hu', icelandic: 'is', indonesian: 'id', irish: 'ga',
  italian: 'it', japanese: 'ja', korean: 'ko', malayalam: 'ml', 'mandarin chinese': 'zh',
  mandarin: 'zh', norwegian: 'no', persian: 'fa', polish: 'pl', portuguese: 'pt',
  romanian: 'ro', russian: 'ru', spanish: 'es', swedish: 'sv', tagalog: 'tl', tamil: 'ta',
  telugu: 'te', thai: 'th', turkish: 'tr', ukrainian: 'uk', vietnamese: 'vi',
};

/**
 * The directive's `languages` are ISO 639-1 codes (recFilters.cleanConstraints). Wave 5 may
 * store original_language as a code or as Wikidata's English label; accept both. Unknown
 * values return null and therefore PASS the filter (spec §6.3: a missing value passes).
 */
export function languageCode(value: string | null): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (/^[a-z]{2}$/.test(v)) return v;
  return LANGUAGE_CODES[v.replace(/ language$/, '')] ?? null;
}

/**
 * The directive's hard constraints with spec §6.3's explicit mapping: year range -> release
 * year; exclude_subjects -> genres and main subjects; exclude_authors -> adaptation source
 * author; languages -> original language. A missing value always passes. Author and subject
 * matching reuse exclusions.ts so screen and book exclusions behave identically (including the
 * inherited surname quirk documented there).
 */
export function applyScreenDirective(
  cands: ScreenPoolCandidate[],
  constraints: Record<string, unknown>
): ScreenPoolCandidate[] {
  if (!constraints || Object.keys(constraints).length === 0) return cands;
  const minYear = constraints.min_year as number | null | undefined;
  const maxYear = constraints.max_year as number | null | undefined;
  const languages = ((constraints.languages as string[] | null) ?? []).map((l) => l.toLowerCase());
  return cands.filter((c) => {
    if (typeof c.year === 'number' && Number.isInteger(c.year)) {
      if (minYear != null && c.year < minYear) return false;
      if (maxYear != null && c.year > maxYear) return false;
    }
    for (const subject of [...c.genres, ...c.main_subjects]) {
      if (subjectExcluded(subject, constraints.exclude_subjects)) return false;
    }
    for (const source of c.based_on) {
      if (source.author && authorExcluded(source.author, constraints.exclude_authors)) return false;
    }
    if (languages.length) {
      const code = languageCode(c.original_language);
      if (code !== null && !languages.includes(code)) return false;
    }
    return true;
  });
}

/** At most MAX_PER_PERSON per first-listed director (films) or creator (series). */
export function applyPersonCap(cands: ScreenPoolCandidate[]): ScreenPoolCandidate[] {
  const counts = new Map<string, number>();
  return cands.filter((c) => {
    const person = (c.media_type === 'movie' ? c.directors : c.creators)[0]?.trim().toLowerCase();
    if (!person) return true;
    const n = counts.get(person) ?? 0;
    if (n >= MAX_PER_PERSON) return false;
    counts.set(person, n + 1);
    return true;
  });
}

export async function assembleScreenPool(
  port: ScreenCatalogPort,
  pools: PoolHit[][],
  signal: Pick<ScreenSignal, 'owned_qids' | 'owned_tvmaze_ids' | 'owned_keys' | 'directive_constraints'>,
  mediaFilter: MediaFilter,
  deadline: Deadline
): Promise<ScreenPoolCandidate[]> {
  const merged = mergeHits(pools, signal).filter((h) => allows(mediaFilter, h.media_type));
  const hydrated = await hydrate(port, capHits(merged, HYDRATE_CAP), deadline);
  // Re-check after hydration: the Wikipedia title can differ from the pool's label.
  const kept = hydrated.filter(
    (c) =>
      allows(mediaFilter, c.media_type) &&
      !(c.media_type === 'tv' && c.tvmaze_id === null) &&
      !signal.owned_keys.has(normalizeTitleKey(c.title, c.year))
  );
  return capHits(
    applyPersonCap(applyScreenDirective(kept, signal.directive_constraints)),
    SCREEN_MAX_CANDIDATES
  );
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run lib/server/__tests__/screen-assemble.test.ts lib/server/__tests__/screen-pools.test.ts`
Expected: PASS.

If the directive test fails on `Q3` (`main_subjects: ['war']` with `exclude_subjects: ['war']`), check `subjectExcluded`'s whole-word matching before changing anything. `'war'` must hit `'war'`.

- [ ] **Step 5: Mutation check (owned exclusion is load-bearing)**

Delete `if (owned.owned_qids.has(h.qid)) continue;` and run the test. `applies the popularity floor … every owned key` must go red. Revert.

- [ ] **Step 6: Commit**

```bash
git add lib/server/screenAssemble.ts lib/server/__tests__/screen-assemble.test.ts
git commit -m "feat(screen): merge, floor, hydrate and filter the screen pool (#96)"
```

---
### Task 7: Seed and rerank prompts

**Files:**
- Create: `lib/server/screenRecPrompts.ts`
- Test: `lib/server/__tests__/screen-rec-prompts.test.ts`

**Interfaces:**
- Consumes: `PromptBlock` (`recPrompts.ts`), `LOVED_SAMPLE` (`recSignal.ts`), `ScreenSignal` (Task 3), `MediaFilter` and `ScreenPoolCandidate` (Tasks 5–6), `pyJsonDumps`.
- Produces (Task 8):

```ts
export const SCREEN_SEED_MAX_TOKENS = 2000;
export const SCREEN_SEED_COUNT = 20;
export const SCREEN_RANK_MAX_TOKENS = 4000;
export const LOVED_TITLES_SAMPLE = 20;
export const FAVORITES_SAMPLE = 20;
export const SCREEN_SEED_TOOL: { name: 'propose_screen_comparables'; … };
export const SCREEN_SEED_SYSTEM: string;
export const SCREEN_RANK_TOOL: { name: 'rank_screen_recommendations'; … };
export const SCREEN_RANK_SYSTEM: string;
export interface ScreenPromptEvidence { books; titles; favorite_books; favorite_titles }
export function screenPromptEvidence(signal: ScreenSignal): ScreenPromptEvidence;
export interface EvidenceIds { traitIds: Set<number>; bookIds: Set<number>; titleIds: Set<number> }
export function validEvidenceIds(signal: ScreenSignal, candidates: ScreenPoolCandidate[]): EvidenceIds;
export function buildScreenSeedPrompt(signal: ScreenSignal, mediaFilter: MediaFilter, n: number): PromptBlock[];
export function buildScreenRerankPrompt(candidates: ScreenPoolCandidate[], signal: ScreenSignal, n: number): PromptBlock[];
```

Validation rule (spec §6.5): an id is citable only if the prompt carried it. That covers the sampled loved books and titles, the favorites, and the book named in any candidate's `adaptation_of`. `validEvidenceIds` derives its sets from `screenPromptEvidence`, the same function the prompt serializes, so the two cannot drift.

- [ ] **Step 1: Write the failing test**

Create `lib/server/__tests__/screen-rec-prompts.test.ts`:

```ts
import { describe, test, expect } from 'vitest';
import {
  buildScreenRerankPrompt,
  buildScreenSeedPrompt,
  SCREEN_RANK_TOOL,
  SCREEN_SEED_TOOL,
  validEvidenceIds,
} from '../screenRecPrompts';
import type { ScreenPoolCandidate } from '../screenAssemble';
import type { ScreenSignal } from '../screenSignal';
import { pyFloat } from '../serialize';
import { candidate } from './helpers/screenRecFixtures';

function signal(over: Partial<ScreenSignal> = {}): ScreenSignal {
  return {
    traits: [{ id: 7, claim: 'Rewards slow burns', polarity: 'reward', confidence: pyFloat(0.8), user_weight: pyFloat(1), status: 'proposed' }],
    loved_books: Array.from({ length: 25 }, (_, i) => ({ id: i + 1, title: `Book ${i + 1}`, author: 'A. Writer', additional_authors: [], rating: 5, read_year: 2024 })),
    loved_titles: [{ id: 40, type: 'tv', title: 'Severance', year: 2022, rating: 4, genres: ['drama'], people: ['Dan Erickson'], wikidata_qid: 'Q1', watched_year: 2025 }],
    favorite_books: [{ id: 99, title: 'Fav Book', author: 'B. Writer' }],
    favorite_titles: [],
    top_genres: [],
    top_people: [],
    original_languages: [],
    owned_qids: new Set(),
    owned_tvmaze_ids: new Set(),
    owned_keys: new Set(),
    owned_list: ['Severance (2022)', 'Arrival (2016)'],
    rejected_list: ['Heat (1995)'],
    rejected_with_notes: [{ title: 'Heat', year: 1995, type: 'movie', note: 'Too long' }],
    more_like_titles: ['Severance (2022)'],
    less_like_titles: [],
    reject_reason_counts: new Map([['too_long', 2]]),
    directive_text: 'No horror, please.',
    directive_constraints: {},
    ...over,
  };
}

function pc(qid: string, over: Partial<ScreenPoolCandidate> = {}): ScreenPoolCandidate {
  return { ...candidate({ title: `Film ${qid}`, wikidata_qid: qid, year: 2015 }), retrieval_pool: 'metadata', seed_reason: '', adaptation: null, ...over };
}

describe('tools', () => {
  test('the seed tool asks for comparable titles with a type and a year, never themes', () => {
    expect(SCREEN_SEED_TOOL.name).toBe('propose_screen_comparables');
    const item = SCREEN_SEED_TOOL.input_schema.properties.comparables.items;
    expect(item.required).toEqual(['title', 'media_type', 'year', 'reason']);
    expect(item.properties.media_type.enum).toEqual(['movie', 'tv']);
    expect(item.properties.year.type).toBe('integer');
  });

  test('the rank tool cites trait, book and title ids', () => {
    expect(SCREEN_RANK_TOOL.name).toBe('rank_screen_recommendations');
    expect(SCREEN_RANK_TOOL.input_schema.properties.recommendations.items.required).toEqual([
      'candidate_index',
      'score',
      'rationale',
      'grounded_trait_ids',
      'grounded_book_ids',
      'grounded_title_ids',
    ]);
  });
});

describe('buildScreenSeedPrompt', () => {
  test('caches the profile block and carries the owned and rejected lists', () => {
    const [profile, task] = buildScreenSeedPrompt(signal(), 'both', 20);
    expect(profile.cache_control).toEqual({ type: 'ephemeral' });
    expect(profile.text).toContain('TASTE TRAITS (JSON):\n');
    expect(profile.text).toContain('"id": 20');
    expect(profile.text).not.toContain('"id": 21'); // loved books sampled to 20
    expect(profile.text).toContain('LOVED FILMS AND SHOWS (JSON):\n');
    expect(profile.text).toContain('FAVORITES (JSON):\n');
    expect(task.text).toContain('Propose 20 specific films and TV series (a mix of both)');
    expect(task.text).toContain("ALREADY IN THE VIEWER'S LIBRARY (never propose these): Severance (2022); Arrival (2016)");
    expect(task.text).toContain('PREVIOUSLY REJECTED (never propose these): Heat (1995)');
    expect(task.text).toContain('No horror, please.');
    expect(task.text).toContain('["Severance (2022)"]');
  });

  test('the media filter narrows the request; an empty library emits no owned block', () => {
    expect(buildScreenSeedPrompt(signal(), 'tv', 20)[1].text).toContain('TV series only (no films)');
    expect(buildScreenSeedPrompt(signal(), 'movie', 20)[1].text).toContain('films only (no TV series)');
    const bare = buildScreenSeedPrompt(signal({ owned_list: [], rejected_list: [], favorite_books: [] }), 'both', 20);
    expect(bare[1].text).not.toContain('ALREADY IN');
    expect(bare[0].text).not.toContain('FAVORITES');
  });
});

describe('buildScreenRerankPrompt / validEvidenceIds', () => {
  const adaptation = { book_id: 23, book_title: 'Book 23', source_qid: 'Q70', via: 'work' as const };
  const cands = [
    pc('Q1', { genres: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], directors: ['X', 'Y', 'Z', 'W'], original_language: 'English' }),
    pc('Q2', { media_type: 'tv', tvmaze_id: 5, creators: ['C'], retrieval_pool: 'adaptation', adaptation }),
  ];

  test('candidates carry type, trimmed metadata, and adaptation_of only for the bridge', () => {
    const [profile, task] = buildScreenRerankPrompt(cands, signal(), 10);
    expect(task.text).toContain('Rank the best 10 candidates for this viewer');
    expect(task.text).toContain(
      '{"idx": 0, "type": "movie", "title": "Film Q1", "year": 2015, "genres": ["a", "b", "c", "d", "e", "f"], "people": ["X", "Y", "Z"], "original_language": "English"}'
    );
    expect(task.text).toContain('"adaptation_of": {"book_id": 23, "title": "Book 23"}');
    expect(task.text.match(/adaptation_of/g)).toHaveLength(1);
    expect(profile.text).toContain('REJECTED RECOMMENDATIONS WITH NOTES (JSON):');
    expect(profile.text).toContain('FREQUENT REJECT REASONS: too_long: 2 times');
    expect(profile.text).toContain("CUSTOM INSTRUCTIONS (the viewer's own standing guidance");
  });

  test('citable ids are exactly the ones the prompt carried', () => {
    const ids = validEvidenceIds(signal(), cands);
    expect([...ids.traitIds]).toEqual([7]);
    expect(ids.bookIds.has(20)).toBe(true);
    expect(ids.bookIds.has(21)).toBe(false); // outside the 20-book sample
    expect(ids.bookIds.has(23)).toBe(true); // named by adaptation_of
    expect(ids.bookIds.has(99)).toBe(true); // favorite
    expect([...ids.titleIds]).toEqual([40]);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run lib/server/__tests__/screen-rec-prompts.test.ts`
Expected: FAIL. `Cannot find module '../screenRecPrompts'`.

- [ ] **Step 3: Implement**

Create `lib/server/screenRecPrompts.ts`:

```ts
/**
 * Screen recommendation prompts (spec §6.3 seeds, §6.5 rerank). New prompts, not ports: no
 * Python parity applies. They follow recPrompts.ts's shape (a cached profile block, then the
 * task) and its voice rules, with film/TV wording.
 *
 * Seeds are comparable TITLES with a media type and a year -- never themes. The spike showed
 * theme seeds do not resolve usefully against Wikidata (spec §2.1 finding 7), and titles only
 * resolve reliably with a year.
 */
import type { PromptBlock } from './recPrompts';
import { LOVED_SAMPLE } from './recSignal';
import type { MediaFilter, ScreenPoolCandidate } from './screenAssemble';
import type { FavoriteBook, FavoriteTitle, ScreenSignal } from './screenSignal';
import { pyJsonDumps } from './serialize';

export const SCREEN_SEED_MAX_TOKENS = 2000;
/** Index decision 1: ask for 20 comparables. */
export const SCREEN_SEED_COUNT = 20;
export const SCREEN_RANK_MAX_TOKENS = 4000;
export const LOVED_TITLES_SAMPLE = 20;
export const FAVORITES_SAMPLE = 20;

export const SCREEN_SEED_TOOL = {
  name: 'propose_screen_comparables' as const,
  description:
    'Propose specific, real films and TV series this viewer is likely to love next. Each is ' +
    'looked up by exact title and year in a public catalog, so give the title as it is ' +
    'commonly known in English and the correct year.',
  input_schema: {
    type: 'object',
    properties: {
      comparables: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: {
              type: 'string',
              description: 'The exact, commonly used English title, with no year or annotation in it.',
            },
            media_type: {
              type: 'string',
              enum: ['movie', 'tv'],
              description: "'movie' for a film (animated and documentary films included), 'tv' for a series.",
            },
            year: {
              type: 'integer',
              description: 'The film release year, or the series premiere year.',
            },
            reason: {
              type: 'string',
              description: 'Which trait, loved book or loved title this pick chases.',
            },
          },
          required: ['title', 'media_type', 'year', 'reason'],
        },
      },
    },
    required: ['comparables'],
  },
};

export const SCREEN_SEED_SYSTEM =
  "You suggest films and TV series for a viewer from their evidence-backed taste profile, " +
  'which may be built from books, from films and shows, or from both. You name specific real ' +
  'titles with their years, never themes or search terms. You aim at the viewer\'s ' +
  'distinguishing traits rather than generic popularity, and you never suggest something the ' +
  'viewer already has.';

export const SCREEN_RANK_TOOL = {
  name: 'rank_screen_recommendations' as const,
  description:
    "Rank the provided real catalog films and TV series by how well they fit this viewer's " +
    'taste profile, and explain each pick. Choose ONLY from the given candidates.',
  input_schema: {
    type: 'object',
    properties: {
      recommendations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            candidate_index: { type: 'integer', description: 'The `idx` of a provided candidate. Must exist.' },
            score: { type: 'number', description: "0..1 fit with the viewer's taste profile." },
            rationale: {
              type: 'string',
              description:
                '1-2 sentences in the voice of a friend who reads and watches a lot: what the film ' +
                'or show does, anchored to at most two things the viewer loved, by name, naming ' +
                'the mechanism of the fit. Plain punctuation, no em dashes.',
            },
            grounded_trait_ids: {
              type: 'array',
              items: { type: 'integer' },
              description: 'Trait ids (from the profile) this pick leans on.',
            },
            grounded_book_ids: {
              type: 'array',
              items: { type: 'integer' },
              description: 'Library book ids this candidate is most like.',
            },
            grounded_title_ids: {
              type: 'array',
              items: { type: 'integer' },
              description: 'Library film/show ids this candidate is most like.',
            },
          },
          required: [
            'candidate_index',
            'score',
            'rationale',
            'grounded_trait_ids',
            'grounded_book_ids',
            'grounded_title_ids',
          ],
        },
      },
    },
    required: ['recommendations'],
  },
};

export const SCREEN_RANK_SYSTEM =
  'You are a film and TV recommender. You rank a fixed list of real catalog films and series ' +
  "against a viewer's evidence-backed taste profile, which may be built from their reading, " +
  'their viewing, or both. You never invent titles; you only rank the candidates given. Every ' +
  'pick cites the trait ids, library book ids and library title ids it is grounded in, drawn ' +
  'only from the provided data. You prefer specific fit over popularity, and you respect ' +
  'aversion traits (penalize candidates that trip them).\n\n' +
  'Write each rationale like a friend who reads and watches a lot, in 1-2 sentences: lead with ' +
  'what the film or show does, then anchor it to at most two things the viewer loved (a book ' +
  'or a title) by name. Name the mechanism of the fit (pace, voice, structure, mood: whatever ' +
  'the trait actually is), never just shared genre. Say a pick is an adaptation only when its ' +
  'candidate carries an `adaptation_of` field, and then name that book. If the pick is a ' +
  'stretch, say so honestly and name what still connects. Use plain punctuation only: no em ' +
  'dashes. Never write "you\'ll love this", generic praise, or clinical trait language.';

export interface ScreenPromptEvidence {
  books: Array<{ id: number; title: string; author: string | null; rating: number }>;
  titles: Array<{
    id: number;
    type: string;
    title: string;
    year: number | null;
    rating: number;
    genres: string[];
    people: string[];
  }>;
  favorite_books: FavoriteBook[];
  favorite_titles: FavoriteTitle[];
}

/** The evidence the prompts carry. validEvidenceIds reads the SAME function, so citations are
 *  validated against exactly what was sent (spec §6.5). */
export function screenPromptEvidence(signal: ScreenSignal): ScreenPromptEvidence {
  return {
    books: signal.loved_books
      .slice(0, LOVED_SAMPLE)
      .map((b) => ({ id: b.id, title: b.title, author: b.author, rating: b.rating })),
    titles: signal.loved_titles.slice(0, LOVED_TITLES_SAMPLE).map((t) => ({
      id: t.id,
      type: t.type,
      title: t.title,
      year: t.year,
      rating: t.rating,
      genres: t.genres.slice(0, 6),
      people: t.people,
    })),
    favorite_books: signal.favorite_books.slice(0, FAVORITES_SAMPLE),
    favorite_titles: signal.favorite_titles.slice(0, FAVORITES_SAMPLE),
  };
}

export interface EvidenceIds {
  traitIds: Set<number>;
  bookIds: Set<number>;
  titleIds: Set<number>;
}

export function validEvidenceIds(
  signal: ScreenSignal,
  candidates: ScreenPoolCandidate[]
): EvidenceIds {
  const ev = screenPromptEvidence(signal);
  const bookIds = new Set<number>([...ev.books, ...ev.favorite_books].map((b) => b.id));
  for (const c of candidates) if (c.adaptation) bookIds.add(c.adaptation.book_id);
  return {
    traitIds: new Set(signal.traits.map((t) => t.id)),
    bookIds,
    titleIds: new Set<number>([...ev.titles, ...ev.favorite_titles].map((t) => t.id)),
  };
}

function screenTasteContext(signal: ScreenSignal): string {
  const ev = screenPromptEvidence(signal);
  let out =
    'TASTE TRAITS (JSON):\n' +
    pyJsonDumps(signal.traits) +
    '\n\nLOVED BOOKS (JSON):\n' +
    pyJsonDumps(ev.books) +
    '\n\nLOVED FILMS AND SHOWS (JSON):\n' +
    pyJsonDumps(ev.titles);
  if (ev.favorite_books.length || ev.favorite_titles.length) {
    out +=
      '\n\nFAVORITES (JSON):\n' +
      pyJsonDumps({ books: ev.favorite_books, films_and_shows: ev.favorite_titles });
  }
  return out;
}

const KIND_PHRASE: Record<MediaFilter, string> = {
  both: 'films and TV series (a mix of both)',
  movie: 'films only (no TV series)',
  tv: 'TV series only (no films)',
};

export function buildScreenSeedPrompt(
  signal: ScreenSignal,
  mediaFilter: MediaFilter,
  n: number
): PromptBlock[] {
  let steering = '';
  if (signal.more_like_titles.length) {
    steering +=
      ' Lean toward the qualities of these films and shows the viewer wants more of: ' +
      pyJsonDumps(signal.more_like_titles) +
      '.';
  }
  if (signal.less_like_titles.length) {
    steering +=
      ' Avoid the qualities of these films and shows the viewer wants less of: ' +
      pyJsonDumps(signal.less_like_titles) +
      '.';
  }
  const directive = (signal.directive_text ?? '').trim();
  if (directive) steering += "\n\nThe viewer's own standing instructions: " + directive;
  const owned = signal.owned_list.length
    ? "\n\nALREADY IN THE VIEWER'S LIBRARY (never propose these): " + signal.owned_list.join('; ')
    : '';
  const rejected = signal.rejected_list.length
    ? '\n\nPREVIOUSLY REJECTED (never propose these): ' + signal.rejected_list.join('; ')
    : '';

  const task =
    "The viewer's taste profile is above. It may rest on books, on films and shows, or on " +
    'both: a taste that shows up in their reading is evidence about what they will enjoy ' +
    `watching. Propose ${n} specific ${KIND_PHRASE[mediaFilter]} they are likely to rate ` +
    'highly. Give each by its exact, commonly used English title and its year (film release ' +
    'year, or the series premiere year). Chase their distinguishing traits and cover their ' +
    'range; avoid generic blockbusters they would find anyway.' +
    steering +
    owned +
    rejected;

  return [
    { type: 'text', text: screenTasteContext(signal), cache_control: { type: 'ephemeral' } },
    { type: 'text', text: task },
  ];
}

function screenSteeringBlock(signal: ScreenSignal): string {
  const lines: string[] = ['\n\n## User Steering'];
  if (signal.more_like_titles.length) {
    lines.push('MORE LIKE (titles the viewer explicitly wants more of):\n' + pyJsonDumps(signal.more_like_titles));
  }
  if (signal.less_like_titles.length) {
    lines.push('LESS LIKE (titles the viewer explicitly wants less of):\n' + pyJsonDumps(signal.less_like_titles));
  }
  if (signal.reject_reason_counts.size) {
    const reasons = [...signal.reject_reason_counts.entries()]
      .map(([r, c]) => `${r}: ${c} times`)
      .join(', ');
    lines.push('FREQUENT REJECT REASONS: ' + reasons);
  }
  const directive = (signal.directive_text ?? '').trim();
  if (directive) {
    lines.push(
      "CUSTOM INSTRUCTIONS (the viewer's own standing guidance, in their words; honor it as " +
        'direct high-priority intent, second only to the hard constraints already applied to ' +
        'the candidate set):\n' +
        directive
    );
  }
  lines.push(
    'Favor candidates resembling the more-like titles; penalize candidates resembling the ' +
      'less-like titles; penalize candidates matching frequent reject reasons (too_long means ' +
      "runtime or season count); weight trait influence by each trait's `user_weight`: traits " +
      'with a lower weight should influence the score less (0.0 = ignore, 1.0 = normal).'
  );
  return lines.join('\n\n');
}

export function buildScreenRerankPrompt(
  candidates: ScreenPoolCandidate[],
  signal: ScreenSignal,
  n: number
): PromptBlock[] {
  const indexed = candidates.map((c, i) => ({
    idx: i,
    type: c.media_type,
    title: c.title,
    year: c.year,
    genres: c.genres.slice(0, 6),
    people: (c.media_type === 'movie' ? c.directors : c.creators).slice(0, 3),
    original_language: c.original_language,
    ...(c.adaptation
      ? { adaptation_of: { book_id: c.adaptation.book_id, title: c.adaptation.book_title } }
      : {}),
  }));

  const rejectedBlock = signal.rejected_with_notes.length
    ? '\n\nREJECTED RECOMMENDATIONS WITH NOTES (JSON):\n' +
      'These are films and shows the viewer explicitly skipped with an explanation. Treat ' +
      'each note as direct testimony about what to avoid; heavily penalize candidates that ' +
      'share the same qualities.\n' +
      pyJsonDumps(signal.rejected_with_notes)
    : '';

  const task =
    `Rank the best ${n} candidates for this viewer and explain each. Choose ONLY from the ` +
    'CANDIDATES list (cite each by its `idx`). Score 0..1 for fit. Penalize anything that ' +
    "trips an aversion trait or resembles a rejected title's noted reason. Ground every pick " +
    'in specific trait ids, and in the library book ids and library title ids it most ' +
    'resembles - use only ids that appear above.\n\n' +
    'CANDIDATES (JSON):\n' +
    pyJsonDumps(indexed);

  return [
    {
      type: 'text',
      text: screenTasteContext(signal) + rejectedBlock + screenSteeringBlock(signal),
      cache_control: { type: 'ephemeral' },
    },
    { type: 'text', text: task },
  ];
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run lib/server/__tests__/screen-rec-prompts.test.ts`
Expected: PASS.

If the exact candidate-JSON assertion fails only on separators, `pyJsonDumps` emits `", "` and `": "` (see `serialize.ts`). Fix the assertion string, not `pyJsonDumps`.

- [ ] **Step 5: Commit**

```bash
git add lib/server/screenRecPrompts.ts lib/server/__tests__/screen-rec-prompts.test.ts
git commit -m "feat(screen): seed and rerank prompts for screen recommendations (#96)"
```

---

### Task 8: `runScreenRecommend`

**Files:**
- Create: `lib/server/screenRecommendRun.ts`
- Modify: `lib/server/claudeErrors.ts` (append screen messages)
- Test: `lib/server/__tests__/screen-recommend-run.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–7; `ensureProfileMeta`, `readRebuildReason`; `booksChangedSince` (`profileUpdate.ts`); `titlesChangedSince` (w6); `requireScreenEnabled` (w4); `effectiveTitleRating`, `TitleRow` (w4); `modelFor` (w2); `asIdList` (`profileBuild.ts`); `trackedCreate`, `toolInput`.
- Produces (Tasks 9, 11):

```ts
export const SCREEN_DEFAULT_N = 10;
export const SCREEN_REQUEST_BUDGET_MS = 300_000;
export const SEED_BUDGET_MS = 45_000;
export const RETRIEVAL_END_MS = 180_000;
export const PERSIST_RESERVE_MS = 20_000;
export const MIN_RERANK_MS = 10_000;
export interface ScreenRecommendOptions { mediaFilter: MediaFilter; n?: number }
export interface ScreenRecommendDeps {
  nowMs: () => number;
  abortAfter: (ms: number) => AbortSignal;
  catalog: (db: Db, deadline: Deadline) => ScreenCatalogPort;
}
export const defaultScreenRecommendDeps: ScreenRecommendDeps;
export function blocksScreenRecs(t: TitleRow): boolean;
export function parseSeedProposals(input: Record<string, unknown> | null, mediaFilter: MediaFilter, nowYear: number): SeedProposal[];
export async function runScreenRecommend(db: Db, client: ClaudeClient | null, userId: string, opts: ScreenRecommendOptions, deps?: ScreenRecommendDeps): Promise<Record<string, unknown>>;
```
- claudeErrors.ts gains `SCREEN_REBUILD_REQUIRED_MESSAGE`, `SCREEN_TIMEOUT_MESSAGE`, `screenStaleMessage(books: number, titles: number): string`.

**Time budget (spec §6.4).** One request clock starts on entry. Seeds: the SDK request is aborted at 45 s, and on abort the run continues without seeds. Retrieval: every catalog call checks a deadline at start + 180 s. Rerank: its request is aborted at `300 s − 20 s − elapsed`, and a rerank left with less than 10 s answers 504 rather than starting. The 20 s are reserved for persistence. The route's literal `maxDuration = 300` is the outer bound.

- [ ] **Step 1: Add the messages**

Append to `lib/server/claudeErrors.ts`:

```ts
/** Screen recommendations (wave 7): the profile needs a FULL rebuild first (spec §5.6). */
export const SCREEN_REBUILD_REQUIRED_MESSAGE =
  'Your taste profile needs a full rebuild before ScreenSprite can recommend. Re-profile ' +
  'first (POST /profile/update).';

/** Screen recommendations ran out of their 300s request budget before or during the rerank. */
export const SCREEN_TIMEOUT_MESSAGE =
  'ScreenSprite ran out of time finding recommendations. Please try again.';

/** The book gate's message, widened to name changed titles too (spec §6.2). */
export function screenStaleMessage(books: number, titles: number): string {
  return (
    `${books} book(s) and ${titles} title(s) have changed since the last profile build. ` +
    'Re-profile first (POST /profile/update) so recommendations reflect your current taste.'
  );
}
```

- [ ] **Step 2: Write the failing test**

Create `lib/server/__tests__/screen-recommend-run.test.ts`:

```ts
import { describe, test, expect } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { makeTestDb } from './helpers/pglite';
import { setupTestEnv } from './helpers/testEnv';
import { fakeClaude } from './helpers/fakeClaude';
import {
  AFTER,
  candidate,
  fakeScreenPort,
  lit,
  seedScreenLibrary,
  wd,
  type FakePort,
} from './helpers/screenRecFixtures';
import { schema, type Db } from '../db';
import type { ClaudeClient } from '../claude';
import { modelFor } from '../models';
import { setRebuildReason } from '../profileMeta';
import {
  parseSeedProposals,
  runScreenRecommend,
  SEED_BUDGET_MS,
  type ScreenRecommendDeps,
} from '../screenRecommendRun';

const seedResponse = {
  content: [
    {
      type: 'tool_use',
      name: 'propose_screen_comparables',
      input: {
        comparables: [
          { title: 'Moon', media_type: 'movie', year: 2009, reason: 'quiet isolation sci-fi' },
          { title: 'The Expanse', media_type: 'tv', year: 2015, reason: 'loved the books' },
        ],
      },
    },
  ],
  usage: { input_tokens: 100, output_tokens: 50 },
};

function rankResponse(picks: Array<{ idx: number; score: number; traits?: number[]; books?: number[]; titles?: number[] }>) {
  return {
    content: [
      {
        type: 'tool_use',
        name: 'rank_screen_recommendations',
        input: {
          recommendations: picks.map((p) => ({
            candidate_index: p.idx,
            score: p.score,
            rationale: `  Because ${p.idx}.  `,
            grounded_trait_ids: p.traits ?? [],
            grounded_book_ids: p.books ?? [],
            grounded_title_ids: p.titles ?? [],
          })),
        },
      },
    ],
    usage: { input_tokens: 200, output_tokens: 80 },
  };
}

/** Candidates after assembly, in order: 0 The Expanse (multiple), 1 Murderbot, 2 Film A, 3 Moon. */
function scriptedPort(): FakePort {
  return fakeScreenPort({
    sparql: {
      'seed-movie': [{ name: lit('Moon'), y: lit(2009), q: wd('Q11002'), sl: lit(70), len: lit('Moon') }],
      'tv-crosswalk': [{ s: wd('Q12001'), tvm: lit(1825), sl: lit(60), len: lit('The Expanse') }],
      adaptation: [
        { title: lit('Leviathan Wakes'), an: lit('James S. A. Corey'), via: lit('series'), src: wd('Q7001'), adapt: wd('Q12001'), kind: lit('tv'), tvm: lit(1825), sl: lit(60), len: lit('The Expanse'), yr: lit(2015) },
        { title: lit('All Systems Red'), an: lit('Martha Wells'), via: lit('series'), src: wd('Q7002'), adapt: wd('Q8004'), kind: lit('tv'), tvm: lit(60000), sl: lit(30), len: lit('Murderbot'), yr: lit(2025) },
      ],
      'loved-people': [{ p: wd('Q10'), n: lit(1) }],
      'loved-genres': [{ g: wd('Q20'), n: lit(1) }],
      'metadata-movie': [
        { f: wd('Q5001'), np: lit(1), ng: lit(1), nsl: lit(25), len: lit('Film A'), yr: lit(2001) },
        { f: wd('Q134773'), np: lit(3), ng: lit(3), nsl: lit(99), len: lit('Forrest Gump'), yr: lit(1994) },
      ],
      'metadata-tv': [{ f: wd('Q6001'), np: lit(1), ng: lit(1), nsl: lit(25), tvm: lit(44778), len: lit('Severance'), yr: lit(2022) }],
    },
    tvmaze: { 'The Expanse': { id: 1825, name: 'The Expanse', premiered: '2015-12-14' } },
    metadata: {
      Q12001: candidate({ title: 'The Expanse', wikidata_qid: 'Q12001', media_type: 'tv', tvmaze_id: 1825, year: 2015, creators: ['Mark Fergus'], description: 'A series.', description_source: 'tvmaze', image_url: 'https://static.tvmaze.com/e.jpg' }),
      Q8004: candidate({ title: 'Murderbot', wikidata_qid: 'Q8004', media_type: 'tv', tvmaze_id: 60000, year: 2025 }),
      Q5001: candidate({ title: 'Film A', wikidata_qid: 'Q5001', year: 2001, directors: ['Someone'] }),
      Q11002: candidate({ title: 'Moon', wikidata_qid: 'Q11002', year: 2009, directors: ['Duncan Jones'], description: 'A film.', description_source: 'wikipedia', image_url: 'https://upload.wikimedia.org/m.jpg' }),
    },
  });
}

function deps(port: FakePort, over: Partial<ScreenRecommendDeps> = {}): ScreenRecommendDeps & { aborts: number[] } {
  const aborts: number[] = [];
  return {
    aborts,
    nowMs: () => 1_000_000,
    abortAfter: (ms) => {
      aborts.push(ms);
      return new AbortController().signal;
    },
    catalog: () => port,
    ...over,
  };
}

async function seeded(opts: { enabled?: boolean } = {}): Promise<{ db: Db; close: () => Promise<void> }> {
  const { db, close } = await makeTestDb();
  await seedScreenLibrary(db, opts);
  return { db, close };
}

async function usageOps(db: Db): Promise<Array<{ operation: string; model: string }>> {
  const result = await db.execute('select operation, model from usage_events order by id' as never);
  return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as Array<{ operation: string; model: string }>;
}

describe('runScreenRecommend gates', () => {
  setupTestEnv();

  test('403 when ScreenSprite is disabled', async () => {
    const { db, close } = await seeded({ enabled: false });
    try {
      await expect(runScreenRecommend(db, null, 'local', { mediaFilter: 'both' }, deps(scriptedPort()))).rejects.toMatchObject({ status: 403 });
    } finally {
      await close();
    }
  });

  test('400 with no profile, and while a rebuild reason is set', async () => {
    const { db, close } = await seeded();
    try {
      await setRebuildReason(db, 'local', 'title_deleted');
      await expect(runScreenRecommend(db, null, 'local', { mediaFilter: 'both' }, deps(scriptedPort()))).rejects.toMatchObject({
        status: 400,
        detail: expect.stringContaining('needs a full rebuild'),
      });
      await db.update(schema.profileMeta).set({ lastProfiledAt: null });
      await expect(runScreenRecommend(db, null, 'local', { mediaFilter: 'both' }, deps(scriptedPort()))).rejects.toMatchObject({
        status: 400,
        detail: expect.stringContaining('No taste profile found'),
      });
    } finally {
      await close();
    }
  });

  test('400 when a book or a rated title changed since the build', async () => {
    const { db, close } = await seeded();
    try {
      await db.update(schema.books).set({ feedbackUpdatedAt: AFTER }).where(eq(schema.books.id, 1));
      await expect(runScreenRecommend(db, null, 'local', { mediaFilter: 'both' }, deps(scriptedPort()))).rejects.toMatchObject({
        status: 400,
        detail: '1 book(s) and 0 title(s) have changed since the last profile build. Re-profile first (POST /profile/update) so recommendations reflect your current taste.',
      });
      await db.update(schema.books).set({ feedbackUpdatedAt: null }).where(eq(schema.books.id, 1));
      await db.update(schema.titles).set({ appRating: 3, feedbackUpdatedAt: AFTER }).where(eq(schema.titles.id, 1));
      await expect(runScreenRecommend(db, null, 'local', { mediaFilter: 'both' }, deps(scriptedPort()))).rejects.toMatchObject({
        status: 400,
        detail: expect.stringContaining('0 book(s) and 1 title(s)'),
      });
    } finally {
      await close();
    }
  });

  test('a want-only change does not block (accepting a rec must not force a re-profile)', async () => {
    const { db, close } = await seeded();
    try {
      const [t] = await db
        .insert(schema.titles)
        .values({ userId: 'local', mediaType: 'movie', title: 'Accepted Rec', year: 2012, status: 'want', wikidataQid: 'Q777' })
        .returning();
      await db.insert(schema.titleEnrichment).values({ titleId: t.id, wikidataQid: 'Q777', resolutionConfidence: 1, confidenceLabel: 'HIGH', identitySource: 'auto', resolvedAt: AFTER });
      // Past the gate, the next check is the API key: reaching it proves the gate passed.
      await expect(runScreenRecommend(db, null, 'local', { mediaFilter: 'both' }, deps(scriptedPort()))).rejects.toMatchObject({
        status: 400,
        detail: expect.stringContaining('No Anthropic API key configured'),
      });
    } finally {
      await close();
    }
  });
});

describe('runScreenRecommend happy path', () => {
  setupTestEnv();

  test('retrieves from all three pools, validates citations, persists one run', async () => {
    const { db, close } = await seeded();
    const port = scriptedPort();
    const d = deps(port);
    const client = fakeClaude([
      seedResponse,
      rankResponse([
        { idx: 3, score: 0.9, traits: [1, 2, 3], books: [1, 4], titles: [4, 5, 3] },
        { idx: 0, score: 0.8, traits: [1], books: [1], titles: [] },
        { idx: 99, score: 0.99 },
        { idx: 0, score: 0.1 },
      ]),
    ] as never);
    try {
      const out = await runScreenRecommend(db, client, 'local', { mediaFilter: 'both' }, d);

      expect(out).toMatchObject({
        served: 2,
        candidates: 4,
        media_filter: 'both',
        pool_adaptation: 2,
        pool_metadata: 1,
        pool_seed: 2,
        seed_timed_out: false,
        seeds: ['Moon (2009)', 'The Expanse (2015)'],
        model: modelFor('rerank'),
      });
      expect(typeof out.run_id).toBe('string');

      // Claude call plumbing: seed first with a 45s abort, rerank with the remaining budget.
      expect(d.aborts).toEqual([SEED_BUDGET_MS, 280_000]);
      expect(client.calls).toHaveLength(2);
      expect(client.calls[0].params).toMatchObject({ model: modelFor('seed'), tool_choice: { type: 'tool', name: 'propose_screen_comparables' } });
      expect(client.calls[0].options?.signal).toBeInstanceOf(AbortSignal);
      expect(client.calls[1].params).toMatchObject({ model: modelFor('rerank'), tool_choice: { type: 'tool', name: 'rank_screen_recommendations' } });

      // Owned titles never reach the reranker; the adaptation carries its book.
      const rankText = (client.calls[1].params.messages as Array<{ content: Array<{ text: string }> }>)[0].content[1].text;
      expect(rankText).not.toContain('Forrest Gump');
      expect(rankText).not.toContain('Severance');
      expect(rankText).toContain('"adaptation_of": {"book_id": 1, "title": "Leviathan Wakes (The Expanse, #1)"}');

      const rows = await db.select().from(schema.titleRecommendations).orderBy(asc(schema.titleRecommendations.rank));
      expect(rows.map((r) => [r.rank, r.title, r.mediaType, r.mediaFilter, r.status])).toEqual([
        [1, 'Moon', 'movie', 'both', 'served'],
        [2, 'The Expanse', 'tv', 'both', 'served'],
      ]);
      expect(rows[0]).toMatchObject({
        userId: 'local',
        wikidataQid: 'Q11002',
        tvmazeId: null,
        retrievalPool: 'claude_seed',
        seedReason: 'seed:quiet isolation sci-fi',
        imageUrl: 'https://upload.wikimedia.org/m.jpg',
        rationale: 'Because 3.',
        groundedTraitIds: [1], // 2 is rejected, 3 belongs to another user
        groundedBookIds: [1], // 4 belongs to another user
        groundedTitleIds: [4], // 5 is another user's, 3 is a want title the prompt never carried
      });
      expect(rows[1]).toMatchObject({ tvmazeId: 1825, retrievalPool: 'multiple', seedReason: 'adaptation:series=Q7001;book=1' });

      expect((await usageOps(db)).map((u) => u.operation)).toEqual(['screen_rec_seed', 'screen_rec_rank']);
    } finally {
      await close();
    }
  });

  test('no surviving picks mints no run (issue #64)', async () => {
    const { db, close } = await seeded();
    const client = fakeClaude([seedResponse, rankResponse([{ idx: 99, score: 0.9 }, { idx: -1, score: 0.5 }])] as never);
    try {
      const out = await runScreenRecommend(db, client, 'local', { mediaFilter: 'both' }, deps(scriptedPort()));
      expect(out).toMatchObject({ run_id: null, served: 0, candidates: 4 });
      expect(await db.select().from(schema.titleRecommendations)).toEqual([]);
    } finally {
      await close();
    }
  });

  test('the TV filter keeps only series, each with a TVmaze id', async () => {
    const { db, close } = await seeded();
    const client = fakeClaude([seedResponse, rankResponse([{ idx: 0, score: 0.9 }, { idx: 1, score: 0.8 }])] as never);
    try {
      await runScreenRecommend(db, client, 'local', { mediaFilter: 'tv' }, deps(scriptedPort()));
      const rows = await db.select().from(schema.titleRecommendations);
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r.mediaType).toBe('tv');
        expect(r.tvmazeId).not.toBeNull();
        expect(r.mediaFilter).toBe('tv');
      }
      const seedText = (client.calls[0].params.messages as Array<{ content: Array<{ text: string }> }>)[0].content[1].text;
      expect(seedText).toContain('TV series only (no films)');
    } finally {
      await close();
    }
  });
});

describe('runScreenRecommend time budget', () => {
  setupTestEnv();

  test('seed timeout still serves a run from the other pools', async () => {
    const { db, close } = await seeded();
    const client = {
      calls: [] as unknown[],
      messages: {
        create: async (params: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
          const tool = (params.tools as Array<{ name: string }>)[0].name;
          if (tool === 'propose_screen_comparables') {
            return new Promise((_, reject) => {
              const s = options?.signal;
              if (s?.aborted) reject(new Error('Request was aborted.'));
              s?.addEventListener('abort', () => reject(new Error('Request was aborted.')));
            });
          }
          return rankResponse([{ idx: 0, score: 0.9 }]);
        },
      },
    } as unknown as ClaudeClient;
    const d = deps(scriptedPort(), {
      abortAfter: (ms) => (ms === SEED_BUDGET_MS ? AbortSignal.abort() : new AbortController().signal),
    });
    try {
      const out = await runScreenRecommend(db, client, 'local', { mediaFilter: 'both' }, d);
      expect(out).toMatchObject({ seed_timed_out: true, pool_seed: 0, served: 1, seeds: [] });
      expect(out.pool_adaptation).toBeGreaterThan(0);
    } finally {
      await close();
    }
  });

  test('a seed error that is NOT a timeout still fails the run', async () => {
    const { db, close } = await seeded();
    const client = {
      messages: { create: async () => { throw new Error('upstream 500'); } },
    } as unknown as ClaudeClient;
    try {
      await expect(runScreenRecommend(db, client, 'local', { mediaFilter: 'both' }, deps(scriptedPort()))).rejects.toThrow('upstream 500');
    } finally {
      await close();
    }
  });

  test('504 when retrieval leaves less than the minimum rerank window', async () => {
    const { db, close } = await seeded();
    let now = 0;
    const inner = scriptedPort();
    const port: FakePort = {
      ...inner,
      fetchMetadata: async (qids) => {
        const r = await inner.fetchMetadata(qids);
        now = 275_000; // hydration was the last retrieval step; 300 - 20 - 275 = 5s left
        return r;
      },
    };
    const client = fakeClaude([seedResponse] as never);
    try {
      await expect(
        runScreenRecommend(db, client, 'local', { mediaFilter: 'both' }, deps(port, { nowMs: () => now }))
      ).rejects.toMatchObject({ status: 504 });
      expect(client.calls).toHaveLength(1); // the rerank was never started
    } finally {
      await close();
    }
  });

  test('504 when the rerank request itself is aborted', async () => {
    const { db, close } = await seeded();
    const client = {
      messages: {
        create: async (params: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
          const tool = (params.tools as Array<{ name: string }>)[0].name;
          if (tool === 'propose_screen_comparables') return seedResponse;
          if (options?.signal?.aborted) throw new Error('Request was aborted.');
          throw new Error('unreachable');
        },
      },
    } as unknown as ClaudeClient;
    const d = deps(scriptedPort(), {
      abortAfter: (ms) => (ms === SEED_BUDGET_MS ? new AbortController().signal : AbortSignal.abort()),
    });
    try {
      await expect(runScreenRecommend(db, client, 'local', { mediaFilter: 'both' }, d)).rejects.toMatchObject({ status: 504 });
    } finally {
      await close();
    }
  });
});

describe('parseSeedProposals', () => {
  test('keeps well-formed titles in range, honors the filter, dedupes', () => {
    const input = {
      comparables: [
        { title: ' Moon ', media_type: 'movie', year: 2009, reason: 'x' },
        { title: 'Moon', media_type: 'movie', year: 2009, reason: 'dup' },
        { title: 'Show', media_type: 'tv', year: 2020, reason: 'y' },
        { title: '', media_type: 'movie', year: 2000 },
        { title: 'Future', media_type: 'movie', year: 2099 },
        { title: 'Float', media_type: 'movie', year: 2001.5 },
        { title: 'Theme', media_type: 'theme', year: 2001 },
      ],
    };
    expect(parseSeedProposals(input, 'both', 2026)).toEqual([
      { title: 'Moon', media_type: 'movie', year: 2009, reason: 'x' },
      { title: 'Show', media_type: 'tv', year: 2020, reason: 'y' },
    ]);
    expect(parseSeedProposals(input, 'tv', 2026).map((s) => s.title)).toEqual(['Show']);
    expect(parseSeedProposals(null, 'both', 2026)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it and see it fail**

Run: `npx vitest run lib/server/__tests__/screen-recommend-run.test.ts`
Expected: FAIL. `Cannot find module '../screenRecommendRun'`.

- [ ] **Step 4: Implement**

Create `lib/server/screenRecommendRun.ts`:

```ts
/**
 * Screen recommendations (spec §6): the two-stage orchestrator, the screen twin of
 * recommendRun.ts.
 *
 * Locked decision: the LLM is NOT the recommender. Claude's seeds are lookup INPUTS; only items
 * Stage 1 retrieved from Wikidata/TVmaze can be ranked, every cited index and id is validated,
 * and a rerank with no surviving picks mints no run (issue #64).
 *
 * Like recommendRun.ts, both Claude calls and every catalog fetch run OUTSIDE any transaction
 * (db.ts uses max: 1; touching `db` inside an open transaction deadlocks). The run is written
 * in one transaction afterwards.
 *
 * Time budget (spec §6.4), all measured from entry against the route's literal 300s ceiling:
 * seeds <= 45s (the SDK request is aborted), retrieval until 180s, the rerank gets the
 * remainder minus a 20s persistence reserve.
 */
import { randomUUID } from 'node:crypto';
import { trackedCreate } from './anthropic';
import { toolInput, type ClaudeClient } from './claude';
import {
  NO_PROFILE_MESSAGE,
  RECOMMEND_NO_KEY_MESSAGE,
  SCREEN_REBUILD_REQUIRED_MESSAGE,
  SCREEN_TIMEOUT_MESSAGE,
  screenStaleMessage,
} from './claudeErrors';
import { schema, type Db } from './db';
import { ApiError } from './errors';
import { logDebug } from './log';
import { modelFor } from './models';
import { asIdList } from './profileBuild';
import { ensureProfileMeta, readRebuildReason } from './profileMeta';
import { booksChangedSince } from './profileUpdate';
import {
  adaptationPool,
  assembleScreenPool,
  defaultScreenCatalogPort,
  metadataPool,
  seedPool,
  type MediaFilter,
  type ScreenCatalogPort,
  type ScreenPoolCandidate,
  type SeedProposal,
} from './screenAssemble';
import type { Deadline } from './screenCatalog';
import { titlesChangedSince } from './screenProfile';
import {
  buildScreenRerankPrompt,
  buildScreenSeedPrompt,
  SCREEN_RANK_MAX_TOKENS,
  SCREEN_RANK_SYSTEM,
  SCREEN_RANK_TOOL,
  SCREEN_SEED_COUNT,
  SCREEN_SEED_MAX_TOKENS,
  SCREEN_SEED_SYSTEM,
  SCREEN_SEED_TOOL,
  validEvidenceIds,
} from './screenRecPrompts';
import { requireScreenEnabled } from './screenSettings';
import { buildScreenSignal, type ScreenSignal } from './screenSignal';
import { round2, utcnowTs } from './serialize';
import { effectiveTitleRating, type TitleRow } from './titles';

export const SCREEN_DEFAULT_N = 10;
/** Must equal the route's literal `maxDuration = 300` (seconds). */
export const SCREEN_REQUEST_BUDGET_MS = 300_000;
export const SEED_BUDGET_MS = 45_000;
export const RETRIEVAL_END_MS = 180_000;
export const PERSIST_RESERVE_MS = 20_000;
/** A rerank with less than this left would almost certainly be aborted: answer 504 instead. */
export const MIN_RERANK_MS = 10_000;
/** Seeds kept from one proposal (the prompt asks for SCREEN_SEED_COUNT). */
const MAX_SEEDS = Math.round(SCREEN_SEED_COUNT * 1.5);

export interface ScreenRecommendOptions {
  mediaFilter: MediaFilter;
  n?: number;
}

export interface ScreenRecommendDeps {
  nowMs: () => number;
  abortAfter: (ms: number) => AbortSignal;
  catalog: (db: Db, deadline: Deadline) => ScreenCatalogPort;
}

export const defaultScreenRecommendDeps: ScreenRecommendDeps = {
  nowMs: () => Date.now(),
  abortAfter: (ms) => AbortSignal.timeout(ms),
  catalog: defaultScreenCatalogPort,
};

interface RankedScreenCandidate extends ScreenPoolCandidate {
  score: number;
  rationale: string;
  grounded_trait_ids: number[];
  grounded_book_ids: number[];
  grounded_title_ids: number[];
}

/**
 * The gate counts a changed title only when it is profile evidence the build would have seen:
 * rated, dropped, or a favorite -- the predicate booksChangedSince applies to books. A new
 * unrated `want` row (what accepting a recommendation creates) never blocks: spec §6.2 says rec
 * feedback does not block the server gate.
 */
export function blocksScreenRecs(t: TitleRow): boolean {
  return effectiveTitleRating(t) !== null || t.status === 'dropped' || t.isFavorite;
}

export function parseSeedProposals(
  input: Record<string, unknown> | null,
  mediaFilter: MediaFilter,
  nowYear: number
): SeedProposal[] {
  const raw = Array.isArray(input?.comparables) ? (input.comparables as unknown[]) : [];
  const seen = new Set<string>();
  const out: SeedProposal[] = [];
  for (const entry of raw) {
    if (out.length >= MAX_SEEDS) break;
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const media = item.media_type;
    const year = item.year;
    if (!title || (media !== 'movie' && media !== 'tv')) continue;
    if (typeof year !== 'number' || !Number.isInteger(year) || year < 1880 || year > nowYear + 2) continue;
    if (mediaFilter !== 'both' && media !== mediaFilter) continue;
    const key = `${media}\u0000${title.toLowerCase()}\u0000${year}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      title,
      media_type: media,
      year,
      reason: typeof item.reason === 'string' ? item.reason.trim() : '',
    });
  }
  return out;
}

async function claudeScreenSeeds(
  db: Db,
  client: ClaudeClient,
  signal: ScreenSignal,
  userId: string,
  mediaFilter: MediaFilter,
  abortSignal: AbortSignal
): Promise<SeedProposal[]> {
  const message = await trackedCreate(
    client,
    db,
    { userId, operation: 'screen_rec_seed' },
    {
      model: modelFor('seed'),
      max_tokens: SCREEN_SEED_MAX_TOKENS,
      system: SCREEN_SEED_SYSTEM,
      tools: [SCREEN_SEED_TOOL],
      tool_choice: { type: 'tool', name: SCREEN_SEED_TOOL.name },
      messages: [
        { role: 'user', content: buildScreenSeedPrompt(signal, mediaFilter, SCREEN_SEED_COUNT) },
      ],
    },
    { signal: abortSignal }
  );
  return parseSeedProposals(toolInput(message, ''), mediaFilter, new Date().getUTCFullYear());
}

async function claudeScreenRerank(
  db: Db,
  client: ClaudeClient,
  candidates: ScreenPoolCandidate[],
  signal: ScreenSignal,
  userId: string,
  n: number,
  abortSignal: AbortSignal
): Promise<RankedScreenCandidate[]> {
  const ids = validEvidenceIds(signal, candidates);
  const message = await trackedCreate(
    client,
    db,
    { userId, operation: 'screen_rec_rank' },
    {
      model: modelFor('rerank'),
      max_tokens: SCREEN_RANK_MAX_TOKENS,
      system: SCREEN_RANK_SYSTEM,
      tools: [SCREEN_RANK_TOOL],
      tool_choice: { type: 'tool', name: SCREEN_RANK_TOOL.name },
      messages: [{ role: 'user', content: buildScreenRerankPrompt(candidates, signal, n) }],
    },
    { signal: abortSignal }
  );

  const input = toolInput(message, '');
  const rankedRaw = (input?.recommendations as Array<Record<string, unknown>> | undefined) ?? [];
  const out: RankedScreenCandidate[] = [];
  const seenIdx = new Set<number>();
  for (const r of rankedRaw) {
    const idx = r.candidate_index;
    // Claude cannot add a candidate: an index outside the pool, or a repeat, is dropped.
    if (
      typeof idx !== 'number' ||
      !Number.isInteger(idx) ||
      idx < 0 ||
      idx >= candidates.length ||
      seenIdx.has(idx)
    ) {
      continue;
    }
    seenIdx.add(idx);
    out.push({
      ...candidates[idx],
      score: Number(r.score ?? 0),
      rationale: String(r.rationale ?? '').trim(),
      grounded_trait_ids: asIdList(r.grounded_trait_ids, ids.traitIds),
      grounded_book_ids: asIdList(r.grounded_book_ids, ids.bookIds),
      grounded_title_ids: asIdList(r.grounded_title_ids, ids.titleIds),
    });
  }
  if (rankedRaw.length > 0 && out.length === 0) {
    logDebug('screen-recommend', 'rerank returned no usable candidate indices', {
      userId,
      returned: rankedRaw.length,
      candidates: candidates.length,
      sampleIndex: JSON.stringify(rankedRaw[0]?.candidate_index ?? null),
    });
  }
  out.sort((a, b) => b.score - a.score);
  const withDesc = out.filter((c) => c.description);
  const withoutDesc = out.filter((c) => !c.description);
  return [...withDesc, ...withoutDesc].slice(0, n);
}

export async function runScreenRecommend(
  db: Db,
  client: ClaudeClient | null,
  userId: string,
  opts: ScreenRecommendOptions,
  deps: ScreenRecommendDeps = defaultScreenRecommendDeps
): Promise<Record<string, unknown>> {
  const startMs = deps.nowMs();
  const mediaFilter = opts.mediaFilter;
  const n = opts.n ?? SCREEN_DEFAULT_N;

  await requireScreenEnabled(db, userId);

  // Gate (spec §6.2): mirrors runRecommend, widened to titles and the rebuild reason. No
  // loved-titles requirement: a book-built profile is enough.
  const meta = await ensureProfileMeta(db, userId);
  if (meta.lastProfiledAt === null) throw new ApiError(400, NO_PROFILE_MESSAGE);
  if (await readRebuildReason(db, userId)) throw new ApiError(400, SCREEN_REBUILD_REQUIRED_MESSAGE);
  const changedBooks = await booksChangedSince(db, meta.lastProfiledAt, userId);
  const changedTitles = (await titlesChangedSince(db, meta.lastProfiledAt, userId)).filter(
    blocksScreenRecs
  );
  if (changedBooks.length > 0 || changedTitles.length > 0) {
    throw new ApiError(400, screenStaleMessage(changedBooks.length, changedTitles.length));
  }

  // Seeds always run, so the key is required up front (the book path defers this check only
  // because its seed stage is optional).
  if (!client) throw new ApiError(400, RECOMMEND_NO_KEY_MESSAGE);

  const signal = await buildScreenSignal(db, userId);

  // Stage 1b first: the seed call is paid for, so its titles resolve before the free pools
  // spend the retrieval window. A timeout is not an error -- the other pools still serve.
  let seeds: SeedProposal[] = [];
  let seedTimedOut = false;
  const seedAbort = deps.abortAfter(SEED_BUDGET_MS);
  try {
    seeds = await claudeScreenSeeds(db, client, signal, userId, mediaFilter, seedAbort);
  } catch (err) {
    if (!seedAbort.aborted) throw err;
    seedTimedOut = true;
    logDebug('screen-recommend', 'seed call aborted at the 45s budget', { userId });
  }

  const retrievalDeadline: Deadline = {
    remainingMs: () => startMs + RETRIEVAL_END_MS - deps.nowMs(),
  };
  const port = deps.catalog(db, retrievalDeadline);
  const seedHits = await seedPool(port, seeds, retrievalDeadline);
  const adaptationHits = await adaptationPool(port, signal, mediaFilter, retrievalDeadline);
  const metadataHits = await metadataPool(port, signal, mediaFilter, retrievalDeadline);
  // Merge order is provenance order: an adaptation keeps its "adaptation of" reason.
  const candidates = await assembleScreenPool(
    port,
    [adaptationHits, metadataHits, seedHits],
    signal,
    mediaFilter,
    retrievalDeadline
  );

  const summary = {
    media_filter: mediaFilter,
    candidates: candidates.length,
    pool_adaptation: adaptationHits.length,
    pool_metadata: metadataHits.length,
    pool_seed: seedHits.length,
    seeds: seeds.map((s) => `${s.title} (${s.year})`),
    seed_timed_out: seedTimedOut,
  };

  if (candidates.length === 0) {
    return {
      run_id: null,
      served: 0,
      ...summary,
      note: 'Retrieval surfaced no new candidates (catalog empty or unreachable?).',
      recommendations: [],
    };
  }

  const rerankMs = SCREEN_REQUEST_BUDGET_MS - PERSIST_RESERVE_MS - (deps.nowMs() - startMs);
  if (rerankMs < MIN_RERANK_MS) throw new ApiError(504, SCREEN_TIMEOUT_MESSAGE);
  const rankAbort = deps.abortAfter(rerankMs);
  let ranked: RankedScreenCandidate[];
  try {
    ranked = await claudeScreenRerank(db, client, candidates, signal, userId, n, rankAbort);
  } catch (err) {
    if (rankAbort.aborted) throw new ApiError(504, SCREEN_TIMEOUT_MESSAGE);
    throw err;
  }

  // A rerank that survives none of its own citations must not mint a run: an empty run writes
  // no rows, so GET /screen/recommendations keeps serving the PREVIOUS run (issue #64).
  if (ranked.length === 0) {
    return {
      run_id: null,
      served: 0,
      ...summary,
      note: `The reranker returned no usable picks from ${candidates.length} candidates.`,
      recommendations: [],
    };
  }

  const runId = randomUUID().replace(/-/g, '').slice(0, 12);
  const createdAt = utcnowTs();
  const recsOut: Record<string, unknown>[] = [];
  await db.transaction(async (tx) => {
    for (let i = 0; i < ranked.length; i++) {
      const c = ranked[i];
      const rank = i + 1;
      await tx.insert(schema.titleRecommendations).values({
        userId,
        runId,
        rank,
        mediaType: c.media_type,
        mediaFilter,
        title: c.title,
        year: c.year,
        wikidataQid: c.wikidata_qid,
        tvmazeId: c.tvmaze_id,
        imageUrl: c.image_url,
        genres: c.genres.slice(0, 8),
        description: c.description,
        retrievalPool: c.retrieval_pool,
        seedReason: c.seed_reason,
        score: c.score,
        rationale: c.rationale,
        groundedTraitIds: c.grounded_trait_ids,
        groundedBookIds: c.grounded_book_ids,
        groundedTitleIds: c.grounded_title_ids,
        status: 'served',
        createdAt,
      });
      recsOut.push({
        rank,
        media_type: c.media_type,
        title: c.title,
        year: c.year,
        score: round2(c.score),
        rationale: c.rationale,
        retrieval_pool: c.retrieval_pool,
        seed_reason: c.seed_reason,
        grounded_trait_ids: c.grounded_trait_ids,
        grounded_book_ids: c.grounded_book_ids,
        grounded_title_ids: c.grounded_title_ids,
      });
    }
  });

  return {
    run_id: runId,
    served: recsOut.length,
    ...summary,
    model: modelFor('rerank'),
    recommendations: recsOut,
  };
}
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run lib/server/__tests__/screen-recommend-run.test.ts`
Expected: PASS.

Points to check if it fails:
- `candidates: 4` assumes the assembled order: The Expanse ('multiple'), Murderbot, Film A, Moon. The Severance metadata row is dropped because it is owned by TVmaze id 44778, and Forrest Gump because it is owned by QID. If the count differs, print the rerank prompt's CANDIDATES block and compare it with `mergeHits`'s rules before changing the test.
- `pool_seed: 2` counts Moon and The Expanse. The Expanse merges into the adaptation hit as 'multiple'.
- The usage query casts a raw SQL string through `never` because `db.execute` is typed for `sql` templates. `anthropic.test.ts` uses the same raw-string form; mirror whatever it does if `tsc` objects.

- [ ] **Step 6: Mutation checks (spec §10: load-bearing)**

Run each of these, confirm the named test goes red, then revert:
1. Remove the `if (ranked.length === 0) { … }` block → `no surviving picks mints no run` goes red (a run with zero rows is not minted, but `run_id` comes back non-null).
2. Replace `.filter(blocksScreenRecs)` with nothing → `a want-only change does not block` goes red.
3. Replace `asIdList(r.grounded_title_ids, ids.titleIds)` with `(r.grounded_title_ids as number[])` → `validates citations` goes red.
4. Change `if (!seedAbort.aborted) throw err;` to `throw err;` → `seed timeout still serves a run` goes red.

- [ ] **Step 7: Commit**

```bash
git add lib/server/screenRecommendRun.ts lib/server/claudeErrors.ts lib/server/__tests__/screen-recommend-run.test.ts
git commit -m "feat(screen): orchestrate screen recommendations under the 300s budget (#96)"
```

**Hand off here (end of Batch B).**

---

### Task 9: Run and read routes

**Files:**
- Create: `lib/server/screenRecs.ts` (`titleRecOut`, `SCREEN_REJECT_REASONS`, `MEDIA_FILTERS`; Task 10 appends)
- Modify: `lib/server/ratelimit.ts` (`RATE_LIMITS.screenRecommend`)
- Create: `app/api/screen/recommend/route.ts`
- Create: `app/api/screen/recommendations/route.ts`
- Modify: `app/api/enrich/enrich-max-duration.test.ts` (add the recommend route to `ROUTES`)
- Test: `lib/server/__tests__/screen-recommend-routes.test.ts`

**Interfaces:**
- Consumes: `runScreenRecommend`, `SCREEN_DEFAULT_N` (Task 8); `MediaFilter` (Task 5); `requireScreenEnabled` (w4); `resolveAnthropicKey`, `makeAnthropicClient` (`claude.ts`); `checkRateLimit`, `RATE_LIMITS` (`ratelimit.ts`); `tsToIso` (`serialize.ts`); `seedScreenLibrary`, `PROFILED_AT` (Task 3 fixtures).
- Produces (Task 10 and wave 8 rely on these):

```ts
export const MEDIA_FILTERS = ['both', 'movie', 'tv'] as const; // satisfies readonly MediaFilter[]
export const SCREEN_REJECT_REASONS = ['wrong_genre', 'too_dark', 'too_long', 'not_now', 'overhyped', 'wrong_vibe'] as const;
export type ScreenRejectReason = (typeof SCREEN_REJECT_REASONS)[number];
export type TitleRecRow = typeof schema.titleRecommendations.$inferSelect;
export interface TitleRecOut {
  id: number; run_id: string; rank: number; media_type: 'movie' | 'tv'; media_filter: MediaFilter;
  title: string; year: number | null; wikidata_qid: string | null; tvmaze_id: number | null;
  image_url: string | null; genres: string[]; description: string | null;
  retrieval_pool: string | null; seed_reason: string | null; score: number; rationale: string | null;
  grounded_trait_ids: number[]; grounded_book_ids: number[]; grounded_title_ids: number[];
  status: 'served' | 'accepted' | 'rejected' | 'already_watched'; user_note: string | null;
  reject_reasons: string[] | null; created_at: string | null;
}
export function titleRecOut(row: TitleRecRow): TitleRecOut;
```
- `POST /api/screen/recommend` with body `{ media_filter?: 'both' | 'movie' | 'tv', n?: 1–20 }` (both defaulted; an absent body means all defaults) returns `runScreenRecommend`'s object. Order: body validation (422), `requireScreenEnabled` (403), rate limit (429 "Too many recommendation runs. Try again in a minute."), then the run.
- `GET /api/screen/recommendations` returns `TitleRecOut[]` for the latest run across all filters, in rank order, or `[]`. 403 when ScreenSprite is disabled.

Spec §6.6 and §6.8, and design decision 11. The run route is the screen twin of `app/api/recommend/route.ts`, with two deliberate differences: the body may be absent (that route's 422-on-missing-body is FastAPI parity, and this route has no Python ancestor), and it is rate-limited because each run spends two Claude calls and up to about 20 Wikimedia queries. The rate-limit response uses `ApiError(429, …)` and the normal `{"detail": …}` shape.

`titleRecOut` carries `description` but no description source: `title_recommendations` has no source column (spec §6.6). Wave 8's recommendation card shows tile, year, type, rationale and chips (spec §7.2), not the description, and the `/screen` footer credits Wikidata, Wikipedia and TVmaze (§7.9).

- [ ] **Step 1: Write the failing test**

Create `lib/server/__tests__/screen-recommend-routes.test.ts`:

```ts
import { describe, test, expect } from 'vitest';
import { makeTestDb } from './helpers/pglite';
import { setupTestEnv } from './helpers/testEnv';
import { seedScreenLibrary } from './helpers/screenRecFixtures';
import { _setDbForTests, schema, type Db } from '../db';
import { SCREEN_REJECT_REASONS, titleRecOut } from '../screenRecs';
import { REJECT_REASONS } from '../recs';
import { POST as recommend } from '@/app/api/screen/recommend/route';
import { GET as latest } from '@/app/api/screen/recommendations/route';

const runReq = (body?: unknown) =>
  new Request('http://test/api/screen/recommend', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
const latestReq = () => new Request('http://test/api/screen/recommendations');

async function withDb(fn: (db: Db) => Promise<void>, opts: { enabled?: boolean } = {}) {
  const { db, close } = await makeTestDb();
  try {
    await seedScreenLibrary(db, opts);
    _setDbForTests(db);
    await fn(db);
  } finally {
    _setDbForTests(null);
    await close();
  }
}

function rec(over: Partial<typeof schema.titleRecommendations.$inferInsert>) {
  return {
    userId: 'local',
    runId: 'run-a',
    rank: 1,
    mediaType: 'movie',
    mediaFilter: 'both',
    title: 'Moon',
    year: 2009,
    wikidataQid: 'Q11002',
    score: 0.9,
    rationale: 'Because.',
    groundedTraitIds: [1],
    groundedBookIds: [1],
    groundedTitleIds: [2],
    status: 'served',
    createdAt: '2026-09-20 10:00:00',
    ...over,
  };
}

describe('screen reject vocabulary', () => {
  test('is the book list without tried_author, in the book order', () => {
    expect([...SCREEN_REJECT_REASONS]).toEqual(REJECT_REASONS.filter((r) => r !== 'tried_author'));
  });
});

describe('POST /api/screen/recommend', () => {
  setupTestEnv();

  test('422 on malformed JSON, an unknown filter, or an out-of-range n', async () => {
    await withDb(async () => {
      expect((await recommend(runReq('{not json'))).status).toBe(422);
      expect((await recommend(runReq({ media_filter: 'books' }))).status).toBe(422);
      expect((await recommend(runReq({ n: 0 }))).status).toBe(422);
      expect((await recommend(runReq({ n: 21 }))).status).toBe(422);
    });
  });

  test('403 when ScreenSprite is disabled', async () => {
    await withDb(
      async () => {
        const res = await recommend(runReq());
        expect(res.status).toBe(403);
      },
      { enabled: false }
    );
  });

  test('an absent body takes the defaults and reaches the key check', async () => {
    await withDb(async () => {
      const res = await recommend(runReq());
      expect(res.status).toBe(400);
      expect((await res.json()).detail).toContain('No Anthropic API key configured');
    });
  });

  test('the fourth run in a minute answers 429 in the detail shape', async () => {
    await withDb(async () => {
      for (let i = 0; i < 3; i++) expect((await recommend(runReq({}))).status).toBe(400);
      const res = await recommend(runReq({}));
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({
        detail: 'Too many recommendation runs. Try again in a minute.',
      });
    });
  });
});

describe('GET /api/screen/recommendations', () => {
  setupTestEnv();

  test('[] before any run', async () => {
    await withDb(async () => {
      const res = await latest(latestReq());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });
  });

  test('returns the latest run across filters, in rank order, for this user only', async () => {
    await withDb(async (db) => {
      await db.insert(schema.titleRecommendations).values([
        rec({ runId: 'run-a', mediaFilter: 'movie', createdAt: '2026-09-20 10:00:00' }),
        rec({ runId: 'run-b', mediaFilter: 'tv', rank: 2, title: 'Murderbot', mediaType: 'tv', wikidataQid: 'Q8004', tvmazeId: 60000, createdAt: '2026-09-21 10:00:00' }),
        rec({ runId: 'run-b', mediaFilter: 'tv', rank: 1, title: 'The Expanse', mediaType: 'tv', wikidataQid: 'Q12001', tvmazeId: 1825, createdAt: '2026-09-21 10:00:00' }),
        rec({ userId: 'other', runId: 'run-z', createdAt: '2026-09-22 10:00:00' }),
      ]);
      const body = await (await latest(latestReq())).json();
      expect(body.map((r: { run_id: string; rank: number; title: string }) => [r.run_id, r.rank, r.title])).toEqual([
        ['run-b', 1, 'The Expanse'],
        ['run-b', 2, 'Murderbot'],
      ]);
      expect(body[0]).toMatchObject({ media_type: 'tv', media_filter: 'tv', tvmaze_id: 1825, genres: [], status: 'served', reject_reasons: null });
    });
  });

  test('403 when ScreenSprite is disabled', async () => {
    await withDb(async () => expect((await latest(latestReq())).status).toBe(403), { enabled: false });
  });
});

describe('titleRecOut', () => {
  test('defaults null JSON lists to [] and serializes created_at', () => {
    const out = titleRecOut({
      ...rec({}),
      id: 7,
      tvmazeId: null,
      imageUrl: null,
      genres: null,
      description: null,
      retrievalPool: 'metadata',
      seedReason: 'shares a director',
      groundedTraitIds: null,
      groundedBookIds: null,
      groundedTitleIds: null,
      userNote: null,
      rejectReasons: null,
    } as never);
    expect(out).toMatchObject({ id: 7, genres: [], grounded_trait_ids: [], grounded_book_ids: [], grounded_title_ids: [] });
    expect(out.created_at).toBe('2026-09-20T10:00:00');
  });
});
```

The rate-limit test relies on each of the first three calls failing fast at the key check, after the rate-limit check has counted it. Each `withDb` builds a fresh database, so rate-limit buckets never leak between tests.

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest list lib/server/__tests__/screen-recommend-routes.test.ts` (expect the tests listed), then `npx vitest run lib/server/__tests__/screen-recommend-routes.test.ts`.
Expected: FAIL, because `../screenRecs` and both route modules do not exist.

- [ ] **Step 3: Implement**

Create `lib/server/screenRecs.ts`:

```ts
/**
 * Screen recommendation rows on the wire, the screen reject vocabulary, and (Task 10) landing an
 * accepted recommendation in the library. The screen twin of recs.ts.
 */
import type { schema } from './db';
import type { MediaFilter } from './screenAssemble';
import { tsToIso } from './serialize';

export const MEDIA_FILTERS = ['both', 'movie', 'tv'] as const satisfies readonly MediaFilter[];

/**
 * Spec §6.7: the book list (recs.ts#REJECT_REASONS) without `tried_author`, in the same order,
 * so the 422 detail lists codes the way the book route does. `too_long` means runtime or
 * season count.
 */
export const SCREEN_REJECT_REASONS = [
  'wrong_genre',
  'too_dark',
  'too_long',
  'not_now',
  'overhyped',
  'wrong_vibe',
] as const;
export type ScreenRejectReason = (typeof SCREEN_REJECT_REASONS)[number];

export type TitleRecRow = typeof schema.titleRecommendations.$inferSelect;

export interface TitleRecOut {
  id: number;
  run_id: string;
  rank: number;
  media_type: 'movie' | 'tv';
  media_filter: MediaFilter;
  title: string;
  year: number | null;
  wikidata_qid: string | null;
  tvmaze_id: number | null;
  image_url: string | null;
  genres: string[];
  description: string | null;
  retrieval_pool: string | null;
  seed_reason: string | null;
  score: number;
  rationale: string | null;
  grounded_trait_ids: number[];
  grounded_book_ids: number[];
  grounded_title_ids: number[];
  status: 'served' | 'accepted' | 'rejected' | 'already_watched';
  user_note: string | null;
  reject_reasons: string[] | null;
  created_at: string | null;
}

function ids(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((v): v is number => typeof v === 'number') : [];
}

export function titleRecOut(r: TitleRecRow): TitleRecOut {
  return {
    id: r.id,
    run_id: r.runId,
    rank: r.rank,
    media_type: r.mediaType as 'movie' | 'tv',
    media_filter: r.mediaFilter as MediaFilter,
    title: r.title,
    year: r.year,
    wikidata_qid: r.wikidataQid,
    tvmaze_id: r.tvmazeId,
    image_url: r.imageUrl,
    genres: Array.isArray(r.genres) ? (r.genres as string[]) : [],
    description: r.description,
    retrieval_pool: r.retrievalPool,
    seed_reason: r.seedReason,
    score: r.score,
    rationale: r.rationale,
    grounded_trait_ids: ids(r.groundedTraitIds),
    grounded_book_ids: ids(r.groundedBookIds),
    grounded_title_ids: ids(r.groundedTitleIds),
    status: r.status as TitleRecOut['status'],
    user_note: r.userNote,
    reject_reasons: Array.isArray(r.rejectReasons) ? (r.rejectReasons as string[]) : null,
    created_at: tsToIso(r.createdAt),
  };
}
```

If `tsToIso`'s signature does not accept this column's type, read it in `serialize.ts` and match how `recs.ts#recOut` calls it; do not change `tsToIso`.

In `lib/server/ratelimit.ts`, add this entry to `RATE_LIMITS`, after wave 5's `screenSearch`:

```ts
  /** One run spends two Claude calls and up to ~20 Wikimedia queries (w7 decision 11). */
  screenRecommend: { limit: 3, windowSeconds: 60 },
```

Create `app/api/screen/recommend/route.ts`:

```ts
import { z } from 'zod';
import { makeAnthropicClient, resolveAnthropicKey } from '@/lib/server/claude';
import { getDb } from '@/lib/server/db';
import { ApiError, withApi } from '@/lib/server/http';
import { checkRateLimit, RATE_LIMITS } from '@/lib/server/ratelimit';
import { SCREEN_DEFAULT_N, runScreenRecommend } from '@/lib/server/screenRecommendRun';
import { MEDIA_FILTERS } from '@/lib/server/screenRecs';
import { requireScreenEnabled } from '@/lib/server/screenSettings';

// Two Claude calls plus up to ~20 Wikimedia queries, budgeted inside this ceiling by
// screenRecommendRun.ts (spec §6.4). Must stay a literal: Next's segment-config analyzer
// rejects an imported binding, and the build fails without naming this file.
export const maxDuration = 300;

const Body = z.object({
  media_filter: z.enum(MEDIA_FILTERS).default('both'),
  n: z.number().int().min(1).max(20).default(SCREEN_DEFAULT_N),
});

export const POST = withApi('/api/screen/recommend', async (req, ctx) => {
  // Unlike /api/recommend (FastAPI parity), an absent body means "all defaults".
  const text = await req.text();
  let raw: unknown = {};
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new ApiError(422, 'validation error: body is not valid JSON');
    }
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(
      422,
      `validation error: ${parsed.error.issues[0]?.message ?? 'invalid body'}`
    );
  }

  const db = getDb();
  const userId = ctx.user.userId;
  // Disabled users never spend a rate-limit slot.
  await requireScreenEnabled(db, userId);
  const limit = await checkRateLimit(db, {
    key: `screenRecommend:${userId}`,
    ...RATE_LIMITS.screenRecommend,
  });
  if (!limit.allowed) {
    throw new ApiError(429, 'Too many recommendation runs. Try again in a minute.');
  }

  const apiKey = await resolveAnthropicKey(db, userId);
  const client = apiKey ? makeAnthropicClient(apiKey) : null;
  const out = await runScreenRecommend(db, client, userId, {
    mediaFilter: parsed.data.media_filter,
    n: parsed.data.n,
  });
  ctx.timer.mark('claude');
  return Response.json(out);
});
```

Create `app/api/screen/recommendations/route.ts`:

```ts
import { and, asc, desc, eq } from 'drizzle-orm';
import { getDb, schema } from '@/lib/server/db';
import { withApi } from '@/lib/server/http';
import { titleRecOut } from '@/lib/server/screenRecs';
import { requireScreenEnabled } from '@/lib/server/screenSettings';

const recs = schema.titleRecommendations;

/** Spec §6.6: the latest run across filters, rank order. The twin of GET /api/recommendations. */
export const GET = withApi('/api/screen/recommendations', async (_req, ctx) => {
  const db = getDb();
  const userId = ctx.user.userId;
  await requireScreenEnabled(db, userId);
  const last = await db
    .select({ runId: recs.runId })
    .from(recs)
    .where(eq(recs.userId, userId))
    .orderBy(desc(recs.createdAt), desc(recs.id))
    .limit(1);
  if (last.length === 0) {
    ctx.timer.mark('db');
    return Response.json([]);
  }
  const rows = await db
    .select()
    .from(recs)
    .where(and(eq(recs.userId, userId), eq(recs.runId, last[0].runId)))
    .orderBy(asc(recs.rank));
  ctx.timer.mark('db');
  return Response.json(rows.map(titleRecOut));
});
```

In `app/api/enrich/enrich-max-duration.test.ts`, add `'../screen/recommend/route.ts'` to `ROUTES` (after wave 5's `'../screen/enrich/start/route.ts'`).

- [ ] **Step 4: Run the tests**

Run: `npx vitest run lib/server/__tests__/screen-recommend-routes.test.ts app/api/enrich/enrich-max-duration.test.ts lib/server/__tests__/recommend-route.test.ts`
Expected: PASS. The book recommend route test passes unedited.

- [ ] **Step 5: Mutation checks**

1. In the recommend route, move the rate-limit block above `requireScreenEnabled`. Expected: every test still passes. That is correct: order is not observable here, and this check only confirms the 429 test does not depend on it. Restore.
2. In the recommend route, change `export const maxDuration = 300;` to `export const maxDuration = 60 * 5;`. Run the max-duration test. Expected: FAIL for `../screen/recommend/route.ts`. Restore.
3. In the GET route, drop `eq(recs.userId, userId)` from the first query. Expected: FAIL in `returns the latest run across filters…`, because `other`'s newer run wins. Restore.

- [ ] **Step 6: Commit**

```bash
git add lib/server/screenRecs.ts lib/server/ratelimit.ts app/api/screen/recommend/route.ts app/api/screen/recommendations/route.ts app/api/enrich/enrich-max-duration.test.ts lib/server/__tests__/screen-recommend-routes.test.ts
git commit -m "feat(screen): screen recommendation run and read routes (#96)"
```

---

### Task 10: Feedback on a recommendation

**Files:**
- Modify: `lib/server/screenRecs.ts` (append `ensureScreenTitle` and the metadata seam)
- Create: `app/api/screen/recommendations/[id]/feedback/route.ts`
- Test: `lib/server/__tests__/screen-rec-feedback-route.test.ts`

**Interfaces:**
- Consumes: `TitleRecRow`, `SCREEN_REJECT_REASONS` (Task 9); `fetchScreenMetadata`, `candidateEnrichmentValues`, `isTitleIdentityViolation`, `serializeResolutionConfidence` (w5); `ScreenCandidate` (w5); `deadlineIn` (w5); `normalizeTitleKey`, `titleOut`, `TitleRow`, `TitleEnrichmentRow` (w4); `requireScreenEnabled` (w4); `ensureProfileMeta` (`profileMeta.ts`); `parseIdParam`, `pyList`, `utcnowTs` (`serialize.ts`).
- Produces (wave 8 relies on the route):

```ts
export const REC_METADATA_DEADLINE_MS = 20_000;
export async function fetchRecCandidate(db: Db, rec: TitleRecRow): Promise<ScreenCandidate | null>;
export function _setRecCandidateFetchForTests(fn: ((rec: TitleRecRow) => Promise<ScreenCandidate | null>) | null): void;
export async function ensureScreenTitle(
  tx: Db | DbTx, userId: string, rec: TitleRecRow, status: 'want' | 'watched', candidate: ScreenCandidate | null
): Promise<{ title: TitleRow; enrichment: TitleEnrichmentRow | null; created: boolean }>;
```
- `POST /api/screen/recommendations/[id]/feedback` with body `{ status: 'accepted' | 'already_watched' | 'rejected', reject_reasons?: string[], user_note?: string | null }` returns `{ id, status, user_note, reject_reasons, title: TitleOut | null }`. `title` is the library title for `accepted` and `already_watched`, else `null`.

Spec §6.7 and design decisions 8–10:
- **accepted / already_watched** land the recommendation in the library, idempotently. The match is on `titles.wikidata_qid`, then `titles.tvmaze_id`, then normalized title plus year (media type is not compared, because a Letterboxd import files a miniseries as a movie until enrichment converts it). An existing title comes back **unchanged**: no status, rating, review or favorite overwrite, so accepting a film already rated 4.5 never demotes it to `want`.
- A new title gets `want` (accepted) or `watched` (already watched), `feedback_updated_at` left null (it is not a rating change), and a `title_enrichment` row with `identity_source = 'auto'`, label `HIGH` and `match_method = 'recommendation'`. Its metadata comes from `fetchScreenMetadata`, fetched **outside** the transaction (normally a `catalog_cache` hit from the run). If that fetch fails, the row's own stored fields are used.
- **rejected** accepts optional `reject_reasons` from `SCREEN_REJECT_REASONS`. `reject_reasons` with any other status is a 422.
- Every call stamps `profile_meta.rec_feedback_updated_at` (decision 9), in the same transaction as the row update.
- Two quick clicks can race past the match into the `(user_id, wikidata_qid)` or `(user_id, tvmaze_id)` unique index. The route retries the transaction once on `isTitleIdentityViolation`; the retry finds the row the other request created (Review Focus 4).

- [ ] **Step 1: Write the failing test**

Create `lib/server/__tests__/screen-rec-feedback-route.test.ts`:

```ts
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeTestDb } from './helpers/pglite';
import { setupTestEnv } from './helpers/testEnv';
import { candidate, seedScreenLibrary } from './helpers/screenRecFixtures';
import { _setDbForTests, schema, type Db } from '../db';
import { _setRecCandidateFetchForTests } from '../screenRecs';

const race = vi.hoisted(() => ({ failNext: false }));

vi.mock('../screenRecs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../screenRecs')>();
  return {
    ...actual,
    ensureScreenTitle: async (...args: Parameters<typeof actual.ensureScreenTitle>) => {
      if (race.failNext) {
        race.failNext = false;
        throw new Error('duplicate key value violates unique constraint "uq_titles_user_wikidata_qid"');
      }
      return actual.ensureScreenTitle(...args);
    },
  };
});

// vi.mock is hoisted above every import, so the route sees the wrapped ensureScreenTitle.
import { POST } from '@/app/api/screen/recommendations/[id]/feedback/route';

const call = (id: number | string, body: unknown) =>
  POST(
    new Request(`http://test/api/screen/recommendations/${id}/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: { id: String(id) } }
  );

/** Recs for 'local' (ids 1-5) and one for 'other' (id 6). */
async function seedRecs(db: Db): Promise<void> {
  const base = {
    userId: 'local',
    runId: 'run-a',
    mediaFilter: 'both',
    score: 0.9,
    rationale: 'Because.',
    status: 'served',
    createdAt: '2026-09-20 10:00:00',
  };
  await db.insert(schema.titleRecommendations).values([
    { ...base, rank: 1, mediaType: 'movie', title: 'Moon', year: 2009, wikidataQid: 'Q11002', genres: ['science fiction film'], description: 'Stored description.', imageUrl: 'https://upload.wikimedia.org/m.jpg' },
    { ...base, rank: 2, mediaType: 'tv', title: 'The Expanse', year: 2015, wikidataQid: 'Q12001', tvmazeId: 1825 },
    { ...base, rank: 3, mediaType: 'movie', title: 'Forrest Gump', year: 1994, wikidataQid: 'Q134773' },
    { ...base, rank: 4, mediaType: 'movie', title: 'Arrival', year: 2016, wikidataQid: 'Q20000001' },
    { ...base, rank: 5, mediaType: 'tv', title: 'Severance', year: 2022, wikidataQid: 'Q20000002', tvmazeId: 44778 },
    { ...base, userId: 'other', rank: 1, mediaType: 'movie', title: 'Their Rec', year: 2001, wikidataQid: 'Q30000001' },
  ]);
}

const MOON = candidate({
  title: 'Moon',
  wikidata_qid: 'Q11002',
  year: 2009,
  directors: ['Duncan Jones'],
  genres: ['science fiction film', 'drama film'],
  description: 'Fetched description.',
  description_source: 'wikipedia',
  description_url: 'https://en.wikipedia.org/wiki/Moon_(2009_film)',
});

async function withDb(fn: (db: Db) => Promise<void>, opts: { enabled?: boolean } = {}) {
  const { db, close } = await makeTestDb();
  try {
    await seedScreenLibrary(db, opts);
    await seedRecs(db);
    _setDbForTests(db);
    await fn(db);
  } finally {
    _setDbForTests(null);
    _setRecCandidateFetchForTests(null);
    await close();
  }
}

async function titleCount(db: Db): Promise<number> {
  return (await db.select().from(schema.titles).where(eq(schema.titles.userId, 'local'))).length;
}

describe('POST /api/screen/recommendations/[id]/feedback', () => {
  setupTestEnv();
  beforeEach(() => {
    race.failNext = false;
    _setRecCandidateFetchForTests(async (rec) => (rec.wikidataQid === 'Q11002' ? MOON : null));
  });

  test('accepted lands a new want title with fetched metadata and stamps rec feedback', async () => {
    await withDb(async (db) => {
      const res = await call(1, { status: 'accepted' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ id: 1, status: 'accepted', user_note: null, reject_reasons: null });
      expect(body.title).toMatchObject({ title: 'Moon', year: 2009, status: 'want', media_type: 'movie' });
      expect(body.title.enrichment).toMatchObject({ identity_source: 'auto', confidence_label: 'HIGH', match_method: 'recommendation', directors: ['Duncan Jones'], description_source: 'wikipedia' });

      const [t] = await db.select().from(schema.titles).where(eq(schema.titles.id, body.title.id));
      expect(t).toMatchObject({ wikidataQid: 'Q11002', tvmazeId: null, feedbackUpdatedAt: null });
      const [meta] = await db.select().from(schema.profileMeta).where(eq(schema.profileMeta.userId, 'local'));
      expect(meta.recFeedbackUpdatedAt).not.toBeNull();
      const [r] = await db.select().from(schema.titleRecommendations).where(eq(schema.titleRecommendations.id, 1));
      expect(r.status).toBe('accepted');
    });
  });

  test('already_watched lands a show as watched with its TVmaze id, from stored fields when the fetch fails', async () => {
    await withDb(async (db) => {
      const body = await (await call(2, { status: 'already_watched' })).json();
      expect(body.title).toMatchObject({ title: 'The Expanse', status: 'watched', media_type: 'tv' });
      const [t] = await db.select().from(schema.titles).where(eq(schema.titles.id, body.title.id));
      expect(t).toMatchObject({ wikidataQid: 'Q12001', tvmazeId: 1825 });
      expect(body.title.enrichment).toMatchObject({ identity_source: 'auto', directors: [] });
    });
  });

  test('accepting twice is idempotent', async () => {
    await withDb(async (db) => {
      const first = await (await call(1, { status: 'accepted' })).json();
      const before = await titleCount(db);
      const second = await (await call(1, { status: 'accepted' })).json();
      expect(second.title.id).toBe(first.title.id);
      expect(await titleCount(db)).toBe(before);
    });
  });

  test('an existing rated title is returned unchanged', async () => {
    await withDb(async (db) => {
      const [before] = await db.select().from(schema.titles).where(eq(schema.titles.id, 1));
      const body = await (await call(3, { status: 'accepted' })).json();
      expect(body.title.id).toBe(1);
      const [after] = await db.select().from(schema.titles).where(eq(schema.titles.id, 1));
      expect(after).toEqual(before); // still watched, still 4.5, never demoted to want
    });
  });

  test('matches an owned title by title and year when the ids differ', async () => {
    await withDb(async (db) => {
      const count = await titleCount(db);
      const body = await (await call(4, { status: 'already_watched' })).json();
      expect(body.title).toMatchObject({ id: 3, title: 'Arrival', status: 'want' });
      expect(await titleCount(db)).toBe(count);
    });
  });

  test('matches an owned show by TVmaze id', async () => {
    await withDb(async () => {
      const body = await (await call(5, { status: 'accepted' })).json();
      expect(body.title.id).toBe(4);
    });
  });

  test('retries once when a racing request wins the unique index', async () => {
    await withDb(async (db) => {
      race.failNext = true;
      const res = await call(1, { status: 'accepted' });
      expect(res.status).toBe(200);
      expect((await res.json()).title.title).toBe('Moon');
      expect(race.failNext).toBe(false);
      expect((await db.select().from(schema.titles).where(eq(schema.titles.wikidataQid, 'Q11002'))).length).toBe(1);
    });
  });

  test('rejected stores reasons and a note, and lands nothing', async () => {
    await withDb(async (db) => {
      const count = await titleCount(db);
      const body = await (await call(1, { status: 'rejected', reject_reasons: ['too_long', 'not_now'], user_note: 'Maybe later' })).json();
      expect(body).toEqual({ id: 1, status: 'rejected', user_note: 'Maybe later', reject_reasons: ['too_long', 'not_now'], title: null });
      expect(await titleCount(db)).toBe(count);
    });
  });

  test('422 on a bad status, unknown or empty reasons, or reasons without a rejection', async () => {
    await withDb(async () => {
      const detail = async (body: unknown) => {
        const res = await call(1, body);
        expect(res.status).toBe(422);
        return (await res.json()).detail as string;
      };
      expect(await detail({ status: 'already_read' })).toBe(
        "status must be one of 'accepted', 'already_watched', 'rejected'"
      );
      expect(await detail({ status: 'rejected', reject_reasons: ['tried_author'] })).toBe(
        "Unknown reject_reasons: ['tried_author']. Valid codes: ['wrong_genre', 'too_dark', 'too_long', 'not_now', 'overhyped', 'wrong_vibe']"
      );
      expect(await detail({ status: 'rejected', reject_reasons: [] })).toContain('non-empty list');
      expect(await detail({ status: 'accepted', reject_reasons: ['too_long'] })).toBe(
        "reject_reasons may only be provided when status is 'rejected'"
      );
      expect((await call('abc', { status: 'accepted' })).status).toBe(422);
    });
  });

  test("404 for another user's recommendation and for a missing one", async () => {
    await withDb(async () => {
      expect((await call(6, { status: 'accepted' })).status).toBe(404);
      expect((await call(999, { status: 'accepted' })).status).toBe(404);
    });
  });

  test('403 when ScreenSprite is disabled', async () => {
    await withDb(async () => expect((await call(1, { status: 'accepted' })).status).toBe(403), { enabled: false });
  });
});
```

Check the 422 messages against `pyList`'s output format in `serialize.ts` before running. If `pyList` renders differently from `['a', 'b']`, fix the **expected strings** in this test to its real output; the book route's messages come from the same helper.

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest list lib/server/__tests__/screen-rec-feedback-route.test.ts`, then `npx vitest run lib/server/__tests__/screen-rec-feedback-route.test.ts`.
Expected: FAIL, because `_setRecCandidateFetchForTests` and the route do not exist.

- [ ] **Step 3: Append to `lib/server/screenRecs.ts`**

Replace the file's `import type { schema } from './db';` with the runtime import below and add the others:

```ts
import { and, asc, eq, isNull, or } from 'drizzle-orm';
import { schema, type Db, type DbTx } from './db';
import { deadlineIn } from './screenCatalog';
import {
  candidateEnrichmentValues,
  fetchScreenMetadata,
  serializeResolutionConfidence,
  type ScreenCandidate,
} from './screenEnrichment';
import { normalizeTitleKey, type TitleEnrichmentRow, type TitleRow } from './titles';
import { utcnowTs } from './serialize';
```

(`tsToIso` stays imported from `./serialize`; merge the two imports into one.) If `serializeResolutionConfidence` is not exported from `screenEnrichment.ts`, import it from where wave 5's manual-add route imports it.

Then append:

```ts
// --- Landing an accepted recommendation (spec §6.7) ----------------------------------

/** The metadata fetch runs before the transaction; usually a catalog_cache hit from the run. */
export const REC_METADATA_DEADLINE_MS = 20_000;

let recCandidateFetch: ((rec: TitleRecRow) => Promise<ScreenCandidate | null>) | null = null;

/** Test seam: replace the metadata fetch. `null` restores the catalog. */
export function _setRecCandidateFetchForTests(
  fn: ((rec: TitleRecRow) => Promise<ScreenCandidate | null>) | null
): void {
  recCandidateFetch = fn;
}

/**
 * Full metadata for a recommendation (decision 8), or null when it cannot be fetched now:
 * the caller then falls back to the fields stored on the recommendation row.
 */
export async function fetchRecCandidate(db: Db, rec: TitleRecRow): Promise<ScreenCandidate | null> {
  if (recCandidateFetch) return recCandidateFetch(rec);
  if (!rec.wikidataQid) return null;
  const result = await fetchScreenMetadata(
    db,
    [rec.wikidataQid],
    deadlineIn(REC_METADATA_DEADLINE_MS)
  );
  return result.kind === 'ok' ? (result.value.get(rec.wikidataQid) ?? null) : null;
}

/** Stored-field fallback, shaped like candidateEnrichmentValues' output. */
function recEnrichmentValues(rec: TitleRecRow) {
  return {
    wikidataQid: rec.wikidataQid,
    tvmazeId: rec.tvmazeId,
    wikipediaPage: null,
    genres: Array.isArray(rec.genres) ? rec.genres : [],
    directors: [],
    creators: [],
    writers: [],
    countries: [],
    originalLanguage: null,
    basedOn: [],
    mainSubjects: [],
    series: [],
    productionCompanies: [],
    sitelinks: null,
    description: rec.description,
    descriptionSource: null,
    descriptionUrl: null,
    imageUrl: rec.imageUrl,
  };
}

async function withEnrichment(tx: Db | DbTx, title: TitleRow) {
  const [enrichment] = await tx
    .select()
    .from(schema.titleEnrichment)
    .where(eq(schema.titleEnrichment.titleId, title.id));
  return { title, enrichment: enrichment ?? null, created: false };
}

/**
 * Idempotently land a recommendation in the library (spec §6.7). An existing title is returned
 * unchanged: nothing here may overwrite a status, rating, review or favorite.
 */
export async function ensureScreenTitle(
  tx: Db | DbTx,
  userId: string,
  rec: TitleRecRow,
  status: 'want' | 'watched',
  candidate: ScreenCandidate | null
): Promise<{ title: TitleRow; enrichment: TitleEnrichmentRow | null; created: boolean }> {
  const t = schema.titles;
  const tvmazeId = rec.mediaType === 'tv' ? rec.tvmazeId : null;
  const idMatches = [];
  if (rec.wikidataQid) idMatches.push(eq(t.wikidataQid, rec.wikidataQid));
  if (tvmazeId !== null) idMatches.push(eq(t.tvmazeId, tvmazeId));
  if (idMatches.length > 0) {
    const [byId] = await tx
      .select()
      .from(t)
      .where(and(eq(t.userId, userId), or(...idMatches)))
      .orderBy(asc(t.id))
      .limit(1);
    if (byId) return withEnrichment(tx, byId);
  }
  // Title + year, media type deliberately not compared (a miniseries imports as a movie).
  const key = normalizeTitleKey(rec.title, rec.year);
  const sameYear = await tx
    .select()
    .from(t)
    .where(and(eq(t.userId, userId), rec.year === null ? isNull(t.year) : eq(t.year, rec.year)))
    .orderBy(asc(t.id));
  const byTitle = sameYear.find((row) => normalizeTitleKey(row.title, row.year) === key);
  if (byTitle) return withEnrichment(tx, byTitle);

  const now = utcnowTs();
  const [title] = await tx
    .insert(t)
    .values({
      userId,
      mediaType: rec.mediaType,
      title: rec.title,
      year: rec.year,
      status,
      wikidataQid: rec.wikidataQid,
      tvmazeId,
      // Not a rating change (decision 10), so it never marks the profile dirty.
      feedbackUpdatedAt: null,
      updatedAt: now,
    })
    .returning();
  const [enrichment] = await tx
    .insert(schema.titleEnrichment)
    .values({
      titleId: title.id,
      ...(candidate ? candidateEnrichmentValues(candidate) : recEnrichmentValues(rec)),
      wikidataQid: rec.wikidataQid,
      tvmazeId,
      resolutionConfidence: serializeResolutionConfidence('HIGH'),
      confidenceLabel: 'HIGH',
      matchMethod: 'recommendation',
      identitySource: 'auto',
      duplicateOfTitleId: null,
      rawResponse: null,
      resolvedAt: now,
    })
    .returning();
  return { title, enrichment, created: true };
}
```

The explicit `wikidataQid` and `tvmazeId` after the spread keep the enrichment row's identity equal to the title's, whatever the fetched candidate says.

- [ ] **Step 4: Create the route**

Create `app/api/screen/recommendations/[id]/feedback/route.ts`:

```ts
import { and, eq } from 'drizzle-orm';
import { getDb, schema, type Db } from '@/lib/server/db';
import { ApiError, withApi } from '@/lib/server/http';
import { ensureProfileMeta } from '@/lib/server/profileMeta';
import { isTitleIdentityViolation, type ScreenCandidate } from '@/lib/server/screenEnrichment';
import {
  ensureScreenTitle,
  fetchRecCandidate,
  SCREEN_REJECT_REASONS,
  titleRecOut,
  type TitleRecRow,
} from '@/lib/server/screenRecs';
import { requireScreenEnabled } from '@/lib/server/screenSettings';
import { parseIdParam, pyList, utcnowTs } from '@/lib/server/serialize';
import { titleOut } from '@/lib/server/titles';

const STATUSES = ['accepted', 'already_watched', 'rejected'] as const;
type FeedbackStatus = (typeof STATUSES)[number];
const REASONS: readonly string[] = SCREEN_REJECT_REASONS;

interface Feedback {
  status: FeedbackStatus;
  rejectReasons: string[] | null;
  userNote: string | null;
}

function parseFeedback(raw: unknown): Feedback {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ApiError(422, 'validation error: invalid body');
  }
  const body = raw as Record<string, unknown>;
  if (!STATUSES.includes(body.status as FeedbackStatus)) {
    throw new ApiError(422, "status must be one of 'accepted', 'already_watched', 'rejected'");
  }
  const status = body.status as FeedbackStatus;
  const userNote = body.user_note ?? null;
  if (userNote !== null && (typeof userNote !== 'string' || userNote.length > 2000)) {
    throw new ApiError(422, 'user_note must be a string of at most 2000 characters');
  }
  const reasons = body.reject_reasons ?? null;
  if (reasons === null) return { status, rejectReasons: null, userNote };
  if (status !== 'rejected') {
    throw new ApiError(422, "reject_reasons may only be provided when status is 'rejected'");
  }
  if (!Array.isArray(reasons) || reasons.length === 0) {
    throw new ApiError(
      422,
      `reject_reasons must be a non-empty list. Valid codes: ${pyList([...REASONS])}`
    );
  }
  const unknown = reasons.filter((r) => typeof r !== 'string' || !REASONS.includes(r));
  if (unknown.length > 0) {
    throw new ApiError(
      422,
      `Unknown reject_reasons: ${pyList(unknown.map(String))}. Valid codes: ${pyList([...REASONS])}`
    );
  }
  return { status, rejectReasons: reasons as string[], userNote };
}

async function apply(
  db: Db,
  userId: string,
  rec: TitleRecRow,
  feedback: Feedback,
  candidate: ScreenCandidate | null
) {
  return db.transaction(async (tx) => {
    await tx
      .update(schema.titleRecommendations)
      .set({
        status: feedback.status,
        userNote: feedback.userNote,
        rejectReasons: feedback.rejectReasons,
      })
      .where(eq(schema.titleRecommendations.id, rec.id));
    // Decision 9: every feedback call stamps it, not only rejections.
    const meta = await ensureProfileMeta(tx, userId);
    await tx
      .update(schema.profileMeta)
      .set({ recFeedbackUpdatedAt: utcnowTs() })
      .where(eq(schema.profileMeta.id, meta.id));
    if (feedback.status === 'rejected') return null;
    const landed = await ensureScreenTitle(
      tx,
      userId,
      rec,
      feedback.status === 'accepted' ? 'want' : 'watched',
      candidate
    );
    return titleOut(landed.title, landed.enrichment);
  });
}

/** Spec §6.7. Transactional and tenant-scoped; the metadata fetch runs before the transaction. */
export const POST = withApi('/api/screen/recommendations/[id]/feedback', async (req, ctx) => {
  const feedback = parseFeedback(await req.json().catch(() => null));
  const recId = parseIdParam(ctx.params.id);
  const db = getDb();
  const userId = ctx.user.userId;
  await requireScreenEnabled(db, userId);

  const recs = schema.titleRecommendations;
  const [rec] = await db
    .select()
    .from(recs)
    .where(and(eq(recs.id, recId), eq(recs.userId, userId)));
  if (!rec) throw new ApiError(404, `Recommendation ${recId} not found`);

  // Outside the transaction: db.ts uses max: 1, so a catalog call inside one would deadlock.
  const candidate = feedback.status === 'rejected' ? null : await fetchRecCandidate(db, rec);

  let title;
  try {
    title = await apply(db, userId, rec, feedback, candidate);
  } catch (error) {
    // Two quick clicks: the other request inserted this identity first. The retry finds it.
    if (!isTitleIdentityViolation(error)) throw error;
    title = await apply(db, userId, rec, feedback, candidate);
  }
  ctx.timer.mark('db');
  const updated = titleRecOut({
    ...rec,
    status: feedback.status,
    userNote: feedback.userNote,
    rejectReasons: feedback.rejectReasons,
  });
  return Response.json({
    id: updated.id,
    status: updated.status,
    user_note: updated.user_note,
    reject_reasons: updated.reject_reasons,
    title,
  });
});
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run lib/server/__tests__/screen-rec-feedback-route.test.ts lib/server/__tests__/screen-recommend-routes.test.ts`
Expected: PASS.

If `accepted lands a new want title…` fails on `enrichment.directors` or `description_source`, check that wave 5's `titleOut` maps them (w5 Task 0 Step 3 lists the mapped fields). `titleOut` maps `directors` and `description_source`; if a field is missing there, report it rather than widening `titleOut` here.

- [ ] **Step 6: Mutation checks (load-bearing: never overwrite, never duplicate)**

1. In `ensureScreenTitle`, replace `if (byId) return withEnrichment(tx, byId);` with an update that sets `status` on `byId` before returning. Expected: FAIL in `an existing rated title is returned unchanged`. Restore.
2. Delete the title-and-year block (`const key = …` through `if (byTitle) …`). Expected: FAIL in `matches an owned title by title and year when the ids differ`. Restore.
3. In the route, replace the `catch` body with `throw error;`. Expected: FAIL in `retries once when a racing request wins the unique index`. Restore.

- [ ] **Step 7: Commit**

```bash
git add lib/server/screenRecs.ts "app/api/screen/recommendations/[id]/feedback/route.ts" lib/server/__tests__/screen-rec-feedback-route.test.ts
git commit -m "feat(screen): act on a screen recommendation without overwriting the library (#96)"
```

---

### Task 11: Recorded catalog fixture for the Stage 1 pools

**Files:**
- Create: `lib/server/__tests__/fixtures/screen/recommend-set.ts`
- Create: `scripts/record-screen-rec-fixture.ts`
- Create (recorded): `lib/server/__tests__/fixtures/screen/recommend-port.json`
- Test: `lib/server/__tests__/screen-recommend-fixture.test.ts`

**Interfaces:**
- Consumes: `seedPool`, `adaptationPool`, `metadataPool`, `assembleScreenPool`, `defaultScreenCatalogPort`, `ScreenCatalogPort`, `MediaFilter`, `SeedProposal`, `TvmazeHit`, `ScreenPoolCandidate` (Tasks 5–6); `buildScreenSignal` (Task 3); `runScreenRecommend`, `ScreenRecommendDeps` (Task 8); `seedScreenLibrary` (Task 3 fixtures); `makeTestDb`; `deadlineIn`, `_setScreenCatalogHooksForTests` (w5); `fakeClaude`.
- Produces (test-only): `REC_SEEDS`, `REC_FILTERS`, `RecordedPort`, `RecObserved`, `recordingPort`, `replayPort`, `runRecommendSet`.

Design decision 12: the fixture records **port** traffic (query text to rows, show name to TVmaze hit, QID to candidate), not raw HTTP, so it is independent of how wave 5 transports SPARQL. Wave 5 Task 14 already covers the HTTP level.

The recorded run uses Task 3's synthetic library (`seedScreenLibrary`) against the **real** catalog. Its loved books are real (*Leviathan Wakes*, *All Systems Red*), two of its titles carry real QIDs (*Forrest Gump*, *Toy Story*), and *Severance* carries its real TVmaze id. *Arrival* is owned under a fake QID, so a real *Arrival* hit can only be excluded by normalized title plus year. The replay then pins the spec's rules on real Wikidata data: the popularity floor, owned exclusion, the TV cross-walk requirement, and the media filter.

**The replay is verified, not trusted.** As in wave 5 Task 14, the recorder re-runs the whole set against only the recorded answers and refuses to write the file unless both runs produce identical candidate lists.

**Controller-only.** Steps 1–3 need the network and are marked **[controller]**. Never dispatch this task before they have run.

- [ ] **Step 1 [controller]: Write the shared set**

Create `lib/server/__tests__/fixtures/screen/recommend-set.ts`. It imports no vitest:

```ts
/**
 * The Stage 1 pool run the screen recommender is replayed against, shared by
 * scripts/record-screen-rec-fixture.ts and screen-recommend-fixture.test.ts. Deliberately free
 * of vitest imports. Records ScreenCatalogPort traffic, not HTTP (wave 7 decision 12).
 */
import type { Db } from '../../../db';
import {
  adaptationPool,
  assembleScreenPool,
  metadataPool,
  seedPool,
  type MediaFilter,
  type ScreenCatalogPort,
  type ScreenPoolCandidate,
  type SeedProposal,
  type TvmazeHit,
} from '../../../screenAssemble';
import type { Deadline } from '../../../screenCatalog';
import type { ScreenCandidate } from '../../../screenEnrichment';
import { buildScreenSignal } from '../../../screenSignal';
import type { SparqlRow } from '../../../screenSparql';

/** Fixed seed proposals stand in for the seed call, so the run needs no Claude. */
export const REC_SEEDS: SeedProposal[] = [
  { title: 'Moon', media_type: 'movie', year: 2009, reason: 'quiet, isolated science fiction' },
  { title: 'Arrival', media_type: 'movie', year: 2016, reason: 'first contact through language' },
  { title: 'The Expanse', media_type: 'tv', year: 2015, reason: 'adapts a loved series' },
  { title: 'Station Eleven', media_type: 'tv', year: 2021, reason: 'literary post-collapse drama' },
];

export const REC_FILTERS: MediaFilter[] = ['both', 'movie', 'tv'];

/** null records a definite empty answer. */
export interface RecordedPort {
  sparql: Record<string, SparqlRow[] | null>;
  tvmaze: Record<string, TvmazeHit | null>;
  metadata: Record<string, ScreenCandidate | null>;
}

export interface CandidateSummary {
  qid: string | null;
  media_type: 'movie' | 'tv';
  title: string;
  year: number | null;
  tvmaze_id: number | null;
  retrieval_pool: string;
  sitelinks: number;
}

export type RecObserved = Record<MediaFilter, CandidateSummary[]>;

export function emptyRecording(): RecordedPort {
  return { sparql: {}, tvmaze: {}, metadata: {} };
}

/** Wraps a live port; a retryable answer is noted in `failures` and passed through. */
export function recordingPort(
  inner: ScreenCatalogPort,
  into: RecordedPort,
  failures: string[]
): ScreenCatalogPort {
  return {
    async sparql(query) {
      const res = await inner.sparql(query);
      if (res.kind === 'retryable') failures.push(`sparql ${query.split('\n')[0]}: ${res.reason}`);
      else into.sparql[query] = res.kind === 'ok' ? res.value : null;
      return res;
    },
    async tvmazeSingleSearch(name) {
      const res = await inner.tvmazeSingleSearch(name);
      if (res.kind === 'retryable') failures.push(`tvmaze ${name}: ${res.reason}`);
      else into.tvmaze[name] = res.kind === 'ok' ? res.value : null;
      return res;
    },
    async fetchMetadata(qids) {
      const res = await inner.fetchMetadata(qids);
      if (res.kind === 'retryable') failures.push(`metadata ${qids.join(',')}: ${res.reason}`);
      else if (res.kind === 'ok') for (const q of qids) into.metadata[q] = res.value.get(q) ?? null;
      else for (const q of qids) into.metadata[q] = null;
      return res;
    },
  };
}

/** Serves only recorded answers; anything unrecorded is a broken fixture and throws. */
export function replayPort(recorded: RecordedPort): ScreenCatalogPort {
  return {
    async sparql(query) {
      if (!(query in recorded.sparql)) {
        throw new Error(`recommend fixture: no recorded answer for ${query.split('\n')[0]}`);
      }
      const rows = recorded.sparql[query];
      return rows === null ? { kind: 'empty' } : { kind: 'ok', value: rows };
    },
    async tvmazeSingleSearch(name) {
      if (!(name in recorded.tvmaze)) {
        throw new Error(`recommend fixture: no recorded TVmaze answer for ${name}`);
      }
      const hit = recorded.tvmaze[name];
      return hit === null ? { kind: 'empty' } : { kind: 'ok', value: hit };
    },
    async fetchMetadata(qids) {
      const out = new Map<string, ScreenCandidate>();
      for (const q of qids) {
        if (!(q in recorded.metadata)) {
          throw new Error(`recommend fixture: no recorded metadata for ${q}`);
        }
        const c = recorded.metadata[q];
        if (c) out.set(q, c);
      }
      return { kind: 'ok', value: out };
    },
  };
}

function summarize(c: ScreenPoolCandidate): CandidateSummary {
  return {
    qid: c.wikidata_qid,
    media_type: c.media_type,
    title: c.title,
    year: c.year,
    tvmaze_id: c.tvmaze_id,
    retrieval_pool: c.retrieval_pool,
    sitelinks: c.sitelinks,
  };
}

/** The same pool order runScreenRecommend uses (Task 8), once per filter. */
export async function runRecommendSet(
  db: Db,
  port: ScreenCatalogPort,
  deadline: Deadline
): Promise<RecObserved> {
  const signal = await buildScreenSignal(db, 'local');
  const out = {} as RecObserved;
  for (const filter of REC_FILTERS) {
    const seeds = REC_SEEDS.filter((s) => filter === 'both' || s.media_type === filter);
    const seedHits = await seedPool(port, seeds, deadline);
    const adaptationHits = await adaptationPool(port, signal, filter, deadline);
    const metadataHits = await metadataPool(port, signal, filter, deadline);
    const candidates = await assembleScreenPool(
      port,
      [adaptationHits, metadataHits, seedHits],
      signal,
      filter,
      deadline
    );
    out[filter] = candidates.map(summarize);
  }
  return out;
}
```

If Task 8's `runScreenRecommend` calls the pools in a different order or passes a different array to `assembleScreenPool`, match **Task 8's actual code** here: the replayed full run in Step 4 only works if the recorded query set covers it.

- [ ] **Step 2 [controller]: Write the recorder**

Create `scripts/record-screen-rec-fixture.ts`:

```ts
/**
 * Controller-run, needs the network: records the Stage 1 port traffic for the screen recommender.
 *
 *   npx tsx scripts/record-screen-rec-fixture.ts
 *   npx prettier --write lib/server/__tests__/fixtures/screen/recommend-port.json
 *
 * Runs the pool set live over Task 3's synthetic library, aborts on any retryable answer,
 * replays the recording through replayPort, and writes only if both runs match exactly.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  emptyRecording,
  recordingPort,
  replayPort,
  runRecommendSet,
  type RecObserved,
  type RecordedPort,
} from '../lib/server/__tests__/fixtures/screen/recommend-set';
import { makeTestDb } from '../lib/server/__tests__/helpers/pglite';
import { seedScreenLibrary } from '../lib/server/__tests__/helpers/screenRecFixtures';
import type { Db } from '../lib/server/db';
import { defaultScreenCatalogPort, type ScreenCatalogPort } from '../lib/server/screenAssemble';
import { deadlineIn } from '../lib/server/screenCatalog';

const OUT = path.resolve(
  __dirname,
  '..',
  'lib/server/__tests__/fixtures/screen/recommend-port.json'
);

async function run(portFor: (db: Db) => ScreenCatalogPort): Promise<RecObserved> {
  const { db, close } = await makeTestDb();
  try {
    await seedScreenLibrary(db);
    return await runRecommendSet(db, portFor(db), deadlineIn(900_000));
  } finally {
    await close();
  }
}

async function main(): Promise<void> {
  const recorded: RecordedPort = emptyRecording();
  const failures: string[] = [];
  const live = await run((db) =>
    recordingPort(defaultScreenCatalogPort(db, deadlineIn(900_000)), recorded, failures)
  );
  if (failures.length > 0) {
    console.error('Not writing the fixture; retryable answers:\n' + failures.join('\n'));
    process.exit(1);
  }
  const replayed = await run(() => replayPort(recorded));
  if (!isDeepStrictEqual(live, replayed)) {
    console.error('Not writing the fixture; the replay differs from the live run.');
    console.error(JSON.stringify({ live, replayed }, null, 2));
    process.exit(1);
  }
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify({
      recorded_at: new Date().toISOString(),
      note: 'Recorded by scripts/record-screen-rec-fixture.ts over the synthetic seedScreenLibrary. Re-record, never hand-edit.',
      observed: live,
      recorded,
    })
  );
  console.log(JSON.stringify(live, null, 2));
  console.log(
    `recorded ${Object.keys(recorded.sparql).length} queries, ${Object.keys(recorded.tvmaze).length} TVmaze lookups, ${Object.keys(recorded.metadata).length} candidates`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 3 [controller]: Record, then review the candidates by hand**

Run:

```bash
npx tsx scripts/record-screen-rec-fixture.ts
npx prettier --write lib/server/__tests__/fixtures/screen/recommend-port.json
ls -l lib/server/__tests__/fixtures/screen/recommend-port.json
```

Expected: the printed candidate lists for `both`, `movie` and `tv`. The live run takes a few minutes. The file should be under about 2 MB; if it is larger, report which section dominates before committing.

Read every candidate. **Record what you actually observe, not what this plan predicts.** Things to check:
- The adaptation pool found at least one screen adaptation of the two loved books (the spike's bridge found *The Expanse* from *Leviathan Wakes*).
- No candidate is *Forrest Gump*, *Toy Story*, *Severance* or *Arrival* (2016).
- Nothing looks like a wrong-year namesake of a seed.

A candidate that should not be there is a **finding to report**, not something to delete from the fixture.

- [ ] **Step 4: Write the replay test**

Create `lib/server/__tests__/screen-recommend-fixture.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test, expect } from 'vitest';
import { makeTestDb } from './helpers/pglite';
import { setupTestEnv } from './helpers/testEnv';
import { fakeClaude } from './helpers/fakeClaude';
import { seedScreenLibrary } from './helpers/screenRecFixtures';
import {
  REC_SEEDS,
  replayPort,
  runRecommendSet,
  type CandidateSummary,
  type RecObserved,
  type RecordedPort,
} from './fixtures/screen/recommend-set';
import { schema } from '../db';
import { POPULARITY_MIN_SITELINKS } from '../screenSparql';
import { runScreenRecommend } from '../screenRecommendRun';
import { normalizeTitleKey } from '../titles';

const fixture = JSON.parse(
  readFileSync(path.join(__dirname, 'fixtures', 'screen', 'recommend-port.json'), 'utf8')
) as { observed: RecObserved; recorded: RecordedPort };

const OPEN = { remainingMs: () => 600_000 };
const OWNED_QIDS = ['Q134773', 'Q171048'];
const OWNED_KEYS = [normalizeTitleKey('Arrival', 2016), normalizeTitleKey('Severance', 2022)];

async function replayed(): Promise<RecObserved> {
  const { db, close } = await makeTestDb();
  try {
    await seedScreenLibrary(db);
    return await runRecommendSet(db, replayPort(fixture.recorded), OPEN);
  } finally {
    await close();
  }
}

function all(o: RecObserved): CandidateSummary[] {
  return [...o.both, ...o.movie, ...o.tv];
}

describe('screen Stage 1 against recorded catalog answers', () => {
  test('replays to exactly what the live run observed', async () => {
    expect(await replayed()).toEqual(fixture.observed);
  });

  test('every filter surfaces candidates, within the cap', () => {
    for (const list of Object.values(fixture.observed)) {
      expect(list.length).toBeGreaterThan(0);
      expect(list.length).toBeLessThanOrEqual(60);
    }
  });

  test('the media filter holds', () => {
    expect(fixture.observed.movie.every((c) => c.media_type === 'movie')).toBe(true);
    expect(fixture.observed.tv.every((c) => c.media_type === 'tv')).toBe(true);
  });

  test('owned titles never come back, by QID, TVmaze id, or title and year', () => {
    for (const c of all(fixture.observed)) {
      expect(OWNED_QIDS).not.toContain(c.qid);
      expect(c.tvmaze_id).not.toBe(44778);
      expect(OWNED_KEYS).not.toContain(normalizeTitleKey(c.title, c.year));
    }
  });

  test('every TV candidate cross-walks to TVmaze', () => {
    for (const c of all(fixture.observed).filter((c) => c.media_type === 'tv')) {
      expect(typeof c.tvmaze_id).toBe('number');
    }
  });

  test('every candidate clears the popularity floor', () => {
    for (const c of all(fixture.observed)) {
      expect(c.sitelinks).toBeGreaterThanOrEqual(POPULARITY_MIN_SITELINKS);
    }
  });

  test('the adaptation bridge finds a screen adaptation of a loved book', () => {
    expect(fixture.observed.both.some((c) => c.retrieval_pool === 'adaptation' || c.retrieval_pool === 'multiple')).toBe(true);
  });
});

describe('runScreenRecommend over the recorded catalog', () => {
  setupTestEnv();

  test('persists a run whose rows are all real retrieved candidates', async () => {
    const { db, close } = await makeTestDb();
    try {
      await seedScreenLibrary(db);
      const client = fakeClaude([
        {
          content: [{ type: 'tool_use', name: 'propose_screen_comparables', input: { comparables: REC_SEEDS } }],
          usage: { input_tokens: 10, output_tokens: 10 },
        },
        {
          content: [
            {
              type: 'tool_use',
              name: 'rank_screen_recommendations',
              input: {
                recommendations: [0, 1, 2].map((i) => ({
                  candidate_index: i,
                  score: 1 - i / 10,
                  rationale: `pick ${i}`,
                  grounded_trait_ids: [1],
                  grounded_book_ids: [1],
                  grounded_title_ids: [],
                })),
              },
            },
          ],
          usage: { input_tokens: 10, output_tokens: 10 },
        },
      ] as never);
      const out = await runScreenRecommend(db, client, 'local', { mediaFilter: 'both' }, {
        nowMs: () => 1_000_000,
        abortAfter: () => new AbortController().signal,
        catalog: () => replayPort(fixture.recorded),
      });
      expect(out.run_id).toEqual(expect.any(String));
      const rows = await db.select().from(schema.titleRecommendations);
      expect(rows.length).toBe(Math.min(3, fixture.observed.both.length));
      const known = new Set(fixture.observed.both.map((c) => c.qid));
      for (const r of rows) expect(known.has(r.wikidataQid)).toBe(true);
    } finally {
      await close();
    }
  });
});
```

Run: `npx vitest list lib/server/__tests__/screen-recommend-fixture.test.ts` (expect 8 tests), then `npx vitest run lib/server/__tests__/screen-recommend-fixture.test.ts`.
Expected: PASS. If the full-run test throws "no recorded answer", the run issued a query the set did not: `runRecommendSet` and Task 8 disagree on pool order or arguments. Fix `recommend-set.ts` to match Task 8 and re-record; do not add answers by hand.

- [ ] **Step 5: Mutation check (load-bearing: owned exclusion by title and year)**

In Task 6's `mergeHits`, delete the `owned_keys` check. Run the replay test.
Expected: FAIL, in the exact-replay test and, if the live catalog returned *Arrival* 2016 as a seed hit (it should: it is a fixed seed), in `owned titles never come back…`. If only the exact-replay test fails, record that the owned-key rule has no real-data witness in this fixture. Restore; re-run: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/server/__tests__/fixtures/screen/recommend-set.ts scripts/record-screen-rec-fixture.ts lib/server/__tests__/fixtures/screen/recommend-port.json lib/server/__tests__/screen-recommend-fixture.test.ts
git commit -m "test(screen): replay screen Stage 1 against recorded catalog answers (#96)"
```

---

### Task 12: Docs, full gate, and real-flow verification

**Files:**
- Modify: `docs/architecture.md`, `docs/conventions.md`

**Interfaces:** none new.

- [ ] **Step 1: Update `docs/architecture.md`**

In the "### ScreenSprite (movies & TV)" subsection, append:

```markdown
- `screenSignal.ts` — the screen recommender's signal: unified traits, loved books and titles,
  favorites, owned identity sets, rejected screen recs, title more/less-like, and the directive.
- `screenSparql.ts` — pure SPARQL builders and row readers for the Stage 1 pools. Every user
  string goes through `sparqlString`; every label read uses `en` then `mul`.
- `screenAssemble.ts` — `ScreenCatalogPort` (the only code touching wave 5's clients), the
  metadata, adaptation and seed pools, then merge (popularity floor, owned exclusion), cap,
  hydrate, directive filter and a two-per-person cap.
- `screenRecPrompts.ts` — the seed (`propose_screen_comparables`) and rerank
  (`rank_screen_recommendations`) tools and prompts.
- `screenRecommendRun.ts` — `runScreenRecommend`: gate, the §6.4 time budget (seeds aborted at
  45 s, retrieval until 180 s, rerank gets the rest minus a 20 s persistence reserve), citation
  validation, and one-transaction persistence. A rerank with no surviving picks mints no run.
- `screenRecs.ts` — `titleRecOut`, `SCREEN_REJECT_REASONS`, and `ensureScreenTitle`.
```

Extend the routes line with `POST /api/screen/recommend`, `GET /api/screen/recommendations`, `POST /api/screen/recommendations/{id}/feedback`.

- [ ] **Step 2: Update `docs/conventions.md`**

Under "## Data invariants", add:

```markdown
- **Screen recommendations follow the book two-stage rule.** Every candidate comes from a
  Wikidata or TVmaze lookup; Claude's seeds are lookup inputs, never candidates. Each pool
  requires an English Wikipedia article and at least 10 sitelinks, and a series without a TVmaze
  id never enters the pool.
- **Acting on a screen recommendation never overwrites the library.** An existing title (matched
  by QID, TVmaze id, or normalized title plus year) is returned unchanged. A new one is created
  with `feedback_updated_at` null, so accepting a recommendation never forces a re-profile.
```

- [ ] **Step 3: Run the full gate**

```bash
npm run test:server 2>&1 | grep -E "Test Files|Tests "
npm test
npm run type-check
npm run lint
npm run format:check
npm run build
```

Expected: all pass. Extract the Vitest counts with the `grep` above; do not slice output.

- [ ] **Step 4: Real-flow verification against an isolated local run**

Follow the `marketing-screenshot-pipeline` memory note, exactly as wave 5 Task 15 Step 4 does: a copy of the tree with no `.env` in scope (`git ls-files -z --cached --others --exclude-standard | rsync …`, then `ls -a` names only), a scratch Postgres on port **55437** (check it is free first), `npm run db:migrate`, and a local-mode dev server on port 3100 with `ALLOW_LOCAL_AUTH=true` and `CRON_SECRET=local-verify-secret`.

**What the executor can verify alone** (no Anthropic key):

1. Import `lib/server/__tests__/fixtures/sample_goodreads.csv` through `POST /api/import`, and wave 5 Task 15's real-title Letterboxd ZIP (rebuild it with that step's Python) through `POST /api/screen/import`. Poll the screen job to `done` (Monitor tool with an until-loop; never a foreground sleep).
2. `POST /api/screen/recommend` with `{}`. Expect 400 with the no-profile message (nothing is profiled yet). Record the body.
3. `POST /api/screen/recommend` with `{"media_filter":"books"}`: 422.
4. Four quick `POST /api/screen/recommend` calls: the fourth answers 429 with the `detail` shape.
5. `GET /api/screen/recommendations`: `[]`.
6. `PUT /api/settings/screen` with `{"enabled":false}`, then `POST /api/screen/recommend`: 403. Re-enable.

**What needs Chase:** the Claude calls. Ask Chase to start the dev server with the Anthropic key exported **in his own shell**; the executor never reads, prints or writes it. With that server:

7. `POST /api/profile` (builds the unified profile; wave 6).
8. `POST /api/screen/recommend` once per filter: `{"media_filter":"both"}`, `{"media_filter":"movie"}`, `{"media_filter":"tv"}`. For each, record `served`, the pool counts, `seed_timed_out`, and the titles. Check by hand:
   - every title is a real film or series (open two or three QIDs on Wikidata);
   - `movie` returns only films and `tv` only series;
   - no title is already in the library;
   - each rationale's cited trait, book and title ids exist (`GET /api/profile`, `GET /api/books`, `GET /api/screen/titles`).
   Record each run's wall time from the dev-server log. A run near 300 s is a finding.
9. `GET /api/screen/recommendations` returns the last run (the `tv` one).
10. `POST /api/screen/recommendations/<id>/feedback` with `{"status":"accepted"}` on one rec: the title appears in `GET /api/screen/titles` as `want`, with a description and attribution fields. Repeat the call: the same title id, no second row.
11. `{"status":"already_watched"}` on a rec whose title you then rate via `PATCH /api/screen/titles/<id>` `{"rating":4}`. Call `already_watched` again: the rating is still 4.
12. `{"status":"rejected","reject_reasons":["too_long"]}` on a third rec: `title` is `null`.
13. `GET /api/profile/status`: accepting in step 10 did **not** make the profile dirty (Review Focus 1). The rating in step 11 did.
14. `POST /api/screen/recommend` again after `POST /api/profile/update`: no accepted, watched or rejected title from steps 10–12 comes back.

If Chase has not provided a key-bearing server, record "Steps 7–14 not run: need an Anthropic key in Chase's shell", and report the wave as verified up to the Claude calls. Do not call it done.

Clean up: stop the dev server, `docker rm -f` the scratch container, delete the tree copy and the ZIP.

Record what you observed in the ledger. Any divergence from the expectations above is a finding to report, not something to reconcile silently.

- [ ] **Step 5: Commit the docs**

```bash
git add docs/architecture.md docs/conventions.md
git commit -m "docs(screen): document the screen recommender (#96)"
```

- [ ] **Step 6: Report to Chase**

This wave adds **no migration**. Report the gate results, which real-flow steps ran, whether steps 7–14 are waiting on him, the run wall times, and any candidate you judged wrong.
