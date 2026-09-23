# ScreenSprite wave 5 — screen catalog, enrichment, jobs, manual add, correction

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every title in a user's screen library gets a Wikidata/TVmaze identity with a `HIGH`/`MEDIUM`/`LOW` label and metadata, through a time-bounded background job; users can search and add movies and shows by hand, and correct a mis-resolved title.

**Architecture:** Three layers, each in its own file. `screenCatalog.ts` is the transport: per-host throttles, `catalog_cache`, capped `Retry-After`, a deadline threaded into every request, and a three-way `CatalogResult` that keeps "the service said no" (`empty`) apart from "we could not ask" (`retryable`). `screenMatch.ts` and `screenClasses.ts` are pure: screen-only title normalization (NFKC, non-Latin kept) and the precomputed film/TV subclass sets. `screenEnrichment.ts` ports the spike's measured resolver (Stage A exact title+year SPARQL, Stage B `wbsearchentities`, classify by P31, tie-breaks), builds the `ScreenCandidate` metadata record, and persists a resolution with the identity, clash and conversion rules of spec §4.4 and decision 18. `enrichmentJobs.ts` gains a `kind` and a generic chunk loop: the book path keeps its exact call sequence (existing tests pass unmodified), and the screen path runs **batches of up to 50 titles** per loop iteration, so the spike's batched Stage A and 50-per-call entity fetches stay efficient while progress is still recounted from persisted `title_enrichment` rows and the stall check still fires when a batch persists nothing.

**Tech Stack:** TypeScript, Next.js route handlers (`withApi`), drizzle-orm on Postgres, Vitest + PGlite for `lib/server/**` and `app/api/**`, Wikidata Action API + WDQS SPARQL, Wikipedia REST, TVmaze.

**Spec:** `docs/superpowers/specs/2026-09-22-screen-media-design.md` — §4 (all of it), §3.4 "Media type" (decision 18), §3.5, §2.1 findings 2–5 and 8, §10. **Index and cross-wave contract:** `docs/superpowers/plans/2026-09-22-screen-media-00-index.md`. Read both before starting. The spike's throwaway code (`wd.py`, `resolve3.py`, `cold.py`) is the reference for every Wikidata call in this plan; this plan ports it and says so wherever it departs.

**Issue:** #96. **Branch:** `feat/screen-media` (waves 2 and 4 have landed on it).

---

## Global Constraints

Every task's requirements implicitly include this section. The first block is copied verbatim from the plan index; the second is specific to this wave.

- **Two test runners with disjoint ownership.** `npm run test:server` (Vitest) owns exactly `lib/server/**` and `app/api/**`; `npm test` (Jest) owns everything else. Before naming a single test file as a gate, confirm the runner sees it: `npx vitest list <path>` or `npx jest --listTests <path>`. A gate that matches zero tests exits 0.
- **Full gate at the end of every wave**, from the repository root: `npm run test:server`, `npm test`, `npm run type-check`, `npm run lint`, `npm run format:check`, `npm run build`. `npm run build` is the only gate that catches Next segment-config and prerender failures.
- **Real-flow verification before a wave is called done** (spec §10). Tests alone never close a wave. Use an isolated local run: a scratch Postgres in Docker plus a local-mode dev server (`ALLOW_LOCAL_AUTH=true`) with **no `.env` file in scope**, following the procedure recorded in the project memory note `marketing-screenshot-pipeline`. Never point a verification run at the production database. Record what you actually observe, not what a plan predicts.
- **Secrets.** Never open, print, or name the contents of `.env*` files; check presence only. Never ask Codex to inspect them.
- **Ratings.** `numeric(2,1)` with drizzle `mode: 'number'` on every rating column. `0` on an API mutation means "clear". The manual `isValidRating` guard owns the 422 message; do not move the grid rule into Zod.
- **Wire format.** API JSON is snake_case. Prompt payloads use `pyJsonDumps` over ordered `Map`s (`lib/server/serialize.ts`); never `JSON.stringify` a prompt payload.
- **Long-running routes** export the literal `export const maxDuration = 300;` — never an imported binding. Every new one is added to `app/api/enrich/enrich-max-duration.test.ts`.
- **Tenancy.** Every query on a user-owned table filters by `user_id`; every route test includes a second user whose ids are rejected (404, never 403 that leaks existence).
- **Schema changes.** Edit `lib/server/schema.ts`, run `npm run db:generate`, read the generated SQL, and mirror the change in `lib/server/__tests__/helpers/pglite.ts` (the test database is hand-written SQL, not generated) plus `loadSeed`'s key/JSON/timestamp/sequence lists when a seed needs the table. `books` is never dropped or recreated. Applying a migration to production is Chase's step, not the executor's; the plan's final task lists the command for him.
- **`.tsx` string literals are ASCII-only**; put a non-ASCII value in an expression container (`{'\u2026'}`), never in a bare JSX attribute. `text-base` is a colour, not a size.
- **Copy.** User-facing copy says **ScreenSprite**; code, routes, tables and settings keys say `screen` (spec decision 13).
- **Git.** Work on `feat/screen-media`. Chase commits manually by default: a plan's "Commit" step runs only when Chase has authorized commits for that execution session; otherwise stage the listed paths and leave them. Plain commit messages, no `Co-Authored-By` trailer; end each with the `Claude-Session:` line from the session's attribution instructions. Subjects: `feat(profile): … (#97)` for wave 1, `feat(screen): … (#96)` or `fix(profile): … (#96)` after.
- **Next.js here is not the Next.js you know.** Before writing route, page or `next/image` code, read the relevant guide in `node_modules/next/dist/docs/`.

Wave 5 specifics:

- **No migration in this wave.** Every table and column this wave writes (`titles`, `title_enrichment`, `enrich_jobs.kind`, the `(user_id, kind)` partial unique index) landed in wave 4. `lib/server/schema.ts` is read, never edited. If Task 0 finds a column missing, STOP and report.
- **Failure is not "no match"** (spec §4.1). Only a definite answer from a catalog (HTTP 404, or a 200 with no hits) may be persisted as unresolved. A network error, 5xx, 429 after retries, non-404 4xx, unparseable body, or a request skipped for lack of time is `retryable`, and a title whose pipeline hit one is **deferred**: no `title_enrichment` row is written, so the next batch or chunk retries it.
- **Per-host throttles** (spec §4.1, §2.1 finding 5): Wikidata Action API one request at a time, at least 250 ms apart (≤ 4 req/s); WDQS SPARQL at least 250 ms apart; Wikipedia REST at least 250 ms apart; TVmaze at least 550 ms apart (≤ 20 per 10 s). All screen requests are sequential. `Retry-After` is honoured but capped at 10 s.
- **User-Agent** is exactly `ShelfSprite/0.1 (https://shelfsprite.app)` on every screen request. It names the app and a website; it never carries an email address.
- **`en|mul` everywhere** (spec §2.1 finding 2a): every `wbgetentities` call passes `languages=en|mul`, every label read prefers `en` then `mul`, and every Stage A exact match is written as both `"…"@en` and `"…"@mul`.
- **The book helpers are not reused for screen matching** (`normalizeTitle`, `titleSim`, `sameWork`): they strip every non-`[a-z0-9 ]` character, which turns two different Japanese titles into the same empty string. `similarity.ts#ratio` itself is reused.
- **Book enrichment behaviour is unchanged.** `enrichment.ts`, `catalog.ts` and every book route keep their behaviour. Existing tests stay green **unmodified**, with exactly two justified exceptions named in Task 9 and Task 10.
- **Images are hotlinked, never copied** (decision 8). Only `https://upload.wikimedia.org/…` and `https://static.tvmaze.com/…` image URLs are accepted from a client; nothing proxies or re-encodes them.
- **Rate-limit responses** on the new routes use the normal `{"detail": …}` shape via `ApiError(429, …)`. `rateLimitExceededResponse` exists only for byte-parity with a retired Python handler, and these routes have no Python ancestor (see the `inviteRequest` note in `lib/server/ratelimit.ts`).

---

## Review Focus

The five input classes the spec implies but no happy-path test exercises, most likely first. Each line names the task whose tests pin it.

1. **A Wikidata outage or 429 storm in the middle of a job.** Expected: no title is persisted as unresolved; titles already resolved in earlier batches keep their rows; the job ends `error` with the existing "made no progress" message, and "Retry enrichment" resumes it. Pinned in **Task 9** (`runs a screen chunk against a failing catalog and persists nothing`).
2. **A title deleted by the user while its batch is in flight.** Expected: persistence skips the vanished title and the batch's other titles still land; no foreign-key error. Pinned in **Task 8** (`skips a title that was deleted after its batch was read`).
3. **Two titles in one library resolving to the same film or show** (a Letterboxd TV entry that converts to a TVmaze id a manually added show already holds; a film logged under two spellings). Expected: the second is recorded with `duplicate_of_title_id`, its own identity column stays null, the unique index never throws, and the job continues. Pinned in **Task 8** (`records a clash as duplicate_of_title_id instead of violating the unique index`, both movie and TV cases).
4. **Years that disagree by one, or no year at all.** Letterboxd dates a film by release and Wikidata may carry only the premiere year. Expected: a ±1 year with a strong title match is `MEDIUM`, never `HIGH`; a title with no year can never be `HIGH`. Pinned in **Task 5** (`never labels a title HIGH without an exact year`).
5. **A double-submitted manual add** (two quick clicks). Expected: the second answers 409 "already in your ScreenSprite library", never 500, even when the two requests race past the pre-check into the partial unique index. Pinned in **Task 11** (`answers 409 when the unique index catches a racing duplicate`).

---

## Design decisions this plan makes

These refine the spec where it left a choice open. Treat them as requirements for this wave.

1. **Batches inside the chunk loop.** The screen chunk selects up to `SCREEN_BATCH_SIZE = 50` selectable titles per iteration and hands them to one `runBatch` call. The loop is otherwise the book loop, verbatim: recount from persisted rows before and after each batch, write the recount as progress, stop when a batch persisted nothing (stall check), stop at `CHUNK_BUDGET_MS`. A batch shares one `Deadline` derived from the chunk clock, so requests stop being issued three seconds before the budget ends and whatever was not finished is deferred rather than recorded. Measured sizing: Stage A for 50 titles is about two SPARQL calls of about 120 variant names each (the spike's batch size), candidate fetches are one or two 50-id `wbgetentities` calls, and the batch's 50 Wikipedia summaries at 250 ms spacing dominate at roughly 15–20 s. The spike's cold 0.25 s/film was measured with REST concurrency 3; sequential requests make this about 2–3× slower, so a 560-title import takes two to three chunks. That is accepted for simplicity; raising Wikipedia REST concurrency to 3 is a later optimisation, not part of this wave.
2. **A deferred title is simply not persisted.** The next iteration re-selects it (selection is by `titles.id`). Earlier responses are served from `catalog_cache`, so a retry costs only the request that failed. If every title in a batch defers, the batch persisted nothing and the stall check ends the chunk; a chunk that made no progress at all ends the job with `STALLED_MESSAGE`.
3. **Stage A restricts classes inside the query**, exactly as the spike's `cold.py` measured (10 s for 562 films): `?q wdt:P31 ?c . { ?c wdt:P279* wd:Q11424 } UNION { ?c wdt:P279* wd:Q15416 }`. Classification after `wbgetentities` uses the checked-in class sets.
4. **Variants** are the spike's set (`resolve3.py#variants`): as given, Python `str.title()`, `str.capitalize()`, lower case, upper case, and for a trailing parenthetical, the base and `Base: Parenthetical`. The spec lists a subset; the spike's superset is what produced the measured 97.3 % HIGH.
5. **Scoring names** are the `en` and `mul` labels plus the `en` and `mul` aliases. The spike scored `en` aliases only; the spec says `en`/`mul`, and the Stage A query already matches `mul` aliases, so scoring matches what Stage A can return.
6. **"A film beats a TV item" runs first**, before the enwiki and popularity tie-breaks (spec §4.3). The spike did not implement it; the spec added it.
7. **Identity columns on `titles`** are written only for `HIGH` and `MEDIUM` auto resolutions (and for manual add and correction). A `LOW` pick lives only in `title_enrichment.wikidata_qid`, so an uncertain match never occupies the unique index.
8. **Conversion (decision 18).** A resolved pick that is a TV **series** (a subclass of Q5398426) **and** carries P8600 converts the title: `media_type = 'tv'`, `tvmaze_id` set, and `wikidata_qid` set too as a metadata bonus (both columns join the clash check). A TV special or TV film stays `movie`.
9. **Force re-runs** route by identity: a `tv` title with a `tvmaze_id` refreshes from TVmaze plus the crosswalk; a movie whose identity is `manual` or `corrected` refreshes metadata by its QID without re-resolving; every other title is re-resolved. A refresh never changes the label, identity source or identity columns.
10. **`original_language` stores an ISO 639-1 code** read from the language item's P218 (`'en'`, `'ja'`), falling back to the language item's lower-cased label. Wave 7 maps directive languages, which are codes like the book path's `normLang` output.
11. **The import route queues the screen job and returns immediately**; it does not run a chunk inline. It creates (or reuses) the active screen job and dispatches `/api/enrich/tick` after the response, exactly as a continuation does. The import response gains `job`. If an active screen job already exists, it picks up the new titles itself, because the loop recounts selectable titles before every batch.
12. **Search runs Stage A too.** `GET /api/screen/search?type=movie` unions an exact-label Stage A lookup with `wbsearchentities` (limit 10), because the spike showed short titles (*Her*, *Old*, *Pig*) never appear in search's top results. A trailing year in the query (`Nosferatu 2024`) ranks exact-title, exact-year films first.
13. **Cache retention** prunes screen sources (`source like 'screen:%'`) by age (90 days) and count (newest 50,000 kept) from the existing janitor. The janitor's response body is unchanged; the prune result goes to the log.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `lib/server/screenMatch.ts` | Create | Pure: `screenNormalize`, `screenRatio`, `screenSimilarity`, `titleVariants`. |
| `lib/server/screenMatch.test.ts` | Create | Normalization, variants, non-Latin and empty-title behaviour. |
| `scripts/screen-classes.ts` | Create | Controller-run generator for the subclass sets (network). |
| `lib/server/screenClasses.json` | Create (generated) | Film, TV program and TV series class QIDs. |
| `lib/server/screenClasses.ts` | Create | `classifyP31`, `isTvSeries` over the generated sets. |
| `lib/server/screenClasses.test.ts` | Create | Roots present, film beats TV, sizes sane. |
| `lib/server/__tests__/helpers/replayKey.ts` | Create | Vitest-free `replayKey(url, init)`, shared by the replay stub and the fixture recorder. |
| `lib/server/__tests__/helpers/httpReplay.ts` | Modify | Key POST fixtures by URL **and** body; GET keys unchanged. |
| `lib/server/screenCatalog.ts` | Create | Transport (`screenFetchJson`), throttles, deadline, `CatalogResult`, endpoint functions, Wikidata entity helpers, cache retention. |
| `lib/server/__tests__/screen-catalog-transport.test.ts` | Create | Retry, cap, deadline, negative cache, POST keying. |
| `lib/server/__tests__/screen-catalog-endpoints.test.ts` | Create | Endpoint URL shapes and response parsing, entity helpers. |
| `lib/server/screenEnrichment.ts` | Create | Scoring, `ScreenCandidate` + schema, `fetchScreenMetadata`, `resolveMovies`, `refreshMovies`, `resolveTv`, `searchMovies`, `searchShows`, `persistTitleResolution`, `candidateEnrichmentValues`. |
| `lib/server/__tests__/screen-score.test.ts` | Create | `scoreTitle` against synthetic entities (load-bearing false-HIGH tests). |
| `lib/server/__tests__/screen-metadata.test.ts` | Create | `fetchScreenMetadata` and TVmaze merge against synthetic replay fixtures. |
| `lib/server/__tests__/screen-resolve.test.ts` | Create | `resolveMovies` / `resolveTv` orchestration and deferral. |
| `lib/server/__tests__/screen-persist.test.ts` | Create | `persistTitleResolution` identity, conversion, clash, refresh, deletion. |
| `lib/server/enrichmentJobs.ts` | Modify | `JobKind`, kind-scoped active job, generic chunk loop, screen work source, `runClaimedScreenChunk`, `screenEnrichmentRunner`. |
| `lib/server/__tests__/enrich-job-insert.test.ts` | Modify | Add `kind: 'books'` to both literals (justified in Task 9). |
| `lib/server/__tests__/screen-jobs.test.ts` | Create | Screen chunk behaviour, kinds side by side. |
| `lib/server/screenJobs.ts` | Create | `queueScreenEnrichment` (create-or-reuse + post-response dispatch) and `startScreenEnrichment` (claim + one inline chunk). |
| `lib/server/__tests__/screen-jobs-queue.test.ts` | Create | Queue and start semantics, including a stranded pending job. |
| `lib/server/ratelimit.ts` | Modify | `screenSearch`, `screenEnrichStart` entries. |
| `app/api/enrich/tick/route.ts` | Modify | Dispatch on the claimed row's `kind`. |
| `app/api/enrich/tick/screen.test.ts` | Create | Tick runs the screen chunk for a screen job. |
| `app/api/screen/enrich/start/route.ts` | Create | Start or resume the screen job; literal `maxDuration = 300`. |
| `app/api/screen/enrich/start/route.test.ts` | Create | |
| `app/api/screen/enrich/active/route.ts` | Create | The user's active screen job, for reload recovery. |
| `app/api/screen/enrich/active/route.test.ts` | Create | |
| `app/api/enrich/enrich-max-duration.test.ts` | Modify | Add the screen start route to `ROUTES`. |
| `app/api/screen/import/route.ts` | Modify (wave 4 file) | Queue the screen job; response gains `job`. |
| `lib/server/__tests__/screen-import-routes.test.ts` | Modify (wave 4 file) | Install the dispatch test seam; assert `job` (justified in Task 10). |
| `app/api/screen/search/route.ts` | Create | Movie and TV search. |
| `app/api/screen/search/route.test.ts` | Create | |
| `app/api/screen/titles/route.ts` | Modify (wave 4 file) | Add `POST` (manual add) beside wave 4's `GET`. |
| `app/api/screen/titles/add.test.ts` | Create | Manual-add tests (a separate file so wave 4's `screen-title-routes.test.ts` is untouched). |
| `app/api/screen/titles/[id]/correct/route.ts` | Create | LOW correction. |
| `app/api/screen/titles/[id]/correct/route.test.ts` | Create | |
| `app/api/enrich/janitor/route.ts` | Modify | Call `pruneScreenCache` after job repair; log the result. |
| `app/api/enrich/janitor/screen-prune.test.ts` | Create | The janitor prunes screen cache rows and leaves its response body unchanged. |
| `lib/server/__tests__/screen-cache-retention.test.ts` | Create | `pruneScreenCache` age and count bounds; book rows untouched. |
| `lib/server/__tests__/fixtures/screen/replay-set.ts` | Create | The replay inputs, shared by the recorder and the replay test (no vitest imports). |
| `scripts/record-screen-fixtures.ts` | Create | Controller-run recorder for the replay fixture. |
| `lib/server/__tests__/fixtures/screen/resolve-films.json` | Create (recorded) | Trimmed live responses for the synthetic title set. |
| `lib/server/__tests__/screen-resolve-replay.test.ts` | Create | End-to-end resolution against the recorded fixture. |

---

## Handoff batching

A controller's cost is its context multiplied by its turns. Stop and hand off at each batch boundary, and keep the `.superpowers/sdd/` ledger current after **every** task so the next session can rebuild state from disk.

- **Batch A** (pure + transport): Task 0, Task 1, Task 2, Task 3, Task 4 → hand off
- **Batch B** (resolution): Task 5, Task 6, Task 7, Task 8 → hand off
- **Batch C** (jobs + routes): Task 9, Task 10, Task 11, Task 12, Task 13 → hand off
- **Batch D** (fixtures + verification, controller-heavy): Task 14, Task 15

**Controller-only steps.** Codex's sandbox has no network. Task 2 Step 1 (generate the class sets) and Task 14 Steps 1–3 (record fixtures) must be run by the controller before the task is dispatched. They are marked **[controller]**. Never dispatch a task whose controller steps have not run.

---

### Task 0: Preconditions from waves 2 and 4

**Files:** none (read-only checks).

The plan assumes wave 4's contract. Confirm it before writing code. Record what you actually observe; if anything is missing, STOP and report instead of adding it here.

- [ ] **Step 1: Schema and mirror carry the wave-4 shapes**

Run:

```bash
grep -n "export const titles\b\|export const titleEnrichment\|kind: varchar()\|uq_enrich_jobs_active_user_kind\|identitySource\|duplicateOfTitleId\|screenEnabled" lib/server/schema.ts
grep -n "create table titles\|create table title_enrichment\|uq_enrich_jobs_active_user_kind\|ix_title_enrichment_title_id\|kind text not null default 'books'" lib/server/__tests__/helpers/pglite.ts
```

Expected: every name appears in both files (the pglite mirror spells columns in snake_case). `title_enrichment.title_id` must carry a **unique** index (`ix_title_enrichment_title_id`), because `persistTitleResolution` upserts on it.

- [ ] **Step 2: Wave-4 modules export the contract names**

Run:

```bash
grep -n "export async function requireScreenEnabled\|export const SCREEN_DISABLED_MESSAGE" lib/server/screenSettings.ts
grep -n "export function titleOut\|export function normalizeTitleKey\|export type TitleRow\|export type TitleEnrichmentRow\|export interface TitleOut" lib/server/titles.ts
ls app/api/screen/import/route.ts app/api/screen/titles/route.ts lib/server/__tests__/screen-import-routes.test.ts lib/server/__tests__/screen-title-routes.test.ts
```

Expected: all present.

- [ ] **Step 3: `titleOut` maps enrichment**

Open `lib/server/titles.ts` and read `titleOut`. The contract says "wave 5 fills `enrichment`". If `titleOut` already maps a non-null `enr` to the contract's `enrichment` object, do nothing. If it returns `enrichment: null` regardless of `enr`, replace that property with this mapping (and keep everything else):

```ts
    enrichment: enr
      ? {
          confidence_label: enr.confidenceLabel,
          resolution_confidence: enr.resolutionConfidence,
          match_method: enr.matchMethod,
          identity_source: enr.identitySource as 'auto' | 'manual' | 'corrected',
          image_url: enr.imageUrl,
          description: enr.description,
          description_source: enr.descriptionSource as 'wikipedia' | 'tvmaze' | null,
          description_url: enr.descriptionUrl,
          wikipedia_page: enr.wikipediaPage,
          genres: (enr.genres as string[] | null) ?? [],
          directors: (enr.directors as string[] | null) ?? [],
          creators: (enr.creators as string[] | null) ?? [],
          duplicate_of_title_id: enr.duplicateOfTitleId,
        }
      : null,
```

- [ ] **Step 4: `enrichmentJobs.ts` hydrates `kind`**

Wave 4 added `enrich_jobs.kind`, which widens `EnrichJobRow`. Run `grep -n "kind" lib/server/enrichmentJobs.ts`. Expected: `RawJobRow` has `kind: string` and `hydrateJob` sets `kind: row.kind` (wave 4 Task 1 Step 8 adds them). If absent, add both lines; Task 9 relies on them.

- [ ] **Step 5: Baseline gates are green before any change**

Run: `npm run test:server 2>&1 | grep -E "Test Files|Tests "` and `npm run type-check`.
Expected: all passing. Record the test-file and test counts; Task 15 compares against them.

---

### Task 1: Screen title matching (`screenMatch.ts`)

**Files:**
- Create: `lib/server/screenMatch.ts`
- Test: `lib/server/screenMatch.test.ts`

**Interfaces:**
- Consumes: `ratio` from `lib/server/similarity.ts`; `pyTitle` from `lib/server/serialize.ts`.
- Produces (contract names, relied on by Tasks 5–7, 11 and waves 7):
  - `export function screenNormalize(title: string | null | undefined): string`
  - `export function screenRatio(a: string, b: string): number` — ratio over already-normalized strings; `0` when either is empty.
  - `export function screenSimilarity(a: string, b: string): number` — `screenRatio(screenNormalize(a), screenNormalize(b))`.
  - `export function titleVariants(title: string): string[]`

Why not `dedup.ts#normalizeTitle`: it drops subtitles and every character outside `[a-z0-9 ]`, so `東京物語` and `おくりびと` both normalize to `''`, and `ratio('', '')` is `1.0` — a manufactured HIGH (spec §1, §4.3).

- [ ] **Step 1: Write the failing test**

Create `lib/server/screenMatch.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { normalizeTitle } from './dedup';
import { ratio } from './similarity';
import { screenNormalize, screenRatio, screenSimilarity, titleVariants } from './screenMatch';

describe('screenNormalize', () => {
  it('lowercases, applies NFKC, and turns punctuation into single spaces', () => {
    expect(screenNormalize('Spider-Man: No Way Home')).toBe('spider man no way home');
    expect(screenNormalize('  WALL·E  ')).toBe('wall e');
    expect(screenNormalize('Ｔｏｋｙｏ')).toBe('tokyo'); // fullwidth "Tokyo"
  });

  it('keeps the full title, including subtitles and parentheticals', () => {
    expect(screenNormalize('The Human Centipede (First Sequence)')).toBe(
      'the human centipede first sequence'
    );
  });

  it('keeps non-Latin letters and combining marks', () => {
    expect(screenNormalize('東京物語')).toBe('東京物語');
    expect(screenNormalize('Amélie')).toBe('amélie');
    expect(screenNormalize('नमस्ते')).toBe(
      'नमस्ते'
    );
  });

  it('returns an empty string for punctuation-only and missing titles', () => {
    expect(screenNormalize('!!!')).toBe('');
    expect(screenNormalize('')).toBe('');
    expect(screenNormalize(null)).toBe('');
  });
});

describe('screenRatio and screenSimilarity', () => {
  it('never scores two empty titles as a match (unlike the raw ratio)', () => {
    expect(ratio('', '')).toBe(1);
    expect(screenRatio('', '')).toBe(0);
    expect(screenSimilarity('!!!', '???')).toBe(0);
  });

  it('keeps two different non-Latin titles apart, where the book helper collapses them', () => {
    const tokyoStory = '東京物語';
    const departures = 'おくりびと';
    expect(normalizeTitle(tokyoStory)).toBe(normalizeTitle(departures)); // both '' -- the bug
    expect(screenSimilarity(tokyoStory, departures)).toBe(0);
    expect(screenSimilarity(tokyoStory, tokyoStory)).toBe(1);
  });

  it('scores near-identical Latin titles highly', () => {
    expect(
      screenSimilarity('The Boy in the Striped Pyjamas', 'The Boy in the Striped Pajamas')
    ).toBeGreaterThanOrEqual(0.9);
  });
});

describe('titleVariants', () => {
  it('returns the spike variant set: as given, title case, capitalized, lower, upper', () => {
    expect(titleVariants("don't look up")).toEqual([
      "don't look up",
      "Don'T Look Up",
      "Don't look up",
      "DON'T LOOK UP",
    ]);
  });

  it('adds the base title and "Base: Parenthetical" for a trailing parenthetical', () => {
    const v = titleVariants('The Human Centipede (First Sequence)');
    expect(v).toContain('The Human Centipede (First Sequence)');
    expect(v).toContain('The Human Centipede');
    expect(v).toContain('The Human Centipede: First Sequence');
  });

  it('never returns an empty variant', () => {
    expect(titleVariants('(500)').every((x) => x.trim() !== '')).toBe(true);
  });
});
```

Note on the first variants case: `"don't look up"` lower-cased is itself, so the de-duplicated list has four entries in insertion order.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest list lib/server/screenMatch.test.ts` (expect the tests listed), then `npx vitest run lib/server/screenMatch.test.ts`.
Expected: FAIL — `Failed to resolve import "./screenMatch"`.

- [ ] **Step 3: Write the implementation**

Create `lib/server/screenMatch.ts`:

```ts
/**
 * Screen title matching (spec §4.3). Deliberately NOT the book helpers in dedup.ts:
 * normalizeTitle keeps only [a-z0-9 ], so two different non-Latin titles both
 * normalize to '' and ratio('', '') is 1.0 -- a manufactured HIGH. Screen titles keep
 * the full title (subtitles and parentheticals included), apply NFKC, lowercase, and
 * keep letters, combining marks and numbers in every script.
 *
 * Ported from the 2026-09-22 spike (resolve3.py#norm and #variants). One deliberate
 * difference: Python's \w drops combining marks (Devanagari vowel signs, for example),
 * so the port keeps \p{M} as part of a word instead of splitting on it.
 */
import { pyTitle } from './serialize';
import { ratio } from './similarity';

export function screenNormalize(title: string | null | undefined): string {
  if (!title) return '';
  return title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

/** ratio() over already-normalized titles. An empty side never matches. */
export function screenRatio(a: string, b: string): number {
  if (!a || !b) return 0;
  return ratio(a, b);
}

export function screenSimilarity(a: string, b: string): number {
  return screenRatio(screenNormalize(a), screenNormalize(b));
}

/** Python str.capitalize(): first character upper, the rest lower. */
function pyCapitalize(s: string): string {
  const chars = [...s];
  if (chars.length === 0) return s;
  return chars[0].toUpperCase() + chars.slice(1).join('').toLowerCase();
}

const TRAILING_PARENTHETICAL = /^(.*?)\s*\((.*)\)$/;

/**
 * The spike's Stage A variant set: as given, str.title(), str.capitalize(), lower,
 * upper, and for a trailing parenthetical such as "(First Sequence)", the base title
 * and "Base: Parenthetical". Insertion order, de-duplicated, blanks dropped.
 */
export function titleVariants(title: string): string[] {
  const out = new Set<string>([
    title,
    pyTitle(title),
    pyCapitalize(title),
    title.toLowerCase(),
    title.toUpperCase(),
  ]);
  const m = TRAILING_PARENTHETICAL.exec(title);
  if (m) {
    out.add(m[1]);
    out.add(`${m[1]}: ${m[2]}`);
  }
  return [...out].filter((v) => v.trim() !== '');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/server/screenMatch.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation check (load-bearing: non-Latin titles never falsely match)**

Temporarily replace the body of `screenNormalize` with `return normalizeTitle(title ?? '');` (import it from `./dedup`). Run the test file. Expected: FAIL in `keeps non-Latin letters` and `keeps two different non-Latin titles apart`. Restore the real body and re-run: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/server/screenMatch.ts lib/server/screenMatch.test.ts
git commit -m "feat(screen): screen title normalization and variants (#96)"
```

---

### Task 2: Film and TV subclass sets (`screenClasses`)

**Files:**
- Create: `scripts/screen-classes.ts`
- Create (generated): `lib/server/screenClasses.json`
- Create: `lib/server/screenClasses.ts`
- Test: `lib/server/screenClasses.test.ts`

**Interfaces:**
- Produces, relied on by Tasks 5–7:
  - `export type ScreenKind = 'film' | 'tv'`
  - `export function classifyP31(p31: readonly string[]): ScreenKind | null` — film if any P31 is a film class, else tv if any is a TV-program class, else null (spike `resolve3.py`).
  - `export function isTvSeries(p31: readonly string[]): boolean`
  - `export const FILM_CLASSES`, `TV_PROGRAM_CLASSES`, `TV_SERIES_CLASSES: ReadonlySet<string>`

Index decision 2: the sets are a checked-in generated file, refreshed by the controller, never walked at request time.

- [ ] **Step 1 [controller]: Write and run the generator**

Create `scripts/screen-classes.ts`:

```ts
/**
 * Regenerates lib/server/screenClasses.json: every Wikidata class reachable through
 * P279* from film (Q11424), television program (Q15416) and television series
 * (Q5398426). One SPARQL walk per root. Needs network, so the controller runs it,
 * never a request:  npx tsx scripts/screen-classes.ts && npx prettier --write lib/server/screenClasses.json
 */
import { writeFileSync } from 'node:fs';

const USER_AGENT = 'ShelfSprite/0.1 (https://shelfsprite.app)';
const ROOTS = { film: 'Q11424', tv_program: 'Q15416', tv_series: 'Q5398426' } as const;

async function subclasses(root: string): Promise<string[]> {
  const query = `SELECT DISTINCT ?c WHERE { ?c wdt:P279* wd:${root} . }`;
  const resp = await fetch('https://query.wikidata.org/sparql', {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/sparql-results+json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ query }).toString(),
  });
  if (!resp.ok) throw new Error(`WDQS answered ${resp.status} for ${root}`);
  const data = (await resp.json()) as {
    results: { bindings: Array<{ c: { value: string } }> };
  };
  const ids = data.results.bindings
    .map((b) => b.c.value.slice(b.c.value.lastIndexOf('/') + 1))
    .filter((id) => /^Q\d+$/.test(id));
  return [...new Set(ids)].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

async function main(): Promise<void> {
  const out: Record<string, unknown> = {
    generated_at: new Date().toISOString().slice(0, 10),
    source: 'Wikidata P279* walk; regenerate with scripts/screen-classes.ts',
  };
  for (const [key, root] of Object.entries(ROOTS)) out[key] = await subclasses(root);
  writeFileSync('lib/server/screenClasses.json', `${JSON.stringify(out, null, 2)}\n`);
  console.log(
    Object.keys(ROOTS)
      .map((key) => `${key}=${(out[key] as string[]).length}`)
      .join(' ')
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

Run: `npx tsx scripts/screen-classes.ts && npx prettier --write lib/server/screenClasses.json`
Expected output close to the spike's counts: `film=848 tv_program=507 tv_series=218`. Record the actual numbers in the task report; counts drift as Wikidata changes, and any value within roughly ±10 % is normal. A count under 100 means the query failed silently — investigate before continuing.

- [ ] **Step 2: Write the failing test**

Create `lib/server/screenClasses.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  FILM_CLASSES,
  TV_PROGRAM_CLASSES,
  TV_SERIES_CLASSES,
  classifyP31,
  isTvSeries,
} from './screenClasses';

describe('screen class sets', () => {
  it('contains each root class (P279* includes the zero-length path)', () => {
    expect(FILM_CLASSES.has('Q11424')).toBe(true);
    expect(TV_PROGRAM_CLASSES.has('Q15416')).toBe(true);
    expect(TV_SERIES_CLASSES.has('Q5398426')).toBe(true);
  });

  it('is large enough to be a real walk, not a failed query', () => {
    expect(FILM_CLASSES.size).toBeGreaterThan(300);
    expect(TV_PROGRAM_CLASSES.size).toBeGreaterThan(200);
    expect(TV_SERIES_CLASSES.size).toBeGreaterThan(80);
  });

  it('nests TV series inside TV programs', () => {
    expect([...TV_SERIES_CLASSES].every((c) => TV_PROGRAM_CLASSES.has(c))).toBe(true);
  });
});

describe('classifyP31', () => {
  it('classifies films, TV programs and everything else', () => {
    expect(classifyP31(['Q11424'])).toBe('film');
    expect(classifyP31(['Q5398426'])).toBe('tv');
    expect(classifyP31(['Q5'])).toBeNull();
    expect(classifyP31([])).toBeNull();
  });

  it('prefers film when an item is both', () => {
    expect(classifyP31(['Q5398426', 'Q11424'])).toBe('film');
  });
});

describe('isTvSeries', () => {
  it('is true only for TV series classes', () => {
    expect(isTvSeries(['Q5398426'])).toBe(true);
    expect(isTvSeries(['Q11424'])).toBe(false);
    expect(isTvSeries(['Q15416'])).toBe(false); // a TV program root is not a series
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run lib/server/screenClasses.test.ts`
Expected: FAIL — cannot resolve `./screenClasses`.

- [ ] **Step 4: Write the implementation**

Create `lib/server/screenClasses.ts`:

```ts
/**
 * Film / TV-program / TV-series class sets, generated by scripts/screen-classes.ts
 * (a one-off SPARQL P279* walk per root) and checked in. Never walked at request time:
 * the walk is slow and the sets change rarely. Regenerate when Wikidata reclassifies.
 */
import classes from './screenClasses.json';

export type ScreenKind = 'film' | 'tv';

export const FILM_CLASSES: ReadonlySet<string> = new Set(classes.film);
export const TV_PROGRAM_CLASSES: ReadonlySet<string> = new Set(classes.tv_program);
export const TV_SERIES_CLASSES: ReadonlySet<string> = new Set(classes.tv_series);

/** Spike resolve3.py: 'film' if any P31 is a film class, else 'tv' if a TV-program class. */
export function classifyP31(p31: readonly string[]): ScreenKind | null {
  if (p31.some((c) => FILM_CLASSES.has(c))) return 'film';
  if (p31.some((c) => TV_PROGRAM_CLASSES.has(c))) return 'tv';
  return null;
}

/** A subclass of Q5398426 -- the only kind of TV item that converts to media_type 'tv'. */
export function isTvSeries(p31: readonly string[]): boolean {
  return p31.some((c) => TV_SERIES_CLASSES.has(c));
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run lib/server/screenClasses.test.ts`
Expected: PASS. If `nests TV series inside TV programs` fails, record which QIDs are outside and report it: it means Wikidata's hierarchy changed and `classifyP31` may miss a series; do not delete the assertion.

- [ ] **Step 6: Commit**

```bash
git add scripts/screen-classes.ts lib/server/screenClasses.json lib/server/screenClasses.ts lib/server/screenClasses.test.ts
git commit -m "feat(screen): checked-in Wikidata film and TV class sets (#96)"
```

---

### Task 3: Screen catalog transport (`screenFetchJson`) and POST-aware replay

**Files:**
- Create: `lib/server/__tests__/helpers/replayKey.ts`
- Modify: `lib/server/__tests__/helpers/httpReplay.ts`
- Create: `lib/server/screenCatalog.ts` (transport half; Task 4 appends the endpoints)
- Test: `lib/server/__tests__/screen-catalog-transport.test.ts`

**Interfaces:**
- Consumes: `cacheGet`, `cachePut` from `lib/server/catalogCache.ts` (they hash any identity string with sha1, so a POST identity works unchanged).
- Produces (contract `CatalogResult` and `Deadline`, plus):
  - `export type CatalogResult<T> = { kind: 'ok'; value: T } | { kind: 'empty' } | { kind: 'retryable'; reason: string }`
  - `export interface Deadline { remainingMs(): number }`
  - `export function deadlineIn(ms: number, now?: () => number): Deadline`
  - `export const SCREEN_SOURCES` (`'screen:wikidata' | 'screen:wdqs' | 'screen:wikipedia' | 'screen:tvmaze'`) and `type ScreenSource`
  - `export const SCREEN_USER_AGENT`, `MAX_ATTEMPTS = 3`, `RETRY_AFTER_CAP_MS = 10_000`, `MIN_REQUEST_BUDGET_MS = 3_000`, `MIN_INTERVAL_MS`
  - `export interface ScreenRequest { url: string; source: ScreenSource; body?: string }`
  - `export function requestIdentity(req: ScreenRequest): string`
  - `export async function screenFetchJson(db: Db, req: ScreenRequest, deadline: Deadline): Promise<CatalogResult<unknown>>`
  - `export function _setScreenCatalogHooksForTests(overrides: { sleep?: (ms: number) => Promise<void>; now?: () => number } | null): void`
  - Test helper: `export function replayKey(url: string, init?: { method?: string; body?: unknown }): string`

Why the replay helper changes: `installHttpReplay` keys fixtures by URL, and every SPARQL query is a POST to the same URL. After this change a request with a body is keyed `"<METHOD> <url>\n<body>"`; a GET is still keyed by its bare URL, so every existing replay test is untouched.

- [ ] **Step 1: Write the failing test**

Create `lib/server/__tests__/screen-catalog-transport.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheGet } from '../catalogCache';
import type { Db } from '../db';
import {
  MAX_ATTEMPTS,
  RETRY_AFTER_CAP_MS,
  SCREEN_SOURCES,
  SCREEN_USER_AGENT,
  _setScreenCatalogHooksForTests,
  requestIdentity,
  screenFetchJson,
  type Deadline,
} from '../screenCatalog';
import { installHttpReplay } from './helpers/httpReplay';
import { replayKey } from './helpers/replayKey';
import { makeTestDb } from './helpers/pglite';

const WD = 'https://www.wikidata.org/w/api.php?action=wbgetentities&ids=Q1&format=json';
const WDQS = 'https://query.wikidata.org/sparql';
const TVMAZE = 'https://api.tvmaze.com/shows/1';

let db: Db;
let close: () => Promise<void>;
let sleeps: number[];
let calls: Array<{ url: string; init?: RequestInit }>;

const plenty: Deadline = { remainingMs: () => 600_000 };
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

function stubFetch(queue: Array<Response | Error>): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = queue.shift();
    if (!next) throw new Error('stubFetch: queue exhausted');
    if (next instanceof Error) throw next;
    return next;
  });
}

beforeEach(async () => {
  ({ db, close } = await makeTestDb());
  sleeps = [];
  calls = [];
  _setScreenCatalogHooksForTests({
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => 1_000_000,
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  _setScreenCatalogHooksForTests(null);
  await close();
});

describe('screenFetchJson', () => {
  it('returns ok, caches the payload under a screen source, and serves the cache next time', async () => {
    stubFetch([json(200, { entities: {} })]);
    const req = { url: WD, source: SCREEN_SOURCES.wikidata };
    expect(await screenFetchJson(db, req, plenty)).toEqual({ kind: 'ok', value: { entities: {} } });
    expect(await screenFetchJson(db, req, plenty)).toEqual({ kind: 'ok', value: { entities: {} } });
    expect(calls).toHaveLength(1);
    const rows = await (db as any).$client.query('select source from catalog_cache');
    expect(rows.rows).toEqual([{ source: 'screen:wikidata' }]);
  });

  it('sends the screen User-Agent, which carries no email address', async () => {
    stubFetch([json(200, {})]);
    await screenFetchJson(db, { url: TVMAZE, source: SCREEN_SOURCES.tvmaze }, plenty);
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe(SCREEN_USER_AGENT);
    expect(SCREEN_USER_AGENT).toBe('ShelfSprite/0.1 (https://shelfsprite.app)');
    expect(SCREEN_USER_AGENT).not.toMatch(/@/);
  });

  it('answers empty for a 404 and caches it negatively', async () => {
    stubFetch([json(404, { error: 'not found' })]);
    const req = { url: TVMAZE, source: SCREEN_SOURCES.tvmaze };
    expect(await screenFetchJson(db, req, plenty)).toEqual({ kind: 'empty' });
    expect(await screenFetchJson(db, req, plenty)).toEqual({ kind: 'empty' });
    expect(calls).toHaveLength(1);
  });

  it('answers retryable, never empty, after MAX_ATTEMPTS server errors, and caches nothing', async () => {
    stubFetch([json(503, {}), json(503, {}), json(503, {})]);
    const req = { url: WD, source: SCREEN_SOURCES.wikidata };
    const out = await screenFetchJson(db, req, plenty);
    expect(out).toEqual({ kind: 'retryable', reason: 'HTTP 503' });
    expect(calls).toHaveLength(MAX_ATTEMPTS);
    expect(await cacheGet(db, requestIdentity(req))).toEqual({ hit: false, payload: null });
  });

  it('caps Retry-After at ten seconds', async () => {
    stubFetch([json(429, {}, { 'Retry-After': '120' }), json(200, { ok: 1 })]);
    const out = await screenFetchJson(db, { url: WD, source: SCREEN_SOURCES.wikidata }, plenty);
    expect(out).toEqual({ kind: 'ok', value: { ok: 1 } });
    expect(sleeps).toContain(RETRY_AFTER_CAP_MS);
    expect(Math.max(...sleeps)).toBe(RETRY_AFTER_CAP_MS);
  });

  it('defers rather than sleeping past the deadline', async () => {
    stubFetch([json(429, {}, { 'Retry-After': '5' })]);
    const tight: Deadline = { remainingMs: () => 6_000 };
    const out = await screenFetchJson(db, { url: WD, source: SCREEN_SOURCES.wikidata }, tight);
    expect(out).toEqual({ kind: 'retryable', reason: 'deadline after HTTP 429' });
    expect(calls).toHaveLength(1);
  });

  it('does not start a request when less than three seconds remain', async () => {
    stubFetch([]);
    const spent: Deadline = { remainingMs: () => 2_000 };
    const out = await screenFetchJson(db, { url: WD, source: SCREEN_SOURCES.wikidata }, spent);
    expect(out.kind).toBe('retryable');
    expect(calls).toHaveLength(0);
  });

  it('still serves a cache hit when the deadline is spent', async () => {
    stubFetch([json(200, { cached: true })]);
    const req = { url: WD, source: SCREEN_SOURCES.wikidata };
    await screenFetchJson(db, req, plenty);
    const out = await screenFetchJson(db, req, { remainingMs: () => 0 });
    expect(out).toEqual({ kind: 'ok', value: { cached: true } });
  });

  it('treats a non-404 client error as retryable without retrying it', async () => {
    stubFetch([json(400, { error: 'bad query' })]);
    const out = await screenFetchJson(db, { url: WD, source: SCREEN_SOURCES.wikidata }, plenty);
    expect(out).toEqual({ kind: 'retryable', reason: 'HTTP 400' });
    expect(calls).toHaveLength(1);
  });

  it('retries a network error and then answers retryable', async () => {
    stubFetch([new TypeError('fetch failed'), new TypeError('fetch failed'), new TypeError('fetch failed')]);
    const out = await screenFetchJson(db, { url: WD, source: SCREEN_SOURCES.wikidata }, plenty);
    expect(out).toEqual({ kind: 'retryable', reason: 'network error: fetch failed' });
    expect(calls).toHaveLength(MAX_ATTEMPTS);
  });

  it('treats an unparseable body as retryable', async () => {
    stubFetch([new Response('<html>oops</html>', { status: 200 })]);
    const out = await screenFetchJson(db, { url: WD, source: SCREEN_SOURCES.wikidata }, plenty);
    expect(out).toEqual({ kind: 'retryable', reason: 'unparseable response body' });
  });

  it('keys a POST by its body, so two SPARQL queries are cached separately', async () => {
    stubFetch([json(200, { results: { bindings: [] } }), json(200, { results: { bindings: [1] } })]);
    const a = { url: WDQS, source: SCREEN_SOURCES.wdqs, body: 'query=A' };
    const b = { url: WDQS, source: SCREEN_SOURCES.wdqs, body: 'query=B' };
    await screenFetchJson(db, a, plenty);
    const out = await screenFetchJson(db, b, plenty);
    expect(out).toEqual({ kind: 'ok', value: { results: { bindings: [1] } } });
    expect(calls.map((c) => c.init?.method)).toEqual(['POST', 'POST']);
    expect(requestIdentity(a)).toBe('POST https://query.wikidata.org/sparql\nquery=A');
  });

  it('spaces two requests to the same host by the host minimum interval', async () => {
    stubFetch([json(200, {}), json(200, {})]);
    await screenFetchJson(db, { url: TVMAZE, source: SCREEN_SOURCES.tvmaze }, plenty);
    await screenFetchJson(db, { url: `${TVMAZE}0`, source: SCREEN_SOURCES.tvmaze }, plenty);
    expect(sleeps).toEqual([550]);
  });

  it('rethrows a replay-harness miss instead of retrying it', async () => {
    const restore = installHttpReplay({});
    try {
      await expect(
        screenFetchJson(db, { url: WD, source: SCREEN_SOURCES.wikidata }, plenty)
      ).rejects.toThrow(/no fixture/);
    } finally {
      restore();
    }
  });
});

describe('POST-aware replay', () => {
  it('replays a POST fixture keyed by URL and body, and leaves GET keys as bare URLs', async () => {
    expect(replayKey(TVMAZE)).toBe(TVMAZE);
    expect(replayKey(WDQS, { method: 'POST', body: 'query=A' })).toBe(
      'POST https://query.wikidata.org/sparql\nquery=A'
    );
    const restore = installHttpReplay({
      [replayKey(WDQS, { method: 'POST', body: 'query=A' })]: {
        status: 200,
        body: { results: { bindings: ['a'] } },
      },
    });
    try {
      const out = await screenFetchJson(
        db,
        { url: WDQS, source: SCREEN_SOURCES.wdqs, body: 'query=A' },
        plenty
      );
      expect(out).toEqual({ kind: 'ok', value: { results: { bindings: ['a'] } } });
    } finally {
      restore();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest list lib/server/__tests__/screen-catalog-transport.test.ts` (expect the tests listed), then `npx vitest run lib/server/__tests__/screen-catalog-transport.test.ts`.
Expected: FAIL — cannot resolve `../screenCatalog` and `./helpers/replayKey`.

- [ ] **Step 3: Add the replay key helper and make the replay stub POST-aware**

Create `lib/server/__tests__/helpers/replayKey.ts`:

```ts
/**
 * Fixture key for a replayed HTTP request. A GET is keyed by its bare URL (exactly as
 * installHttpReplay always did); a request with a body is keyed by method, URL and
 * body, so two SPARQL POSTs to the same endpoint replay different fixtures.
 *
 * Deliberately free of vitest imports: scripts/record-screen-fixtures.ts uses it
 * outside the test runner to write fixtures under the same keys.
 */
export function replayKey(url: string, init?: { method?: string; body?: unknown }): string {
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method === 'GET' || init?.body === undefined || init.body === null) return url;
  return `${method} ${url}\n${String(init.body)}`;
}
```

In `lib/server/__tests__/helpers/httpReplay.ts`, add the import and re-export below the existing `import { vi } from 'vitest';` line:

```ts
import { replayKey } from './replayKey';

export { replayKey };
```

and replace the body of `installHttpReplay` with:

```ts
export function installHttpReplay(
  fixtures: Record<string, ReplayEntry>,
  onCall?: (url: string) => void
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    // GET keys stay the bare URL, so every existing fixture still matches.
    const key = replayKey(url, init);
    onCall?.(key);
    const entry = fixtures[key];
    if (!entry) throw new HttpReplayMissError(key);
    return new Response(entry.body === undefined ? null : JSON.stringify(entry.body), {
      status: entry.status,
      headers: { 'content-type': 'application/json', ...(entry.headers ?? {}) },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}
```

Update the helper's doc comment to add one sentence: "A request with a body is keyed by `replayKey` (method, URL and body); a GET by its bare URL."

- [ ] **Step 4: Write the transport**

Create `lib/server/screenCatalog.ts`:

```ts
/**
 * Screen catalog transport and clients: Wikidata (Action API and WDQS SPARQL),
 * Wikipedia REST, TVmaze. Spec §4.1. Two deliberate departures from the book client
 * in catalog.ts:
 *  - Failure is not "no match". CatalogResult keeps a definite empty answer (a 404)
 *    apart from a retryable failure (network error, 5xx, 429 after retries, any other
 *    4xx, an unparseable body, or no time left). Only a definite answer may ever be
 *    persisted as "unresolved"; a retryable one defers the title to a later batch.
 *  - A deadline is threaded into every request and retry, and Retry-After is capped.
 * Throttling is per invocation, as in catalog.ts: each Vercel isolate spaces its own
 * requests; cross-request spacing is not attempted at invite-only scale. Requests are
 * strictly sequential, which satisfies Wikimedia's "concurrency 1" for the Action API.
 */
import { cacheGet, cachePut } from './catalogCache';
import type { Db } from './db';

/** Names the app and a contact website. Never an email address. */
export const SCREEN_USER_AGENT = 'ShelfSprite/0.1 (https://shelfsprite.app)';

export type CatalogResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'empty' }
  | { kind: 'retryable'; reason: string };

export interface Deadline {
  remainingMs(): number;
}

export function deadlineIn(ms: number, now: () => number = Date.now): Deadline {
  const end = now() + ms;
  return { remainingMs: () => end - now() };
}

/** catalog_cache.source values. The shared prefix is what cache retention prunes by. */
export const SCREEN_SOURCES = {
  wikidata: 'screen:wikidata',
  wdqs: 'screen:wdqs',
  wikipedia: 'screen:wikipedia',
  tvmaze: 'screen:tvmaze',
} as const;
export type ScreenSource = (typeof SCREEN_SOURCES)[keyof typeof SCREEN_SOURCES];

/**
 * Minimum spacing between two requests to one host. Wikimedia's robot policy allows
 * 5 req/s (Action API at concurrency 1); TVmaze allows 20 calls per 10 s. 250 ms and
 * 550 ms keep a margin under both.
 */
export const MIN_INTERVAL_MS: Record<ScreenSource, number> = {
  'screen:wikidata': 250,
  'screen:wdqs': 250,
  'screen:wikipedia': 250,
  'screen:tvmaze': 550,
};

const REQUEST_TIMEOUT_MS: Record<ScreenSource, number> = {
  'screen:wikidata': 15_000,
  'screen:wdqs': 30_000,
  'screen:wikipedia': 10_000,
  'screen:tvmaze': 10_000,
};

export const MAX_ATTEMPTS = 3;
/** The spike saw Retry-After of about 20 s; waiting that long inside a chunk is not worth it. */
export const RETRY_AFTER_CAP_MS = 10_000;
/** Never start a request with less than this left; the title is deferred instead. */
export const MIN_REQUEST_BUDGET_MS = 3_000;

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

interface Hooks {
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const defaultHooks: Hooks = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

let hooks: Hooks = defaultHooks;
const lastCallAt = new Map<ScreenSource, number>();

/** Test seam: replace sleeping and the throttle clock. `null` restores both. */
export function _setScreenCatalogHooksForTests(overrides: Partial<Hooks> | null): void {
  hooks = overrides ? { ...defaultHooks, ...overrides } : defaultHooks;
  lastCallAt.clear();
}

async function throttle(source: ScreenSource): Promise<void> {
  const last = lastCallAt.get(source);
  if (last !== undefined) {
    const wait = MIN_INTERVAL_MS[source] - (hooks.now() - last);
    if (wait > 0) await hooks.sleep(wait);
  }
  lastCallAt.set(source, hooks.now());
}

export interface ScreenRequest {
  url: string;
  source: ScreenSource;
  /** A form-encoded POST body (SPARQL). Absent means GET. */
  body?: string;
}

/** Cache identity: the URL for a GET; method, URL and body for a POST. */
export function requestIdentity(req: ScreenRequest): string {
  return req.body === undefined ? req.url : `POST ${req.url}\n${req.body}`;
}

function retryAfterMs(header: string | null): number | null {
  const value = header?.trim();
  if (!value || !/^\d+$/.test(value)) return null;
  return Math.min(Number(value) * 1_000, RETRY_AFTER_CAP_MS);
}

function requestHeaders(req: ScreenRequest): Record<string, string> {
  if (req.body === undefined) return { 'User-Agent': SCREEN_USER_AGENT, Accept: 'application/json' };
  return {
    'User-Agent': SCREEN_USER_AGENT,
    Accept: 'application/sparql-results+json',
    'Content-Type': 'application/x-www-form-urlencoded',
  };
}

export async function screenFetchJson(
  db: Db,
  req: ScreenRequest,
  deadline: Deadline
): Promise<CatalogResult<unknown>> {
  const identity = requestIdentity(req);
  const cached = await cacheGet(db, identity);
  if (cached.hit) {
    return cached.payload === null ? { kind: 'empty' } : { kind: 'ok', value: cached.payload };
  }

  let backoff = 1_000;
  let reason = 'no attempt';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const remaining = deadline.remainingMs();
    if (remaining < MIN_REQUEST_BUDGET_MS) {
      return { kind: 'retryable', reason: `deadline after ${reason}` };
    }
    await throttle(req.source);
    let resp: Response;
    try {
      resp = await fetch(req.url, {
        method: req.body === undefined ? 'GET' : 'POST',
        headers: requestHeaders(req),
        body: req.body,
        signal: AbortSignal.timeout(
          Math.max(1_000, Math.min(REQUEST_TIMEOUT_MS[req.source], remaining - 1_000))
        ),
      });
    } catch (err) {
      // Same guard as catalog.ts: a replay-harness miss is a broken test, not a network
      // failure. Duck-typed on `.name` so production code never imports a test helper.
      if (err instanceof Error && err.name === 'HttpReplayMissError') throw err;
      reason = `network error: ${err instanceof Error ? err.message : String(err)}`;
      if (attempt === MAX_ATTEMPTS) break;
      if (backoff > deadline.remainingMs() - MIN_REQUEST_BUDGET_MS) {
        return { kind: 'retryable', reason: `deadline after ${reason}` };
      }
      await hooks.sleep(backoff);
      backoff *= 2;
      continue;
    }
    if (resp.status === 404) {
      await cachePut(db, identity, req.source, null);
      return { kind: 'empty' };
    }
    if (!resp.ok) {
      reason = `HTTP ${resp.status}`;
      // A 400 from SPARQL is a bug in our query, not "no such film": never let it
      // become an unresolved row. It is retryable and the stall check surfaces it.
      if (!RETRYABLE_STATUS.has(resp.status)) return { kind: 'retryable', reason };
      if (attempt === MAX_ATTEMPTS) break;
      const wait = retryAfterMs(resp.headers.get('Retry-After')) ?? backoff;
      if (wait > deadline.remainingMs() - MIN_REQUEST_BUDGET_MS) {
        return { kind: 'retryable', reason: `deadline after ${reason}` };
      }
      await hooks.sleep(wait);
      backoff *= 2;
      continue;
    }
    let data: unknown;
    try {
      data = await resp.json();
    } catch {
      return { kind: 'retryable', reason: 'unparseable response body' };
    }
    await cachePut(db, identity, req.source, data);
    return { kind: 'ok', value: data };
  }
  return { kind: 'retryable', reason };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run lib/server/__tests__/screen-catalog-transport.test.ts`
Expected: PASS.

Run the existing replay users to prove GET keys are unchanged: `npx vitest run lib/server/__tests__/catalog-fetch.test.ts lib/server/__tests__/catalog-ranking.test.ts lib/server/__tests__/enrichment-run.test.ts lib/server/__tests__/recommend-run.test.ts`
Expected: PASS, with the same test counts as before the change.

- [ ] **Step 6: Mutation check (load-bearing: a retryable failure never reads as "no match")**

Temporarily change the final `return { kind: 'retryable', reason };` in `screenFetchJson` to `return { kind: 'empty' };`. Run the transport test file. Expected: FAIL in `answers retryable, never empty, after MAX_ATTEMPTS server errors` and `retries a network error`. Restore; re-run: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/server/screenCatalog.ts lib/server/__tests__/screen-catalog-transport.test.ts lib/server/__tests__/helpers/replayKey.ts lib/server/__tests__/helpers/httpReplay.ts
git commit -m "feat(screen): screen catalog transport with deadlines and retryable results (#96)"
```

---

### Task 4: Catalog endpoints and Wikidata entity helpers

**Files:**
- Modify: `lib/server/screenCatalog.ts` (append)
- Test: `lib/server/__tests__/screen-catalog-endpoints.test.ts`

**Interfaces:**
- Consumes: `screenFetchJson`, `SCREEN_SOURCES`, `CatalogResult`, `Deadline` (Task 3).
- Produces (contract endpoint names; each takes `db` first and `deadline` last):
  - `export async function wikidataSearch(db: Db, term: string, limit: number, deadline: Deadline): Promise<CatalogResult<string[]>>` — QIDs in rank order; a 404 answers `ok([])`.
  - `export async function wikidataEntities(db: Db, qids: readonly string[], props: EntityProps, deadline: Deadline): Promise<CatalogResult<Map<string, WikidataEntity>>>` — sorted, de-duplicated, 50 ids per call, `languages=en|mul`; missing entities omitted; any failed batch makes the whole call `retryable`.
  - `export async function wikidataSparql(db: Db, query: string, deadline: Deadline): Promise<CatalogResult<SparqlBinding[]>>`
  - `export async function wikipediaSummary(db: Db, pageTitle: string, deadline: Deadline): Promise<CatalogResult<WikipediaSummary>>` — 404 answers `empty`.
  - `export async function tvmazeSingleSearch(db: Db, q: string, deadline: Deadline): Promise<CatalogResult<TvmazeShow>>` — 404 answers `empty`.
  - `export async function tvmazeSearch(db: Db, q: string, deadline: Deadline): Promise<CatalogResult<TvmazeShow[]>>`
  - `export async function tvmazeShow(db: Db, id: number, deadline: Deadline): Promise<CatalogResult<TvmazeShow>>` — 404 answers `empty`.
  - Types: `WikidataEntity`, `WikidataClaim`, `EntityProps` (`'labels|aliases|claims|sitelinks' | 'labels|claims' | 'labels'`), `FULL_ENTITY_PROPS`, `SparqlBinding`, `WikipediaSummary`, `TvmazeShow`.
  - URL builders: `export const screenUrls` (`wikidataSearch`, `wikidataEntities`, `wikipediaSummary`, `tvmazeSingleSearch`, `tvmazeSearch`, `tvmazeShow`, `sparqlBody`), plus `WIKIDATA_API`, `WDQS_ENDPOINT`, `ENTITIES_PER_CALL = 50`.
  - Helpers: `isQid`, `compareQids`, `qidFromUri`, `sparqlString`, `claimIds`, `claimStrings`, `claimYears`, `entityLabel`, `entityNames`, `sitelinkCount`, `enwikiTitle`.

- [ ] **Step 1: Write the failing test**

Create `lib/server/__tests__/screen-catalog-endpoints.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db';
import {
  FULL_ENTITY_PROPS,
  WDQS_ENDPOINT,
  _setScreenCatalogHooksForTests,
  claimIds,
  claimStrings,
  claimYears,
  enwikiTitle,
  entityLabel,
  entityNames,
  screenUrls,
  sitelinkCount,
  sparqlString,
  tvmazeSearch,
  tvmazeSingleSearch,
  wikidataEntities,
  wikidataSearch,
  wikidataSparql,
  wikipediaSummary,
  type Deadline,
  type WikidataEntity,
} from '../screenCatalog';
import { installHttpReplay, type ReplayEntry } from './helpers/httpReplay';
import { replayKey } from './helpers/replayKey';
import { makeTestDb } from './helpers/pglite';

let db: Db;
let close: () => Promise<void>;
let restore: (() => void) | null = null;
let called: string[];
const plenty: Deadline = { remainingMs: () => 600_000 };

function replay(fixtures: Record<string, ReplayEntry>): void {
  restore = installHttpReplay(fixtures, (key) => called.push(key));
}

const film = (id: string, extra: Partial<WikidataEntity> = {}): WikidataEntity => ({
  id,
  labels: { en: { value: `Film ${id}` } },
  claims: { P31: [{ mainsnak: { datavalue: { value: { id: 'Q11424' } } } }] },
  sitelinks: { enwiki: { title: `Film ${id}` } },
  ...extra,
});

beforeEach(async () => {
  ({ db, close } = await makeTestDb());
  called = [];
  _setScreenCatalogHooksForTests({ sleep: async () => undefined });
});

afterEach(async () => {
  restore?.();
  restore = null;
  _setScreenCatalogHooksForTests(null);
  await close();
});

describe('URL builders', () => {
  it('builds wbgetentities with en|mul labels and pipe-separated ids', () => {
    expect(screenUrls.wikidataEntities(['Q1', 'Q2'], FULL_ENTITY_PROPS)).toBe(
      'https://www.wikidata.org/w/api.php?action=wbgetentities&ids=Q1%7CQ2' +
        '&props=labels%7Caliases%7Cclaims%7Csitelinks&languages=en%7Cmul&format=json'
    );
  });

  it('encodes a Wikipedia page title with underscores and a percent-encoded slash', () => {
    expect(screenUrls.wikipediaSummary('AC/DC (film)')).toBe(
      'https://en.wikipedia.org/api/rest_v1/page/summary/AC%2FDC_(film)'
    );
  });
});

describe('wikidataEntities', () => {
  it('sorts, de-duplicates, fetches 50 ids per call, and omits missing entities', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `Q${i + 1}`);
    const first = ids.slice(0, 50);
    const entities = Object.fromEntries(first.map((id) => [id, film(id)]));
    entities.Q3 = { id: 'Q3', missing: '' } as unknown as WikidataEntity;
    replay({
      [screenUrls.wikidataEntities(first, FULL_ENTITY_PROPS)]: { status: 200, body: { entities } },
      [screenUrls.wikidataEntities(['Q51'], FULL_ENTITY_PROPS)]: {
        status: 200,
        body: { entities: { Q51: film('Q51') } },
      },
    });
    const out = await wikidataEntities(db, [...ids].reverse().concat(['Q1']), FULL_ENTITY_PROPS, plenty);
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.value.size).toBe(50); // 51 ids, Q3 missing
    expect(out.value.has('Q3')).toBe(false);
    expect(called).toHaveLength(2);
  });

  it('is retryable when any batch fails', async () => {
    replay({ [screenUrls.wikidataEntities(['Q1'], FULL_ENTITY_PROPS)]: { status: 503 } });
    const out = await wikidataEntities(db, ['Q1'], FULL_ENTITY_PROPS, plenty);
    expect(out).toEqual({ kind: 'retryable', reason: 'HTTP 503' });
  });

  it('answers ok with an empty map for no ids, without a request', async () => {
    replay({});
    expect(await wikidataEntities(db, [], FULL_ENTITY_PROPS, plenty)).toEqual({
      kind: 'ok',
      value: new Map(),
    });
  });
});

describe('wikidataSearch', () => {
  it('returns only well-formed QIDs, in rank order', async () => {
    replay({
      [screenUrls.wikidataSearch('Her', 10)]: {
        status: 200,
        body: { search: [{ id: 'Q9' }, { id: 'L1' }, { id: 'Q2' }] },
      },
    });
    expect(await wikidataSearch(db, 'Her', 10, plenty)).toEqual({ kind: 'ok', value: ['Q9', 'Q2'] });
  });
});

describe('wikidataSparql', () => {
  it('POSTs the query as a form body and returns the bindings', async () => {
    const query = 'SELECT ?q WHERE { }';
    replay({
      [replayKey(WDQS_ENDPOINT, { method: 'POST', body: screenUrls.sparqlBody(query) })]: {
        status: 200,
        body: { results: { bindings: [{ q: { type: 'uri', value: 'http://www.wikidata.org/entity/Q1' } }] } },
      },
    });
    const out = await wikidataSparql(db, query, plenty);
    expect(out).toEqual({
      kind: 'ok',
      value: [{ q: { type: 'uri', value: 'http://www.wikidata.org/entity/Q1' } }],
    });
  });

  it('escapes quotes, backslashes and newlines in a string literal', () => {
    expect(sparqlString('Say "hi"\\now\nplease')).toBe('"Say \\"hi\\"\\\\now\\nplease"');
  });
});

describe('Wikipedia and TVmaze', () => {
  it('answers empty for a missing Wikipedia page', async () => {
    replay({ [screenUrls.wikipediaSummary('Nope')]: { status: 404 } });
    expect(await wikipediaSummary(db, 'Nope', plenty)).toEqual({ kind: 'empty' });
  });

  it('answers empty when TVmaze singlesearch finds nothing', async () => {
    replay({ [screenUrls.tvmazeSingleSearch('zzqx')]: { status: 404 } });
    expect(await tvmazeSingleSearch(db, 'zzqx', plenty)).toEqual({ kind: 'empty' });
  });

  it('unwraps TVmaze search hits and drops malformed ones', async () => {
    replay({
      [screenUrls.tvmazeSearch('severance')]: {
        status: 200,
        body: [{ score: 0.9, show: { id: 44933, name: 'Severance' } }, { score: 0.1, show: {} }],
      },
    });
    expect(await tvmazeSearch(db, 'severance', plenty)).toEqual({
      kind: 'ok',
      value: [{ id: 44933, name: 'Severance' }],
    });
  });
});

describe('entity helpers', () => {
  const e: WikidataEntity = {
    id: 'Q134773',
    labels: { mul: { value: 'Forrest Gump' } },
    aliases: { en: [{ value: 'Gump' }], mul: [{ value: 'Forrest Gump (film)' }] },
    claims: {
      P31: [
        { mainsnak: { datavalue: { value: { id: 'Q11424' } } } },
        { mainsnak: {} }, // a novalue snak has no datavalue
      ],
      P577: [
        { mainsnak: { datavalue: { value: { time: '+1994-07-06T00:00:00Z' } } } },
        { mainsnak: { datavalue: { value: { time: '+1994-10-07T00:00:00Z' } } } },
        { mainsnak: { datavalue: { value: { time: '+1995-02-03T00:00:00Z' } } } },
      ],
      P8600: [{ mainsnak: { datavalue: { value: '123' } } }],
    },
    sitelinks: { enwiki: { title: 'Forrest Gump' }, frwiki: { title: 'Forrest Gump' } },
  };

  it('reads the mul label when there is no en label', () => {
    expect(entityLabel(e)).toBe('Forrest Gump');
  });

  it('returns en and mul labels and aliases as scoring names', () => {
    expect(entityNames(e)).toEqual(['Forrest Gump', 'Gump', 'Forrest Gump (film)']);
  });

  it('reads item ids, strings, distinct sorted years, sitelinks and the enwiki title', () => {
    expect(claimIds(e, 'P31')).toEqual(['Q11424']);
    expect(claimStrings(e, 'P8600')).toEqual(['123']);
    expect(claimYears(e)).toEqual([1994, 1995]);
    expect(claimYears(e, 'P580')).toEqual([]);
    expect(sitelinkCount(e)).toBe(2);
    expect(enwikiTitle(e)).toBe('Forrest Gump');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/server/__tests__/screen-catalog-endpoints.test.ts`
Expected: FAIL — `screenUrls` (and the other endpoint exports) are not exported.

- [ ] **Step 3: Append the endpoints and helpers to `lib/server/screenCatalog.ts`**

```ts
// --- Wikidata ---------------------------------------------------------------------

export const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
export const WDQS_ENDPOINT = 'https://query.wikidata.org/sparql';
export const ENTITIES_PER_CALL = 50;

export interface WikidataClaim {
  mainsnak?: { datavalue?: { value?: unknown } };
  rank?: string;
}

export interface WikidataEntity {
  id: string;
  labels?: Record<string, { value: string }>;
  aliases?: Record<string, Array<{ value: string }>>;
  claims?: Record<string, WikidataClaim[]>;
  sitelinks?: Record<string, { title: string }>;
}

export type EntityProps = 'labels|aliases|claims|sitelinks' | 'labels|claims' | 'labels';
export const FULL_ENTITY_PROPS: EntityProps = 'labels|aliases|claims|sitelinks';

export type SparqlBinding = Record<string, { type: string; value: string; 'xml:lang'?: string }>;

export interface WikipediaSummary {
  type?: string;
  title?: string;
  extract?: string;
  thumbnail?: { source?: string };
  content_urls?: { desktop?: { page?: string } };
}

export interface TvmazeShow {
  id: number;
  name: string;
  url?: string;
  premiered?: string | null;
  summary?: string | null;
  genres?: string[];
  language?: string | null;
  image?: { medium?: string; original?: string } | null;
}

export const screenUrls = {
  wikidataSearch: (term: string, limit: number) =>
    `${WIKIDATA_API}?${new URLSearchParams({
      action: 'wbsearchentities',
      search: term,
      language: 'en',
      uselang: 'en',
      type: 'item',
      limit: String(limit),
      format: 'json',
    })}`,
  wikidataEntities: (ids: readonly string[], props: EntityProps) =>
    `${WIKIDATA_API}?${new URLSearchParams({
      action: 'wbgetentities',
      ids: ids.join('|'),
      props,
      languages: 'en|mul',
      format: 'json',
    })}`,
  wikipediaSummary: (pageTitle: string) =>
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(
      pageTitle.replace(/ /g, '_')
    )}`,
  tvmazeSingleSearch: (q: string) =>
    `https://api.tvmaze.com/singlesearch/shows?${new URLSearchParams({ q })}`,
  tvmazeSearch: (q: string) => `https://api.tvmaze.com/search/shows?${new URLSearchParams({ q })}`,
  tvmazeShow: (id: number) => `https://api.tvmaze.com/shows/${id}`,
  sparqlBody: (query: string) => new URLSearchParams({ query }).toString(),
};

const QID_PATTERN = /^Q\d+$/;

export function isQid(value: unknown): value is string {
  return typeof value === 'string' && QID_PATTERN.test(value);
}

export function compareQids(a: string, b: string): number {
  return Number(a.slice(1)) - Number(b.slice(1));
}

/** `http://www.wikidata.org/entity/Q42` -> `Q42`. */
export function qidFromUri(uri: string): string | null {
  const id = uri.slice(uri.lastIndexOf('/') + 1);
  return isQid(id) ? id : null;
}

/** A SPARQL string literal (the caller appends @en / @mul). */
export function sparqlString(s: string): string {
  const escaped = s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

export async function wikidataSearch(
  db: Db,
  term: string,
  limit: number,
  deadline: Deadline
): Promise<CatalogResult<string[]>> {
  const out = await screenFetchJson(
    db,
    { url: screenUrls.wikidataSearch(term, limit), source: SCREEN_SOURCES.wikidata },
    deadline
  );
  if (out.kind === 'retryable') return out;
  if (out.kind === 'empty') return { kind: 'ok', value: [] };
  const hits = (out.value as { search?: Array<{ id?: unknown }> }).search ?? [];
  return { kind: 'ok', value: hits.map((hit) => hit.id).filter(isQid) };
}

export async function wikidataEntities(
  db: Db,
  qids: readonly string[],
  props: EntityProps,
  deadline: Deadline
): Promise<CatalogResult<Map<string, WikidataEntity>>> {
  const ids = [...new Set(qids)].filter(isQid).sort(compareQids);
  const found = new Map<string, WikidataEntity>();
  for (let i = 0; i < ids.length; i += ENTITIES_PER_CALL) {
    const batch = ids.slice(i, i + ENTITIES_PER_CALL);
    const out = await screenFetchJson(
      db,
      { url: screenUrls.wikidataEntities(batch, props), source: SCREEN_SOURCES.wikidata },
      deadline
    );
    if (out.kind === 'retryable') return out;
    if (out.kind === 'empty') continue;
    const entities = (out.value as { entities?: Record<string, WikidataEntity> }).entities ?? {};
    for (const [id, entity] of Object.entries(entities)) {
      if (entity && !('missing' in entity) && isQid(id)) found.set(id, entity);
    }
  }
  return { kind: 'ok', value: found };
}

export async function wikidataSparql(
  db: Db,
  query: string,
  deadline: Deadline
): Promise<CatalogResult<SparqlBinding[]>> {
  const out = await screenFetchJson(
    db,
    { url: WDQS_ENDPOINT, source: SCREEN_SOURCES.wdqs, body: screenUrls.sparqlBody(query) },
    deadline
  );
  if (out.kind === 'retryable') return out;
  if (out.kind === 'empty') return { kind: 'ok', value: [] };
  const bindings = (out.value as { results?: { bindings?: SparqlBinding[] } }).results?.bindings;
  return { kind: 'ok', value: Array.isArray(bindings) ? bindings : [] };
}

// --- Wikipedia ----------------------------------------------------------------------

export async function wikipediaSummary(
  db: Db,
  pageTitle: string,
  deadline: Deadline
): Promise<CatalogResult<WikipediaSummary>> {
  const out = await screenFetchJson(
    db,
    { url: screenUrls.wikipediaSummary(pageTitle), source: SCREEN_SOURCES.wikipedia },
    deadline
  );
  if (out.kind !== 'ok') return out;
  return { kind: 'ok', value: out.value as WikipediaSummary };
}

// --- TVmaze -------------------------------------------------------------------------

function isTvmazeShow(value: unknown): value is TvmazeShow {
  const show = value as TvmazeShow | null;
  return (
    !!show && typeof show === 'object' && typeof show.id === 'number' && typeof show.name === 'string'
  );
}

async function tvmazeOne(db: Db, url: string, deadline: Deadline): Promise<CatalogResult<TvmazeShow>> {
  const out = await screenFetchJson(db, { url, source: SCREEN_SOURCES.tvmaze }, deadline);
  if (out.kind !== 'ok') return out;
  return isTvmazeShow(out.value) ? { kind: 'ok', value: out.value } : { kind: 'empty' };
}

export function tvmazeSingleSearch(db: Db, q: string, deadline: Deadline) {
  return tvmazeOne(db, screenUrls.tvmazeSingleSearch(q), deadline);
}

export function tvmazeShow(db: Db, id: number, deadline: Deadline) {
  return tvmazeOne(db, screenUrls.tvmazeShow(id), deadline);
}

export async function tvmazeSearch(
  db: Db,
  q: string,
  deadline: Deadline
): Promise<CatalogResult<TvmazeShow[]>> {
  const out = await screenFetchJson(
    db,
    { url: screenUrls.tvmazeSearch(q), source: SCREEN_SOURCES.tvmaze },
    deadline
  );
  if (out.kind === 'retryable') return out;
  if (out.kind === 'empty') return { kind: 'ok', value: [] };
  const hits = Array.isArray(out.value) ? (out.value as Array<{ show?: unknown }>) : [];
  return { kind: 'ok', value: hits.map((hit) => hit.show).filter(isTvmazeShow) };
}

// --- Entity helpers (spike wd.py#claim_ids / #claim_years) -------------------------

function claimValues(entity: WikidataEntity, property: string): unknown[] {
  return (entity.claims?.[property] ?? [])
    .map((claim) => claim.mainsnak?.datavalue?.value)
    .filter((value) => value !== undefined && value !== null);
}

export function claimIds(entity: WikidataEntity, property: string): string[] {
  return claimValues(entity, property)
    .map((value) => (value as { id?: unknown }).id)
    .filter(isQid);
}

export function claimStrings(entity: WikidataEntity, property: string): string[] {
  return claimValues(entity, property).filter((value): value is string => typeof value === 'string');
}

/** Every distinct year among a time property's values, ascending. Any P577 year counts (§2.1 finding 3). */
export function claimYears(entity: WikidataEntity, property = 'P577'): number[] {
  const years = new Set<number>();
  for (const value of claimValues(entity, property)) {
    const time = (value as { time?: unknown }).time;
    if (typeof time !== 'string') continue;
    const match = /^([+-])(\d+)-/.exec(time);
    if (match) years.add((match[1] === '-' ? -1 : 1) * Number(match[2]));
  }
  return [...years].sort((a, b) => a - b);
}

/** en first, then mul: famous items often carry only a mul label (§2.1 finding 2a). */
export function entityLabel(entity: WikidataEntity): string | null {
  return entity.labels?.en?.value ?? entity.labels?.mul?.value ?? null;
}

export function entityNames(entity: WikidataEntity): string[] {
  return [
    entity.labels?.en?.value,
    entity.labels?.mul?.value,
    ...(entity.aliases?.en ?? []).map((alias) => alias.value),
    ...(entity.aliases?.mul ?? []).map((alias) => alias.value),
  ].filter((name): name is string => typeof name === 'string' && name.length > 0);
}

export function sitelinkCount(entity: WikidataEntity): number {
  return Object.keys(entity.sitelinks ?? {}).length;
}

export function enwikiTitle(entity: WikidataEntity): string | null {
  return entity.sitelinks?.enwiki?.title ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/server/__tests__/screen-catalog-endpoints.test.ts lib/server/__tests__/screen-catalog-transport.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/server/screenCatalog.ts lib/server/__tests__/screen-catalog-endpoints.test.ts
git commit -m "feat(screen): Wikidata, Wikipedia and TVmaze endpoint clients (#96)"
```

---

### Task 5: Movie scoring (`scoreTitle`)

**Files:**
- Create: `lib/server/screenEnrichment.ts` (scoring section; Tasks 6–8 append)
- Test: `lib/server/__tests__/screen-score.test.ts`

**Interfaces:**
- Consumes: `screenNormalize`, `screenRatio`, `titleVariants` (Task 1); `classifyP31`, `isTvSeries`, `ScreenKind` (Task 2); `claimIds`, `claimStrings`, `claimYears`, `compareQids`, `entityNames`, `enwikiTitle`, `sitelinkCount`, `WikidataEntity` (Task 4).
- Produces, relied on by Tasks 7, 8, 11:
  - `export const SIMILARITY_THRESHOLD = 0.9`, `SIMILARITY_MARGIN = 0.1`, `POPULARITY_FACTOR = 2`
  - `export type ScreenLabel = 'HIGH' | 'MEDIUM' | 'LOW'`
  - `export type ScreenMatchMethod = 'wikidata:exact' | 'wikidata:exact_tiebreak' | 'wikidata:popularity' | 'wikidata:fuzzy' | 'wikidata:ambiguous' | 'unresolved' | 'manual' | 'user_correction' | 'refresh'`
  - `export interface ScoredCandidate { qid: string; kind: ScreenKind; similarity: number; exact: boolean; yearExact: boolean; yearNear: boolean; years: number[]; enwiki: boolean; sitelinks: number; tvSeries: boolean; tvmazeId: number | null }`
  - `export interface TitleScore { label: ScreenLabel | 'UNRESOLVED'; method: ScreenMatchMethod; pick: ScoredCandidate | null; top: ScoredCandidate[] }`
  - `export function scoreCandidate(normalized: string, variants: ReadonlySet<string>, year: number | null, entity: WikidataEntity): ScoredCandidate | null`
  - `export function scoreTitle(title: string, year: number | null, entities: readonly WikidataEntity[]): TitleScore`

The rules are spec §4.3, ported from `resolve3.py`:

- **HIGH**: exact normalized title (label or alias, including variants) **and** an exact year (any P577 year; P580 when a TV item has no P577), and exactly one such candidate after the tie-breaks, in order: a film beats a TV item; then the only candidate with an enwiki article wins.
- **MEDIUM**: either an exact tie broken by popularity (leader has at least 2× the runner-up's sitelinks, runner-up floored at 1), or similarity ≥ 0.9 with year within ±1 and a margin ≥ 0.1 over the runner-up.
- **LOW**: anything else with a classified candidate. **UNRESOLVED**: no classified candidate, or a title that normalizes to `''`.

The margin comparison keeps the spike's float semantics (`1.0 - 0.9` is `0.0999…`, which fails `>= 0.1` in Python and TypeScript alike). Do not "fix" it with an epsilon: the thresholds were validated with exactly this arithmetic.

- [ ] **Step 1: Write the failing test**

Create `lib/server/__tests__/screen-score.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { WikidataEntity } from '../screenCatalog';
import { scoreTitle } from '../screenEnrichment';

interface EntitySpec {
  id: string;
  label?: string;
  lang?: 'en' | 'mul';
  aliases?: string[];
  p31?: string;
  years?: number[];
  p580?: number[];
  sitelinks?: number;
  enwiki?: boolean;
  p8600?: string;
}

const FILM = 'Q11424';
const TV_SERIES = 'Q5398426';

function ent(spec: EntitySpec): WikidataEntity {
  const time = (y: number) => ({ mainsnak: { datavalue: { value: { time: `+${y}-01-01T00:00:00Z` } } } });
  const sitelinks: Record<string, { title: string }> = {};
  if (spec.enwiki ?? true) sitelinks.enwiki = { title: spec.label ?? spec.id };
  for (let i = Object.keys(sitelinks).length; i < (spec.sitelinks ?? 1); i++) {
    sitelinks[`x${i}wiki`] = { title: 'x' };
  }
  return {
    id: spec.id,
    labels: spec.label ? { [spec.lang ?? 'en']: { value: spec.label } } : {},
    aliases: spec.aliases ? { en: spec.aliases.map((value) => ({ value })) } : {},
    claims: {
      P31: [{ mainsnak: { datavalue: { value: { id: spec.p31 ?? FILM } } } }],
      P577: (spec.years ?? []).map(time),
      P580: (spec.p580 ?? []).map(time),
      ...(spec.p8600 ? { P8600: [{ mainsnak: { datavalue: { value: spec.p8600 } } }] } : {}),
    },
    sitelinks,
  };
}

describe('scoreTitle: HIGH', () => {
  it('is HIGH for an exact title and an exact year', () => {
    const out = scoreTitle('Her', 2013, [ent({ id: 'Q1', label: 'Her', years: [2013] })]);
    expect([out.label, out.method, out.pick?.qid]).toEqual(['HIGH', 'wikidata:exact', 'Q1']);
  });

  it('matches an item that carries only a mul label', () => {
    const out = scoreTitle('Forrest Gump', 1994, [
      ent({ id: 'Q134773', label: 'Forrest Gump', lang: 'mul', years: [1994] }),
    ]);
    expect(out.label).toBe('HIGH');
  });

  it('matches an alias and accepts any of several P577 years', () => {
    const out = scoreTitle('Night Watch', 2005, [
      ent({ id: 'Q2', label: 'Nochnoy Dozor', aliases: ['Night Watch'], years: [2004, 2005] }),
    ]);
    expect(out.label).toBe('HIGH');
  });

  it('reads P580 for a TV item with no P577', () => {
    const out = scoreTitle('Tiger King', 2020, [
      ent({ id: 'Q3', label: 'Tiger King', p31: TV_SERIES, p580: [2020], p8600: '46519' }),
    ]);
    expect([out.label, out.pick?.kind, out.pick?.tvSeries, out.pick?.tvmazeId]).toEqual([
      'HIGH',
      'tv',
      true,
      46519,
    ]);
  });

  it('matches the base of a trailing parenthetical', () => {
    const out = scoreTitle('The Human Centipede (First Sequence)', 2009, [
      ent({ id: 'Q4', label: 'The Human Centipede', years: [2009] }),
    ]);
    expect(out.label).toBe('HIGH');
  });

  it('lets a film beat a TV item with the same title and year', () => {
    const out = scoreTitle('Frozen', 2010, [
      ent({ id: 'Q5', label: 'Frozen', p31: TV_SERIES, years: [2010], sitelinks: 90 }),
      ent({ id: 'Q6', label: 'Frozen', years: [2010], sitelinks: 3 }),
    ]);
    expect([out.label, out.method, out.pick?.qid]).toEqual(['HIGH', 'wikidata:exact_tiebreak', 'Q6']);
  });

  it('breaks an exact tie by the only enwiki article', () => {
    const out = scoreTitle('Titanic', 1997, [
      ent({ id: 'Q7', label: 'Titanic', years: [1997], enwiki: false, sitelinks: 5 }),
      ent({ id: 'Q8', label: 'Titanic', years: [1997], sitelinks: 2 }),
    ]);
    expect([out.label, out.method, out.pick?.qid]).toEqual(['HIGH', 'wikidata:exact_tiebreak', 'Q8']);
  });
});

describe('scoreTitle: MEDIUM', () => {
  it('breaks an exact tie by popularity at 2x as MEDIUM, never HIGH', () => {
    const out = scoreTitle('Aladdin', 1992, [
      ent({ id: 'Q9', label: 'Aladdin', years: [1992], sitelinks: 40 }),
      ent({ id: 'Q10', label: 'Aladdin', years: [1992], sitelinks: 12 }),
    ]);
    expect([out.label, out.method, out.pick?.qid]).toEqual(['MEDIUM', 'wikidata:popularity', 'Q9']);
  });

  it('is MEDIUM for a close spelling within a year', () => {
    const out = scoreTitle('The Boy in the Striped Pyjamas', 2008, [
      ent({ id: 'Q11', label: 'The Boy in the Striped Pajamas', years: [2008] }),
    ]);
    expect([out.label, out.method]).toEqual(['MEDIUM', 'wikidata:fuzzy']);
  });
});

describe('scoreTitle: never HIGH without an exact year', () => {
  it('labels an exact title one year off as MEDIUM', () => {
    const out = scoreTitle('Suspiria', 2018, [ent({ id: 'Q12', label: 'Suspiria', years: [2019] })]);
    expect(out.label).toBe('MEDIUM');
  });

  it('labels a title with no year LOW even on an exact title', () => {
    const out = scoreTitle('Suspiria', null, [ent({ id: 'Q12', label: 'Suspiria', years: [2018] })]);
    expect(out.label).toBe('LOW');
  });
});

describe('scoreTitle: LOW and UNRESOLVED', () => {
  it('keeps a popularity gap under 2x LOW', () => {
    const out = scoreTitle('Split', 2016, [
      ent({ id: 'Q13', label: 'Split', years: [2016], sitelinks: 20 }),
      ent({ id: 'Q14', label: 'Split', years: [2016], sitelinks: 12 }),
    ]);
    expect([out.label, out.method]).toEqual(['LOW', 'wikidata:ambiguous']);
  });

  it('keeps two equally close near-year matches LOW (no margin)', () => {
    const out = scoreTitle('Coco', 2017, [
      ent({ id: 'Q15', label: 'Coco', years: [2016] }),
      ent({ id: 'Q16', label: 'Coco', years: [2018] }),
    ]);
    expect(out.label).toBe('LOW');
  });

  it('never matches two different non-Latin titles (the book helper would say HIGH)', () => {
    const out = scoreTitle('東京物語', 1953, [
      ent({ id: 'Q17', label: 'おくりびと', lang: 'mul', years: [1953] }),
    ]);
    expect(out.label).not.toBe('HIGH');
    expect(out.label).not.toBe('MEDIUM');
  });

  it('matches a non-Latin title against itself', () => {
    const out = scoreTitle('東京物語', 1953, [
      ent({ id: 'Q18', label: '東京物語', lang: 'mul', years: [1953] }),
    ]);
    expect(out.label).toBe('HIGH');
  });

  it('never resolves a title that normalizes to nothing', () => {
    // 'Heat' scores 0 against '', so without the guard this would come back LOW, not UNRESOLVED.
    const out = scoreTitle('!!!', 2001, [ent({ id: 'Q19', label: 'Heat', years: [2001] })]);
    expect([out.label, out.method, out.pick]).toEqual(['UNRESOLVED', 'unresolved', null]);
  });

  it('ignores items that are neither films nor TV programs', () => {
    const out = scoreTitle('Her', 2013, [ent({ id: 'Q20', label: 'Her', p31: 'Q5', years: [2013] })]);
    expect(out.label).toBe('UNRESOLVED');
  });
});
```

(The non-Latin literals are 東京物語 *Tokyo Story* and おくりびと *Departures*; this is a `.ts` file, so non-ASCII literals are fine.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/server/__tests__/screen-score.test.ts`
Expected: FAIL — cannot resolve `../screenEnrichment`.

- [ ] **Step 3: Write the scoring section**

Create `lib/server/screenEnrichment.ts`:

```ts
/**
 * Screen enrichment: movie resolution (spec §4.3), TV crosswalk, metadata (§4.5),
 * identity and clash rules (§4.4), and the ScreenCandidate record shared by manual
 * add, correction and recommendations.
 *
 * The resolver is a port of the 2026-09-22 spike (resolve3.py / cold.py), which
 * measured HIGH 97.3 %, MEDIUM 1.8 %, LOW 0.9 %, unresolved 0 on a real 562-film
 * export. Departures from the spike are deliberate and named where they occur:
 * film-beats-TV runs first (the spec added it), and scoring names include mul aliases.
 */
import { classifyP31, isTvSeries, type ScreenKind } from './screenClasses';
import {
  claimIds,
  claimStrings,
  claimYears,
  compareQids,
  entityNames,
  enwikiTitle,
  sitelinkCount,
  type WikidataEntity,
} from './screenCatalog';
import { screenNormalize, screenRatio, titleVariants } from './screenMatch';

// --- Scoring (spec §4.3) --------------------------------------------------------------

/** Validated by the spike on real data (§2.1 finding 2). */
export const SIMILARITY_THRESHOLD = 0.9;
export const SIMILARITY_MARGIN = 0.1;
export const POPULARITY_FACTOR = 2;

export type ScreenLabel = 'HIGH' | 'MEDIUM' | 'LOW';

export type ScreenMatchMethod =
  | 'wikidata:exact'
  | 'wikidata:exact_tiebreak'
  | 'wikidata:popularity'
  | 'wikidata:fuzzy'
  | 'wikidata:ambiguous'
  | 'unresolved'
  | 'manual'
  | 'user_correction'
  | 'refresh';

export interface ScoredCandidate {
  qid: string;
  kind: ScreenKind;
  similarity: number;
  exact: boolean;
  yearExact: boolean;
  yearNear: boolean;
  years: number[];
  enwiki: boolean;
  sitelinks: number;
  tvSeries: boolean;
  tvmazeId: number | null;
}

export interface TitleScore {
  label: ScreenLabel | 'UNRESOLVED';
  method: ScreenMatchMethod;
  pick: ScoredCandidate | null;
  top: ScoredCandidate[];
}

function firstInt(values: string[]): number | null {
  for (const value of values) {
    if (/^\d+$/.test(value)) return Number(value);
  }
  return null;
}

export function scoreCandidate(
  normalized: string,
  variants: ReadonlySet<string>,
  year: number | null,
  entity: WikidataEntity
): ScoredCandidate | null {
  const p31 = claimIds(entity, 'P31');
  const kind = classifyP31(p31);
  if (!kind) return null;
  const names = entityNames(entity).map(screenNormalize).filter(Boolean);
  if (names.length === 0) return null;
  let years = claimYears(entity, 'P577');
  if (kind === 'tv' && years.length === 0) years = claimYears(entity, 'P580');
  return {
    qid: entity.id,
    kind,
    similarity: Math.max(...names.map((name) => screenRatio(normalized, name))),
    exact: names.some((name) => variants.has(name)),
    yearExact: year !== null && years.includes(year),
    yearNear: year !== null && years.some((y) => Math.abs(y - year) <= 1),
    years,
    enwiki: enwikiTitle(entity) !== null,
    sitelinks: sitelinkCount(entity),
    tvSeries: isTvSeries(p31),
    tvmazeId: firstInt(claimStrings(entity, 'P8600')),
  };
}

const UNRESOLVED_SCORE: TitleScore = { label: 'UNRESOLVED', method: 'unresolved', pick: null, top: [] };

export function scoreTitle(
  title: string,
  year: number | null,
  entities: readonly WikidataEntity[]
): TitleScore {
  const normalized = screenNormalize(title);
  if (!normalized) return UNRESOLVED_SCORE; // an empty normalized title never matches
  const variants = new Set(titleVariants(title).map(screenNormalize).filter(Boolean));
  const scored = [...entities]
    .sort((a, b) => compareQids(a.id, b.id))
    .map((entity) => scoreCandidate(normalized, variants, year, entity))
    .filter((c): c is ScoredCandidate => c !== null);
  if (scored.length === 0) return UNRESOLVED_SCORE;

  const near = scored
    .filter((c) => c.yearNear)
    .sort(
      (a, b) =>
        b.similarity - a.similarity || b.sitelinks - a.sitelinks || compareQids(a.qid, b.qid)
    );
  const top = near.slice(0, 3);

  let exact = scored.filter((c) => c.exact && c.yearExact);
  let tiebreak: 'film' | 'enwiki' | 'popularity' | null = null;
  if (exact.length > 1) {
    // Letterboxd is a film log: a film beats a TV item with the same title and year.
    const films = exact.filter((c) => c.kind === 'film');
    if (films.length > 0 && films.length < exact.length) {
      exact = films;
      tiebreak = 'film';
    }
  }
  if (exact.length > 1) {
    const withArticle = exact.filter((c) => c.enwiki);
    if (withArticle.length === 1) {
      exact = withArticle;
      tiebreak = 'enwiki';
    } else {
      const pool = [...(withArticle.length > 0 ? withArticle : exact)].sort(
        (a, b) => b.sitelinks - a.sitelinks || compareQids(a.qid, b.qid)
      );
      if (pool[0].sitelinks >= POPULARITY_FACTOR * Math.max(1, pool[1].sitelinks)) {
        exact = [pool[0]];
        tiebreak = 'popularity';
      }
    }
  }

  if (exact.length === 1) {
    if (tiebreak === 'popularity') {
      return { label: 'MEDIUM', method: 'wikidata:popularity', pick: exact[0], top };
    }
    return {
      label: 'HIGH',
      method: tiebreak ? 'wikidata:exact_tiebreak' : 'wikidata:exact',
      pick: exact[0],
      top,
    };
  }
  if (
    near.length > 0 &&
    near[0].similarity >= SIMILARITY_THRESHOLD &&
    (near.length === 1 || near[0].similarity - near[1].similarity >= SIMILARITY_MARGIN)
  ) {
    return { label: 'MEDIUM', method: 'wikidata:fuzzy', pick: near[0], top };
  }
  const bestBySimilarity = [...scored].sort(
    (a, b) => b.similarity - a.similarity || compareQids(a.qid, b.qid)
  )[0];
  return {
    label: 'LOW',
    method: 'wikidata:ambiguous',
    pick: exact[0] ?? near[0] ?? bestBySimilarity,
    top,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/server/__tests__/screen-score.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation checks (load-bearing)**

1. Delete `if (!normalized) return UNRESOLVED_SCORE;`. Run the file. Expected: FAIL in `never resolves a title that normalizes to nothing` (the title comes back LOW). Restore.
2. Change `yearExact: year !== null && years.includes(year)` to `yearExact: year === null || years.includes(year)`. Expected: FAIL in `labels a title with no year LOW even on an exact title`. Restore.
3. Delete the film-beats-TV block. Expected: FAIL in `lets a film beat a TV item`. Restore; re-run: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/server/screenEnrichment.ts lib/server/__tests__/screen-score.test.ts
git commit -m "feat(screen): movie resolution scoring with spec tie-breaks (#96)"
```

---

### Task 6: `ScreenCandidate`, its schema, and metadata (`fetchScreenMetadata`)

**Files:**
- Modify: `lib/server/screenEnrichment.ts` (append)
- Test: `lib/server/__tests__/screen-metadata.test.ts`

**Interfaces:**
- Consumes: Task 4 endpoints and helpers; `isTvSeries` (Task 2); `firstInt` (Task 5, module-private).
- Produces (contract `ScreenCandidate` and `fetchScreenMetadata`; the schema and helpers are used by Tasks 7, 8, 11, 12 and wave 7):
  - `export interface ScreenCandidate` — exactly the contract's fields:

    ```ts
    export interface ScreenCandidate {
      media_type: 'movie' | 'tv';
      title: string;
      year: number | null;
      wikidata_qid: string | null;
      tvmaze_id: number | null;
      image_url: string | null;
      description: string | null;
      description_source: 'wikipedia' | 'tvmaze' | null;
      description_url: string | null;
      wikipedia_page: string | null;
      genres: string[];
      directors: string[];
      creators: string[];
      writers: string[];
      countries: string[];
      original_language: string | null; // ISO 639-1 from P218, else the language's label
      based_on: Array<{ qid: string; title: string | null; author: string | null }>;
      main_subjects: string[];
      series: Array<{ qid: string; label: string | null }>;
      production_companies: Array<{ qid: string; label: string | null }>;
      sitelinks: number;
    }
    ```
  - `export const ScreenCandidateSchema` (Zod) — used to validate client-supplied candidates; image URLs must be `https` on `upload.wikimedia.org` or `static.tvmaze.com`, description URLs `https` on `en.wikipedia.org` or `(www.)tvmaze.com`.
  - `export const IMAGE_HOSTS`, `DESCRIPTION_HOSTS`
  - `export interface MetadataOptions { entities?: ReadonlyMap<string, WikidataEntity>; skipTvmaze?: boolean }`
  - `export async function fetchScreenMetadata(db: Db, qids: readonly string[], deadline: Deadline, options?: MetadataOptions): Promise<CatalogResult<Map<string, ScreenCandidate>>>` — the contract signature plus one optional parameter: preloaded entities (so Task 7 does not refetch what it already scored) and `skipTvmaze` (so TV callers that already hold the TVmaze show do not fetch it twice).
  - `export function mergeTvmaze(show: TvmazeShow, wikidata: ScreenCandidate | null): ScreenCandidate`
  - `export function stripHtml(html: string): string`

Metadata sources (spec §4.5): genre P136, director P57, screenwriter P58, creator P170, country P495, original language P364 (→ P218 code), based on P144 (→ each source's P50 author), main subject P921, series P179, production company P272, sitelink count. Description and image from the enwiki summary; a TV series prefers the TVmaze summary (HTML stripped) and TVmaze image. Every list is capped at 20 entries to keep rows small; cast is never fetched (spec §3.3).

Request plan per call, all batched: entities not preloaded (`FULL`), then one `labels|claims` fetch for based-on sources and language items, then one `labels` fetch for every other referenced item plus the authors, then one Wikipedia summary per item with an enwiki article, then TVmaze for converted series. Any retryable step makes the whole call retryable; cached steps are free on the retry.

- [ ] **Step 1: Write the failing test**

Create `lib/server/__tests__/screen-metadata.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db';
import {
  FULL_ENTITY_PROPS,
  _setScreenCatalogHooksForTests,
  screenUrls,
  type Deadline,
  type WikidataEntity,
} from '../screenCatalog';
import {
  ScreenCandidateSchema,
  fetchScreenMetadata,
  mergeTvmaze,
  stripHtml,
  type ScreenCandidate,
} from '../screenEnrichment';
import { installHttpReplay, type ReplayEntry } from './helpers/httpReplay';
import { makeTestDb } from './helpers/pglite';

let db: Db;
let close: () => Promise<void>;
let restore: (() => void) | null = null;
let called: string[];
const plenty: Deadline = { remainingMs: () => 600_000 };

type ClaimSpec = Record<string, Array<string | { id: string } | { time: string }>>;

function entity(id: string, label: string, claimSpec: ClaimSpec, sitelinks: string[] = []): WikidataEntity {
  const claims = Object.fromEntries(
    Object.entries(claimSpec).map(([p, values]) => [
      p,
      values.map((value) => ({ mainsnak: { datavalue: { value } } })),
    ])
  );
  return {
    id,
    labels: { en: { value: label } },
    claims,
    sitelinks: Object.fromEntries(sitelinks.map((site) => [site, { title: site === 'enwiki' ? `${label} (film)` : label }])),
  };
}

const labelOnly = (id: string, label: string): WikidataEntity => ({ id, labels: { en: { value: label } } });

function replay(fixtures: Record<string, ReplayEntry>): void {
  restore = installHttpReplay(fixtures, (key) => called.push(key));
}

beforeEach(async () => {
  ({ db, close } = await makeTestDb());
  called = [];
  _setScreenCatalogHooksForTests({ sleep: async () => undefined });
});

afterEach(async () => {
  restore?.();
  restore = null;
  _setScreenCatalogHooksForTests(null);
  await close();
});

const ARRIVAL = entity(
  'Q100',
  'Arrival',
  {
    P31: [{ id: 'Q11424' }],
    P577: [{ time: '+2016-09-01T00:00:00Z' }, { time: '+2016-11-11T00:00:00Z' }],
    P136: [{ id: 'Q200' }],
    P57: [{ id: 'Q300' }],
    P58: [{ id: 'Q301' }],
    P495: [{ id: 'Q30' }],
    P364: [{ id: 'Q1860' }],
    P144: [{ id: 'Q400' }],
    P921: [{ id: 'Q600' }],
    P272: [{ id: 'Q700' }],
  },
  ['enwiki', 'frwiki', 'dewiki']
);

function arrivalFixtures(summaryStatus = 200): Record<string, ReplayEntry> {
  return {
    [screenUrls.wikidataEntities(['Q100'], FULL_ENTITY_PROPS)]: {
      status: 200,
      body: { entities: { Q100: ARRIVAL } },
    },
    [screenUrls.wikidataEntities(['Q400', 'Q1860'], 'labels|claims')]: {
      status: 200,
      body: {
        entities: {
          Q400: entity('Q400', 'Story of Your Life', { P50: [{ id: 'Q500' }] }),
          Q1860: entity('Q1860', 'English', { P218: ['en'] }),
        },
      },
    },
    [screenUrls.wikidataEntities(['Q30', 'Q200', 'Q300', 'Q301', 'Q500', 'Q600', 'Q700'], 'labels')]: {
      status: 200,
      body: {
        entities: {
          Q30: labelOnly('Q30', 'United States'),
          Q200: labelOnly('Q200', 'science fiction film'),
          Q300: labelOnly('Q300', 'Denis Villeneuve'),
          Q301: labelOnly('Q301', 'Eric Heisserer'),
          Q500: labelOnly('Q500', 'Ted Chiang'),
          Q600: labelOnly('Q600', 'first contact'),
          Q700: labelOnly('Q700', 'Lava Bear Films'),
        },
      },
    },
    [screenUrls.wikipediaSummary('Arrival (film)')]: {
      status: summaryStatus,
      body: {
        type: 'standard',
        extract: 'Arrival is a 2016 American science fiction film.',
        thumbnail: { source: 'https://upload.wikimedia.org/wikipedia/en/d/df/Arrival.jpg' },
        content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Arrival_(film)' } },
      },
    },
  };
}

describe('fetchScreenMetadata', () => {
  it('builds a full movie candidate from Wikidata and the Wikipedia summary', async () => {
    replay(arrivalFixtures());
    const out = await fetchScreenMetadata(db, ['Q100'], plenty);
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    const expected: ScreenCandidate = {
      media_type: 'movie',
      title: 'Arrival',
      year: 2016,
      wikidata_qid: 'Q100',
      tvmaze_id: null,
      image_url: 'https://upload.wikimedia.org/wikipedia/en/d/df/Arrival.jpg',
      description: 'Arrival is a 2016 American science fiction film.',
      description_source: 'wikipedia',
      description_url: 'https://en.wikipedia.org/wiki/Arrival_(film)',
      wikipedia_page: 'Arrival (film)',
      genres: ['science fiction film'],
      directors: ['Denis Villeneuve'],
      creators: [],
      writers: ['Eric Heisserer'],
      countries: ['United States'],
      original_language: 'en',
      based_on: [{ qid: 'Q400', title: 'Story of Your Life', author: 'Ted Chiang' }],
      main_subjects: ['first contact'],
      series: [],
      production_companies: [{ qid: 'Q700', label: 'Lava Bear Films' }],
      sitelinks: 3,
    };
    expect(out.value.get('Q100')).toEqual(expected);
    expect(ScreenCandidateSchema.safeParse(expected).success).toBe(true);
  });

  it('does not refetch entities the caller preloaded', async () => {
    const fixtures = arrivalFixtures();
    delete fixtures[screenUrls.wikidataEntities(['Q100'], FULL_ENTITY_PROPS)];
    replay(fixtures);
    const out = await fetchScreenMetadata(db, ['Q100'], plenty, {
      entities: new Map([['Q100', ARRIVAL]]),
    });
    expect(out.kind).toBe('ok');
  });

  it('is retryable when the Wikipedia summary fails, and builds nothing', async () => {
    replay(arrivalFixtures(503));
    const out = await fetchScreenMetadata(db, ['Q100'], plenty);
    expect(out).toEqual({ kind: 'retryable', reason: 'HTTP 503' });
  });

  it('converts a TV series with a TVmaze id and prefers the TVmaze summary and image', async () => {
    const tigerKing = entity(
      'Q800',
      'Tiger King',
      { P31: [{ id: 'Q5398426' }], P580: [{ time: '+2020-03-20T00:00:00Z' }], P8600: ['46519'] },
      ['enwiki']
    );
    replay({
      [screenUrls.wikidataEntities(['Q800'], FULL_ENTITY_PROPS)]: {
        status: 200,
        body: { entities: { Q800: tigerKing } },
      },
      [screenUrls.wikipediaSummary('Tiger King (film)')]: {
        status: 200,
        body: { type: 'standard', extract: 'Wikipedia text.' },
      },
      [screenUrls.tvmazeShow(46519)]: {
        status: 200,
        body: {
          id: 46519,
          name: 'Tiger King',
          url: 'https://www.tvmaze.com/shows/46519/tiger-king',
          premiered: '2020-03-20',
          summary: '<p><b>Tiger King</b> is a true crime docuseries &amp; more.</p>',
          genres: ['Crime'],
          language: 'English',
          image: { medium: 'https://static.tvmaze.com/uploads/images/medium_portrait/1/1.jpg' },
        },
      },
    });
    const out = await fetchScreenMetadata(db, ['Q800'], plenty);
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.value.get('Q800')).toMatchObject({
      media_type: 'tv',
      tvmaze_id: 46519,
      wikidata_qid: 'Q800',
      year: 2020,
      description: 'Tiger King is a true crime docuseries & more.',
      description_source: 'tvmaze',
      description_url: 'https://www.tvmaze.com/shows/46519/tiger-king',
      image_url: 'https://static.tvmaze.com/uploads/images/medium_portrait/1/1.jpg',
    });
  });

  it('keeps a TV special (no series class, no P8600) as a movie', async () => {
    const special = entity('Q900', 'Frosty Returns', { P31: [{ id: 'Q15416' }], P577: [{ time: '+1992-01-01T00:00:00Z' }] });
    replay({
      [screenUrls.wikidataEntities(['Q900'], FULL_ENTITY_PROPS)]: {
        status: 200,
        body: { entities: { Q900: special } },
      },
    });
    const out = await fetchScreenMetadata(db, ['Q900'], plenty);
    expect(out.kind === 'ok' && out.value.get('Q900')?.media_type).toBe('movie');
  });

  it('skips the TVmaze fetch when asked', async () => {
    const series = entity('Q801', 'Severance', { P31: [{ id: 'Q5398426' }], P8600: ['44933'] });
    replay({
      [screenUrls.wikidataEntities(['Q801'], FULL_ENTITY_PROPS)]: {
        status: 200,
        body: { entities: { Q801: series } },
      },
    });
    const out = await fetchScreenMetadata(db, ['Q801'], plenty, { skipTvmaze: true });
    expect(out.kind).toBe('ok');
    expect(called.some((key) => key.includes('tvmaze'))).toBe(false);
  });
});

describe('mergeTvmaze and stripHtml', () => {
  it('builds a TV candidate from TVmaze alone when there is no crosswalk', () => {
    const out = mergeTvmaze(
      {
        id: 1,
        name: 'Under the Dome',
        url: 'https://www.tvmaze.com/shows/1/under-the-dome',
        premiered: '2013-06-24',
        summary: '<p>A dome.</p>',
        genres: ['Drama', 'Science-Fiction'],
        language: 'English',
        image: null,
      },
      null
    );
    expect(out).toMatchObject({
      media_type: 'tv',
      title: 'Under the Dome',
      year: 2013,
      wikidata_qid: null,
      tvmaze_id: 1,
      genres: ['Drama', 'Science-Fiction'],
      original_language: 'en',
      description: 'A dome.',
      description_source: 'tvmaze',
      sitelinks: 0,
    });
    expect(ScreenCandidateSchema.safeParse(out).success).toBe(true);
  });

  it('strips tags and decodes common entities', () => {
    expect(stripHtml('<p>Tom &amp; Jerry&#39;s <i>big</i>&nbsp;day</p>')).toBe("Tom & Jerry's big day");
  });
});

describe('ScreenCandidateSchema', () => {
  it('rejects an image hosted anywhere but Wikimedia or TVmaze', () => {
    const base = mergeTvmaze({ id: 2, name: 'X', premiered: null, summary: null }, null);
    expect(
      ScreenCandidateSchema.safeParse({ ...base, image_url: 'https://evil.example/pixel.gif' }).success
    ).toBe(false);
    expect(
      ScreenCandidateSchema.safeParse({ ...base, image_url: 'http://upload.wikimedia.org/a.jpg' }).success
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/server/__tests__/screen-metadata.test.ts`
Expected: FAIL — `fetchScreenMetadata` is not exported.

- [ ] **Step 3: Append the candidate section to `lib/server/screenEnrichment.ts`**

Add these imports to the existing import block at the top of the file (merge with the ones already there):

```ts
import { z } from 'zod';
import type { Db } from './db';
import {
  FULL_ENTITY_PROPS,
  entityLabel,
  isQid,
  tvmazeShow,
  wikidataEntities,
  wikipediaSummary,
  type CatalogResult,
  type Deadline,
  type TvmazeShow,
  type WikipediaSummary,
} from './screenCatalog';
```

Then append:

```ts
// --- Candidate record (spec §4.5) -------------------------------------------------------

export interface ScreenRef {
  qid: string;
  label: string | null;
}

export interface ScreenBasedOn {
  qid: string;
  title: string | null;
  author: string | null;
}

export interface ScreenCandidate {
  media_type: 'movie' | 'tv';
  title: string;
  year: number | null;
  wikidata_qid: string | null;
  tvmaze_id: number | null;
  image_url: string | null;
  description: string | null;
  description_source: 'wikipedia' | 'tvmaze' | null;
  description_url: string | null;
  wikipedia_page: string | null;
  genres: string[];
  directors: string[];
  creators: string[];
  writers: string[];
  countries: string[];
  /** ISO 639-1 code from the language item's P218, else its lower-cased label. */
  original_language: string | null;
  based_on: ScreenBasedOn[];
  main_subjects: string[];
  series: ScreenRef[];
  production_companies: ScreenRef[];
  sitelinks: number;
}

/** Hotlinked only (decision 8): nothing else may reach an <img src>. */
export const IMAGE_HOSTS = ['upload.wikimedia.org', 'static.tvmaze.com'] as const;
export const DESCRIPTION_HOSTS = ['en.wikipedia.org', 'www.tvmaze.com', 'tvmaze.com'] as const;

function allowedUrl(value: string | null | undefined, hosts: readonly string[]): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && hosts.includes(url.hostname) ? value : null;
  } catch {
    return null;
  }
}

function httpsUrlOn(hosts: readonly string[]) {
  return z
    .string()
    .max(2_000)
    .refine((value) => allowedUrl(value, hosts) !== null, `must be an https URL on ${hosts.join(', ')}`);
}

const labelText = z.string().max(300);
const labelList = z.array(labelText).max(50);
const refSchema = z.object({ qid: z.string().regex(/^Q\d+$/), label: labelText.nullable() });

export const ScreenCandidateSchema = z.object({
  media_type: z.enum(['movie', 'tv']),
  title: z.string().trim().min(1).max(500),
  year: z.number().int().min(1870).max(2100).nullable(),
  wikidata_qid: z.string().regex(/^Q\d+$/).nullable(),
  tvmaze_id: z.number().int().positive().nullable(),
  image_url: httpsUrlOn(IMAGE_HOSTS).nullable(),
  description: z.string().max(20_000).nullable(),
  description_source: z.enum(['wikipedia', 'tvmaze']).nullable(),
  description_url: httpsUrlOn(DESCRIPTION_HOSTS).nullable(),
  wikipedia_page: z.string().max(500).nullable(),
  genres: labelList,
  directors: labelList,
  creators: labelList,
  writers: labelList,
  countries: labelList,
  original_language: z.string().max(100).nullable(),
  based_on: z
    .array(
      z.object({
        qid: z.string().regex(/^Q\d+$/),
        title: labelText.nullable(),
        author: labelText.nullable(),
      })
    )
    .max(50),
  main_subjects: labelList,
  series: z.array(refSchema).max(50),
  production_companies: z.array(refSchema).max(50),
  sitelinks: z.number().int().min(0),
});

const PROP = {
  genre: 'P136',
  director: 'P57',
  screenwriter: 'P58',
  creator: 'P170',
  country: 'P495',
  language: 'P364',
  basedOn: 'P144',
  author: 'P50',
  mainSubject: 'P921',
  series: 'P179',
  company: 'P272',
  iso6391: 'P218',
  tvmaze: 'P8600',
} as const;

const LIST_CAP = 20;

const TVMAZE_LANGUAGES: Record<string, string> = {
  English: 'en',
  Japanese: 'ja',
  Korean: 'ko',
  Spanish: 'es',
  French: 'fr',
  German: 'de',
  Italian: 'it',
  Portuguese: 'pt',
  Russian: 'ru',
  Chinese: 'zh',
  Swedish: 'sv',
  Danish: 'da',
  Norwegian: 'no',
  Dutch: 'nl',
  Hindi: 'hi',
  Polish: 'pl',
  Turkish: 'tr',
};

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
  apos: "'",
  nbsp: ' ',
};

/** TVmaze summaries are HTML fragments (spec §4.5: "HTML stripped"). */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, name: string) => HTML_ENTITIES[name])
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueNonNull(values: Array<string | null>): string[] {
  return [...new Set(values.filter((v): v is string => typeof v === 'string' && v.length > 0))];
}

function candidateFromEntity(
  entity: WikidataEntity,
  labelOf: (qid: string) => string | null,
  heavy: ReadonlyMap<string, WikidataEntity>
): ScreenCandidate {
  const p31 = claimIds(entity, 'P31');
  const tvmazeId = firstInt(claimStrings(entity, PROP.tvmaze));
  // Decision 18: only a TV *series* with a TVmaze crosswalk is TV. Specials stay movies.
  const mediaType: 'movie' | 'tv' = isTvSeries(p31) && tvmazeId !== null ? 'tv' : 'movie';
  let years = claimYears(entity, 'P577');
  if (years.length === 0) years = claimYears(entity, 'P580');
  const labels = (property: string) =>
    uniqueNonNull(claimIds(entity, property).map(labelOf)).slice(0, LIST_CAP);
  const refs = (property: string) =>
    claimIds(entity, property)
      .slice(0, LIST_CAP)
      .map((qid) => ({ qid, label: labelOf(qid) }));
  const languageItem = claimIds(entity, PROP.language)
    .map((qid) => heavy.get(qid))
    .find((item): item is WikidataEntity => item !== undefined);
  return {
    media_type: mediaType,
    title: entityLabel(entity) ?? entity.id,
    year: years[0] ?? null,
    wikidata_qid: entity.id,
    tvmaze_id: mediaType === 'tv' ? tvmazeId : null,
    image_url: null,
    description: null,
    description_source: null,
    description_url: null,
    wikipedia_page: null,
    genres: labels(PROP.genre),
    directors: labels(PROP.director),
    creators: labels(PROP.creator),
    writers: labels(PROP.screenwriter),
    countries: labels(PROP.country),
    original_language: languageItem
      ? (claimStrings(languageItem, PROP.iso6391)[0] ??
        entityLabel(languageItem)?.toLowerCase() ??
        null)
      : null,
    based_on: claimIds(entity, PROP.basedOn)
      .slice(0, LIST_CAP)
      .map((qid) => {
        const source = heavy.get(qid);
        const authorId = source ? claimIds(source, PROP.author)[0] : undefined;
        return {
          qid,
          title: source ? entityLabel(source) : null,
          author: authorId ? labelOf(authorId) : null,
        };
      }),
    main_subjects: labels(PROP.mainSubject),
    series: refs(PROP.series),
    production_companies: refs(PROP.company),
    sitelinks: sitelinkCount(entity),
  };
}

function withWikipedia(
  candidate: ScreenCandidate,
  page: string | null,
  summary: WikipediaSummary | null
): ScreenCandidate {
  const extract =
    summary && summary.type !== 'disambiguation' ? summary.extract?.trim() || null : null;
  const articleUrl = page
    ? `https://en.wikipedia.org/wiki/${encodeURIComponent(page.replace(/ /g, '_'))}`
    : null;
  return {
    ...candidate,
    wikipedia_page: page,
    description: extract,
    description_source: extract ? 'wikipedia' : null,
    description_url: extract
      ? allowedUrl(summary?.content_urls?.desktop?.page, DESCRIPTION_HOSTS) ?? articleUrl
      : null,
    image_url: allowedUrl(summary?.thumbnail?.source, IMAGE_HOSTS),
  };
}

/** A TV candidate: TVmaze identity, title, summary and image; Wikidata metadata when crosswalked. */
export function mergeTvmaze(show: TvmazeShow, wikidata: ScreenCandidate | null): ScreenCandidate {
  const summary = stripHtml(show.summary ?? '');
  const premiered = show.premiered ? Number(show.premiered.slice(0, 4)) : NaN;
  const showUrl =
    allowedUrl(show.url, DESCRIPTION_HOSTS) ?? `https://www.tvmaze.com/shows/${show.id}`;
  return {
    media_type: 'tv',
    title: show.name,
    year: Number.isInteger(premiered) ? premiered : (wikidata?.year ?? null),
    wikidata_qid: wikidata?.wikidata_qid ?? null,
    tvmaze_id: show.id,
    image_url:
      allowedUrl(show.image?.medium ?? show.image?.original, IMAGE_HOSTS) ??
      wikidata?.image_url ??
      null,
    description: summary || wikidata?.description || null,
    description_source: summary ? 'tvmaze' : wikidata?.description ? wikidata.description_source : null,
    description_url: summary ? showUrl : wikidata?.description ? wikidata.description_url : null,
    wikipedia_page: wikidata?.wikipedia_page ?? null,
    genres:
      wikidata && wikidata.genres.length > 0 ? wikidata.genres : (show.genres ?? []).slice(0, LIST_CAP),
    directors: wikidata?.directors ?? [],
    creators: wikidata?.creators ?? [],
    writers: wikidata?.writers ?? [],
    countries: wikidata?.countries ?? [],
    original_language:
      wikidata?.original_language ?? (show.language ? (TVMAZE_LANGUAGES[show.language] ?? null) : null),
    based_on: wikidata?.based_on ?? [],
    main_subjects: wikidata?.main_subjects ?? [],
    series: wikidata?.series ?? [],
    production_companies: wikidata?.production_companies ?? [],
    sitelinks: wikidata?.sitelinks ?? 0,
  };
}

export interface MetadataOptions {
  /** Entities the caller already fetched with FULL_ENTITY_PROPS (not refetched). */
  entities?: ReadonlyMap<string, WikidataEntity>;
  /** The caller already holds the TVmaze show and will merge it itself. */
  skipTvmaze?: boolean;
}

const LABEL_PROPERTIES = [
  PROP.genre,
  PROP.director,
  PROP.screenwriter,
  PROP.creator,
  PROP.country,
  PROP.mainSubject,
  PROP.series,
  PROP.company,
];

export async function fetchScreenMetadata(
  db: Db,
  qids: readonly string[],
  deadline: Deadline,
  options: MetadataOptions = {}
): Promise<CatalogResult<Map<string, ScreenCandidate>>> {
  const wanted = [...new Set(qids)].filter(isQid).sort(compareQids);
  const entities = new Map<string, WikidataEntity>();
  const toFetch: string[] = [];
  for (const qid of wanted) {
    const preloaded = options.entities?.get(qid);
    if (preloaded) entities.set(qid, preloaded);
    else toFetch.push(qid);
  }
  const fetched = await wikidataEntities(db, toFetch, FULL_ENTITY_PROPS, deadline);
  if (fetched.kind !== 'ok') return fetched;
  for (const [qid, entity] of fetched.value) entities.set(qid, entity);

  // Hop 1: based-on sources (for their P50 author) and language items (for P218).
  const heavyIds = new Set<string>();
  for (const entity of entities.values()) {
    for (const qid of claimIds(entity, PROP.basedOn)) heavyIds.add(qid);
    for (const qid of claimIds(entity, PROP.language)) heavyIds.add(qid);
  }
  const heavy = await wikidataEntities(db, [...heavyIds], 'labels|claims', deadline);
  if (heavy.kind !== 'ok') return heavy;

  // Hop 2: labels for every other referenced item, plus the authors found in hop 1.
  const labelIds = new Set<string>();
  for (const entity of entities.values()) {
    for (const property of LABEL_PROPERTIES) {
      for (const qid of claimIds(entity, property)) labelIds.add(qid);
    }
  }
  for (const source of heavy.value.values()) {
    for (const qid of claimIds(source, PROP.author)) labelIds.add(qid);
  }
  for (const qid of heavy.value.keys()) labelIds.delete(qid);
  const labels = await wikidataEntities(db, [...labelIds], 'labels', deadline);
  if (labels.kind !== 'ok') return labels;
  const labelOf = (qid: string): string | null => {
    const item = labels.value.get(qid) ?? heavy.value.get(qid);
    return item ? entityLabel(item) : null;
  };

  const out = new Map<string, ScreenCandidate>();
  for (const qid of wanted) {
    const entity = entities.get(qid);
    if (!entity) continue; // deleted or merged on Wikidata; the caller decides
    const page = enwikiTitle(entity);
    let summary: WikipediaSummary | null = null;
    if (page) {
      const fetchedSummary = await wikipediaSummary(db, page, deadline);
      if (fetchedSummary.kind === 'retryable') return fetchedSummary;
      summary = fetchedSummary.kind === 'ok' ? fetchedSummary.value : null;
    }
    let candidate = withWikipedia(candidateFromEntity(entity, labelOf, heavy.value), page, summary);
    if (candidate.media_type === 'tv' && candidate.tvmaze_id !== null && !options.skipTvmaze) {
      const show = await tvmazeShow(db, candidate.tvmaze_id, deadline);
      if (show.kind === 'retryable') return show;
      if (show.kind === 'ok') candidate = mergeTvmaze(show.value, candidate);
    }
    out.set(qid, candidate);
  }
  return { kind: 'ok', value: out };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/server/__tests__/screen-metadata.test.ts lib/server/__tests__/screen-score.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/server/screenEnrichment.ts lib/server/__tests__/screen-metadata.test.ts
git commit -m "feat(screen): screen candidate metadata from Wikidata, Wikipedia and TVmaze (#96)"
```

---

### Task 7: Resolution orchestration (`resolveMovies`, `refreshMovies`, `resolveTv`, search)

**Files:**
- Modify: `lib/server/screenEnrichment.ts` (append)
- Test: `lib/server/__tests__/screen-resolve.test.ts`

**Interfaces:**
- Consumes: `scoreTitle`, `scoreCandidate` (Task 5); `fetchScreenMetadata`, `mergeTvmaze` (Task 6); Task 4 endpoints; `round4` from `lib/server/serialize.ts`.
- Produces (contract `resolveMovies` / `resolveTv`, plus), relied on by Tasks 8, 9, 11, 12, 14:
  - ```ts
    export type TitleResolution =
      | { kind: 'resolved'; label: ScreenLabel; method: ScreenMatchMethod; candidate: ScreenCandidate; raw: Record<string, unknown> }
      | { kind: 'unresolved'; raw: Record<string, unknown> }
      | { kind: 'refreshed'; candidate: ScreenCandidate | null }
      | { kind: 'deferred'; reason: string };
    ```
    `resolved` and `unresolved` are definite and persist; `refreshed` updates metadata for a fixed identity (`null` means the source no longer has the item: keep what is stored); `deferred` is never persisted.
  - `export interface MovieInput { id: number; title: string; year: number | null }`
  - `export interface FixedMovieInput { id: number; wikidataQid: string }`
  - `export interface TvInput { id: number; tvmazeId: number }`
  - `export const STAGE_A_NAMES_PER_QUERY = 120`, `STAGE_B_LIMIT = 10`, `SEARCH_LIMIT = 10`
  - `export function stageANames(titles: readonly string[]): string[]` and `export function stageAQuery(names: readonly string[]): string`
  - `export function crosswalkQuery(tvmazeIds: readonly number[]): string`
  - `export async function resolveMovies(db: Db, titles: readonly MovieInput[], deadline: Deadline): Promise<Map<number, TitleResolution>>`
  - `export async function refreshMovies(db: Db, titles: readonly FixedMovieInput[], deadline: Deadline): Promise<Map<number, TitleResolution>>`
  - `export async function resolveTv(db: Db, titles: readonly TvInput[], deadline: Deadline): Promise<Map<number, TitleResolution>>`
  - `export async function searchMovies(db: Db, query: string, deadline: Deadline): Promise<CatalogResult<ScreenCandidate[]>>`
  - `export async function searchShows(db: Db, query: string, deadline: Deadline): Promise<CatalogResult<ScreenCandidate[]>>`

Candidate lookup, in order (spec §4.3, ported from `resolve3.py`):

1. **Stage A** — one batched SPARQL query per 120 variant names: label or alias exactly equal to a variant, `@en` or `@mul`, restricted in the query to film or TV-program classes.
2. **`wbgetentities`** for every Stage A candidate, 50 per call, `en|mul`.
3. **Stage B** — `wbsearchentities` (limit 10) only for titles with no classified Stage A item in their exact year; then `wbgetentities` for the new ids.
4. **Score** each title (Task 5); then **one** `fetchScreenMetadata` call for all picks, reusing the fetched entities.

Deferral granularity: a Stage A or first entity-fetch failure defers the whole batch; a Stage B search failure defers only that title; a Stage B entity-fetch failure defers only the Stage B titles; a metadata failure defers every scored title. Titles decided before a failure keep their result.

- [ ] **Step 1: Write the failing test**

Create `lib/server/__tests__/screen-resolve.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db';
import {
  FULL_ENTITY_PROPS,
  WDQS_ENDPOINT,
  _setScreenCatalogHooksForTests,
  screenUrls,
  type Deadline,
  type WikidataEntity,
} from '../screenCatalog';
import {
  crosswalkQuery,
  resolveMovies,
  resolveTv,
  searchMovies,
  searchShows,
  stageANames,
  stageAQuery,
} from '../screenEnrichment';
import { installHttpReplay, type ReplayEntry } from './helpers/httpReplay';
import { replayKey } from './helpers/replayKey';
import { makeTestDb } from './helpers/pglite';

let db: Db;
let close: () => Promise<void>;
let restore: (() => void) | null = null;
let called: string[];
const plenty: Deadline = { remainingMs: () => 600_000 };

function replay(fixtures: Record<string, ReplayEntry>): void {
  restore = installHttpReplay(fixtures, (key) => called.push(key));
}

const sparqlKey = (query: string) =>
  replayKey(WDQS_ENDPOINT, { method: 'POST', body: screenUrls.sparqlBody(query) });

const stageAFixture = (titles: string[], hits: Array<[string, string]>): Record<string, ReplayEntry> => ({
  [sparqlKey(stageAQuery(stageANames(titles)))]: {
    status: 200,
    body: {
      results: {
        bindings: hits.map(([qid, name]) => ({
          q: { type: 'uri', value: `http://www.wikidata.org/entity/${qid}` },
          name: { type: 'literal', value: name, 'xml:lang': 'en' },
        })),
      },
    },
  },
});

function film(id: string, label: string, year: number, extra: Partial<WikidataEntity> = {}): WikidataEntity {
  return {
    id,
    labels: { en: { value: label } },
    claims: {
      P31: [{ mainsnak: { datavalue: { value: { id: 'Q11424' } } } }],
      P577: [{ mainsnak: { datavalue: { value: { time: `+${year}-01-01T00:00:00Z` } } } }],
    },
    sitelinks: {},
    ...extra,
  };
}

const entitiesFixture = (entities: WikidataEntity[]): Record<string, ReplayEntry> => ({
  [screenUrls.wikidataEntities(
    entities.map((e) => e.id),
    FULL_ENTITY_PROPS
  )]: { status: 200, body: { entities: Object.fromEntries(entities.map((e) => [e.id, e])) } },
});

beforeEach(async () => {
  ({ db, close } = await makeTestDb());
  called = [];
  _setScreenCatalogHooksForTests({ sleep: async () => undefined });
});

afterEach(async () => {
  restore?.();
  restore = null;
  _setScreenCatalogHooksForTests(null);
  await close();
});

describe('resolveMovies', () => {
  it('resolves through Stage A without calling search', async () => {
    replay({
      ...stageAFixture(['Her'], [['Q1', 'Her']]),
      ...entitiesFixture([film('Q1', 'Her', 2013)]),
    });
    const out = await resolveMovies(db, [{ id: 7, title: 'Her', year: 2013 }], plenty);
    expect(out.get(7)).toMatchObject({
      kind: 'resolved',
      label: 'HIGH',
      method: 'wikidata:exact',
      candidate: { wikidata_qid: 'Q1', media_type: 'movie', year: 2013 },
      raw: { stage: 'A' },
    });
    expect(called.some((key) => key.includes('wbsearchentities'))).toBe(false);
  });

  it('falls back to search when Stage A has no item in the exact year', async () => {
    replay({
      ...stageAFixture(['Suspiria'], [['Q2', 'Suspiria']]),
      ...entitiesFixture([film('Q2', 'Suspiria', 1977)]),
      [screenUrls.wikidataSearch('Suspiria', 10)]: { status: 200, body: { search: [{ id: 'Q3' }] } },
      ...entitiesFixture([film('Q3', 'Suspiria', 2018)]),
    });
    const out = await resolveMovies(db, [{ id: 8, title: 'Suspiria', year: 2018 }], plenty);
    expect(out.get(8)).toMatchObject({
      kind: 'resolved',
      label: 'HIGH',
      candidate: { wikidata_qid: 'Q3' },
      raw: { stage: 'B' },
    });
  });

  it('defers every title, and resolves none, when Stage A fails', async () => {
    replay({ [sparqlKey(stageAQuery(stageANames(['Her', 'Heat'])))]: { status: 503 } });
    const out = await resolveMovies(
      db,
      [
        { id: 1, title: 'Her', year: 2013 },
        { id: 2, title: 'Heat', year: 1995 },
      ],
      plenty
    );
    expect([...out.values()].map((r) => r.kind)).toEqual(['deferred', 'deferred']);
  });

  it('marks a definite no-match unresolved', async () => {
    replay({
      ...stageAFixture(['Qwxzv Untitled'], []),
      [screenUrls.wikidataSearch('Qwxzv Untitled', 10)]: { status: 200, body: { search: [] } },
    });
    const out = await resolveMovies(db, [{ id: 3, title: 'Qwxzv Untitled', year: 2031 }], plenty);
    expect(out.get(3)?.kind).toBe('unresolved');
  });

  it('marks an empty-normalized title unresolved without any request', async () => {
    replay({});
    const out = await resolveMovies(db, [{ id: 4, title: '!!!', year: 2001 }], plenty);
    expect(out.get(4)?.kind).toBe('unresolved');
    expect(called).toEqual([]);
  });

  it('defers only the title whose search failed', async () => {
    replay({
      ...stageAFixture(['Her', 'Zzz'], [['Q1', 'Her']]),
      ...entitiesFixture([film('Q1', 'Her', 2013)]),
      [screenUrls.wikidataSearch('Zzz', 10)]: { status: 503 },
    });
    const out = await resolveMovies(
      db,
      [
        { id: 1, title: 'Her', year: 2013 },
        { id: 2, title: 'Zzz', year: 2020 },
      ],
      plenty
    );
    expect(out.get(1)?.kind).toBe('resolved');
    expect(out.get(2)?.kind).toBe('deferred');
  });
});

describe('resolveTv', () => {
  const SEVERANCE = {
    id: 44933,
    name: 'Severance',
    url: 'https://www.tvmaze.com/shows/44933/severance',
    premiered: '2022-02-18',
    summary: '<p>Office workers.</p>',
    genres: ['Drama'],
    language: 'English',
    image: null,
  };

  it('refreshes a show from TVmaze and adds crosswalked Wikidata metadata', async () => {
    const wd: WikidataEntity = {
      id: 'Q97',
      labels: { en: { value: 'Severance' } },
      claims: {
        P31: [{ mainsnak: { datavalue: { value: { id: 'Q5398426' } } } }],
        P8600: [{ mainsnak: { datavalue: { value: '44933' } } }],
      },
      sitelinks: {},
    };
    replay({
      [screenUrls.tvmazeShow(44933)]: { status: 200, body: SEVERANCE },
      [sparqlKey(crosswalkQuery([44933]))]: {
        status: 200,
        body: {
          results: {
            bindings: [
              {
                s: { type: 'uri', value: 'http://www.wikidata.org/entity/Q97' },
                tvm: { type: 'literal', value: '44933' },
              },
            ],
          },
        },
      },
      ...entitiesFixture([wd]),
    });
    const out = await resolveTv(db, [{ id: 5, tvmazeId: 44933 }], plenty);
    expect(out.get(5)).toMatchObject({
      kind: 'refreshed',
      candidate: {
        media_type: 'tv',
        tvmaze_id: 44933,
        wikidata_qid: 'Q97',
        description: 'Office workers.',
      },
    });
  });

  it('keeps stored metadata (refreshed null) when TVmaze no longer has the show', async () => {
    replay({ [screenUrls.tvmazeShow(1)]: { status: 404 } });
    const out = await resolveTv(db, [{ id: 6, tvmazeId: 1 }], plenty);
    expect(out.get(6)).toEqual({ kind: 'refreshed', candidate: null });
  });

  it('defers a show when TVmaze fails', async () => {
    replay({ [screenUrls.tvmazeShow(2)]: { status: 503 } });
    const out = await resolveTv(db, [{ id: 7, tvmazeId: 2 }], plenty);
    expect(out.get(7)?.kind).toBe('deferred');
  });
});

describe('search', () => {
  it('ranks an exact title in the queried year first, then exact titles, then the rest', async () => {
    replay({
      ...stageAFixture(['Nosferatu'], [
        ['Q10', 'Nosferatu'],
        ['Q11', 'Nosferatu'],
      ]),
      [screenUrls.wikidataSearch('Nosferatu', 10)]: {
        status: 200,
        body: { search: [{ id: 'Q10' }, { id: 'Q12' }] },
      },
      ...entitiesFixture([
        film('Q10', 'Nosferatu', 1922),
        film('Q11', 'Nosferatu', 2024),
        film('Q12', 'Nosferatu the Vampyre', 1979),
      ]),
    });
    const out = await searchMovies(db, 'Nosferatu 2024', plenty);
    expect(out.kind === 'ok' && out.value.map((c) => c.wikidata_qid)).toEqual(['Q11', 'Q10', 'Q12']);
  });

  it('returns TVmaze shows, crosswalked where Wikidata knows them', async () => {
    replay({
      [screenUrls.tvmazeSearch('severance')]: {
        status: 200,
        body: [
          { score: 1, show: { id: 44933, name: 'Severance', premiered: '2022-02-18' } },
          { score: 0.5, show: { id: 5, name: 'Severance (UK)', premiered: '2006-01-01' } },
        ],
      },
      [sparqlKey(crosswalkQuery([44933, 5]))]: {
        status: 200,
        body: {
          results: {
            bindings: [
              {
                s: { type: 'uri', value: 'http://www.wikidata.org/entity/Q97' },
                tvm: { type: 'literal', value: '44933' },
              },
            ],
          },
        },
      },
      ...entitiesFixture([
        {
          id: 'Q97',
          labels: { en: { value: 'Severance' } },
          claims: { P31: [{ mainsnak: { datavalue: { value: { id: 'Q5398426' } } } }] },
          sitelinks: {},
        },
      ]),
    });
    const out = await searchShows(db, 'severance', plenty);
    expect(
      out.kind === 'ok' && out.value.map((c) => [c.tvmaze_id, c.wikidata_qid, c.media_type])
    ).toEqual([
      [44933, 'Q97', 'tv'],
      [5, null, 'tv'],
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/server/__tests__/screen-resolve.test.ts`
Expected: FAIL — `resolveMovies` is not exported.

- [ ] **Step 3: Append the orchestration to `lib/server/screenEnrichment.ts`**

Add to the imports at the top (merging with existing lines):

```ts
import { round4 } from './serialize';
import {
  qidFromUri,
  sparqlString,
  tvmazeSearch,
  wikidataSearch,
  wikidataSparql,
  type SparqlBinding,
} from './screenCatalog';
```

Then append:

```ts
// --- Resolution orchestration (spec §4.3 candidate lookup) ----------------------------

export const STAGE_A_NAMES_PER_QUERY = 120; // the spike's batch size
export const STAGE_B_LIMIT = 10;
export const SEARCH_LIMIT = 10;

export type TitleResolution =
  | {
      kind: 'resolved';
      label: ScreenLabel;
      method: ScreenMatchMethod;
      candidate: ScreenCandidate;
      raw: Record<string, unknown>;
    }
  | { kind: 'unresolved'; raw: Record<string, unknown> }
  | { kind: 'refreshed'; candidate: ScreenCandidate | null }
  | { kind: 'deferred'; reason: string };

export interface MovieInput {
  id: number;
  title: string;
  year: number | null;
}

export interface FixedMovieInput {
  id: number;
  wikidataQid: string;
}

export interface TvInput {
  id: number;
  tvmazeId: number;
}

function reasonOf(result: { kind: string; reason?: string }): string {
  return result.kind === 'retryable' ? (result.reason ?? 'retryable') : 'no answer';
}

/** Every variant of every title, de-duplicated, in first-seen order. */
export function stageANames(titles: readonly string[]): string[] {
  return [...new Set(titles.flatMap((title) => titleVariants(title)))];
}

/** The spike's measured Stage A query (cold.py), with ?name returned for the join. */
export function stageAQuery(names: readonly string[]): string {
  const values = names
    .flatMap((name) => [`${sparqlString(name)}@en`, `${sparqlString(name)}@mul`])
    .join(' ');
  return (
    `SELECT DISTINCT ?q ?name WHERE { VALUES ?name { ${values} } ` +
    '{ ?q rdfs:label ?name } UNION { ?q skos:altLabel ?name } ' +
    '?q wdt:P31 ?c . { ?c wdt:P279* wd:Q11424 } UNION { ?c wdt:P279* wd:Q15416 } }'
  );
}

/** TVmaze id -> Wikidata item through P8600 (§2.1 finding 4). */
export function crosswalkQuery(tvmazeIds: readonly number[]): string {
  const values = [...new Set(tvmazeIds)]
    .sort((a, b) => a - b)
    .map((id) => sparqlString(String(id)))
    .join(' ');
  return `SELECT ?s ?tvm WHERE { VALUES ?tvm { ${values} } ?s wdt:P8600 ?tvm . }`;
}

function crosswalkMap(bindings: readonly SparqlBinding[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const row of bindings) {
    const tvmazeId = Number(row.tvm?.value);
    const qid = row.s ? qidFromUri(row.s.value) : null;
    if (!Number.isInteger(tvmazeId) || !qid) continue;
    const existing = out.get(tvmazeId);
    if (!existing || compareQids(qid, existing) < 0) out.set(tvmazeId, qid);
  }
  return out;
}

async function stageA(
  db: Db,
  titles: readonly string[],
  deadline: Deadline
): Promise<CatalogResult<Map<string, Set<string>>>> {
  const names = stageANames(titles);
  const exact = new Map<string, Set<string>>();
  for (let i = 0; i < names.length; i += STAGE_A_NAMES_PER_QUERY) {
    const rows = await wikidataSparql(
      db,
      stageAQuery(names.slice(i, i + STAGE_A_NAMES_PER_QUERY)),
      deadline
    );
    if (rows.kind !== 'ok') return rows;
    for (const row of rows.value) {
      const qid = row.q ? qidFromUri(row.q.value) : null;
      const key = screenNormalize(row.name?.value);
      if (!qid || !key) continue;
      const set = exact.get(key) ?? new Set<string>();
      set.add(qid);
      exact.set(key, set);
    }
  }
  return { kind: 'ok', value: exact };
}

function stageACandidates(title: string, exact: ReadonlyMap<string, Set<string>>): Set<string> {
  const out = new Set<string>();
  for (const variant of titleVariants(title)) {
    for (const qid of exact.get(screenNormalize(variant)) ?? []) out.add(qid);
  }
  return out;
}

/** Spike resolve3.py#has_exact_year: a classified candidate dated in the title's year. */
function hasExactYearItem(
  year: number | null,
  qids: ReadonlySet<string>,
  entities: ReadonlyMap<string, WikidataEntity>
): boolean {
  if (year === null) return false;
  for (const qid of qids) {
    const entity = entities.get(qid);
    if (!entity || !classifyP31(claimIds(entity, 'P31'))) continue;
    if (claimYears(entity, 'P577').includes(year) || claimYears(entity, 'P580').includes(year)) {
      return true;
    }
  }
  return false;
}

/** The trimmed raw payload stored on title_enrichment (spec §3.3). */
function rawFor(score: TitleScore, stage: 'A' | 'B'): Record<string, unknown> {
  const brief = (c: ScoredCandidate) => ({
    qid: c.qid,
    kind: c.kind,
    similarity: round4(c.similarity),
    years: c.years,
    sitelinks: c.sitelinks,
  });
  return {
    stage,
    label: score.label,
    method: score.method,
    pick: score.pick ? brief(score.pick) : null,
    top: score.top.map(brief),
  };
}

export async function resolveMovies(
  db: Db,
  titles: readonly MovieInput[],
  deadline: Deadline
): Promise<Map<number, TitleResolution>> {
  const results = new Map<number, TitleResolution>();
  const deferAll = (list: readonly MovieInput[], reason: string) => {
    for (const title of list) {
      if (!results.has(title.id)) results.set(title.id, { kind: 'deferred', reason });
    }
    return results;
  };

  const work = titles.filter((title) => {
    if (screenNormalize(title.title)) return true;
    results.set(title.id, { kind: 'unresolved', raw: { reason: 'empty normalized title' } });
    return false;
  });
  if (work.length === 0) return results;

  const exact = await stageA(
    db,
    work.map((title) => title.title),
    deadline
  );
  if (exact.kind !== 'ok') return deferAll(work, reasonOf(exact));

  const candidates = new Map(work.map((t) => [t.id, stageACandidates(t.title, exact.value)]));
  const entities = new Map<string, WikidataEntity>();
  const firstFetch = await wikidataEntities(
    db,
    [...new Set([...candidates.values()].flatMap((set) => [...set]))],
    FULL_ENTITY_PROPS,
    deadline
  );
  if (firstFetch.kind !== 'ok') return deferAll(work, reasonOf(firstFetch));
  for (const [qid, entity] of firstFetch.value) entities.set(qid, entity);

  // Stage B: only titles with no Stage A item in their exact year (10 of 562 in the spike).
  const stageB = work.filter((t) => !hasExactYearItem(t.year, candidates.get(t.id)!, entities));
  const searchedIds = new Set<string>();
  for (const title of stageB) {
    const hits = await wikidataSearch(db, title.title, STAGE_B_LIMIT, deadline);
    if (hits.kind !== 'ok') {
      results.set(title.id, { kind: 'deferred', reason: reasonOf(hits) });
      continue;
    }
    for (const qid of hits.value) {
      candidates.get(title.id)!.add(qid);
      if (!entities.has(qid)) searchedIds.add(qid);
    }
  }
  if (searchedIds.size > 0) {
    const more = await wikidataEntities(db, [...searchedIds], FULL_ENTITY_PROPS, deadline);
    if (more.kind !== 'ok') deferAll(stageB, reasonOf(more));
    else for (const [qid, entity] of more.value) entities.set(qid, entity);
  }

  const stageBIds = new Set(stageB.map((title) => title.id));
  const scores = new Map<number, TitleScore>();
  for (const title of work) {
    if (results.has(title.id)) continue;
    const scoredEntities = [...candidates.get(title.id)!]
      .map((qid) => entities.get(qid))
      .filter((entity): entity is WikidataEntity => entity !== undefined);
    const score = scoreTitle(title.title, title.year, scoredEntities);
    const stage = stageBIds.has(title.id) ? 'B' : 'A';
    if (score.label === 'UNRESOLVED' || !score.pick) {
      results.set(title.id, { kind: 'unresolved', raw: rawFor(score, stage) });
    } else {
      scores.set(title.id, score);
    }
  }
  if (scores.size === 0) return results;

  const meta = await fetchScreenMetadata(
    db,
    [...scores.values()].map((score) => score.pick!.qid),
    deadline,
    { entities }
  );
  for (const [id, score] of scores) {
    if (meta.kind !== 'ok') {
      results.set(id, { kind: 'deferred', reason: reasonOf(meta) });
      continue;
    }
    const candidate = meta.value.get(score.pick!.qid);
    results.set(
      id,
      candidate
        ? {
            kind: 'resolved',
            label: score.label as ScreenLabel,
            method: score.method,
            candidate,
            raw: rawFor(score, stageBIds.has(id) ? 'B' : 'A'),
          }
        : { kind: 'deferred', reason: `no metadata for ${score.pick!.qid}` }
    );
  }
  return results;
}

/** Force re-run for a manual or corrected movie: metadata only, identity untouched (§4.4). */
export async function refreshMovies(
  db: Db,
  titles: readonly FixedMovieInput[],
  deadline: Deadline
): Promise<Map<number, TitleResolution>> {
  const results = new Map<number, TitleResolution>();
  if (titles.length === 0) return results;
  const meta = await fetchScreenMetadata(
    db,
    titles.map((title) => title.wikidataQid),
    deadline
  );
  for (const title of titles) {
    results.set(
      title.id,
      meta.kind === 'ok'
        ? { kind: 'refreshed', candidate: meta.value.get(title.wikidataQid) ?? null }
        : { kind: 'deferred', reason: reasonOf(meta) }
    );
  }
  return results;
}

/** TV identity is the TVmaze id (§4.4): refresh from TVmaze, add Wikidata via the crosswalk. */
export async function resolveTv(
  db: Db,
  titles: readonly TvInput[],
  deadline: Deadline
): Promise<Map<number, TitleResolution>> {
  const results = new Map<number, TitleResolution>();
  const shows = new Map<number, TvmazeShow>();
  for (const title of titles) {
    const show = await tvmazeShow(db, title.tvmazeId, deadline);
    if (show.kind === 'retryable') results.set(title.id, { kind: 'deferred', reason: show.reason });
    else if (show.kind === 'empty') results.set(title.id, { kind: 'refreshed', candidate: null });
    else shows.set(title.id, show.value);
  }
  if (shows.size === 0) return results;

  const crosswalk = await wikidataSparql(
    db,
    crosswalkQuery([...shows.values()].map((show) => show.id)),
    deadline
  );
  if (crosswalk.kind !== 'ok') {
    for (const id of shows.keys()) results.set(id, { kind: 'deferred', reason: reasonOf(crosswalk) });
    return results;
  }
  const qidByShow = crosswalkMap(crosswalk.value);
  const meta = await fetchScreenMetadata(db, [...qidByShow.values()], deadline, { skipTvmaze: true });
  for (const [id, show] of shows) {
    if (meta.kind !== 'ok') {
      results.set(id, { kind: 'deferred', reason: reasonOf(meta) });
      continue;
    }
    const qid = qidByShow.get(show.id);
    results.set(id, {
      kind: 'refreshed',
      candidate: mergeTvmaze(show, qid ? (meta.value.get(qid) ?? null) : null),
    });
  }
  return results;
}

const QUERY_YEAR = /^(.*\S)\s+\(?((?:18|19|20)\d{2})\)?$/;

/**
 * Manual-add movie search. Stage A (exact label) is unioned with wbsearchentities,
 * because short common titles never reach search's top results (§2.1 finding 2b).
 * Films only. Ranked: exact title in the queried year, exact title, then popularity.
 */
export async function searchMovies(
  db: Db,
  query: string,
  deadline: Deadline
): Promise<CatalogResult<ScreenCandidate[]>> {
  const trimmed = query.trim();
  const match = QUERY_YEAR.exec(trimmed);
  const title = match ? match[1] : trimmed;
  const year = match ? Number(match[2]) : null;
  const normalized = screenNormalize(title);
  if (!normalized) return { kind: 'ok', value: [] };

  const exact = await stageA(db, [title], deadline);
  if (exact.kind !== 'ok') return exact;
  const hits = await wikidataSearch(db, title, STAGE_B_LIMIT, deadline);
  if (hits.kind !== 'ok') return hits;
  const ids = new Set([...stageACandidates(title, exact.value), ...hits.value]);
  const entities = await wikidataEntities(db, [...ids], FULL_ENTITY_PROPS, deadline);
  if (entities.kind !== 'ok') return entities;

  const variants = new Set(titleVariants(title).map(screenNormalize).filter(Boolean));
  const ranked = [...entities.value.values()]
    .map((entity) => scoreCandidate(normalized, variants, year, entity))
    .filter((c): c is ScoredCandidate => c !== null && c.kind === 'film')
    .sort(
      (a, b) =>
        Number(b.exact && b.yearExact) - Number(a.exact && a.yearExact) ||
        Number(b.exact) - Number(a.exact) ||
        b.sitelinks - a.sitelinks ||
        compareQids(a.qid, b.qid)
    )
    .slice(0, SEARCH_LIMIT);

  const meta = await fetchScreenMetadata(
    db,
    ranked.map((c) => c.qid),
    deadline,
    { entities: entities.value }
  );
  if (meta.kind !== 'ok') return meta;
  return {
    kind: 'ok',
    value: ranked
      .map((c) => meta.value.get(c.qid))
      .filter((c): c is ScreenCandidate => c !== undefined),
  };
}

/** Manual-add TV search: TVmaze search, crosswalked to Wikidata where possible. */
export async function searchShows(
  db: Db,
  query: string,
  deadline: Deadline
): Promise<CatalogResult<ScreenCandidate[]>> {
  const hits = await tvmazeSearch(db, query.trim(), deadline);
  if (hits.kind !== 'ok') return hits;
  const shows = hits.value.slice(0, SEARCH_LIMIT);
  if (shows.length === 0) return { kind: 'ok', value: [] };
  const crosswalk = await wikidataSparql(
    db,
    crosswalkQuery(shows.map((show) => show.id)),
    deadline
  );
  if (crosswalk.kind !== 'ok') return crosswalk;
  const qidByShow = crosswalkMap(crosswalk.value);
  const meta = await fetchScreenMetadata(db, [...qidByShow.values()], deadline, { skipTvmaze: true });
  if (meta.kind !== 'ok') return meta;
  return {
    kind: 'ok',
    value: shows.map((show) => {
      const qid = qidByShow.get(show.id);
      return mergeTvmaze(show, qid ? (meta.value.get(qid) ?? null) : null);
    }),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/server/__tests__/screen-resolve.test.ts lib/server/__tests__/screen-metadata.test.ts lib/server/__tests__/screen-score.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation check (load-bearing: a retryable failure never becomes unresolved)**

In `resolveMovies`, change `if (exact.kind !== 'ok') return deferAll(work, reasonOf(exact));` to `if (exact.kind !== 'ok') return new Map(work.map((t) => [t.id, { kind: 'unresolved', raw: {} } as TitleResolution]));`. Run the file. Expected: FAIL in `defers every title, and resolves none, when Stage A fails`. Restore; re-run: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/server/screenEnrichment.ts lib/server/__tests__/screen-resolve.test.ts
git commit -m "feat(screen): Stage A/B movie resolution, TV crosswalk and catalog search (#96)"
```

---

### Task 8: Persisting a resolution (`persistTitleResolution`)

**Files:**
- Modify: `lib/server/screenEnrichment.ts` (append)
- Test: `lib/server/__tests__/screen-persist.test.ts`

**Interfaces:**
- Consumes: `TitleResolution`, `ScreenCandidate` (Tasks 6–7); `titles`, `titleEnrichment` from `lib/server/schema.ts` (wave 4); `serializeResolutionConfidence`, `utcnowTs` from `lib/server/serialize.ts`.
- Produces (contract `persistTitleResolution`, plus), relied on by Tasks 9, 11, 12 and wave 7 (accepting a recommendation writes a candidate the same way):
  - `export async function persistTitleResolution(tx: Db | DbTx, titleId: number, resolution: TitleResolution): Promise<void>` — throws on `deferred`.
  - `export function candidateEnrichmentValues(candidate: ScreenCandidate)` — the `title_enrichment` metadata columns for a candidate (no label, identity or timestamp fields).
  - `export async function findIdentityClash(tx: Db | DbTx, userId: string, titleId: number, qid: string | null, tvmazeId: number | null): Promise<{ id: number; title: string } | null>`

Rules (spec §4.4, decision 18, design decisions 7–9):

| Resolution | `titles` | `title_enrichment` |
|---|---|---|
| resolved HIGH/MEDIUM, no clash | `media_type`, `wikidata_qid`, `tvmaze_id` (TV only) set from the candidate; `updated_at` bumped | candidate metadata, label, confidence, method, `identity_source = 'auto'`, raw |
| resolved HIGH/MEDIUM, clash | an old auto `wikidata_qid` cleared; nothing else | as above plus `duplicate_of_title_id` = the holder |
| resolved LOW | an old auto `wikidata_qid` cleared | candidate metadata, `LOW`, raw (the LOW pick's QID lives only here) |
| unresolved | an old auto `wikidata_qid` cleared | metadata nulled, `LOW`, confidence 0, `unresolved` (the book shape, `enrichment.ts:149-155`) |
| refreshed | untouched | metadata replaced (or only `resolved_at` when the candidate is `null`); label, identity source and confidence kept |
| any, when the stored row is `manual` or `corrected` and the resolution is not `refreshed` | untouched | untouched — the user's pick wins; a correction already stamped `resolved_at`, so the job counts the title as processed |
| any, title deleted | — | nothing (no FK error) |

`feedback_updated_at` is never touched by enrichment: wave 6 detects metadata changes through `title_enrichment.resolved_at` (spec §5.5).

- [ ] **Step 1: Write the failing test**

Create `lib/server/__tests__/screen-persist.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db';
import { titleEnrichment, titles } from '../schema';
import {
  mergeTvmaze,
  persistTitleResolution,
  type ScreenCandidate,
  type TitleResolution,
} from '../screenEnrichment';
import { makeTestDb } from './helpers/pglite';

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await makeTestDb());
});

afterEach(async () => {
  await close();
});

async function addTitle(
  values: Partial<typeof titles.$inferInsert> & { title: string }
): Promise<number> {
  const [row] = await db
    .insert(titles)
    .values({ userId: 'user-a', mediaType: 'movie', status: 'watched', year: 2000, ...values })
    .returning({ id: titles.id });
  return row.id;
}

const movie = (qid: string, overrides: Partial<ScreenCandidate> = {}): ScreenCandidate => ({
  ...mergeTvmaze({ id: 1, name: 'x' }, null),
  media_type: 'movie',
  title: `Film ${qid}`,
  year: 2000,
  wikidata_qid: qid,
  tvmaze_id: null,
  description: 'A film.',
  description_source: 'wikipedia',
  description_url: 'https://en.wikipedia.org/wiki/X',
  genres: ['drama film'],
  sitelinks: 12,
  ...overrides,
});

const resolved = (
  candidate: ScreenCandidate,
  label: 'HIGH' | 'MEDIUM' | 'LOW' = 'HIGH'
): TitleResolution => ({
  kind: 'resolved',
  label,
  method: label === 'LOW' ? 'wikidata:ambiguous' : 'wikidata:exact',
  candidate,
  raw: { stage: 'A' },
});

async function titleRow(id: number) {
  return (await db.select().from(titles).where(eq(titles.id, id)))[0];
}

async function enrichmentRow(id: number) {
  return (await db.select().from(titleEnrichment).where(eq(titleEnrichment.titleId, id)))[0];
}

describe('persistTitleResolution', () => {
  it('sets the movie identity and metadata for HIGH, and never touches feedback_updated_at', async () => {
    const id = await addTitle({ title: 'Heat' });
    await persistTitleResolution(db, id, resolved(movie('Q1')));
    expect(await titleRow(id)).toMatchObject({
      mediaType: 'movie',
      wikidataQid: 'Q1',
      tvmazeId: null,
      feedbackUpdatedAt: null,
    });
    expect(await enrichmentRow(id)).toMatchObject({
      wikidataQid: 'Q1',
      confidenceLabel: 'HIGH',
      resolutionConfidence: 0.95,
      matchMethod: 'wikidata:exact',
      identitySource: 'auto',
      duplicateOfTitleId: null,
      genres: ['drama film'],
      sitelinks: 12,
      descriptionSource: 'wikipedia',
    });
  });

  it('sets identity for MEDIUM too', async () => {
    const id = await addTitle({ title: 'Heat' });
    await persistTitleResolution(db, id, resolved(movie('Q1'), 'MEDIUM'));
    expect((await titleRow(id)).wikidataQid).toBe('Q1');
    expect((await enrichmentRow(id)).resolutionConfidence).toBe(0.7);
  });

  it('keeps a LOW pick out of titles, storing it only on the enrichment row', async () => {
    const id = await addTitle({ title: 'Heat' });
    await persistTitleResolution(db, id, resolved(movie('Q1'), 'LOW'));
    expect((await titleRow(id)).wikidataQid).toBeNull();
    expect(await enrichmentRow(id)).toMatchObject({ wikidataQid: 'Q1', confidenceLabel: 'LOW' });
  });

  it('converts a Letterboxd TV entry that resolved to a crosswalked series', async () => {
    const id = await addTitle({ title: 'Tiger King' });
    await persistTitleResolution(
      db,
      id,
      resolved(movie('Q800', { media_type: 'tv', tvmaze_id: 46519 }))
    );
    expect(await titleRow(id)).toMatchObject({
      mediaType: 'tv',
      tvmazeId: 46519,
      wikidataQid: 'Q800',
    });
  });

  it('keeps a TV special a movie', async () => {
    const id = await addTitle({ title: 'Frosty Returns' });
    await persistTitleResolution(db, id, resolved(movie('Q900')));
    expect((await titleRow(id)).mediaType).toBe('movie');
  });

  it('records a movie clash as duplicate_of_title_id instead of violating the unique index', async () => {
    const holder = await addTitle({ title: 'Heat', wikidataQid: 'Q1' });
    const id = await addTitle({ title: 'Heat (1995)' });
    await persistTitleResolution(db, id, resolved(movie('Q1')));
    expect((await titleRow(id)).wikidataQid).toBeNull();
    expect((await enrichmentRow(id)).duplicateOfTitleId).toBe(holder);
  });

  it('records a TV clash when a manually added show already holds the TVmaze id', async () => {
    const holder = await addTitle({ title: 'Tiger King', mediaType: 'tv', tvmazeId: 46519 });
    const id = await addTitle({ title: 'Tiger King' });
    await persistTitleResolution(
      db,
      id,
      resolved(movie('Q800', { media_type: 'tv', tvmaze_id: 46519 }))
    );
    expect(await titleRow(id)).toMatchObject({ mediaType: 'movie', tvmazeId: null });
    expect((await enrichmentRow(id)).duplicateOfTitleId).toBe(holder);
  });

  it('only clashes within the same user', async () => {
    await db.insert(titles).values({
      userId: 'user-b',
      mediaType: 'movie',
      status: 'watched',
      title: 'Heat',
      wikidataQid: 'Q1',
    });
    const id = await addTitle({ title: 'Heat' });
    await persistTitleResolution(db, id, resolved(movie('Q1')));
    expect((await titleRow(id)).wikidataQid).toBe('Q1');
  });

  it('persists a definite no-match in the book unresolved shape and clears an old auto identity', async () => {
    const id = await addTitle({ title: 'Heat', wikidataQid: 'Q1' });
    await persistTitleResolution(db, id, { kind: 'unresolved', raw: { stage: 'B' } });
    expect((await titleRow(id)).wikidataQid).toBeNull();
    expect(await enrichmentRow(id)).toMatchObject({
      confidenceLabel: 'LOW',
      resolutionConfidence: 0,
      matchMethod: 'unresolved',
      wikidataQid: null,
      description: null,
    });
  });

  it('never overwrites a manual or corrected identity with an automatic one', async () => {
    const id = await addTitle({ title: 'Heat', wikidataQid: 'Q5' });
    await db.insert(titleEnrichment).values({
      titleId: id,
      wikidataQid: 'Q5',
      resolutionConfidence: 1,
      confidenceLabel: 'CORRECTED',
      matchMethod: 'user_correction',
      identitySource: 'corrected',
      resolvedAt: '2026-09-20 00:00:00',
    });
    await persistTitleResolution(db, id, resolved(movie('Q6')));
    await persistTitleResolution(db, id, { kind: 'unresolved', raw: {} });
    expect((await titleRow(id)).wikidataQid).toBe('Q5');
    expect(await enrichmentRow(id)).toMatchObject({
      wikidataQid: 'Q5',
      confidenceLabel: 'CORRECTED',
      identitySource: 'corrected',
    });
  });

  it('refreshes metadata for a fixed identity and keeps its label and source', async () => {
    const id = await addTitle({ title: 'Heat', wikidataQid: 'Q5' });
    await db.insert(titleEnrichment).values({
      titleId: id,
      wikidataQid: 'Q5',
      resolutionConfidence: 0.95,
      confidenceLabel: 'HIGH',
      matchMethod: 'manual',
      identitySource: 'manual',
      resolvedAt: '2026-09-20 00:00:00',
    });
    await persistTitleResolution(db, id, {
      kind: 'refreshed',
      candidate: movie('Q5', { genres: ['crime film'] }),
    });
    const row = await enrichmentRow(id);
    expect(row).toMatchObject({
      genres: ['crime film'],
      confidenceLabel: 'HIGH',
      identitySource: 'manual',
      matchMethod: 'manual',
    });
    expect(row.resolvedAt > '2026-09-20 00:00:00').toBe(true);
  });

  it('only advances resolved_at for a refresh whose source item vanished', async () => {
    const id = await addTitle({ title: 'Show', mediaType: 'tv', tvmazeId: 9 });
    await db.insert(titleEnrichment).values({
      titleId: id,
      tvmazeId: 9,
      description: 'kept',
      resolutionConfidence: 0.95,
      confidenceLabel: 'HIGH',
      identitySource: 'manual',
      resolvedAt: '2026-09-20 00:00:00',
    });
    await persistTitleResolution(db, id, { kind: 'refreshed', candidate: null });
    const row = await enrichmentRow(id);
    expect(row.description).toBe('kept');
    expect(row.resolvedAt > '2026-09-20 00:00:00').toBe(true);
  });

  it('skips a title that was deleted after its batch was read', async () => {
    await expect(persistTitleResolution(db, 999, resolved(movie('Q1')))).resolves.toBeUndefined();
    expect(await db.select().from(titleEnrichment)).toEqual([]);
  });

  it('refuses to persist a deferred resolution', async () => {
    const id = await addTitle({ title: 'Heat' });
    await expect(
      persistTitleResolution(db, id, { kind: 'deferred', reason: 'HTTP 503' })
    ).rejects.toThrow(/deferred/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/server/__tests__/screen-persist.test.ts`
Expected: FAIL — `persistTitleResolution` is not exported.

- [ ] **Step 3: Append persistence to `lib/server/screenEnrichment.ts`**

Add to the imports (merging with existing lines):

```ts
import { and, asc, eq, ne, or } from 'drizzle-orm';
import type { DbTx } from './db';
import { titleEnrichment, titles } from './schema';
import { serializeResolutionConfidence, utcnowTs } from './serialize';
```

Then append:

```ts
// --- Persistence (spec §4.4) ------------------------------------------------------------

/** The title_enrichment metadata columns for a candidate: no label, identity or timestamp. */
export function candidateEnrichmentValues(candidate: ScreenCandidate) {
  return {
    wikidataQid: candidate.wikidata_qid,
    tvmazeId: candidate.tvmaze_id,
    wikipediaPage: candidate.wikipedia_page,
    genres: candidate.genres,
    directors: candidate.directors,
    creators: candidate.creators,
    writers: candidate.writers,
    countries: candidate.countries,
    originalLanguage: candidate.original_language,
    basedOn: candidate.based_on,
    mainSubjects: candidate.main_subjects,
    series: candidate.series,
    productionCompanies: candidate.production_companies,
    sitelinks: candidate.sitelinks,
    description: candidate.description,
    descriptionSource: candidate.description_source,
    descriptionUrl: candidate.description_url,
    imageUrl: candidate.image_url,
  };
}

const EMPTY_METADATA: ReturnType<typeof candidateEnrichmentValues> = {
  wikidataQid: null,
  tvmazeId: null,
  wikipediaPage: null,
  genres: [],
  directors: [],
  creators: [],
  writers: [],
  countries: [],
  originalLanguage: null,
  basedOn: [],
  mainSubjects: [],
  series: [],
  productionCompanies: [],
  sitelinks: 0,
  description: null,
  descriptionSource: null,
  descriptionUrl: null,
  imageUrl: null,
};

type EnrichmentWrite = Omit<typeof titleEnrichment.$inferInsert, 'id' | 'titleId'>;

async function upsertTitleEnrichment(
  tx: Db | DbTx,
  titleId: number,
  values: EnrichmentWrite
): Promise<void> {
  await tx
    .insert(titleEnrichment)
    .values({ titleId, ...values })
    .onConflictDoUpdate({ target: titleEnrichment.titleId, set: values });
}

/** Another title of the same user already holding this QID or TVmaze id, lowest id first. */
export async function findIdentityClash(
  tx: Db | DbTx,
  userId: string,
  titleId: number,
  qid: string | null,
  tvmazeId: number | null
): Promise<{ id: number; title: string } | null> {
  const matches = [];
  if (qid) matches.push(eq(titles.wikidataQid, qid));
  if (tvmazeId !== null) matches.push(eq(titles.tvmazeId, tvmazeId));
  if (matches.length === 0) return null;
  const rows = await tx
    .select({ id: titles.id, title: titles.title })
    .from(titles)
    .where(and(eq(titles.userId, userId), ne(titles.id, titleId), or(...matches)))
    .orderBy(asc(titles.id))
    .limit(1);
  return rows[0] ?? null;
}

export async function persistTitleResolution(
  tx: Db | DbTx,
  titleId: number,
  resolution: TitleResolution
): Promise<void> {
  if (resolution.kind === 'deferred') {
    throw new Error(`a deferred resolution must never be persisted (title ${titleId})`);
  }
  const [title] = await tx.select().from(titles).where(eq(titles.id, titleId));
  if (!title) return; // deleted after its batch was read
  const [existing] = await tx
    .select()
    .from(titleEnrichment)
    .where(eq(titleEnrichment.titleId, titleId));
  const now = utcnowTs();

  if (resolution.kind === 'refreshed') {
    if (!existing) {
      await upsertTitleEnrichment(tx, titleId, {
        ...(resolution.candidate ? candidateEnrichmentValues(resolution.candidate) : EMPTY_METADATA),
        resolutionConfidence: serializeResolutionConfidence(resolution.candidate ? 'HIGH' : 'NONE'),
        confidenceLabel: resolution.candidate ? 'HIGH' : 'LOW',
        matchMethod: 'refresh',
        identitySource: 'auto',
        duplicateOfTitleId: null,
        rawResponse: null,
        resolvedAt: now,
      });
      return;
    }
    await tx
      .update(titleEnrichment)
      .set(
        resolution.candidate
          ? { ...candidateEnrichmentValues(resolution.candidate), resolvedAt: now }
          : { resolvedAt: now }
      )
      .where(eq(titleEnrichment.titleId, titleId));
    return;
  }

  // Forced re-runs never change a manual or corrected identity (§4.4). A correction
  // stamps resolved_at itself, so the running job already counts this title as done.
  if (existing && (existing.identitySource === 'manual' || existing.identitySource === 'corrected')) {
    return;
  }

  const clearAutoIdentity = async () => {
    if (title.wikidataQid !== null) {
      await tx
        .update(titles)
        .set({ wikidataQid: null, updatedAt: now })
        .where(eq(titles.id, titleId));
    }
  };

  if (resolution.kind === 'unresolved') {
    await clearAutoIdentity();
    await upsertTitleEnrichment(tx, titleId, {
      ...EMPTY_METADATA,
      resolutionConfidence: serializeResolutionConfidence('NONE'),
      confidenceLabel: 'LOW',
      matchMethod: 'unresolved',
      identitySource: 'auto',
      duplicateOfTitleId: null,
      rawResponse: resolution.raw,
      resolvedAt: now,
    });
    return;
  }

  const { candidate, label } = resolution;
  let duplicateOf: number | null = null;
  if (label === 'HIGH' || label === 'MEDIUM') {
    const tvmazeId = candidate.media_type === 'tv' ? candidate.tvmaze_id : null;
    const clash = await findIdentityClash(tx, title.userId, titleId, candidate.wikidata_qid, tvmazeId);
    if (clash) {
      duplicateOf = clash.id; // nothing merges silently; the unique indexes hold
      await clearAutoIdentity();
    } else {
      await tx
        .update(titles)
        .set({
          mediaType: candidate.media_type,
          wikidataQid: candidate.wikidata_qid,
          tvmazeId,
          updatedAt: now,
        })
        .where(eq(titles.id, titleId));
    }
  } else {
    await clearAutoIdentity();
  }

  await upsertTitleEnrichment(tx, titleId, {
    ...candidateEnrichmentValues(candidate),
    resolutionConfidence: serializeResolutionConfidence(label),
    confidenceLabel: label,
    matchMethod: resolution.method,
    identitySource: 'auto',
    duplicateOfTitleId: duplicateOf,
    rawResponse: resolution.raw,
    resolvedAt: now,
  });
}
```

If type-check rejects a field in `EnrichmentWrite` (for example because wave 4 typed `sitelinks` as nullable, or declared a JSON column with a `$type`), adjust the literal to wave 4's declared types, not the other way round: `schema.ts` is not edited in this wave.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/server/__tests__/screen-persist.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation check (load-bearing: a corrected identity is never overwritten)**

Delete the `if (existing && (existing.identitySource === 'manual' || …)) return;` block. Run the file. Expected: FAIL in `never overwrites a manual or corrected identity`. Restore; re-run: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/server/screenEnrichment.ts lib/server/__tests__/screen-persist.test.ts
git commit -m "feat(screen): persist screen resolutions with identity, clash and conversion rules (#96)"
```

---

### Task 9: Job kinds and the screen chunk (`enrichmentJobs.ts`)

**Files:**
- Modify: `lib/server/enrichmentJobs.ts`
- Modify: `lib/server/__tests__/enrich-job-insert.test.ts` (justified below)
- Test: `lib/server/__tests__/screen-jobs.test.ts`
- Test: `lib/server/__tests__/screen-runner-routing.test.ts`

**Interfaces:**
- Consumes: `titles`, `titleEnrichment` (wave 4 schema); `resolveMovies`, `refreshMovies`, `resolveTv`, `persistTitleResolution`, `MovieInput`, `FixedMovieInput`, `TvInput`, `TitleResolution` (Tasks 7–8); `Deadline` (Task 3).
- Produces (contract names), relied on by Task 10 and wave 8:
  - `export type JobKind = 'books' | 'screen'`
  - `NewJobValues` gains a **required** `kind: JobKind`
  - `export async function findActiveJob(db: Db, userId: string, kind: JobKind = 'books'): Promise<EnrichJobRow | null>`
  - `export async function createOrGetActiveJob(db: Db, userId: string, options: JobOptions, create: JobInsert = insertJob, kind: JobKind = 'books')`
  - `export const SCREEN_BATCH_SIZE = 50`
  - `export interface ScreenChunkDeps { nowMs: () => number; runBatch: (db: Db, titleIds: number[], options: JobOptions, deadline: Deadline) => Promise<void>; dispatch: (jobId: string) => Promise<void> }`
  - `export async function runClaimedScreenChunk(db: Db, job: EnrichJobRow, deps: ScreenChunkDeps): Promise<RunClaimedChunkResult>`
  - `export function screenEnrichmentRunner(userId: string): ScreenChunkDeps['runBatch']`
  - Unchanged: `runClaimedChunk`, `RunClaimedChunkDeps`, `claimJob`, `repairActiveJobs`, `failIfStale`, `serializeJob` (still exactly seven public fields), `CHUNK_BUDGET_MS`.

**The book path must not change behaviour.** The refactor moves the chunk loop into a private `runChunkLoop` that takes a small `ChunkWork` (`derive`, `runNext`). For books, `derive` is the existing `deriveState` and `runNext` is the existing "next unenriched book, then `runOne`": the same database reads in the same order, and the same number of `nowMs()` calls in the same places (the existing tests drive a sequence clock, so an extra call would shift them). `lib/server/__tests__/enrichment-jobs.test.ts` must pass **unmodified**.

**Exception 1 (justified):** `enrich-job-insert.test.ts` builds `NewJobValues` literals. `kind` joins `NewJobValues` as a required field, for the same reason `progress` and `total` are required there: an insert payload never relies on a database default. Both literals gain `kind: 'books'`, so the `@ts-expect-error` literal still fails only because `progress` and `total` are missing — which is what that test guards.

- [ ] **Step 1: Write the failing tests**

Create `lib/server/__tests__/screen-jobs.test.ts`:

```ts
import { eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../db';
import {
  CHUNK_BUDGET_MS,
  SCREEN_BATCH_SIZE,
  STALLED_MESSAGE,
  createOrGetActiveJob,
  defaultJobOptions,
  findActiveJob,
  runClaimedScreenChunk,
  screenEnrichmentRunner,
  type EnrichJobRow,
  type JobInsert,
} from '../enrichmentJobs';
import { _setScreenCatalogHooksForTests, type Deadline } from '../screenCatalog';
import { books, enrichment, enrichJobs, titleEnrichment, titles } from '../schema';
import { makeTestDb } from './helpers/pglite';

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await makeTestDb());
});

afterEach(async () => {
  vi.unstubAllGlobals();
  _setScreenCatalogHooksForTests(null);
  await close();
});

function errorText(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  return [
    error instanceof Error ? error.message : String(error),
    cause instanceof Error ? cause.message : String(cause ?? ''),
  ].join(' ');
}

async function seedTitles(userId: string, count: number): Promise<number[]> {
  const rows = await db
    .insert(titles)
    .values(
      Array.from({ length: count }, (_, i) => ({
        userId,
        mediaType: 'movie',
        title: `Heat ${i}`,
        year: 1995,
        status: 'watched',
      }))
    )
    .returning({ id: titles.id });
  return rows.map((row) => row.id);
}

async function seedScreenJob(userId: string): Promise<EnrichJobRow> {
  const [row] = await db
    .insert(enrichJobs)
    .values({
      jobId: `screen-${userId}`,
      userId,
      kind: 'screen',
      status: 'running',
      progress: 0,
      total: 0,
      attempts: 1,
      startedAt: '2026-08-11 12:00:00.000',
      leaseExpiresAt: '2026-08-11 12:05:00.000',
    })
    .returning();
  return row;
}

const persistAll = async (_db: Db, titleIds: number[]) => {
  for (const titleId of titleIds) {
    await db.insert(titleEnrichment).values({
      titleId,
      resolutionConfidence: 0.95,
      confidenceLabel: 'HIGH',
      resolvedAt: '2026-08-11 12:00:01.000',
    });
  }
};

const noDispatch = async () => undefined;

describe('job kinds', () => {
  it('lets a book job and a screen job be active for one user at once', async () => {
    const book = await createOrGetActiveJob(db, 'user-a', defaultJobOptions);
    const screen = await createOrGetActiveJob(db, 'user-a', defaultJobOptions, undefined, 'screen');
    const again = await createOrGetActiveJob(db, 'user-a', defaultJobOptions, undefined, 'screen');
    expect([book.created, screen.created, again.created]).toEqual([true, true, false]);
    expect(again.job.job_id).toBe(screen.job.job_id);
    expect(screen.job.job_id).not.toBe(book.job.job_id);
    expect((await findActiveJob(db, 'user-a', 'screen'))?.jobId).toBe(screen.job.job_id);
    expect((await findActiveJob(db, 'user-a'))?.jobId).toBe(book.job.job_id);
    const kinds = await db.select({ kind: enrichJobs.kind }).from(enrichJobs);
    expect(kinds.map((k) => k.kind).sort()).toEqual(['books', 'screen']);
  });

  it('still rejects a second active screen job through the (user_id, kind) index', async () => {
    const values = { userId: 'user-a', kind: 'screen', status: 'pending', progress: 0, total: 0 };
    await db.insert(enrichJobs).values({ ...values, jobId: 'one' });
    let message = '';
    try {
      await db.insert(enrichJobs).values({ ...values, jobId: 'two' });
    } catch (error) {
      message = errorText(error);
    }
    expect(message).toContain('uq_enrich_jobs_active_user_kind');
  });

  it('recovers a racing screen insert by returning the screen winner', async () => {
    const insert: JobInsert = async (conn, values) => {
      await conn.insert(enrichJobs).values({ ...values, jobId: 'winner' });
      const [row] = await conn.insert(enrichJobs).values(values).returning();
      return row;
    };
    const out = await createOrGetActiveJob(db, 'user-a', defaultJobOptions, insert, 'screen');
    expect([out.created, out.job.job_id]).toEqual([false, 'winner']);
  });
});

describe('runClaimedScreenChunk', () => {
  it('runs a batch and recounts progress from title_enrichment rows', async () => {
    const ids = await seedTitles('user-a', 3);
    const job = await seedScreenJob('user-a');
    const runBatch = vi.fn(persistAll);
    const result = await runClaimedScreenChunk(db, job, {
      nowMs: () => 0,
      runBatch,
      dispatch: noDispatch,
    });
    expect(runBatch.mock.calls.map((call) => call[1])).toEqual([ids]);
    expect(result).toEqual({
      outcome: 'done',
      progressBefore: 0,
      progressAfter: 3,
      remaining: 0,
      rearmed: false,
    });
    const [row] = await db.select().from(enrichJobs).where(eq(enrichJobs.jobId, job.jobId));
    expect([row.status, row.progress, row.total]).toEqual(['done', 3, 3]);
  });

  it(`hands at most ${SCREEN_BATCH_SIZE} titles to each batch`, async () => {
    await seedTitles('user-a', SCREEN_BATCH_SIZE + 10);
    const job = await seedScreenJob('user-a');
    const runBatch = vi.fn(persistAll);
    const result = await runClaimedScreenChunk(db, job, { nowMs: () => 0, runBatch, dispatch: noDispatch });
    expect(runBatch.mock.calls.map((call) => call[1].length)).toEqual([SCREEN_BATCH_SIZE, 10]);
    expect(result.outcome).toBe('done');
  });

  it('gives each batch a deadline measured on the chunk clock', async () => {
    await seedTitles('user-a', 1);
    const job = await seedScreenJob('user-a');
    let seen = -1;
    await runClaimedScreenChunk(db, job, {
      nowMs: () => 5_000,
      runBatch: async (conn, titleIds, _options, deadline: Deadline) => {
        seen = deadline.remainingMs();
        await persistAll(conn, titleIds);
      },
      dispatch: noDispatch,
    });
    expect(seen).toBe(CHUNK_BUDGET_MS);
  });

  it('fails the job when a chunk persists nothing (stall check)', async () => {
    await seedTitles('user-a', 2);
    const job = await seedScreenJob('user-a');
    const dispatch = vi.fn(noDispatch);
    const result = await runClaimedScreenChunk(db, job, {
      nowMs: () => 0,
      runBatch: async () => undefined,
      dispatch,
    });
    expect([result.outcome, dispatch.mock.calls.length]).toEqual(['error', 0]);
    const [row] = await db.select().from(enrichJobs).where(eq(enrichJobs.jobId, job.jobId));
    expect([row.status, row.error]).toEqual(['error', STALLED_MESSAGE]);
  });

  it('never selects books, and never another user\'s titles', async () => {
    await db.insert(books).values({ userId: 'user-a', title: 'Dune', goodreadsRating: 5, source: 'test' });
    const mine = await seedTitles('user-a', 1);
    await seedTitles('user-b', 2);
    const job = await seedScreenJob('user-a');
    const runBatch = vi.fn(persistAll);
    await runClaimedScreenChunk(db, job, { nowMs: () => 0, runBatch, dispatch: noDispatch });
    expect(runBatch.mock.calls.map((call) => call[1])).toEqual([mine]);
    expect(await db.select().from(enrichment)).toEqual([]);
  });

  it('refuses a book job', async () => {
    const job = { ...(await seedScreenJob('user-a')), kind: 'books' };
    await expect(
      runClaimedScreenChunk(db, job, { nowMs: () => 0, runBatch: persistAll, dispatch: noDispatch })
    ).rejects.toThrow(/books/);
  });

  it('runs a screen chunk against a failing catalog and persists nothing', async () => {
    // Review Focus 1 and the spec §10 transport test: a retryable failure never persists
    // "unresolved", and the job ends in an error the user can retry.
    _setScreenCatalogHooksForTests({ sleep: async () => undefined });
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 503 }));
    const ids = await seedTitles('user-a', 3);
    const job = await seedScreenJob('user-a');
    const result = await runClaimedScreenChunk(db, job, {
      nowMs: () => 0,
      runBatch: screenEnrichmentRunner('user-a'),
      dispatch: noDispatch,
    });
    expect(
      await db.select().from(titleEnrichment).where(inArray(titleEnrichment.titleId, ids))
    ).toEqual([]);
    expect(result.outcome).toBe('error');
    const [row] = await db.select().from(enrichJobs).where(eq(enrichJobs.jobId, job.jobId));
    expect(row.error).toBe(STALLED_MESSAGE);
  });
});
```

Create `lib/server/__tests__/screen-runner-routing.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../db';
import { titleEnrichment, titles } from '../schema';
import { makeTestDb } from './helpers/pglite';

const { resolveMovies, refreshMovies, resolveTv } = vi.hoisted(() => ({
  resolveMovies: vi.fn(),
  refreshMovies: vi.fn(),
  resolveTv: vi.fn(),
}));

vi.mock('../screenEnrichment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../screenEnrichment')>()),
  resolveMovies,
  refreshMovies,
  resolveTv,
}));

import { screenEnrichmentRunner } from '../enrichmentJobs';

let db: Db;
let close: () => Promise<void>;
const deadline = { remainingMs: () => 60_000 };

beforeEach(async () => {
  ({ db, close } = await makeTestDb());
  resolveMovies.mockReset();
  refreshMovies.mockReset();
  resolveTv.mockReset();
});

afterEach(async () => {
  await close();
});

describe('screenEnrichmentRunner', () => {
  it('routes auto movies, fixed movies and shows to their resolvers and persists only definite results', async () => {
    const [auto, fixed, show, other] = await db
      .insert(titles)
      .values([
        { userId: 'user-a', mediaType: 'movie', title: 'Heat', year: 1995, status: 'watched' },
        { userId: 'user-a', mediaType: 'movie', title: 'Alien', year: 1979, status: 'watched', wikidataQid: 'Q5' },
        { userId: 'user-a', mediaType: 'tv', title: 'Severance', year: 2022, status: 'watching', tvmazeId: 44933 },
        { userId: 'user-b', mediaType: 'movie', title: 'Theirs', year: 2000, status: 'watched' },
      ])
      .returning({ id: titles.id });
    await db.insert(titleEnrichment).values({
      titleId: fixed.id,
      wikidataQid: 'Q5',
      resolutionConfidence: 1,
      confidenceLabel: 'CORRECTED',
      identitySource: 'corrected',
    });
    resolveMovies.mockResolvedValue(new Map([[auto.id, { kind: 'unresolved', raw: {} }]]));
    refreshMovies.mockResolvedValue(new Map([[fixed.id, { kind: 'deferred', reason: 'HTTP 503' }]]));
    resolveTv.mockResolvedValue(new Map([[show.id, { kind: 'refreshed', candidate: null }]]));

    await screenEnrichmentRunner('user-a')(
      db,
      [auto.id, fixed.id, show.id, other.id],
      { force: true, limit: null },
      deadline
    );

    expect(resolveMovies.mock.calls[0][1]).toEqual([{ id: auto.id, title: 'Heat', year: 1995 }]);
    expect(refreshMovies.mock.calls[0][1]).toEqual([{ id: fixed.id, wikidataQid: 'Q5' }]);
    expect(resolveTv.mock.calls[0][1]).toEqual([{ id: show.id, tvmazeId: 44933 }]);
    const rows = await db.select().from(titleEnrichment);
    const byTitle = new Map(rows.map((row) => [row.titleId, row]));
    expect(byTitle.get(auto.id)?.matchMethod).toBe('unresolved');
    expect(byTitle.get(fixed.id)?.confidenceLabel).toBe('CORRECTED'); // deferred: untouched
    expect(byTitle.get(show.id)?.matchMethod).toBe('refresh');
    expect(byTitle.has(other.id)).toBe(false); // another user's id is never read
    const [otherRow] = await db.select().from(titles).where(eq(titles.id, other.id));
    expect(otherRow.wikidataQid).toBeNull();
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npx vitest list lib/server/__tests__/screen-jobs.test.ts lib/server/__tests__/screen-runner-routing.test.ts` (expect both listed), then `npx vitest run lib/server/__tests__/screen-jobs.test.ts lib/server/__tests__/screen-runner-routing.test.ts`.
Expected: FAIL — `runClaimedScreenChunk` / `screenEnrichmentRunner` are not exported.

- [ ] **Step 3: Thread `kind` through job creation and lookup**

In `lib/server/enrichmentJobs.ts`:

Replace the first three import lines with:

```ts
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from './db';
import { enrichLibrary } from './enrichment';
import { books, enrichment, enrichJobs, titleEnrichment, titles } from './schema';
import type { Deadline } from './screenCatalog';
import {
  persistTitleResolution,
  refreshMovies,
  resolveMovies,
  resolveTv,
  type FixedMovieInput,
  type MovieInput,
  type TitleResolution,
  type TvInput,
} from './screenEnrichment';
import { effectiveRating, tsToIso, utcnowTs } from './serialize';
```

(The existing `import { effectiveRating, tsToIso, utcnowTs } from './serialize';` line is kept once, as shown.)

After `export const defaultJobOptions …`, add:

```ts
export type JobKind = 'books' | 'screen';
```

Replace `NewJobValues` with:

```ts
export interface NewJobValues {
  jobId: string;
  userId: string;
  // Required, like progress/total: an insert never relies on a database default.
  kind: JobKind;
  status: string;
  progress: number;
  total: number;
  force: boolean;
  runLimit: number | null;
}
```

Replace `findActiveJob` with:

```ts
export async function findActiveJob(
  db: Db,
  userId: string,
  kind: JobKind = 'books'
): Promise<EnrichJobRow | null> {
  const rows = await db
    .select()
    .from(enrichJobs)
    .where(
      and(
        eq(enrichJobs.userId, userId),
        eq(enrichJobs.kind, kind),
        inArray(enrichJobs.status, ['pending', 'running'])
      )
    )
    .limit(1);
  return rows[0] ?? null;
}
```

Replace `isActiveUserViolation` with:

```ts
function isActiveUserViolation(error: unknown): boolean {
  // Wave 4 replaced uq_enrich_jobs_active_user with the (user_id, kind) index.
  return errorMessages(error).some((message) => message.includes('uq_enrich_jobs_active_user_kind'));
}
```

Replace `createOrGetActiveJob` with:

```ts
export async function createOrGetActiveJob(
  db: Db,
  userId: string,
  options: JobOptions,
  create: JobInsert = insertJob,
  kind: JobKind = 'books'
): Promise<{ created: boolean; job: PublicJob; options: JobOptions }> {
  const active = await findActiveJob(db, userId, kind);
  if (active) return { created: false, job: serializeJob(active), options: storedOptions(active) };

  try {
    const row = await create(db, {
      jobId: randomUUID(),
      userId,
      kind,
      status: 'pending',
      // progress/total are NOT NULL with no server default in the Alembic-owned
      // table -- Python supplies them from the ORM-level `default=0`. Omitting
      // them here makes drizzle emit SQL `default`, which Postgres rejects.
      progress: 0,
      total: 0,
      force: options.force,
      runLimit: options.limit,
    });
    return { created: true, job: serializeJob(row), options: storedOptions(row) };
  } catch (error) {
    if (!isActiveUserViolation(error)) throw error;
    const winner = await findActiveJob(db, userId, kind);
    if (!winner) throw error;
    return { created: false, job: serializeJob(winner), options: storedOptions(winner) };
  }
}
```

In `lib/server/__tests__/enrich-job-insert.test.ts`, add `kind: 'books',` after `userId: 'local',` in **both** literals (`missing` and `complete`). Change nothing else in that file.

- [ ] **Step 4: Replace the chunk section with a shared loop plus the screen work source**

In `lib/server/enrichmentJobs.ts`, replace everything from `function processedThisRun(` down to the end of the file with:

```ts
/** A candidate row of either kind; the recount only reads its enrichment timestamp. */
interface RecountRow {
  enrichment: { resolvedAt: string } | null;
}

function processedThisRun(rows: readonly RecountRow[], startedAt: string): number {
  return rows.filter((row) => row.enrichment !== null && row.enrichment.resolvedAt >= startedAt)
    .length;
}

function selectableRows<T extends RecountRow>(rows: readonly T[], options: RunOptions): T[] {
  return rows.filter(({ enrichment: existing }) =>
    options.force ? existing === null || existing.resolvedAt < options.startedAt : existing === null
  );
}

function limitedCount(count: number, limit: number | null): number {
  if (limit === null) return count;
  return Math.min(count, limit);
}

interface ChunkState {
  progress: number;
  remaining: number;
  total: number;
}

function deriveFromRows(rows: readonly RecountRow[], options: RunOptions): ChunkState {
  const processed = processedThisRun(rows, options.startedAt);
  const preexisting = rows.filter(
    (row) => row.enrichment !== null && row.enrichment.resolvedAt < options.startedAt
  ).length;
  const selectable = selectableRows(rows, options).length;
  const allowance = options.limit === null ? selectable : Math.max(0, options.limit - processed);
  const remaining = Math.min(selectable, allowance);
  const initialWork = options.force
    ? rows.length
    : rows.filter((row) => row.enrichment === null).length + processed;
  const skipped = options.force ? 0 : preexisting;
  const total = skipped + limitedCount(initialWork, options.limit);
  return {
    progress: processed + (options.force ? 0 : preexisting),
    remaining,
    total,
  };
}

async function deriveState(db: Db, userId: string, options: RunOptions): Promise<ChunkState> {
  return deriveFromRows(await candidateRows(db, userId), options);
}

export async function countPersistedEnrichment(
  db: Db,
  userId: string,
  options: RunOptions
): Promise<number> {
  return (await deriveState(db, userId, options)).progress;
}

async function nextUnenrichedBook(
  db: Db,
  userId: string,
  options: RunOptions
): Promise<typeof books.$inferSelect | null> {
  const rows = await candidateRows(db, userId);
  return selectableRows(rows, options)[0]?.book ?? null;
}

async function writeDerivedProgress(
  db: Db,
  jobId: string,
  derived: number,
  total: number
): Promise<void> {
  await db.update(enrichJobs).set({ progress: derived, total }).where(eq(enrichJobs.jobId, jobId));
}

async function writeTerminal(
  db: Db,
  jobId: string,
  status: 'done' | 'error',
  progress: number,
  total: number,
  error: string | null
): Promise<void> {
  await db
    .update(enrichJobs)
    .set({
      status,
      progress,
      total,
      error: error?.slice(0, 2_000) ?? null,
      finishedAt: utcnowTs(),
      leaseExpiresAt: null,
    })
    .where(eq(enrichJobs.jobId, jobId));
}

export function oneBookEnrichmentRunner(userId: string): RunClaimedChunkDeps['runOne'] {
  return async (db, bookId, options) => {
    await enrichLibrary(db, { userId, force: options.force, bookIds: [bookId] });
  };
}

function runOptions(job: EnrichJobRow): RunOptions {
  if (job.startedAt === null) throw new Error('claimed enrichment job has no started_at');
  return { force: job.force, limit: job.runLimit, startedAt: job.startedAt };
}

interface ChunkWork {
  /** Recount from persisted rows -- never an in-memory counter (CLAUDE.md). */
  derive(): Promise<ChunkState>;
  /** Run the next unit of work; false when nothing is selectable. */
  runNext(deadline: Deadline): Promise<boolean>;
}

/**
 * The time-bounded chunk loop shared by both kinds. The book path's call sequence --
 * derive, budget check, next work, derive, write progress, stall check -- is exactly the
 * pre-wave-5 runClaimedChunk body, including where nowMs() is called: the existing tests
 * drive a sequence clock and would shift if a call were added or moved.
 */
async function runChunkLoop(
  db: Db,
  job: EnrichJobRow,
  work: ChunkWork,
  nowMs: () => number,
  dispatch: (jobId: string) => Promise<void>
): Promise<RunClaimedChunkResult> {
  const initial = await work.derive();
  const progressBefore = initial.progress;

  if (job.attempts > MAX_JOB_ATTEMPTS) {
    await writeTerminal(db, job.jobId, 'error', progressBefore, initial.total, ATTEMPTS_MESSAGE);
    return {
      outcome: 'error',
      progressBefore,
      progressAfter: progressBefore,
      remaining: initial.remaining,
      rearmed: false,
    };
  }

  const startedMs = nowMs();
  // Lazy: the book path never calls it, so its clock sequence is unchanged.
  const deadline: Deadline = { remainingMs: () => CHUNK_BUDGET_MS - (nowMs() - startedMs) };
  let lastDerived = progressBefore;
  while ((await work.derive()).remaining > 0) {
    if (nowMs() - startedMs >= CHUNK_BUDGET_MS) break;
    if (!(await work.runNext(deadline))) break;
    const derived = (await work.derive()).progress;
    await writeDerivedProgress(db, job.jobId, derived, initial.total);
    if (derived === lastDerived) break;
    lastDerived = derived;
  }
  const finalState = await work.derive();
  const progressAfter = finalState.progress;

  if (finalState.remaining === 0) {
    await writeTerminal(db, job.jobId, 'done', progressAfter, initial.total, null);
    return {
      outcome: 'done',
      progressBefore,
      progressAfter,
      remaining: 0,
      rearmed: false,
    };
  }

  if (progressAfter === progressBefore) {
    await writeTerminal(db, job.jobId, 'error', progressAfter, initial.total, STALLED_MESSAGE);
    return {
      outcome: 'error',
      progressBefore,
      progressAfter,
      remaining: finalState.remaining,
      rearmed: false,
    };
  }

  await db
    .update(enrichJobs)
    .set({ progress: progressAfter, total: initial.total, leaseExpiresAt: null })
    .where(eq(enrichJobs.jobId, job.jobId));
  let rearmed = true;
  try {
    await dispatch(job.jobId);
  } catch (error) {
    rearmed = false;
    console.error(`Failed to dispatch enrichment job ${job.jobId}`, error);
  }
  return {
    outcome: 'continued',
    progressBefore,
    progressAfter,
    remaining: finalState.remaining,
    rearmed,
  };
}

export async function runClaimedChunk(
  db: Db,
  job: EnrichJobRow,
  deps: RunClaimedChunkDeps
): Promise<RunClaimedChunkResult> {
  const options = runOptions(job);
  return runChunkLoop(
    db,
    job,
    {
      derive: () => deriveState(db, job.userId, options),
      runNext: async () => {
        const next = await nextUnenrichedBook(db, job.userId, options);
        if (!next) return false;
        await deps.runOne(db, next.id, options);
        return true;
      },
    },
    deps.nowMs,
    deps.dispatch
  );
}

// --- Screen enrichment (spec §4.6) ----------------------------------------------------

/**
 * Titles per loop iteration. The resolver batches Stage A SPARQL (~120 names per query)
 * and wbgetentities (50 ids per call), so one iteration per title would waste both. The
 * loop still recounts from persisted rows after every batch, and a batch that persists
 * nothing trips the stall check exactly as a book that fails to persist does.
 */
export const SCREEN_BATCH_SIZE = 50;

export interface ScreenChunkDeps {
  nowMs: () => number;
  runBatch: (db: Db, titleIds: number[], options: JobOptions, deadline: Deadline) => Promise<void>;
  dispatch: (jobId: string) => Promise<void>;
}

interface ScreenCandidateRow {
  title: typeof titles.$inferSelect;
  enrichment: typeof titleEnrichment.$inferSelect | null;
}

/** Every title is a candidate: the want list needs identity for dedup and images (§4.6). */
async function screenCandidateRows(db: Db, userId: string): Promise<ScreenCandidateRow[]> {
  return db
    .select({ title: titles, enrichment: titleEnrichment })
    .from(titles)
    .leftJoin(titleEnrichment, eq(titleEnrichment.titleId, titles.id))
    .where(eq(titles.userId, userId))
    .orderBy(asc(titles.id));
}

export async function runClaimedScreenChunk(
  db: Db,
  job: EnrichJobRow,
  deps: ScreenChunkDeps
): Promise<RunClaimedChunkResult> {
  if (job.kind !== 'screen') throw new Error(`runClaimedScreenChunk was given a ${job.kind} job`);
  const options = runOptions(job);
  return runChunkLoop(
    db,
    job,
    {
      derive: async () => deriveFromRows(await screenCandidateRows(db, job.userId), options),
      runNext: async (deadline) => {
        const rows = await screenCandidateRows(db, job.userId);
        const { remaining } = deriveFromRows(rows, options);
        const batch = selectableRows(rows, options).slice(0, Math.min(SCREEN_BATCH_SIZE, remaining));
        if (batch.length === 0) return false;
        await deps.runBatch(
          db,
          batch.map((row) => row.title.id),
          options,
          deadline
        );
        return true;
      },
    },
    deps.nowMs,
    deps.dispatch
  );
}

/**
 * Resolves one batch and persists every definite result in one transaction. Routing
 * (design decision 9): a TV title with a TVmaze id refreshes through TVmaze and the
 * crosswalk; a manual or corrected movie refreshes metadata by its QID; everything else is
 * resolved from its title and year. A deferred title writes nothing, so the next batch or
 * chunk retries it.
 */
export function screenEnrichmentRunner(userId: string): ScreenChunkDeps['runBatch'] {
  return async (db, titleIds, _options, deadline) => {
    if (titleIds.length === 0) return;
    const rows = await db
      .select({ title: titles, enrichment: titleEnrichment })
      .from(titles)
      .leftJoin(titleEnrichment, eq(titleEnrichment.titleId, titles.id))
      .where(and(eq(titles.userId, userId), inArray(titles.id, titleIds)))
      .orderBy(asc(titles.id));

    const movies: MovieInput[] = [];
    const fixed: FixedMovieInput[] = [];
    const shows: TvInput[] = [];
    for (const { title, enrichment: existing } of rows) {
      const fixedIdentity =
        existing?.identitySource === 'manual' || existing?.identitySource === 'corrected';
      if (title.mediaType === 'tv' && title.tvmazeId !== null) {
        shows.push({ id: title.id, tvmazeId: title.tvmazeId });
      } else if (fixedIdentity && title.wikidataQid !== null) {
        fixed.push({ id: title.id, wikidataQid: title.wikidataQid });
      } else {
        movies.push({ id: title.id, title: title.title, year: title.year });
      }
    }

    const results = new Map<number, TitleResolution>([
      ...(await resolveMovies(db, movies, deadline)),
      ...(await refreshMovies(db, fixed, deadline)),
      ...(await resolveTv(db, shows, deadline)),
    ]);

    await db.transaction(async (tx) => {
      for (const { title } of rows) {
        const result = results.get(title.id);
        if (!result || result.kind === 'deferred') continue;
        await persistTitleResolution(tx, title.id, result);
      }
    });
  };
}
```

`hasWorkRemaining` is gone: `runChunkLoop` inlines it as `(await work.derive()).remaining > 0`. Keep `interface CandidateRow` and `candidateRows` exactly as they are (they sit above `processedThisRun`).

- [ ] **Step 5: Run the old and new job tests**

Run: `npx vitest run lib/server/__tests__/enrichment-jobs.test.ts lib/server/__tests__/enrich-job-insert.test.ts lib/server/__tests__/screen-jobs.test.ts lib/server/__tests__/screen-runner-routing.test.ts app/api/enrich`
Expected: PASS. `enrichment-jobs.test.ts` and every file under `app/api/enrich` pass **without edits**; if one fails, the refactor changed book behaviour — fix the refactor, not the test.

Run: `npm run type-check`
Expected: exit 0 (this is the gate that proves the `@ts-expect-error` in `enrich-job-insert.test.ts` still fires).

- [ ] **Step 6: Mutation checks (load-bearing)**

1. In `findActiveJob`, delete `eq(enrichJobs.kind, kind),`. Run `screen-jobs.test.ts`. Expected: FAIL in `lets a book job and a screen job be active for one user at once`. Restore.
2. In `screenFetchJson` (`lib/server/screenCatalog.ts`), change the final `return { kind: 'retryable', reason };` to `return { kind: 'empty' };`. Run `screen-jobs.test.ts`. Expected: FAIL in `runs a screen chunk against a failing catalog and persists nothing` (titles get persisted as unresolved). Restore; re-run both files: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/server/enrichmentJobs.ts lib/server/__tests__/enrich-job-insert.test.ts lib/server/__tests__/screen-jobs.test.ts lib/server/__tests__/screen-runner-routing.test.ts
git commit -m "feat(screen): screen enrichment jobs beside book jobs, batched per chunk (#96)"
```

---

### Task 10: Screen job routes, tick dispatch, and the import queue

**Files:**
- Create: `lib/server/screenJobs.ts`
- Test: `lib/server/__tests__/screen-jobs-queue.test.ts`
- Modify: `lib/server/ratelimit.ts`
- Modify: `app/api/enrich/tick/route.ts`
- Test: `app/api/enrich/tick/screen.test.ts`
- Create: `app/api/screen/enrich/start/route.ts`, `app/api/screen/enrich/active/route.ts`
- Test: `app/api/screen/enrich/start/route.test.ts`, `app/api/screen/enrich/active/route.test.ts`
- Modify: `app/api/enrich/enrich-max-duration.test.ts`
- Modify: `app/api/screen/import/route.ts` (wave 4 file)
- Modify: `lib/server/__tests__/screen-import-routes.test.ts` (wave 4 file, justified below)

**Interfaces:**
- Consumes: `createOrGetActiveJob`, `findActiveJob`, `claimJob`, `failIfStale`, `serializeJob`, `defaultJobOptions`, `runClaimedScreenChunk`, `screenEnrichmentRunner`, `JobOptions`, `PublicJob` (Task 9 / existing); `rearmAfterResponse`, `_setDispatchForTests` (`lib/server/enrichmentDispatch.ts`); `requireScreenEnabled`, `SCREEN_DISABLED_MESSAGE` (wave 4).
- Produces, relied on by wave 8:
  - `export async function queueScreenEnrichment(db: Db, request: Request, userId: string): Promise<PublicJob>`: creates or reuses the user's active screen job. When it created one, it schedules the first `/api/enrich/tick` after the response. It never runs a chunk inline.
  - `export async function startScreenEnrichment(db: Db, request: Request, userId: string, options: JobOptions): Promise<PublicJob>`: creates or reuses the active screen job, then claims it if no chunk holds the lease and runs one chunk inline.
  - `POST /api/screen/enrich/start` with body `{ force?: boolean, limit?: number | null }` returns a `PublicJob` (`{ job_id, status, progress, total, error, started_at, finished_at }`).
  - `GET /api/screen/enrich/active` returns `{ job: PublicJob | null }`.
  - `POST /api/screen/import` now returns `{ inserted, updated, unchanged, job: PublicJob }`.
  - `RATE_LIMITS.screenEnrichStart = { limit: 5, windowSeconds: 60 }` and `RATE_LIMITS.screenSearch = { limit: 30, windowSeconds: 60 }`. Task 11 uses `screenSearch`.

**A deliberate difference from the book start route.** `POST /api/enrich/start` runs a chunk only for a job it just created. `startScreenEnrichment` also claims an **existing** active job whose lease is free (`claimJob` succeeds only when `lease_expires_at` is null or past), so it can never double-run a chunk.
- **Why:** the import route queues its job and relies on a post-response dispatch. If that dispatch never runs (a missing `CRON_SECRET`, or a crashed isolate), the job sits `pending` with no lease. The status route re-arms only `running` jobs, and the janitor runs once a day (`vercel.json`). Claiming here makes "Retry enrichment" in wave 8 recover that job straight away.

**Exception 2 (justified).** `lib/server/__tests__/screen-import-routes.test.ts` asserts the import body with an exact `toEqual({ inserted, updated, unchanged })`.
- **Why it must change:** the contract always planned for wave 5 to add `job` to that body, and a scheduled dispatch needs `CRON_SECRET` plus the dispatch test seam.
- **What changes:** only the setup, the teardown, and those body assertions. Every other assertion stays exactly as wave 4 wrote it.

- [ ] **Step 1: Write the failing queue and start tests**

Create `lib/server/__tests__/screen-jobs-queue.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../db';
import { _setDispatchForTests } from '../enrichmentDispatch';
import { defaultJobOptions } from '../enrichmentJobs';
import { enrichJobs } from '../schema';
import { makeTestDb } from './helpers/pglite';

const { runClaimedScreenChunkMock } = vi.hoisted(() => ({ runClaimedScreenChunkMock: vi.fn() }));

vi.mock('../enrichmentJobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../enrichmentJobs')>()),
  runClaimedScreenChunk: runClaimedScreenChunkMock,
}));

import { queueScreenEnrichment, startScreenEnrichment } from '../screenJobs';

let db: Db;
let close: () => Promise<void>;
let scheduled: Array<() => void | Promise<void>>;
const request = () => new Request('http://test/api/screen/import', { method: 'POST' });

beforeEach(async () => {
  ({ db, close } = await makeTestDb());
  scheduled = [];
  _setDispatchForTests({ schedule: (callback) => void scheduled.push(callback) });
  vi.stubEnv('CRON_SECRET', 'test-cron-secret');
  runClaimedScreenChunkMock.mockReset();
  runClaimedScreenChunkMock.mockResolvedValue({
    outcome: 'continued',
    progressBefore: 0,
    progressAfter: 1,
    remaining: 1,
    rearmed: true,
  });
});

afterEach(async () => {
  _setDispatchForTests(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await close();
});

async function jobRows() {
  return db.select().from(enrichJobs).orderBy(enrichJobs.id);
}

describe('queueScreenEnrichment', () => {
  it('queues a pending screen job and schedules its first tick after the response', async () => {
    const job = await queueScreenEnrichment(db, request(), 'user-a');
    expect(job.status).toBe('pending');
    expect(scheduled).toHaveLength(1);
    expect(runClaimedScreenChunkMock).not.toHaveBeenCalled();
    const [row] = await jobRows();
    expect([row.jobId, row.kind, row.userId, row.leaseExpiresAt]).toEqual([
      job.job_id,
      'screen',
      'user-a',
      null,
    ]);
  });

  it('reuses the active screen job without scheduling a second tick', async () => {
    const first = await queueScreenEnrichment(db, request(), 'user-a');
    const second = await queueScreenEnrichment(db, request(), 'user-a');
    expect(second.job_id).toBe(first.job_id);
    expect(scheduled).toHaveLength(1);
    expect(await jobRows()).toHaveLength(1);
  });

  it('sits beside an active book job instead of reusing it', async () => {
    await db.insert(enrichJobs).values({
      jobId: 'book-job',
      userId: 'user-a',
      kind: 'books',
      status: 'running',
      progress: 0,
      total: 0,
    });
    const job = await queueScreenEnrichment(db, request(), 'user-a');
    expect(job.job_id).not.toBe('book-job');
    expect((await jobRows()).map((row) => [row.jobId === 'book-job', row.kind])).toEqual([
      [true, 'books'],
      [false, 'screen'],
    ]);
  });

  it('leaves the job pending, and does not throw, when the tick cannot be scheduled', async () => {
    vi.stubEnv('CRON_SECRET', '');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const job = await queueScreenEnrichment(db, request(), 'user-a');
    expect(job.status).toBe('pending');
    expect(scheduled).toHaveLength(0);
    expect(errors).toHaveBeenCalledTimes(1);
  });
});

describe('startScreenEnrichment', () => {
  it('creates a screen job, claims it and runs one chunk inline', async () => {
    const job = await startScreenEnrichment(db, request(), 'user-a', defaultJobOptions);
    expect(runClaimedScreenChunkMock).toHaveBeenCalledTimes(1);
    expect(runClaimedScreenChunkMock.mock.calls[0][1]).toMatchObject({
      jobId: job.job_id,
      kind: 'screen',
      userId: 'user-a',
      status: 'running',
    });
    expect(job.status).toBe('running');
  });

  it('claims a stranded pending job that it did not create', async () => {
    vi.stubEnv('CRON_SECRET', '');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const queued = await queueScreenEnrichment(db, request(), 'user-a'); // dispatch failed
    vi.stubEnv('CRON_SECRET', 'test-cron-secret');
    const started = await startScreenEnrichment(db, request(), 'user-a', defaultJobOptions);
    expect(started.job_id).toBe(queued.job_id);
    expect(runClaimedScreenChunkMock).toHaveBeenCalledTimes(1);
  });

  it('runs nothing while another chunk holds the lease', async () => {
    const leaseUntil = new Date(Date.now() + 60_000).toISOString();
    await db.insert(enrichJobs).values({
      jobId: 'held',
      userId: 'user-a',
      kind: 'screen',
      status: 'running',
      progress: 0,
      total: 0,
      attempts: 1,
      startedAt: new Date().toISOString(),
      leaseExpiresAt: leaseUntil,
    });
    const job = await startScreenEnrichment(db, request(), 'user-a', defaultJobOptions);
    expect(job.job_id).toBe('held');
    expect(runClaimedScreenChunkMock).not.toHaveBeenCalled();
    const [row] = await db.select().from(enrichJobs).where(eq(enrichJobs.jobId, 'held'));
    expect(row.attempts).toBe(1);
  });

  it("never claims another user's screen job", async () => {
    await db.insert(enrichJobs).values({
      jobId: 'theirs',
      userId: 'user-b',
      kind: 'screen',
      status: 'pending',
      progress: 0,
      total: 0,
    });
    const job = await startScreenEnrichment(db, request(), 'user-a', defaultJobOptions);
    expect(job.job_id).not.toBe('theirs');
    const [theirs] = await db.select().from(enrichJobs).where(eq(enrichJobs.jobId, 'theirs'));
    expect([theirs.status, theirs.attempts]).toEqual(['pending', 0]);
  });
});
```

Run: `npx vitest list lib/server/__tests__/screen-jobs-queue.test.ts` (expect it listed), then `npx vitest run lib/server/__tests__/screen-jobs-queue.test.ts`.
Expected: FAIL, because `../screenJobs` does not exist.

- [ ] **Step 2: Write `lib/server/screenJobs.ts`**

```ts
/**
 * Screen enrichment job entry points (spec §4.6), shared by the import and start routes.
 * The chunk itself lives in enrichmentJobs.ts (runClaimedScreenChunk); this module only
 * decides when a chunk is queued and when one runs inline.
 */
import { eq } from 'drizzle-orm';
import type { Db } from './db';
import { rearmAfterResponse } from './enrichmentDispatch';
import {
  claimJob,
  createOrGetActiveJob,
  defaultJobOptions,
  runClaimedScreenChunk,
  screenEnrichmentRunner,
  serializeJob,
  type JobOptions,
  type PublicJob,
} from './enrichmentJobs';
import { enrichJobs } from './schema';

async function readPublicJob(db: Db, jobId: string): Promise<PublicJob> {
  const [row] = await db.select().from(enrichJobs).where(eq(enrichJobs.jobId, jobId)).limit(1);
  if (!row) throw new Error(`screen enrichment job disappeared: ${jobId}`);
  return serializeJob(row);
}

/**
 * Create or reuse the user's active screen job and hand its first chunk to /api/enrich/tick
 * after the response (design decision 11: the import route never runs a chunk inline). A job
 * that already exists is not re-dispatched: its own chain of ticks, or startScreenEnrichment,
 * is already responsible for it, and the loop recounts selectable titles before every batch,
 * so titles imported now are picked up by it.
 */
export async function queueScreenEnrichment(
  db: Db,
  request: Request,
  userId: string
): Promise<PublicJob> {
  const { created, job } = await createOrGetActiveJob(
    db,
    userId,
    defaultJobOptions,
    undefined,
    'screen'
  );
  if (created) {
    try {
      rearmAfterResponse(request, job.job_id);
    } catch (error) {
      // No CRON_SECRET: the job stays pending with no lease. startScreenEnrichment ("Retry
      // enrichment") claims it, and so does the daily janitor.
      console.error(`Failed to dispatch screen enrichment job ${job.job_id}`, error);
    }
  }
  return job;
}

/**
 * Start or resume the user's screen job and run one chunk inline, as the book start route
 * does. Unlike the book route it also claims an existing job whose lease is free, so a job
 * whose first dispatch never ran is recovered here rather than a day later by the janitor.
 * claimJob is an atomic conditional update, so this can never run a second concurrent chunk.
 */
export async function startScreenEnrichment(
  db: Db,
  request: Request,
  userId: string,
  options: JobOptions
): Promise<PublicJob> {
  const { job } = await createOrGetActiveJob(db, userId, options, undefined, 'screen');
  const claimed = await claimJob(db, job.job_id, new Date());
  if (!claimed) return readPublicJob(db, job.job_id);
  await runClaimedScreenChunk(db, claimed, {
    nowMs: () => Date.now(),
    runBatch: screenEnrichmentRunner(userId),
    dispatch: async (jobId) => {
      rearmAfterResponse(request, jobId);
    },
  });
  return readPublicJob(db, job.job_id);
}
```

Run: `npx vitest run lib/server/__tests__/screen-jobs-queue.test.ts`
Expected: PASS.

- [ ] **Step 3: Write the failing tick test**

Create `app/api/enrich/tick/screen.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTestDb } from '@/lib/server/__tests__/helpers/pglite';
import { _resetDebugCache } from '@/lib/server/config';
import { _setDbForTests, type Db } from '@/lib/server/db';
import { enrichJobs } from '@/lib/server/schema';

const { runClaimedChunkMock, runClaimedScreenChunkMock } = vi.hoisted(() => ({
  runClaimedChunkMock: vi.fn(),
  runClaimedScreenChunkMock: vi.fn(),
}));

vi.mock('@/lib/server/enrichmentJobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/enrichmentJobs')>()),
  runClaimedChunk: runClaimedChunkMock,
  runClaimedScreenChunk: runClaimedScreenChunkMock,
}));

import { POST } from './route';

let db: Db;
let close: () => Promise<void>;

const done = { outcome: 'done', progressBefore: 0, progressAfter: 1, remaining: 0, rearmed: false };

function tick(jobId: string): Promise<Response> {
  return POST(
    new Request('http://test/api/enrich/tick', {
      method: 'POST',
      headers: { authorization: 'Bearer test-cron-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ job_id: jobId }),
    })
  );
}

beforeEach(async () => {
  ({ db, close } = await makeTestDb());
  _setDbForTests(db);
  _resetDebugCache();
  vi.stubEnv('CRON_SECRET', 'test-cron-secret');
  runClaimedChunkMock.mockReset().mockResolvedValue(done);
  runClaimedScreenChunkMock.mockReset().mockResolvedValue(done);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  _setDbForTests(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await close();
});

describe('POST /api/enrich/tick dispatches on kind', () => {
  it('runs the screen chunk for a screen job and never the book chunk', async () => {
    await db.insert(enrichJobs).values({
      jobId: 'screen-1',
      userId: 'owner',
      kind: 'screen',
      status: 'pending',
      progress: 0,
      total: 0,
    });
    const response = await tick('screen-1');
    expect(await response.json()).toEqual({ claimed: true, outcome: 'done' });
    expect(runClaimedChunkMock).not.toHaveBeenCalled();
    expect(runClaimedScreenChunkMock.mock.calls).toEqual([
      [
        expect.anything(),
        expect.objectContaining({ jobId: 'screen-1', kind: 'screen', userId: 'owner' }),
        expect.objectContaining({ runBatch: expect.any(Function), dispatch: expect.any(Function) }),
      ],
    ]);
  });

  it('runs the book chunk for a book job and never the screen chunk', async () => {
    await db.insert(enrichJobs).values({
      jobId: 'book-1',
      userId: 'owner',
      status: 'pending',
      progress: 0,
      total: 0,
    });
    await tick('book-1');
    expect(runClaimedScreenChunkMock).not.toHaveBeenCalled();
    expect(runClaimedChunkMock).toHaveBeenCalledTimes(1);
  });
});
```

Run: `npx vitest run app/api/enrich/tick/screen.test.ts`
Expected: FAIL in `runs the screen chunk for a screen job…`, because the book chunk ran instead.

- [ ] **Step 4: Dispatch on `kind` in the tick route**

In `app/api/enrich/tick/route.ts`, replace the `enrichmentJobs` import with:

```ts
import {
  claimJob,
  oneBookEnrichmentRunner,
  runClaimedChunk,
  runClaimedScreenChunk,
  screenEnrichmentRunner,
} from '@/lib/server/enrichmentJobs';
```

and replace the `const result = await runClaimedChunk(…);` statement with:

```ts
    const dispatch = async (jobId: string) => {
      rearmAfterResponse(request, jobId);
    };
    // Shared by both kinds (spec §4.6): the claimed row says which chunk to run.
    const result =
      claimedRow.kind === 'screen'
        ? await runClaimedScreenChunk(db, claimedRow, {
            nowMs: () => Date.now(),
            runBatch: screenEnrichmentRunner(claimedRow.userId),
            dispatch,
          })
        : await runClaimedChunk(db, claimedRow, {
            nowMs: () => Date.now(),
            runOne: oneBookEnrichmentRunner(claimedRow.userId),
            dispatch,
          });
```

Run: `npx vitest run app/api/enrich/tick`
Expected: PASS, including every test in the existing `route.test.ts`, **unedited**.

- [ ] **Step 5: Write the failing start and active route tests**

Create `app/api/screen/enrich/start/route.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTestDb } from '@/lib/server/__tests__/helpers/pglite';
import { _resetDebugCache } from '@/lib/server/config';
import { _setDbForTests, schema, type Db } from '@/lib/server/db';
import { _setDispatchForTests } from '@/lib/server/enrichmentDispatch';
import { SCREEN_DISABLED_MESSAGE } from '@/lib/server/screenSettings';

const { runClaimedScreenChunkMock } = vi.hoisted(() => ({ runClaimedScreenChunkMock: vi.fn() }));

vi.mock('@/lib/server/enrichmentJobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/enrichmentJobs')>()),
  runClaimedScreenChunk: runClaimedScreenChunkMock,
}));

import { POST } from './route';

let db: Db;
let close: () => Promise<void>;

function start(body: string | undefined = '{}'): Promise<Response> {
  return POST(
    new Request('http://test/api/screen/enrich/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
  );
}

async function enableScreen(userId = 'local') {
  await db.insert(schema.userSettings).values({ userId, screenEnabled: true });
}

beforeEach(async () => {
  ({ db, close } = await makeTestDb());
  _setDbForTests(db);
  _resetDebugCache();
  _setDispatchForTests({ schedule: () => undefined });
  vi.stubEnv('CRON_SECRET', 'test-cron-secret');
  runClaimedScreenChunkMock.mockReset().mockResolvedValue({
    outcome: 'continued',
    progressBefore: 0,
    progressAfter: 1,
    remaining: 1,
    rearmed: true,
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  _setDbForTests(null);
  _setDispatchForTests(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await close();
});

describe('POST /api/screen/enrich/start', () => {
  it('answers 403 and creates nothing while ScreenSprite is off', async () => {
    const response = await start();
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 403,
      body: { detail: SCREEN_DISABLED_MESSAGE },
    });
    expect(await db.select().from(schema.enrichJobs)).toEqual([]);
  });

  it('rejects a body that is not JSON or has the wrong types', async () => {
    await enableScreen();
    expect((await start('nope')).status).toBe(422);
    expect((await start(JSON.stringify({ force: 'yes' }))).status).toBe(422);
    expect(runClaimedScreenChunkMock).not.toHaveBeenCalled();
  });

  it('creates a screen job, runs one chunk inline and returns the job', async () => {
    await enableScreen();
    const response = await start(JSON.stringify({ force: true }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: 'running', progress: 0, total: 0, error: null });
    const [row] = await db.select().from(schema.enrichJobs);
    expect([row.jobId, row.kind, row.userId, row.force]).toEqual([body.job_id, 'screen', 'local', true]);
    expect(runClaimedScreenChunkMock).toHaveBeenCalledTimes(1);
  });

  it('is not blocked by an active book job', async () => {
    await enableScreen();
    await db.insert(schema.enrichJobs).values({
      jobId: 'book',
      userId: 'local',
      status: 'running',
      progress: 0,
      total: 0,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const body = await (await start()).json();
    expect(body.job_id).not.toBe('book');
    expect(runClaimedScreenChunkMock).toHaveBeenCalledTimes(1);
  });

  it('is rate limited per user with the normal detail shape', async () => {
    await enableScreen();
    const statuses: number[] = [];
    let last: Response | null = null;
    for (let i = 0; i < 6; i += 1) {
      last = await start();
      statuses.push(last.status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    expect(await last!.json()).toEqual({
      detail: 'Too many enrichment starts. Try again in a minute.',
    });
  });

  it("leaves another user's screen job alone", async () => {
    await enableScreen();
    await db.insert(schema.enrichJobs).values({
      jobId: 'theirs',
      userId: 'other',
      kind: 'screen',
      status: 'pending',
      progress: 0,
      total: 0,
    });
    await start();
    const [theirs] = await db
      .select()
      .from(schema.enrichJobs)
      .where(eq(schema.enrichJobs.jobId, 'theirs'));
    expect([theirs.status, theirs.attempts]).toEqual(['pending', 0]);
  });
});
```

Create `app/api/screen/enrich/active/route.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTestDb } from '@/lib/server/__tests__/helpers/pglite';
import { _resetDebugCache } from '@/lib/server/config';
import { _setDbForTests, schema, type Db } from '@/lib/server/db';
import { SCREEN_DISABLED_MESSAGE } from '@/lib/server/screenSettings';
import { GET } from './route';

let db: Db;
let close: () => Promise<void>;
const active = () => GET(new Request('http://test/api/screen/enrich/active'));

beforeEach(async () => {
  ({ db, close } = await makeTestDb());
  _setDbForTests(db);
  _resetDebugCache();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  _setDbForTests(null);
  vi.restoreAllMocks();
  await close();
});

describe('GET /api/screen/enrich/active', () => {
  it('answers 403 while ScreenSprite is off', async () => {
    const response = await active();
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 403,
      body: { detail: SCREEN_DISABLED_MESSAGE },
    });
  });

  it("returns only the caller's active screen job", async () => {
    await db.insert(schema.userSettings).values({ userId: 'local', screenEnabled: true });
    expect(await (await active()).json()).toEqual({ job: null });
    await db.insert(schema.enrichJobs).values([
      { jobId: 'book', userId: 'local', status: 'running', progress: 0, total: 0 },
      { jobId: 'theirs', userId: 'other', kind: 'screen', status: 'running', progress: 0, total: 0 },
      { jobId: 'old', userId: 'local', kind: 'screen', status: 'done', progress: 3, total: 3 },
    ]);
    expect(await (await active()).json()).toEqual({ job: null });
    await db.insert(schema.enrichJobs).values({
      jobId: 'mine',
      userId: 'local',
      kind: 'screen',
      status: 'pending',
      progress: 0,
      total: 0,
    });
    expect(await (await active()).json()).toEqual({
      job: {
        job_id: 'mine',
        status: 'pending',
        progress: 0,
        total: 0,
        error: null,
        started_at: null,
        finished_at: null,
      },
    });
  });
});
```

Run: `npx vitest run app/api/screen/enrich`
Expected: FAIL, because the route modules do not exist.

- [ ] **Step 6: Add the rate limits**

In `lib/server/ratelimit.ts`, inside `RATE_LIMITS`, directly after wave 4's `screenImport` entry:

```ts
  /**
   * No Python ancestor (like inviteRequest): the screen routes answer a blocked request with
   * ApiError(429, …) and the normal {"detail": …} shape, never rateLimitExceededResponse.
   */
  screenEnrichStart: { limit: 5, windowSeconds: 60 },
  screenSearch: { limit: 30, windowSeconds: 60 },
```

If a rate-limit test enumerates the `RATE_LIMITS` keys exactly, add both keys to its expectation. That is an intended addition, not a weakened assertion.

- [ ] **Step 7: Write the two routes**

Create `app/api/screen/enrich/start/route.ts`:

```ts
import { z } from 'zod';
import { getDb } from '@/lib/server/db';
import { ApiError, withApi } from '@/lib/server/http';
import { checkRateLimit, RATE_LIMITS } from '@/lib/server/ratelimit';
import { startScreenEnrichment } from '@/lib/server/screenJobs';
import { requireScreenEnabled } from '@/lib/server/screenSettings';

const Body = z.object({
  force: z.boolean().default(false),
  limit: z.number().int().positive().nullable().default(null),
});

// Next.js requires a statically analyzable literal here -- an imported binding fails the build
// with "Invalid segment configuration export detected". Must stay equal to
// FUNCTION_CEILING_SECONDS in lib/server/enrichmentJobs.ts; enrich-max-duration.test.ts asserts it.
export const maxDuration = 300;

/** Start or resume the screen enrichment job (spec §4.6); "Retry enrichment" in settings. */
export const POST = withApi('/api/screen/enrich/start', async (req, ctx) => {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiError(422, 'request body must be JSON');
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(
      422,
      `validation error: ${parsed.error.issues[0]?.message ?? 'invalid body'}`
    );
  }
  const db = getDb();
  await requireScreenEnabled(db, ctx.user.userId);
  const rateLimit = await checkRateLimit(db, {
    key: `screenEnrichStart:${ctx.user.userId}`,
    ...RATE_LIMITS.screenEnrichStart,
  });
  if (!rateLimit.allowed) {
    throw new ApiError(429, 'Too many enrichment starts. Try again in a minute.');
  }
  const job = await startScreenEnrichment(db, req, ctx.user.userId, parsed.data);
  ctx.timer.mark('db');
  return Response.json(job);
});
```

Create `app/api/screen/enrich/active/route.ts`:

```ts
import { getDb } from '@/lib/server/db';
import { failIfStale, findActiveJob, serializeJob } from '@/lib/server/enrichmentJobs';
import { withApi } from '@/lib/server/http';
import { requireScreenEnabled } from '@/lib/server/screenSettings';

/**
 * The caller's active screen job, so a reload or a reopened import modal recovers its
 * progress view (spec §4.6, §7.4). Progress then polls the shared
 * GET /api/enrich/status/{job_id}. A stale job comes back as the error it now is.
 */
export const GET = withApi('/api/screen/enrich/active', async (_req, ctx) => {
  const db = getDb();
  await requireScreenEnabled(db, ctx.user.userId);
  const found = await findActiveJob(db, ctx.user.userId, 'screen');
  const job = found ? serializeJob(await failIfStale(db, found, new Date())) : null;
  ctx.timer.mark('db');
  return Response.json({ job });
});
```

Add the start route to the literal-`maxDuration` guard. In `app/api/enrich/enrich-max-duration.test.ts`, replace the `ROUTES` line with:

```ts
const ROUTES = ['./start/route.ts', './tick/route.ts', '../screen/enrich/start/route.ts'] as const;
```

The paths resolve against `app/api/enrich/` through `import.meta.url`.

Run: `npx vitest run app/api/screen/enrich app/api/enrich/enrich-max-duration.test.ts lib/server/__tests__/ratelimit.test.ts lib/server/__tests__/ratelimit-routes.test.ts`
Expected: PASS.

- [ ] **Step 8: The import route queues the job (and Exception 2)**

In `app/api/screen/import/route.ts`, add `import { queueScreenEnrichment } from '@/lib/server/screenJobs';` to the imports. Then replace

```ts
    const counts = await importLetterboxdFilms(db, ctx.user.userId, films);
    ctx.timer.mark('db');
    return Response.json(counts);
```

with

```ts
    const counts = await importLetterboxdFilms(db, ctx.user.userId, films);
    // Spec §3.4 "After import": queue the screen job; its first chunk runs after the response
    // (design decision 11). An active screen job is reused and picks up the new titles itself.
    const job = await queueScreenEnrichment(db, req, ctx.user.userId);
    ctx.timer.mark('db');
    return Response.json({ ...counts, job });
```

Update the route's doc comment: replace "Wave 5 starts a screen enrichment job here and adds `job`." with "It then queues the screen enrichment job and returns it as `job`."

In `lib/server/__tests__/screen-import-routes.test.ts`, change only these five things:

1. Add `vi` to the `vitest` import. Add `import { _setDispatchForTests } from '../enrichmentDispatch';`.
2. Declare `let scheduled: number;` beside `db`. At the end of `beforeEach`, add:

   ```ts
   scheduled = 0;
   _setDispatchForTests({ schedule: () => void (scheduled += 1) });
   vi.stubEnv('CRON_SECRET', 'test-cron-secret');
   ```

   At the start of `afterEach`, add `_setDispatchForTests(null); vi.unstubAllEnvs();`.
3. In `imports the synthetic export, enables screen, and reports counts`, replace the two count assertions:

   ```ts
   const first = await res.json();
   expect(first).toEqual({
     inserted: 6,
     updated: 0,
     unchanged: 0,
     job: expect.objectContaining({ status: 'pending', progress: 0, total: 0 }),
   });
   ```

   Replace the second import's assertion the same way, using `{ inserted: 0, updated: 0, unchanged: 6, job: … }`. After it, add:

   ```ts
   expect(second.job.job_id).toBe(first.job.job_id); // the active screen job is reused
   expect(scheduled).toBe(1);
   const jobs = await db.select().from(schema.enrichJobs);
   expect(jobs.map((j) => [j.kind, j.userId])).toEqual([['screen', 'local']]);
   ```

   Here `const second = await again.json();` replaces the inline `await again.json()`.
4. In `rejects a missing file, a non-zip name, …`, after `expect(state.enabled).toBe(false);`, add `expect(await db.select().from(schema.enrichJobs)).toEqual([]); // a failed import queues nothing`.
5. Nothing else. `is rate limited per user` and the tenancy test pass unchanged. The job is reused across the five successful imports.

Run: `npx vitest run lib/server/__tests__/screen-import-routes.test.ts`
Expected: PASS.

- [ ] **Step 9: Mutation check**

In `startScreenEnrichment`, replace `const claimed = await claimJob(db, job.job_id, new Date());` with `const claimed = created ? await claimJob(db, job.job_id, new Date()) : null;`. You also have to destructure `created`; that is the book route's behaviour.

Run `screen-jobs-queue.test.ts`.
Expected: FAIL in `claims a stranded pending job that it did not create`. Restore it and re-run: PASS.

- [ ] **Step 10: Commit**

```bash
git add lib/server/screenJobs.ts lib/server/__tests__/screen-jobs-queue.test.ts lib/server/ratelimit.ts app/api/enrich/tick/route.ts app/api/enrich/tick/screen.test.ts app/api/screen/enrich app/api/enrich/enrich-max-duration.test.ts app/api/screen/import/route.ts lib/server/__tests__/screen-import-routes.test.ts
git commit -m "feat(screen): screen enrichment start, active and tick routes; import queues the job (#96)"
```

---

### Task 11: Catalog search and manual add

**Files:**
- Create: `app/api/screen/search/route.ts`
- Test: `app/api/screen/search/route.test.ts`
- Modify: `app/api/screen/titles/route.ts` (wave 4 file; add `POST` beside `GET`)
- Test: `app/api/screen/titles/add.test.ts`
- Modify: `lib/server/screenEnrichment.ts` (append `isTitleIdentityViolation`)

**Interfaces:**
- Consumes: `searchMovies`, `searchShows`, `ScreenCandidateSchema`, `candidateEnrichmentValues`, `findIdentityClash` (Tasks 6–8); `deadlineIn` (Task 3); `RATE_LIMITS.screenSearch` (Task 10); `requireScreenEnabled`, `titleOut`, `MEDIA_TYPES`, `TITLE_STATUSES` (wave 4); `isValidRating`; `serializeResolutionConfidence`, `utcnowTs`.
- Produces, relied on by Task 12 and wave 8:
  - `GET /api/screen/search?q=<1–200 chars>&type=movie|tv` returns `ScreenCandidate[]`, at most `SEARCH_LIMIT`. A catalog failure answers 503 and never an empty list, because "nothing found" and "could not ask" must look different to the user (spec §4.1).
  - `POST /api/screen/titles` with body `{ candidate: ScreenCandidate, status, rating?, review? }` returns 201 with a `TitleOut`. The title gets `identity_source = 'manual'`, label `HIGH` and `match_method = 'manual_add'` (spec §3.5).
  - `export function isTitleIdentityViolation(error: unknown): boolean`: true when an insert or update hit `uq_titles_user_wikidata_qid` or `uq_titles_user_tvmaze_id`.

Rules for manual add, mirroring `POST /api/books`:
- **Rating.** Optional, and `0` means unrated. Off the half-star grid answers 422 with the manual guard's message.
- **Review.** A review requires a rating (decision 16), except on a `dropped` title. Spec §3.2 exempts dropped, and so does wave 4's PATCH, so a dropped title added with a review is not rejected here only to be accepted one PATCH later.
- **Identity.** A movie needs `wikidata_qid`; a show needs `tvmaze_id`. A movie's `tvmaze_id` is forced to null. A show keeps its crosswalked QID (design decision 8).
- **Duplicates.**
  - The pre-check is `findIdentityClash` on either id, scoped to the caller.
  - The partial unique indexes catch a request that raced past it.
  - Both answer 409 with `"<title>" is already in your ScreenSprite library.` (Review Focus 5).
- **`feedback_updated_at`** is stamped when the add carries a rating or a review, as for books.

- [ ] **Step 1: Write the failing search test**

Create `app/api/screen/search/route.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTestDb } from '@/lib/server/__tests__/helpers/pglite';
import { _resetDebugCache } from '@/lib/server/config';
import { _setDbForTests, schema, type Db } from '@/lib/server/db';
import { SCREEN_DISABLED_MESSAGE } from '@/lib/server/screenSettings';

const { searchMoviesMock, searchShowsMock } = vi.hoisted(() => ({
  searchMoviesMock: vi.fn(),
  searchShowsMock: vi.fn(),
}));

vi.mock('@/lib/server/screenEnrichment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/screenEnrichment')>()),
  searchMovies: searchMoviesMock,
  searchShows: searchShowsMock,
}));

import { GET } from './route';

let db: Db;
let close: () => Promise<void>;
const search = (query: string) => GET(new Request(`http://test/api/screen/search?${query}`));
const HIT = { media_type: 'movie', title: 'Heat', year: 1995, wikidata_qid: 'Q1' };

beforeEach(async () => {
  ({ db, close } = await makeTestDb());
  _setDbForTests(db);
  _resetDebugCache();
  searchMoviesMock.mockReset().mockResolvedValue({ kind: 'ok', value: [HIT] });
  searchShowsMock.mockReset().mockResolvedValue({ kind: 'ok', value: [] });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  _setDbForTests(null);
  vi.restoreAllMocks();
  await close();
});

async function enable() {
  await db.insert(schema.userSettings).values({ userId: 'local', screenEnabled: true });
}

describe('GET /api/screen/search', () => {
  it('answers 403 while ScreenSprite is off', async () => {
    const response = await search('q=heat&type=movie');
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 403,
      body: { detail: SCREEN_DISABLED_MESSAGE },
    });
    expect(searchMoviesMock).not.toHaveBeenCalled();
  });

  it.each(['type=movie', 'q=%20%20&type=movie', `q=${'x'.repeat(201)}&type=movie`, 'q=heat&type=book'])(
    'rejects %s with 422',
    async (query) => {
      await enable();
      const response = await search(query);
      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 422,
        body: { detail: "q must be 1 to 200 characters; type must be 'movie' or 'tv'." },
      });
    }
  );

  it('routes movies and shows to their searches with a trimmed query and a deadline', async () => {
    await enable();
    const movies = await search('q=%20Heat%201995%20&type=movie');
    expect(await movies.json()).toEqual([HIT]);
    expect(searchMoviesMock.mock.calls[0][1]).toBe('Heat 1995');
    expect(searchMoviesMock.mock.calls[0][2].remainingMs()).toBeGreaterThan(20_000);
    await search('q=severance&type=tv');
    expect(searchShowsMock.mock.calls[0][1]).toBe('severance');
  });

  it('answers 503, never an empty list, when the catalog cannot be asked', async () => {
    await enable();
    searchMoviesMock.mockResolvedValue({ kind: 'retryable', reason: 'HTTP 503' });
    const response = await search('q=heat&type=movie');
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 503,
      body: { detail: 'The catalog did not answer in time. Try the search again.' },
    });
  });

  it('is rate limited per user', async () => {
    await enable();
    const statuses: number[] = [];
    for (let i = 0; i < 31; i += 1) statuses.push((await search('q=heat&type=movie')).status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(30);
    expect(statuses[30]).toBe(429);
  });
});
```

Run: `npx vitest list app/api/screen/search/route.test.ts` (expect it listed), then `npx vitest run app/api/screen/search/route.test.ts`.
Expected: FAIL, because `./route` does not exist.

- [ ] **Step 2: Write the search route**

Create `app/api/screen/search/route.ts`:

```ts
import { z } from 'zod';
import { getDb } from '@/lib/server/db';
import { ApiError, withApi } from '@/lib/server/http';
import { checkRateLimit, RATE_LIMITS } from '@/lib/server/ratelimit';
import { deadlineIn } from '@/lib/server/screenCatalog';
import { searchMovies, searchShows } from '@/lib/server/screenEnrichment';
import { requireScreenEnabled } from '@/lib/server/screenSettings';
import { MEDIA_TYPES } from '@/lib/server/titles';

/**
 * A cold movie search is Stage A + wbsearchentities + entity and label hops + up to ten
 * Wikipedia summaries at 250 ms spacing: about 5-8 s. The deadline stops it well short of
 * any platform limit; what it cannot finish becomes a 503, never a short list.
 */
const SEARCH_DEADLINE_MS = 25_000;

const Query = z.object({
  q: z.string().trim().min(1).max(200),
  type: z.enum(MEDIA_TYPES),
});

/** Manual-add and correction search (spec §3.5): Wikidata for movies, TVmaze + Wikidata for TV. */
export const GET = withApi('/api/screen/search', async (req, ctx) => {
  const url = new URL(req.url);
  const parsed = Query.safeParse({
    q: url.searchParams.get('q') ?? '',
    type: url.searchParams.get('type') ?? '',
  });
  if (!parsed.success) {
    throw new ApiError(422, "q must be 1 to 200 characters; type must be 'movie' or 'tv'.");
  }
  const db = getDb();
  await requireScreenEnabled(db, ctx.user.userId);
  const rateLimit = await checkRateLimit(db, {
    key: `screenSearch:${ctx.user.userId}`,
    ...RATE_LIMITS.screenSearch,
  });
  if (!rateLimit.allowed) throw new ApiError(429, 'Too many searches. Try again in a minute.');

  const deadline = deadlineIn(SEARCH_DEADLINE_MS);
  const { q, type } = parsed.data;
  const result =
    type === 'movie' ? await searchMovies(db, q, deadline) : await searchShows(db, q, deadline);
  ctx.timer.mark('catalog');
  if (result.kind === 'retryable') {
    throw new ApiError(503, 'The catalog did not answer in time. Try the search again.');
  }
  return Response.json(result.kind === 'ok' ? result.value : []);
});
```

Run: `npx vitest run app/api/screen/search/route.test.ts`
Expected: PASS.

- [ ] **Step 3: Write the failing manual-add test**

Create `app/api/screen/titles/add.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTestDb } from '@/lib/server/__tests__/helpers/pglite';
import { _resetDebugCache } from '@/lib/server/config';
import { _setDbForTests, schema, type Db } from '@/lib/server/db';
import { SCREEN_DISABLED_MESSAGE } from '@/lib/server/screenSettings';

// Lets one test skip the pre-check so the insert meets the unique index (Review Focus 5).
const { race } = vi.hoisted(() => ({ race: { skipNextPrecheck: false } }));

vi.mock('@/lib/server/screenEnrichment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/screenEnrichment')>();
  return {
    ...actual,
    findIdentityClash: async (...args: Parameters<typeof actual.findIdentityClash>) => {
      if (race.skipNextPrecheck) {
        race.skipNextPrecheck = false;
        return null;
      }
      return actual.findIdentityClash(...args);
    },
  };
});

import { POST } from './route';

let db: Db;
let close: () => Promise<void>;

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    media_type: 'movie',
    title: 'Heat',
    year: 1995,
    wikidata_qid: 'Q1',
    tvmaze_id: null,
    image_url: 'https://upload.wikimedia.org/wikipedia/en/a/a1/Heat.jpg',
    description: 'A crime film.',
    description_source: 'wikipedia',
    description_url: 'https://en.wikipedia.org/wiki/Heat_(1995_film)',
    wikipedia_page: 'Heat (1995 film)',
    genres: ['crime film'],
    directors: ['A Director'],
    creators: [],
    writers: ['A Writer'],
    countries: ['United States'],
    original_language: 'en',
    based_on: [],
    main_subjects: [],
    series: [],
    production_companies: [{ qid: 'Q2', label: 'A Studio' }],
    sitelinks: 60,
    ...overrides,
  };
}

const show = (overrides: Record<string, unknown> = {}) =>
  candidate({
    media_type: 'tv',
    title: 'Severance',
    year: 2022,
    wikidata_qid: 'Q97',
    tvmaze_id: 44933,
    image_url: 'https://static.tvmaze.com/uploads/images/medium_portrait/1/1.jpg',
    description_source: 'tvmaze',
    description_url: 'https://www.tvmaze.com/shows/44933/severance',
    ...overrides,
  });

function add(body: unknown): Promise<Response> {
  return POST(
    new Request('http://test/api/screen/titles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

async function enable() {
  await db.insert(schema.userSettings).values({ userId: 'local', screenEnabled: true });
}

beforeEach(async () => {
  ({ db, close } = await makeTestDb());
  _setDbForTests(db);
  _resetDebugCache();
  race.skipNextPrecheck = false;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  _setDbForTests(null);
  vi.restoreAllMocks();
  await close();
});

describe('POST /api/screen/titles (manual add)', () => {
  it('answers 403 while ScreenSprite is off', async () => {
    const response = await add({ candidate: candidate(), status: 'watched' });
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 403,
      body: { detail: SCREEN_DISABLED_MESSAGE },
    });
  });

  it('adds a rated movie with a manual HIGH identity and the candidate metadata', async () => {
    await enable();
    const response = await add({ candidate: candidate(), status: 'watched', rating: 4.5 });
    const body = await response.json();
    expect(response.status).toBe(201);
    expect(body).toMatchObject({
      media_type: 'movie',
      title: 'Heat',
      year: 1995,
      status: 'watched',
      rating: 4.5,
      app_rating: 4.5,
      letterboxd_rating: null,
      wikidata_qid: 'Q1',
      tvmaze_id: null,
      enrichment: {
        confidence_label: 'HIGH',
        match_method: 'manual_add',
        identity_source: 'manual',
        genres: ['crime film'],
        directors: ['A Director'],
        duplicate_of_title_id: null,
      },
    });
    const [row] = await db.select().from(schema.titles);
    expect([row.userId, row.feedbackUpdatedAt === null]).toEqual(['local', false]);
    const [enr] = await db.select().from(schema.titleEnrichment);
    expect([enr.titleId, enr.writers, enr.productionCompanies]).toEqual([
      row.id,
      ['A Writer'],
      [{ qid: 'Q2', label: 'A Studio' }],
    ]);
  });

  it('adds a show by its TVmaze id and keeps its crosswalked QID', async () => {
    await enable();
    const body = await (await add({ candidate: show(), status: 'watching' })).json();
    expect([body.media_type, body.tvmaze_id, body.wikidata_qid]).toEqual(['tv', 44933, 'Q97']);
  });

  it('forces a movie tvmaze_id to null', async () => {
    await enable();
    const body = await (await add({ candidate: candidate({ tvmaze_id: 7 }), status: 'want' })).json();
    expect(body.tvmaze_id).toBeNull();
    const [enr] = await db.select().from(schema.titleEnrichment);
    expect(enr.tvmazeId).toBeNull();
  });

  it('treats a missing or 0 rating as unrated, and rejects an off-grid rating', async () => {
    await enable();
    const unrated = await (await add({ candidate: candidate(), status: 'want', rating: 0 })).json();
    expect([unrated.rating, unrated.app_rating]).toEqual([null, null]);
    const [row] = await db.select().from(schema.titles);
    expect(row.feedbackUpdatedAt).toBeNull();
    const off = await add({ candidate: candidate({ wikidata_qid: 'Q3' }), status: 'watched', rating: 4.3 });
    expect({ status: off.status, body: await off.json() }).toEqual({
      status: 422,
      body: { detail: 'rating must be 0.5 to 5 in half-star steps (or omitted/0 for unrated).' },
    });
  });

  it('requires a rating for a review, except on a dropped title', async () => {
    await enable();
    const rejected = await add({ candidate: candidate(), status: 'watched', review: 'Tense.' });
    expect({ status: rejected.status, body: await rejected.json() }).toEqual({
      status: 422,
      body: { detail: 'A review requires a rating (0.5 to 5). Rate the title, or omit the review.' },
    });
    const dropped = await add({ candidate: candidate(), status: 'dropped', review: 'Gave up.' });
    expect(dropped.status).toBe(201);
    expect((await dropped.json()).review).toBe('Gave up.');
  });

  it('rejects a candidate without its identity, or with an image off the allowed hosts', async () => {
    await enable();
    const noQid = await add({ candidate: candidate({ wikidata_qid: null }), status: 'watched' });
    expect({ status: noQid.status, body: await noQid.json() }).toEqual({
      status: 422,
      body: { detail: 'A movie needs its Wikidata id. Pick it from the search results.' },
    });
    const noTvmaze = await add({ candidate: show({ tvmaze_id: null }), status: 'watched' });
    expect({ status: noTvmaze.status, body: await noTvmaze.json() }).toEqual({
      status: 422,
      body: { detail: 'A show needs its TVmaze id. Pick it from the search results.' },
    });
    const badImage = await add({
      candidate: candidate({ image_url: 'https://evil.example/poster.jpg' }),
      status: 'watched',
    });
    expect(badImage.status).toBe(422);
    expect(await db.select().from(schema.titles)).toEqual([]);
  });

  it('answers 409 for a title already in the library, by QID or by TVmaze id', async () => {
    await enable();
    expect((await add({ candidate: candidate(), status: 'watched' })).status).toBe(201);
    const again = await add({ candidate: candidate({ title: 'Heat (1995)' }), status: 'want' });
    expect({ status: again.status, body: await again.json() }).toEqual({
      status: 409,
      body: { detail: '"Heat (1995)" is already in your ScreenSprite library.' },
    });
    expect((await add({ candidate: show(), status: 'watching' })).status).toBe(201);
    const sameShow = await add({ candidate: show({ wikidata_qid: null }), status: 'watched' });
    expect(sameShow.status).toBe(409);
  });

  it('answers 409 when the unique index catches a racing duplicate', async () => {
    await enable();
    expect((await add({ candidate: candidate(), status: 'watched' })).status).toBe(201);
    race.skipNextPrecheck = true; // as if the first request committed after this one checked
    const raced = await add({ candidate: candidate(), status: 'watched' });
    expect({ status: raced.status, body: await raced.json() }).toEqual({
      status: 409,
      body: { detail: '"Heat" is already in your ScreenSprite library.' },
    });
    expect(await db.select().from(schema.titles)).toHaveLength(1);
    expect(await db.select().from(schema.titleEnrichment)).toHaveLength(1);
  });

  it("does not treat another user's copy of the film as a clash", async () => {
    await enable();
    await db.insert(schema.titles).values({
      userId: 'other',
      mediaType: 'movie',
      title: 'Heat',
      status: 'watched',
      wikidataQid: 'Q1',
    });
    expect((await add({ candidate: candidate(), status: 'watched' })).status).toBe(201);
    const [theirs] = await db.select().from(schema.titles).where(eq(schema.titles.userId, 'other'));
    expect(theirs.wikidataQid).toBe('Q1');
  });
});
```

Run: `npx vitest list app/api/screen/titles/add.test.ts` (expect it listed), then `npx vitest run app/api/screen/titles/add.test.ts`.
Expected: FAIL, because `POST` is not exported from `./route`.

- [ ] **Step 4: Append the identity-violation helper**

At the end of `lib/server/screenEnrichment.ts`:

```ts
/**
 * True when a write hit a title identity index: two requests raced past findIdentityClash.
 * drizzle wraps the driver error, so the constraint name may sit on a cause.
 */
export function isTitleIdentityViolation(error: unknown): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if (
      e.message.includes('uq_titles_user_wikidata_qid') ||
      e.message.includes('uq_titles_user_tvmaze_id')
    ) {
      return true;
    }
  }
  return false;
}
```

- [ ] **Step 5: Add `POST` to `app/api/screen/titles/route.ts`**

Merge these into the existing imports (keep wave 4's):

```ts
import { isValidRating } from '@/lib/server/rating';
import {
  candidateEnrichmentValues,
  findIdentityClash,
  isTitleIdentityViolation,
  ScreenCandidateSchema,
} from '@/lib/server/screenEnrichment';
import { serializeResolutionConfidence, utcnowTs } from '@/lib/server/serialize';
```

and `TITLE_STATUSES` is already imported from `@/lib/server/titles`. Then append:

```ts
const AddTitle = z.object({
  candidate: ScreenCandidateSchema,
  status: z.enum(TITLE_STATUSES),
  // Permissive z.number() on purpose: the manual isValidRating guard owns the 422 (CLAUDE.md).
  rating: z.number().nullish(),
  review: z.string().nullish(),
});

/** Manual add (spec §3.5): the user's pick fixes identity at once. */
export const POST = withApi('/api/screen/titles', async (req, ctx) => {
  const parsed = AddTitle.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError(
      422,
      `validation error: ${parsed.error.issues[0]?.message ?? 'invalid body'}`
    );
  }
  const { candidate, status, rating } = parsed.data;
  // 0 is the "unrated" sentinel on the wire, never a stored rating.
  if (rating != null && rating !== 0 && !isValidRating(rating)) {
    throw new ApiError(
      422,
      'rating must be 0.5 to 5 in half-star steps (or omitted/0 for unrated).'
    );
  }
  const rated = rating != null && rating !== 0;
  const review = (parsed.data.review ?? '').trim() || null;
  // Decision 16 mirrors AddBookModal; spec §3.2 exempts dropped, as wave 4's PATCH does.
  if (review && !rated && status !== 'dropped') {
    throw new ApiError(
      422,
      'A review requires a rating (0.5 to 5). Rate the title, or omit the review.'
    );
  }
  const tvmazeId = candidate.media_type === 'tv' ? candidate.tvmaze_id : null;
  if (candidate.media_type === 'movie' && !candidate.wikidata_qid) {
    throw new ApiError(422, 'A movie needs its Wikidata id. Pick it from the search results.');
  }
  if (candidate.media_type === 'tv' && tvmazeId === null) {
    throw new ApiError(422, 'A show needs its TVmaze id. Pick it from the search results.');
  }

  const db = getDb();
  const userId = ctx.user.userId;
  await requireScreenEnabled(db, userId);
  const duplicate = `"${candidate.title}" is already in your ScreenSprite library.`;
  // Title ids are serial from 1, so 0 excludes nothing.
  if (await findIdentityClash(db, userId, 0, candidate.wikidata_qid, tvmazeId)) {
    throw new ApiError(409, duplicate);
  }

  const now = utcnowTs();
  let created;
  try {
    created = await db.transaction(async (tx) => {
      const [title] = await tx
        .insert(schema.titles)
        .values({
          userId,
          mediaType: candidate.media_type,
          title: candidate.title,
          year: candidate.year,
          status,
          appRating: rated ? rating : null,
          appReview: review,
          wikidataQid: candidate.wikidata_qid,
          tvmazeId,
          feedbackUpdatedAt: rated || review ? now : null,
          updatedAt: now,
        })
        .returning();
      const [enr] = await tx
        .insert(schema.titleEnrichment)
        .values({
          titleId: title.id,
          ...candidateEnrichmentValues(candidate),
          tvmazeId,
          resolutionConfidence: serializeResolutionConfidence('HIGH'),
          confidenceLabel: 'HIGH',
          matchMethod: 'manual_add',
          identitySource: 'manual',
          duplicateOfTitleId: null,
          rawResponse: null,
          resolvedAt: now,
        })
        .returning();
      return { title, enr };
    });
  } catch (error) {
    if (isTitleIdentityViolation(error)) throw new ApiError(409, duplicate);
    throw error;
  }
  ctx.timer.mark('db');
  return Response.json(titleOut(created.title, created.enr), { status: 201 });
});
```

Run: `npx vitest run app/api/screen/titles lib/server/__tests__/screen-title-routes.test.ts`
Expected: PASS. Wave 4's `screen-title-routes.test.ts` passes unedited.

- [ ] **Step 6: Mutation check**

Delete the `if (isTitleIdentityViolation(error)) throw new ApiError(409, duplicate);` line. Run `add.test.ts`.
Expected: FAIL in `answers 409 when the unique index catches a racing duplicate`, with a 500. Restore it and re-run: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/api/screen/search app/api/screen/titles/route.ts app/api/screen/titles/add.test.ts lib/server/screenEnrichment.ts
git commit -m "feat(screen): catalog search and manual add for movies and shows (#96)"
```

---

### Task 12: Correcting a mis-resolved title

**Files:**
- Create: `app/api/screen/titles/[id]/correct/route.ts`
- Test: `app/api/screen/titles/[id]/correct/route.test.ts`

**Interfaces:**
- Consumes: `ScreenCandidateSchema`, `candidateEnrichmentValues`, `findIdentityClash`, `isTitleIdentityViolation`, `persistTitleResolution` (Tasks 6–8, 11); `ensureProfileMeta` (`lib/server/profileMeta.ts`); `requireScreenEnabled`, `titleOut` (wave 4).
- Produces, relied on by wave 8: `POST /api/screen/titles/[id]/correct` with body `{ candidate: ScreenCandidate }` returns a `TitleOut`.

Spec §4.4, in one tenant-scoped transaction, as `PATCH /api/books/[id]/enrichment` does:
- sets `titles.wikidata_qid` and `tvmaze_id` from the pick;
- sets `media_type` to the pick's type, so a Letterboxd entry that is really a show can be corrected into one;
- replaces the enrichment metadata;
- sets `confidence_label = 'CORRECTED'`, `identity_source = 'corrected'` and `match_method = 'user_correction'`;
- clears `duplicate_of_title_id`, because the user has now chosen;
- stamps `profile_meta.enrichment_corrected_at`.

The title's own `title`, `year`, ratings, review and status are not touched. The UI offers correction on LOW titles (spec §7.3), but the route accepts any owned title, as the book route does. A later forced job never overwrites the pick; Task 8 pins that in `persistTitleResolution`, and this task pins the end-to-end version.

- [ ] **Step 1: Write the failing test**

Create `app/api/screen/titles/[id]/correct/route.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTestDb } from '@/lib/server/__tests__/helpers/pglite';
import { _resetDebugCache } from '@/lib/server/config';
import { _setDbForTests, schema, type Db } from '@/lib/server/db';
import { persistTitleResolution, type ScreenCandidate } from '@/lib/server/screenEnrichment';
import { SCREEN_DISABLED_MESSAGE } from '@/lib/server/screenSettings';
import { POST } from './route';

let db: Db;
let close: () => Promise<void>;

function candidate(overrides: Partial<ScreenCandidate> = {}): ScreenCandidate {
  return {
    media_type: 'movie',
    title: 'Solaris',
    year: 1972,
    wikidata_qid: 'Q10',
    tvmaze_id: null,
    image_url: null,
    description: 'The right film.',
    description_source: 'wikipedia',
    description_url: 'https://en.wikipedia.org/wiki/Solaris_(1972_film)',
    wikipedia_page: 'Solaris (1972 film)',
    genres: ['science fiction film'],
    directors: ['A Director'],
    creators: [],
    writers: [],
    countries: [],
    original_language: 'ru',
    based_on: [{ qid: 'Q11', title: 'Solaris', author: 'A Novelist' }],
    main_subjects: [],
    series: [],
    production_companies: [],
    sitelinks: 50,
    ...overrides,
  };
}

function correct(id: number | string, body: unknown): Promise<Response> {
  return POST(
    new Request(`http://test/api/screen/titles/${id}/correct`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: { id: String(id) } }
  );
}

async function addTitle(values: Partial<typeof schema.titles.$inferInsert> = {}): Promise<number> {
  const [row] = await db
    .insert(schema.titles)
    .values({ userId: 'local', mediaType: 'movie', title: 'Solaris', year: 1972, status: 'watched', ...values })
    .returning({ id: schema.titles.id });
  return row.id;
}

async function lowEnrichment(titleId: number, extra: Partial<typeof schema.titleEnrichment.$inferInsert> = {}) {
  await db.insert(schema.titleEnrichment).values({
    titleId,
    wikidataQid: 'Q99',
    description: 'The wrong film.',
    resolutionConfidence: 0.3,
    confidenceLabel: 'LOW',
    matchMethod: 'wikidata:ambiguous',
    identitySource: 'auto',
    ...extra,
  });
}

beforeEach(async () => {
  ({ db, close } = await makeTestDb());
  _setDbForTests(db);
  _resetDebugCache();
  await db.insert(schema.userSettings).values({ userId: 'local', screenEnabled: true });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  _setDbForTests(null);
  vi.restoreAllMocks();
  await close();
});

describe('POST /api/screen/titles/[id]/correct', () => {
  it('re-points a LOW title at the pick and stamps enrichment_corrected_at', async () => {
    const id = await addTitle({ appRating: 4 });
    await lowEnrichment(id);
    const response = await correct(id, { candidate: candidate() });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      id,
      title: 'Solaris',
      rating: 4,
      wikidata_qid: 'Q10',
      enrichment: {
        confidence_label: 'CORRECTED',
        resolution_confidence: 1,
        match_method: 'user_correction',
        identity_source: 'corrected',
        description: 'The right film.',
      },
    });
    const [meta] = await db
      .select()
      .from(schema.profileMeta)
      .where(eq(schema.profileMeta.userId, 'local'));
    expect(meta.enrichmentCorrectedAt).not.toBeNull();
  });

  it('corrects a title that has no enrichment row yet', async () => {
    const id = await addTitle();
    expect((await correct(id, { candidate: candidate() })).status).toBe(200);
    const rows = await db.select().from(schema.titleEnrichment);
    expect(rows.map((r) => [r.titleId, r.confidenceLabel])).toEqual([[id, 'CORRECTED']]);
  });

  it('turns a mis-typed movie into a show, and clears a duplicate marker', async () => {
    const id = await addTitle({ title: 'Chernobyl', year: 2019 });
    await lowEnrichment(id, { duplicateOfTitleId: 12345 });
    const pick = candidate({
      media_type: 'tv',
      title: 'Chernobyl',
      year: 2019,
      wikidata_qid: 'Q20',
      tvmaze_id: 39749,
      description_source: 'tvmaze',
      description_url: 'https://www.tvmaze.com/shows/39749/chernobyl',
    });
    const body = await (await correct(id, { candidate: pick })).json();
    expect([body.media_type, body.tvmaze_id, body.wikidata_qid]).toEqual(['tv', 39749, 'Q20']);
    expect(body.enrichment.duplicate_of_title_id).toBeNull();
  });

  it('answers 409 when another of my titles already holds the pick, but not for its own identity', async () => {
    await addTitle({ title: 'Solaris (the other one)', wikidataQid: 'Q10' });
    const id = await addTitle({ year: 2002 });
    const clash = await correct(id, { candidate: candidate() });
    expect({ status: clash.status, body: await clash.json() }).toEqual({
      status: 409,
      body: {
        detail: 'That pick is already in your ScreenSprite library as "Solaris (the other one)".',
      },
    });
    const own = await addTitle({ title: 'Stalker', year: 1979, wikidataQid: 'Q30' });
    expect((await correct(own, { candidate: candidate({ wikidata_qid: 'Q30' }) })).status).toBe(200);
  });

  it("answers 404 for another user's title and writes nothing", async () => {
    const theirs = await addTitle({ userId: 'other' });
    const response = await correct(theirs, { candidate: candidate() });
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 404,
      body: { detail: `Title ${theirs} not found.` },
    });
    const [row] = await db.select().from(schema.titles).where(eq(schema.titles.id, theirs));
    expect(row.wikidataQid).toBeNull();
    expect(await db.select().from(schema.titleEnrichment)).toEqual([]);
    expect(await db.select().from(schema.profileMeta)).toEqual([]);
  });

  it('rejects a bad id, a pick without its identity, and a disabled account', async () => {
    const id = await addTitle();
    expect((await correct('abc', { candidate: candidate() })).status).toBe(422);
    const noQid = await correct(id, { candidate: candidate({ wikidata_qid: null }) });
    expect({ status: noQid.status, body: await noQid.json() }).toEqual({
      status: 422,
      body: { detail: 'A movie needs its Wikidata id. Pick it from the search results.' },
    });
    await db.update(schema.userSettings).set({ screenEnabled: false });
    const off = await correct(id, { candidate: candidate() });
    expect({ status: off.status, body: await off.json() }).toEqual({
      status: 403,
      body: { detail: SCREEN_DISABLED_MESSAGE },
    });
  });

  it('survives a later background resolution of the same title', async () => {
    const id = await addTitle();
    await lowEnrichment(id);
    await correct(id, { candidate: candidate() });
    await persistTitleResolution(db, id, {
      kind: 'resolved',
      label: 'HIGH',
      method: 'wikidata:exact',
      candidate: candidate({ wikidata_qid: 'Q99', description: 'The wrong film.' }),
      raw: {},
    });
    const [title] = await db.select().from(schema.titles).where(eq(schema.titles.id, id));
    const [enr] = await db
      .select()
      .from(schema.titleEnrichment)
      .where(eq(schema.titleEnrichment.titleId, id));
    expect([title.wikidataQid, enr.confidenceLabel, enr.description]).toEqual([
      'Q10',
      'CORRECTED',
      'The right film.',
    ]);
  });
});
```

Run: `npx vitest list 'app/api/screen/titles/[id]/correct/route.test.ts'` (expect it listed), then `npx vitest run 'app/api/screen/titles/[id]/correct'`.
Expected: FAIL, because `./route` does not exist.

- [ ] **Step 2: Write the route**

Create `app/api/screen/titles/[id]/correct/route.ts`:

```ts
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, schema } from '@/lib/server/db';
import { ApiError, withApi } from '@/lib/server/http';
import { ensureProfileMeta } from '@/lib/server/profileMeta';
import {
  candidateEnrichmentValues,
  findIdentityClash,
  isTitleIdentityViolation,
  ScreenCandidateSchema,
} from '@/lib/server/screenEnrichment';
import { requireScreenEnabled } from '@/lib/server/screenSettings';
import { parseIdParam, utcnowTs } from '@/lib/server/serialize';
import { titleOut } from '@/lib/server/titles';

const Body = z.object({ candidate: ScreenCandidateSchema });

/**
 * Correction (spec §4.4): the user picks the right catalog entry for a mis-resolved title.
 * One tenant-scoped transaction, as PATCH /api/books/[id]/enrichment. identity_source
 * 'corrected' is what stops a later forced job from re-resolving it (persistTitleResolution).
 */
export const POST = withApi('/api/screen/titles/[id]/correct', async (req, ctx) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError(
      422,
      `validation error: ${parsed.error.issues[0]?.message ?? 'invalid body'}`
    );
  }
  const { candidate } = parsed.data;
  const tvmazeId = candidate.media_type === 'tv' ? candidate.tvmaze_id : null;
  if (candidate.media_type === 'movie' && !candidate.wikidata_qid) {
    throw new ApiError(422, 'A movie needs its Wikidata id. Pick it from the search results.');
  }
  if (candidate.media_type === 'tv' && tvmazeId === null) {
    throw new ApiError(422, 'A show needs its TVmaze id. Pick it from the search results.');
  }
  const id = parseIdParam(ctx.params.id);
  const userId = ctx.user.userId;
  const db = getDb();
  await requireScreenEnabled(db, userId);
  const [owned] = await db
    .select({ id: schema.titles.id })
    .from(schema.titles)
    .where(and(eq(schema.titles.id, id), eq(schema.titles.userId, userId)));
  if (!owned) throw new ApiError(404, `Title ${id} not found.`);

  const clash = await findIdentityClash(db, userId, id, candidate.wikidata_qid, tvmazeId);
  const clashMessage = (title: string) =>
    `That pick is already in your ScreenSprite library as "${title}".`;
  if (clash) throw new ApiError(409, clashMessage(clash.title));

  const now = utcnowTs();
  try {
    const out = await db.transaction(async (tx) => {
      const [title] = await tx
        .update(schema.titles)
        .set({
          mediaType: candidate.media_type,
          wikidataQid: candidate.wikidata_qid,
          tvmazeId,
          updatedAt: now,
        })
        .where(and(eq(schema.titles.id, id), eq(schema.titles.userId, userId)))
        .returning();
      const values = {
        ...candidateEnrichmentValues(candidate),
        tvmazeId,
        resolutionConfidence: 1.0,
        confidenceLabel: 'CORRECTED',
        matchMethod: 'user_correction',
        identitySource: 'corrected',
        duplicateOfTitleId: null,
        resolvedAt: now,
      };
      const [enr] = await tx
        .insert(schema.titleEnrichment)
        .values({ titleId: id, ...values })
        .onConflictDoUpdate({ target: schema.titleEnrichment.titleId, set: values })
        .returning();
      const meta = await ensureProfileMeta(tx, userId);
      await tx
        .update(schema.profileMeta)
        .set({ enrichmentCorrectedAt: now })
        .where(eq(schema.profileMeta.id, meta.id));
      return titleOut(title, enr);
    });
    ctx.timer.mark('db');
    return Response.json(out);
  } catch (error) {
    if (isTitleIdentityViolation(error)) {
      throw new ApiError(409, 'That pick is already in your ScreenSprite library.');
    }
    throw error;
  }
});
```

If type-check rejects `ensureProfileMeta(tx, …)` (it is typed `Db`), follow the book correction route: it passes the transaction handle the same way, so match whatever that file does at execution time. Do not change `ensureProfileMeta`'s signature.

Run: `npx vitest run 'app/api/screen/titles/[id]/correct'`
Expected: PASS.

- [ ] **Step 3: Mutation check (load-bearing: a correction survives the job)**

Change `identitySource: 'corrected'` to `identitySource: 'auto'` in the route. Run the file.
Expected: FAIL in `survives a later background resolution of the same title`. Restore it and re-run: PASS.

- [ ] **Step 4: Commit**

```bash
git add 'app/api/screen/titles/[id]/correct'
git commit -m "feat(screen): correct a mis-resolved title (#96)"
```

---

### Task 13: Screen cache retention in the janitor

**Files:**
- Modify: `lib/server/screenCatalog.ts` (append `pruneScreenCache`)
- Test: `lib/server/__tests__/screen-cache-retention.test.ts`
- Modify: `app/api/enrich/janitor/route.ts`
- Test: `app/api/enrich/janitor/screen-prune.test.ts`

**Interfaces:**
- Produces: `export const SCREEN_CACHE_MAX_AGE_DAYS = 90`, `export const SCREEN_CACHE_MAX_ROWS = 50_000`, `export interface ScreenCachePrune { expired: number; overflow: number }`, `export async function pruneScreenCache(db: Db, limits?: { maxAgeDays?: number; maxRows?: number }): Promise<ScreenCachePrune>`.

Spec §4.2 and design decision 13:
- Screen sources (`source like 'screen:%'`) are bounded by age (90 days) and by count (the newest 50,000 are kept, oldest pruned first).
- Book cache rows are never touched.
- The janitor's response body is unchanged, and the prune result goes to the log. A prune failure is logged and never fails job repair.

**Why the cutoff is computed in SQL:** `catalog_cache.fetched_at` is a `timestamp` written by the database's `now()` (`cachePut`), so the cutoff uses the database's `now()` too. A cutoff built from the JS clock would drift from the stored values by the session time zone.

- [ ] **Step 1: Write the failing tests**

Create `lib/server/__tests__/screen-cache-retention.test.ts`:

```ts
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db';
import { catalogCache } from '../schema';
import {
  SCREEN_CACHE_MAX_AGE_DAYS,
  SCREEN_CACHE_MAX_ROWS,
  pruneScreenCache,
} from '../screenCatalog';
import { makeTestDb } from './helpers/pglite';

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await makeTestDb());
});

afterEach(async () => {
  await close();
});

async function put(key: string, source: string, ageDays: number): Promise<void> {
  await db.execute(sql`
    insert into catalog_cache (cache_key, source, payload, fetched_at)
    values (${key}, ${source}, '{}'::jsonb, now() - make_interval(days => ${ageDays}))
  `);
}

async function keys(): Promise<string[]> {
  const rows = await db.select({ key: catalogCache.cacheKey }).from(catalogCache);
  return rows.map((row) => row.key).sort();
}

describe('pruneScreenCache', () => {
  it('uses the spec bounds by default', () => {
    expect([SCREEN_CACHE_MAX_AGE_DAYS, SCREEN_CACHE_MAX_ROWS]).toEqual([90, 50_000]);
  });

  it('drops screen rows older than the age bound and keeps book rows of any age', async () => {
    await put('screen-old', 'screen:wikidata', 91);
    await put('screen-new', 'screen:tvmaze', 89);
    await put('book-old', 'openlibrary', 400);
    expect(await pruneScreenCache(db)).toEqual({ expired: 1, overflow: 0 });
    expect(await keys()).toEqual(['book-old', 'screen-new']);
  });

  it('keeps only the newest screen rows beyond the count bound', async () => {
    for (const [key, age] of [['s1', 1], ['s2', 2], ['s3', 3], ['s4', 4]] as const) {
      await put(key, 'screen:wdqs', age);
    }
    await put('book', 'googlebooks', 10);
    expect(await pruneScreenCache(db, { maxRows: 2 })).toEqual({ expired: 0, overflow: 2 });
    expect(await keys()).toEqual(['book', 's1', 's2']);
  });

  it('is a no-op on an empty cache', async () => {
    expect(await pruneScreenCache(db)).toEqual({ expired: 0, overflow: 0 });
  });
});
```

Create `app/api/enrich/janitor/screen-prune.test.ts`:

```ts
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTestDb } from '@/lib/server/__tests__/helpers/pglite';
import { _resetDebugCache } from '@/lib/server/config';
import { _setDbForTests, type Db } from '@/lib/server/db';
import { catalogCache } from '@/lib/server/schema';
import { GET } from './route';

let db: Db;
let close: () => Promise<void>;
const janitor = () =>
  GET(
    new Request('http://test/api/enrich/janitor', {
      headers: { authorization: 'Bearer test-cron-secret' },
    })
  );

beforeEach(async () => {
  ({ db, close } = await makeTestDb());
  _setDbForTests(db);
  _resetDebugCache();
  vi.stubEnv('CRON_SECRET', 'test-cron-secret');
});

afterEach(async () => {
  _setDbForTests(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await close();
});

describe('GET /api/enrich/janitor screen cache retention', () => {
  it('prunes expired screen rows, keeps book rows, and leaves the body unchanged', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    await db.execute(sql`
      insert into catalog_cache (cache_key, source, payload, fetched_at) values
        ('screen-old', 'screen:wikipedia', '{}'::jsonb, now() - interval '120 days'),
        ('book-old', 'openlibrary', '{}'::jsonb, now() - interval '120 days')
    `);
    const response = await janitor();
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 200,
      body: { examined: 0, rearmed: 0, failed: 0, dispatchFailed: 0 },
    });
    const rows = await db.select({ key: catalogCache.cacheKey }).from(catalogCache);
    expect(rows.map((r) => r.key)).toEqual(['book-old']);
    expect(logs).toHaveBeenCalledWith('screen cache prune', { expired: 1, overflow: 0 });
  });

  it('still answers 200 when the prune fails', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(db, 'execute').mockRejectedValue(new Error('prune boom'));
    const response = await janitor();
    expect(response.status).toBe(200);
    expect(errors).toHaveBeenCalledWith('Screen cache prune failed', expect.any(Error));
  });
});
```

The second test depends on `repairActiveJobs` not calling `db.execute` when there are no active jobs. Today it runs one `select`. If the test fails with "prune boom" coming out of job repair, stop and report; do not weaken the test.

Run: `npx vitest run lib/server/__tests__/screen-cache-retention.test.ts app/api/enrich/janitor/screen-prune.test.ts`
Expected: FAIL, because `pruneScreenCache` is not exported.

- [ ] **Step 2: Append `pruneScreenCache` to `lib/server/screenCatalog.ts`**

Add `import { sql } from 'drizzle-orm';` to the imports, then append:

```ts
// --- Cache retention (spec §4.2) -----------------------------------------------------

export const SCREEN_CACHE_MAX_AGE_DAYS = 90;
export const SCREEN_CACHE_MAX_ROWS = 50_000;

export interface ScreenCachePrune {
  expired: number;
  overflow: number;
}

function countOf(result: unknown): number {
  const rows = Array.isArray(result) ? result : (result as { rows: unknown[] }).rows;
  return Number((rows[0] as { n?: number | string } | undefined)?.n ?? 0);
}

/**
 * Bounds screen rows in catalog_cache by age and by count; book sources are never touched
 * (their entries never expire, per catalogCache.ts). The cutoff uses the database's now(),
 * the same clock cachePut stamps fetched_at with.
 */
export async function pruneScreenCache(
  db: Db,
  limits: { maxAgeDays?: number; maxRows?: number } = {}
): Promise<ScreenCachePrune> {
  const maxAgeDays = limits.maxAgeDays ?? SCREEN_CACHE_MAX_AGE_DAYS;
  const maxRows = limits.maxRows ?? SCREEN_CACHE_MAX_ROWS;
  const expired = await db.execute(sql`
    with gone as (
      delete from catalog_cache
      where source like 'screen:%'
        and fetched_at < now() - make_interval(days => ${maxAgeDays})
      returning 1
    )
    select count(*)::int as n from gone
  `);
  const overflow = await db.execute(sql`
    with gone as (
      delete from catalog_cache
      where cache_key in (
        select cache_key from catalog_cache
        where source like 'screen:%'
        order by fetched_at desc nulls last, cache_key
        offset ${maxRows}
      )
      returning 1
    )
    select count(*)::int as n from gone
  `);
  return { expired: countOf(expired), overflow: countOf(overflow) };
}
```

- [ ] **Step 3: Call it from the janitor**

Replace the body of `app/api/enrich/janitor/route.ts` with:

```ts
import { getDb } from '@/lib/server/db';
import { isValidCronSecret, rearmAfterResponse } from '@/lib/server/enrichmentDispatch';
import { repairActiveJobs } from '@/lib/server/enrichmentJobs';
import { ApiError, withApi } from '@/lib/server/http';
import { pruneScreenCache } from '@/lib/server/screenCatalog';

export const GET = withApi(
  '/api/enrich/janitor',
  async (request) => {
    if (!isValidCronSecret(request)) throw new ApiError(401, 'Unauthorized');

    const db = getDb();
    const summary = await repairActiveJobs(db, new Date(), (jobId) => {
      rearmAfterResponse(request, jobId);
    });
    // Spec §4.2: screen cache retention rides the daily janitor. Its result goes to the log so
    // the response body (the job-repair summary) keeps its shape; a failure never fails repair.
    try {
      console.log('screen cache prune', await pruneScreenCache(db));
    } catch (error) {
      console.error('Screen cache prune failed', error);
    }
    return Response.json(summary);
  },
  { requireAuth: false }
);
```

Run: `npx vitest run lib/server/__tests__/screen-cache-retention.test.ts app/api/enrich/janitor`
Expected: PASS. The existing `app/api/enrich/janitor/route.test.ts` passes **unedited**: it asserts the unchanged body, and its 401 case stops before the prune.

- [ ] **Step 4: Mutation check**

In `pruneScreenCache`, delete `where source like 'screen:%'` from the first `delete`, keeping the `and` clause as its `where`. Run the retention test.
Expected: FAIL in `drops screen rows older than the age bound and keeps book rows of any age`, because `book-old` is gone. Restore it and re-run: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/server/screenCatalog.ts lib/server/__tests__/screen-cache-retention.test.ts app/api/enrich/janitor/route.ts app/api/enrich/janitor/screen-prune.test.ts
git commit -m "feat(screen): prune screen catalog cache by age and count in the janitor (#96)"
```

---

### Task 14: Recorded replay fixtures for real titles

**Files:**
- Create: `lib/server/__tests__/fixtures/screen/replay-set.ts`
- Create: `scripts/record-screen-fixtures.ts`
- Create (recorded): `lib/server/__tests__/fixtures/screen/resolve-films.json`
- Test: `lib/server/__tests__/screen-resolve-replay.test.ts`

**Interfaces:**
- Consumes: `resolveMovies`, `resolveTv`, `searchMovies`, `searchShows`, `MovieInput`, `TvInput`, `TitleResolution`, `ScreenCandidate` (Tasks 6–7); `deadlineIn`, `_setScreenCatalogHooksForTests`, `CatalogResult`, `Deadline` (Task 3); `replayKey` (Task 3); `installHttpReplay`, `ReplayEntry` (`helpers/httpReplay.ts`); `makeTestDb` (`helpers/pglite.ts`, which imports no vitest).
- Produces (test-only): `REPLAY_FILMS`, `REPLAY_SHOWS`, `REPLAY_MOVIE_SEARCH`, `REPLAY_SHOW_SEARCH`, `runReplaySet(db, deadline): Promise<ReplayObserved>`, and the `ReplayObserved` summary types.

Every earlier test uses synthetic entities. This task pins the resolver against **real** Wikidata, Wikipedia and TVmaze answers for the spec's named cases (§2.1 findings 2–4): the mul-only label (*Forrest Gump*), short titles search never surfaces (*Her*, *Old*, *Pig*), a remake that shares its title (*Nosferatu* 2024), a TV miniseries logged as a film (*Chernobyl*), a title with no year, and a title that exists nowhere. The responses are recorded once by the controller, trimmed to what the resolver reads, and replayed offline.

**The trim is verified, not trusted.** The recorder runs the whole set live, trims each response, then re-runs the set against only the trimmed fixtures (fresh database, so `catalog_cache` cannot mask a miss) and refuses to write the file unless both runs produce identical summaries. A trim that drops something the resolver reads fails the recorder, not a later test.

**Controller-only.** Steps 1–3 need the network and are marked **[controller]**. Codex's sandbox has none. Never dispatch this task before they have run.

- [ ] **Step 1 [controller]: Write the replay set**

Create `lib/server/__tests__/fixtures/screen/replay-set.ts`. It imports no vitest, so the recorder script can run it outside the test runner:

```ts
/**
 * The real titles the screen resolver is replayed against, and the summaries both the recorder
 * (scripts/record-screen-fixtures.ts) and the replay test compare. Deliberately free of vitest
 * imports. Spec §2.1 findings 2-4 name why each title is here.
 */
import type { Db } from '../../../db';
import { type CatalogResult, type Deadline } from '../../../screenCatalog';
import {
  resolveMovies,
  resolveTv,
  searchMovies,
  searchShows,
  type MovieInput,
  type ScreenCandidate,
  type TitleResolution,
  type TvInput,
} from '../../../screenEnrichment';

export const REPLAY_FILMS: readonly MovieInput[] = [
  { id: 1, title: 'Forrest Gump', year: 1994 }, // only a mul label (finding 2a)
  { id: 2, title: 'Toy Story', year: 1995 },
  { id: 3, title: 'Her', year: 2013 }, // short titles search never surfaces (finding 2b)
  { id: 4, title: 'Old', year: 2021 },
  { id: 5, title: 'Pig', year: 2021 },
  { id: 6, title: 'Nosferatu', year: 2024 }, // shares its title with 1922 and 1979
  { id: 7, title: 'Heat', year: 1995 },
  { id: 8, title: 'The Lord of the Rings: The Fellowship of the Ring', year: 2001 },
  { id: 9, title: 'Amélie', year: 2001 },
  { id: 10, title: 'Spirited Away', year: 2001 },
  { id: 11, title: 'Chernobyl', year: 2019 }, // a miniseries logged as a film (decision 18)
  { id: 12, title: 'Paprika', year: null }, // no year: never HIGH
  { id: 13, title: 'Qzxv Plumbline Orchard', year: 2011 }, // exists nowhere
];

export const REPLAY_SHOWS: readonly TvInput[] = [
  { id: 101, tvmazeId: 82 }, // Game of Thrones
  { id: 102, tvmazeId: 169 }, // Breaking Bad
];

export const REPLAY_MOVIE_SEARCH = 'Nosferatu 2024';
export const REPLAY_SHOW_SEARCH = 'severance';

export interface ResolutionSummary {
  id: number;
  kind: TitleResolution['kind'];
  label: string | null;
  title: string | null;
  qid: string | null;
  media_type: 'movie' | 'tv' | null;
  tvmaze_id: number | null;
  year: number | null;
  reason: string | null;
}

export interface SearchSummary {
  title: string;
  year: number | null;
  qid: string | null;
  tvmaze_id: number | null;
}

export interface ReplayObserved {
  films: ResolutionSummary[];
  shows: ResolutionSummary[];
  /** null when the search did not answer `ok`. */
  movieSearch: SearchSummary[] | null;
  showSearch: SearchSummary[] | null;
}

export function summarizeResolutions(results: Map<number, TitleResolution>): ResolutionSummary[] {
  return [...results.entries()]
    .sort(([a], [b]) => a - b)
    .map(([id, result]) => {
      const candidate =
        result.kind === 'resolved' || result.kind === 'refreshed' ? result.candidate : null;
      return {
        id,
        kind: result.kind,
        label: result.kind === 'resolved' ? result.label : null,
        title: candidate?.title ?? null,
        qid: candidate?.wikidata_qid ?? null,
        media_type: candidate?.media_type ?? null,
        tvmaze_id: candidate?.tvmaze_id ?? null,
        year: candidate?.year ?? null,
        reason: result.kind === 'deferred' ? result.reason : null,
      };
    });
}

export function summarizeSearch(result: CatalogResult<ScreenCandidate[]>): SearchSummary[] | null {
  if (result.kind !== 'ok') return null;
  return result.value.slice(0, 5).map((c) => ({
    title: c.title,
    year: c.year,
    qid: c.wikidata_qid,
    tvmaze_id: c.tvmaze_id,
  }));
}

/** Runs the whole set in a fixed order, so the recorded and replayed request sequences match. */
export async function runReplaySet(db: Db, deadline: Deadline): Promise<ReplayObserved> {
  const films = summarizeResolutions(await resolveMovies(db, REPLAY_FILMS, deadline));
  const shows = summarizeResolutions(await resolveTv(db, REPLAY_SHOWS, deadline));
  const movieSearch = summarizeSearch(await searchMovies(db, REPLAY_MOVIE_SEARCH, deadline));
  const showSearch = summarizeSearch(await searchShows(db, REPLAY_SHOW_SEARCH, deadline));
  return { films, shows, movieSearch, showSearch };
}
```

- [ ] **Step 2 [controller]: Write the recorder**

Create `scripts/record-screen-fixtures.ts`:

```ts
/**
 * Controller-run, needs the network: records the screen replay fixture.
 *
 *   npx tsx scripts/record-screen-fixtures.ts
 *   npx prettier --write lib/server/__tests__/fixtures/screen/resolve-films.json
 *
 * 1. Runs the replay set live against a fresh PGlite database, recording every final 200/404
 *    response under replayKey(url, init). 429s and 5xx are not recorded: the transport retries
 *    them itself, and the retry's answer is what gets recorded.
 * 2. Aborts if any title deferred or either search failed: a fixture must hold definite answers.
 * 3. Trims each response to the fields the resolver reads.
 * 4. Re-runs the set against only the trimmed fixtures (fresh database, sleeps disabled) and
 *    refuses to write unless the summaries are identical to the live run's.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  runReplaySet,
  type ReplayObserved,
} from '../lib/server/__tests__/fixtures/screen/replay-set';
import { makeTestDb } from '../lib/server/__tests__/helpers/pglite';
import { replayKey } from '../lib/server/__tests__/helpers/replayKey';
import { _setScreenCatalogHooksForTests, deadlineIn } from '../lib/server/screenCatalog';

interface Entry {
  status: number;
  body?: unknown;
}

const OUT = path.resolve(
  __dirname,
  '..',
  'lib/server/__tests__/fixtures/screen/resolve-films.json'
);

/** Every property screenEnrichment.ts reads (Tasks 5-7). */
const KEEP_CLAIMS = new Set([
  'P31', 'P50', 'P57', 'P58', 'P136', 'P144', 'P170', 'P179',
  'P218', 'P272', 'P364', 'P495', 'P577', 'P580', 'P921', 'P8600',
]);
const KEEP_LANGS = ['en', 'mul'];

type Json = Record<string, unknown>;

function pickLangs(record: unknown): Json | undefined {
  if (!record || typeof record !== 'object') return undefined;
  const out: Json = {};
  for (const lang of KEEP_LANGS) {
    if (lang in (record as Json)) out[lang] = (record as Json)[lang];
  }
  return out;
}

function trimEntity(entity: Json): Json {
  if ('missing' in entity) return entity;
  const claims: Json = {};
  for (const [prop, list] of Object.entries((entity.claims as Json | undefined) ?? {})) {
    if (!KEEP_CLAIMS.has(prop)) continue;
    claims[prop] = (list as Array<{ mainsnak?: { datavalue?: { value?: unknown } }; rank?: string }>)
      .map((claim) => ({
        mainsnak: { datavalue: { value: claim.mainsnak?.datavalue?.value } },
        rank: claim.rank,
      }));
  }
  const out: Json = { id: entity.id };
  if (entity.labels) out.labels = pickLangs(entity.labels);
  if (entity.aliases) out.aliases = pickLangs(entity.aliases);
  if (entity.claims) out.claims = claims;
  if (entity.sitelinks) {
    // The count is read (popularity), and enwiki's title; nothing else.
    const sitelinks: Json = {};
    for (const [site, link] of Object.entries(entity.sitelinks as Json)) {
      sitelinks[site] = site === 'enwiki' ? { title: (link as { title: string }).title } : {};
    }
    out.sitelinks = sitelinks;
  }
  return out;
}

function trimShow(show: Json): Json {
  const keep = ['id', 'name', 'url', 'premiered', 'summary', 'genres', 'language', 'image'];
  return Object.fromEntries(keep.filter((k) => k in show).map((k) => [k, show[k]]));
}

function trim(url: string, body: unknown): unknown {
  if (url.startsWith('https://www.wikidata.org/w/api.php')) {
    const action = new URL(url).searchParams.get('action');
    if (action === 'wbgetentities') {
      const entities = ((body as Json).entities as Json | undefined) ?? {};
      return {
        entities: Object.fromEntries(
          Object.entries(entities).map(([id, e]) => [id, trimEntity(e as Json)])
        ),
      };
    }
    if (action === 'wbsearchentities') {
      const hits = ((body as Json).search as Array<{ id: unknown }> | undefined) ?? [];
      return { search: hits.map((hit) => ({ id: hit.id })) };
    }
  }
  if (url.startsWith('https://en.wikipedia.org/')) {
    const s = body as Json;
    return {
      type: s.type,
      title: s.title,
      extract: s.extract,
      thumbnail: s.thumbnail ? { source: (s.thumbnail as Json).source } : undefined,
      content_urls: s.content_urls
        ? { desktop: { page: ((s.content_urls as Json).desktop as Json | undefined)?.page } }
        : undefined,
    };
  }
  if (url.startsWith('https://api.tvmaze.com/search/')) {
    return (body as Array<{ show: Json }>).map((hit) => ({ show: trimShow(hit.show) }));
  }
  if (url.startsWith('https://api.tvmaze.com/')) return trimShow(body as Json);
  return body; // SPARQL result sets are already small
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
}

async function runOnce(): Promise<ReplayObserved> {
  const { db, close } = await makeTestDb();
  try {
    return await runReplaySet(db, deadlineIn(900_000));
  } finally {
    await close();
  }
}

function incomplete(observed: ReplayObserved): string[] {
  const problems = [...observed.films, ...observed.shows]
    .filter((s) => s.kind === 'deferred')
    .map((s) => `title ${s.id} deferred: ${s.reason}`);
  if (observed.movieSearch === null) problems.push('movie search did not answer ok');
  if (observed.showSearch === null) problems.push('show search did not answer ok');
  return problems;
}

async function main(): Promise<void> {
  const realFetch = globalThis.fetch;
  const fixtures: Record<string, Entry> = {};

  // 1. Live run, recording.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    const response = await realFetch(input, init);
    if (response.status === 404) {
      fixtures[replayKey(url, init)] = { status: 404 };
    } else if (response.status === 200) {
      try {
        const body = JSON.parse(await response.clone().text());
        fixtures[replayKey(url, init)] = { status: 200, body: trim(url, body) };
      } catch {
        // Unparseable: the transport treats it as retryable, and step 2 aborts.
      }
    }
    return response;
  }) as typeof fetch;
  const live = await runOnce();
  globalThis.fetch = realFetch;

  // 2. Definite answers only.
  const problems = incomplete(live);
  if (problems.length > 0) {
    console.error('Not writing the fixture; the live run was incomplete:\n' + problems.join('\n'));
    process.exit(1);
  }

  // 4. Replay against the trimmed fixtures only.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = replayKey(urlOf(input), init);
    const entry = fixtures[key];
    if (!entry) {
      const miss = new Error(`no fixture for ${key}`);
      miss.name = 'HttpReplayMissError';
      throw miss;
    }
    return new Response(entry.body === undefined ? null : JSON.stringify(entry.body), {
      status: entry.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  _setScreenCatalogHooksForTests({ sleep: async () => undefined });
  const replayed = await runOnce();
  _setScreenCatalogHooksForTests(null);
  globalThis.fetch = realFetch;

  if (!isDeepStrictEqual(live, replayed)) {
    console.error('Not writing the fixture; the trimmed replay differs from the live run.');
    console.error(JSON.stringify({ live, replayed }, null, 2));
    process.exit(1);
  }

  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify({
      recorded_at: new Date().toISOString(),
      note: 'Recorded by scripts/record-screen-fixtures.ts; trimmed to what screenEnrichment.ts reads. Re-record, never hand-edit.',
      observed: live,
      fixtures,
    })
  );
  console.log(JSON.stringify(live, null, 2));
  console.log(`wrote ${Object.keys(fixtures).length} fixtures to ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 3 [controller]: Record, then review every pick by hand**

Run:

```bash
npx tsx scripts/record-screen-fixtures.ts
npx prettier --write lib/server/__tests__/fixtures/screen/resolve-films.json
ls -l lib/server/__tests__/fixtures/screen/resolve-films.json
```

Expected: the script prints the observed summaries and `wrote N fixtures`. A live run takes a few minutes, because the throttles are real. The file should be under about 1.5 MB; if it is much larger, report the size and which keys dominate before committing it.

Now check each observed pick against Wikidata in a browser (`https://www.wikidata.org/wiki/<QID>`). **Record what you actually observe, not what this plan predicts.** The spec's measured facts are:
- *Forrest Gump* 1994 → `Q134773`, `HIGH`;
- *Toy Story* 1995 → `Q171048`, `HIGH`;
- *Paprika* with no year is not `HIGH`;
- *Qzxv Plumbline Orchard* is `unresolved`;
- the first *Nosferatu 2024* search result is the 2024 film;
- *Chernobyl* 2019 converts to `tv` with a TVmaze id.

For every other title, "correct" means the pick is the film the title and year name. A wrong pick is a **finding to report**, not something to paper over by removing the title from the set. If a spec fact above no longer holds (Wikidata was edited), verify it on Wikidata, report it, and pin what is true today; never weaken a pin to accept either value.

- [ ] **Step 4: Write the replay test**

Create `lib/server/__tests__/screen-resolve-replay.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db';
import { _setScreenCatalogHooksForTests, deadlineIn } from '../screenCatalog';
import {
  REPLAY_SHOWS,
  runReplaySet,
  type ReplayObserved,
  type ResolutionSummary,
} from './fixtures/screen/replay-set';
import { installHttpReplay, type ReplayEntry } from './helpers/httpReplay';
import { makeTestDb } from './helpers/pglite';

const fixture = JSON.parse(
  readFileSync(path.join(__dirname, 'fixtures', 'screen', 'resolve-films.json'), 'utf8')
) as { recorded_at: string; note: string; observed: ReplayObserved; fixtures: Record<string, ReplayEntry> };

let db: Db;
let close: () => Promise<void>;
let restore: () => void;
let observed: ReplayObserved;

beforeAll(async () => {
  ({ db, close } = await makeTestDb());
  _setScreenCatalogHooksForTests({ sleep: async () => undefined });
  restore = installHttpReplay(fixture.fixtures);
  observed = await runReplaySet(db, deadlineIn(600_000));
});

afterAll(async () => {
  restore();
  _setScreenCatalogHooksForTests(null);
  await close();
});

function film(id: number): ResolutionSummary {
  const found = observed.films.find((s) => s.id === id);
  if (!found) throw new Error(`no summary for film ${id}`);
  return found;
}

describe('screen resolution against recorded catalog answers', () => {
  it('replays to exactly what the live run observed', () => {
    expect(observed).toEqual(fixture.observed);
  });

  it('defers nothing: every recorded answer is definite', () => {
    expect([...observed.films, ...observed.shows].filter((s) => s.kind === 'deferred')).toEqual([]);
  });

  it('resolves Forrest Gump through its mul-only label', () => {
    expect(film(1)).toMatchObject({ kind: 'resolved', label: 'HIGH', qid: 'Q134773', media_type: 'movie' });
  });

  it('resolves Toy Story', () => {
    expect(film(2)).toMatchObject({ kind: 'resolved', label: 'HIGH', qid: 'Q171048' });
  });

  it('never labels a title without a year HIGH', () => {
    expect(film(12).label).not.toBe('HIGH');
  });

  it('leaves a title that exists nowhere unresolved', () => {
    expect(film(13).kind).toBe('unresolved');
  });

  it('converts a miniseries logged as a film to a show with a TVmaze id', () => {
    expect(film(11)).toMatchObject({ kind: 'resolved', media_type: 'tv' });
    expect(typeof film(11).tvmaze_id).toBe('number');
  });

  it('refreshes shows by TVmaze id and crosswalks them to Wikidata', () => {
    expect(observed.shows.map((s) => [s.id, s.kind, s.tvmaze_id])).toEqual(
      REPLAY_SHOWS.map((s) => [s.id, 'refreshed', s.tvmazeId])
    );
    for (const show of observed.shows) expect(show.qid).toMatch(/^Q\d+$/);
  });

  it('ranks the queried year first in a movie search', () => {
    expect(observed.movieSearch?.[0]).toMatchObject({ year: 2024 });
  });

  it('finds shows by name', () => {
    expect(observed.showSearch?.[0]?.title).toMatch(/Severance/);
    expect(typeof observed.showSearch?.[0]?.tvmaze_id).toBe('number');
  });
});
```

Run: `npx vitest list lib/server/__tests__/screen-resolve-replay.test.ts` (expect 10 tests listed), then `npx vitest run lib/server/__tests__/screen-resolve-replay.test.ts`.
Expected: PASS. If a spec-fact pin fails while "replays to exactly what the live run observed" passes, the recorded answer contradicts the spec: go back to Step 3's review, and do not edit the pin without verifying on Wikidata.

- [ ] **Step 5: Mutation check (load-bearing: mul labels are scored)**

In `lib/server/screenCatalog.ts#entityNames`, delete the line `entity.labels?.mul?.value,`. Run the replay test.
Expected: FAIL, at least in `resolves Forrest Gump through its mul-only label` and in the exact-replay test. If it stays green, the recorded *Forrest Gump* item now carries an `en` label or alias, and the mul path has no real-data coverage: report that. Restore the line; re-run: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/server/__tests__/fixtures/screen/replay-set.ts scripts/record-screen-fixtures.ts lib/server/__tests__/fixtures/screen/resolve-films.json lib/server/__tests__/screen-resolve-replay.test.ts
git commit -m "test(screen): replay screen resolution against recorded catalog answers (#96)"
```

---

### Task 15: Docs, full gate, and real-flow verification

**Files:**
- Modify: `docs/architecture.md`, `docs/conventions.md`

**Interfaces:** none new.

- [ ] **Step 1: Update `docs/architecture.md`**

In the "### ScreenSprite (movies & TV)" subsection wave 4 added, append these bullets after `screenPurge.ts`:

```markdown
- `screenCatalog.ts` — screen catalog transport: per-host throttles (Wikidata Action API, WDQS,
  Wikipedia REST 250 ms; TVmaze 550 ms), `catalog_cache` under `screen:*` sources, `Retry-After`
  capped at 10 s, a `Deadline` threaded into every request, and a three-way `CatalogResult`
  (`ok` / `empty` / `retryable`). Also the endpoint clients, Wikidata entity helpers, and
  `pruneScreenCache` (90 days, newest 50,000 rows), which the janitor runs.
- `screenMatch.ts` — screen-only title normalization (NFKC, non-Latin kept) and variants. The
  book helpers in `dedup.ts` are not used for screen titles.
- `screenClasses.ts` + `screenClasses.json` — the film, TV-program and TV-series subclass sets,
  generated by `scripts/screen-classes.ts`.
- `screenEnrichment.ts` — scoring (`scoreTitle`), `ScreenCandidate` and its schema, metadata,
  movie resolution (Stage A exact title, Stage B search), TV refresh via TVmaze plus the Wikidata
  crosswalk, catalog search, and `persistTitleResolution` (identity, clash, conversion).
- `screenJobs.ts` — `queueScreenEnrichment` (import: create or reuse the job, dispatch a tick
  after the response) and `startScreenEnrichment` (claim and run one chunk inline).
- `enrichmentJobs.ts` jobs carry a `kind` (`books` | `screen`); one active job per user per kind.
  The screen chunk runs batches of up to 50 titles under the same time budget, recount and stall
  rules as the book chunk.
```

Extend the routes line with: `POST /api/screen/enrich/start`, `GET /api/screen/enrich/active`, `GET /api/screen/search`, `POST /api/screen/titles`, `POST /api/screen/titles/{id}/correct`.

- [ ] **Step 2: Update `docs/conventions.md`**

Under "## Data invariants", add:

```markdown
- **Screen catalog failure is not "no match".** Only a definite catalog answer (a 404, or a 200
  with no hits) may be persisted as unresolved. A network error, 5xx, 429 after retries, other
  4xx, unparseable body, or a request skipped for lack of time is `retryable`, and the title is
  deferred: no `title_enrichment` row is written, so the next batch retries it. Search answers
  503 on a retryable failure, never an empty list.
- **Screen identity.** A movie's identity is `titles.wikidata_qid`; a show's is `titles.tvmaze_id`.
  Identity columns are written only for `HIGH`/`MEDIUM` auto resolutions, manual adds and
  corrections; a second title resolving to a held identity records `duplicate_of_title_id` and
  keeps its own identity columns null. A `manual` or `corrected` identity is never overwritten by
  a later job, forced or not.
- **Screen cache retention.** Rows with `source like 'screen:%'` are pruned by the janitor at 90
  days and beyond the newest 50,000. Book cache rows never expire.
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

Expected: all pass. Compare the extracted Vitest counts with Task 0 Step 5's baseline: the test-file count grows by exactly the new files in the File Structure table, and no previously passing test is missing.

- [ ] **Step 4: Real-flow verification against an isolated local database**

Follow the `marketing-screenshot-pipeline` memory note for the isolated run: scratch Postgres in Docker, a local-mode dev server, and no `.env` in scope. This run talks to the real Wikidata, Wikipedia and TVmaze, which is the point.

```bash
# 1. A copy of the working tree with no .env in scope
# Beside the repository, not in /tmp: the memory note records that Turbopack rejects a
# node_modules symlink pointing outside the inferred workspace root when the copy is in /tmp.
# If it still rejects the link here, run `npm ci` in the copy instead (no sudo) and say so.
VERIFY="$HOME/Documents/Code/shelfsprite-w5-verify"
# Tracked + untracked-but-not-ignored files only; secrets files, .next and node_modules are
# gitignored, so the command never names them (the PreToolUse secrets guard denies any command
# whose text names one; do not rephrase around it).
mkdir -p "$VERIFY"
git ls-files -z --cached --others --exclude-standard | rsync -a --from0 --files-from=- ./ "$VERIFY"/
ln -sfn "$PWD/node_modules" "$VERIFY/node_modules"
ls -a "$VERIFY"   # names only; confirm no dot-env entry. If there is one: STOP, delete the copy.

# 2. Scratch Postgres (55432 is the memory note's container; waves 2 and 4 used 55433 and 55434)
docker ps --format '{{.Names}} {{.Ports}}' | grep 55435 && echo "STOP: port 55435 busy"
docker run -d --name ss-w5-pg -e POSTGRES_PASSWORD=postgres -p 55435:5432 postgres:17
export VERIFY_DB=postgres://postgres:postgres@localhost:55435/postgres
cd "$VERIFY" && DATABASE_URL=$VERIFY_DB npm run db:migrate

# 3. Dev server. CRON_SECRET is a throwaway local value, needed for the tick dispatch.
cd "$VERIFY" && DATABASE_URL=$VERIFY_DB ALLOW_LOCAL_AUTH=true CRON_SECRET=local-verify-secret \
  npx next dev -p 3100
```

Build a Letterboxd-shaped export for a synthetic user who logged real films (resolution needs real titles). It includes a TV miniseries logged as a film and a film with no year:

```bash
python3 - <<'PY'
import zipfile
files = {
  "profile.csv": "Date Joined,Username,Given Name,Family Name,Email Address,Location,Website,Bio,Pronoun,Favorite Films\n2020-01-01,synthetic_user,Sam,Example,sam@example.invalid,,,,they/them,\n",
  "watched.csv": "Date,Name,Year,Letterboxd URI\n2024-01-05,Forrest Gump,1994,https://boxd.it/aaa1\n2024-01-06,Her,2013,https://boxd.it/aaa2\n2024-01-07,Spirited Away,2001,https://boxd.it/aaa3\n2024-01-08,Chernobyl,2019,https://boxd.it/aaa4\n2024-01-09,Paprika,,https://boxd.it/aaa5\n2024-01-10,Qzxv Plumbline Orchard,2011,https://boxd.it/aaa6\n",
  "ratings.csv": "Date,Name,Year,Letterboxd URI,Rating\n2024-01-05,Forrest Gump,1994,https://boxd.it/aaa1,4\n2024-01-07,Spirited Away,2001,https://boxd.it/aaa3,5\n",
  "watchlist.csv": "Date,Name,Year,Letterboxd URI\n2024-06-01,Nosferatu,2024,https://boxd.it/bbb1\n",
}
with zipfile.ZipFile("/tmp/shelfsprite-w5-letterboxd.zip", "w", zipfile.ZIP_DEFLATED) as z:
    for name, text in files.items():
        z.writestr(name, text.encode("utf-8"))
PY
```

Exercise the flow and record every response:

```bash
B=http://localhost:3100/api
curl -s -F file=@/tmp/shelfsprite-w5-letterboxd.zip $B/screen/import   # inserted:7, and a job
JOB=$(curl -s $B/screen/enrich/active | python3 -c "import sys,json;print(json.load(sys.stdin)['job']['job_id'])")
curl -s $B/enrich/status/$JOB
```

Poll `GET $B/enrich/status/$JOB` about every 10 seconds until `status` is `done`. In Claude Code, use the Monitor tool with an until-loop; do not sleep in the foreground. Expected: `progress` rises between polls, driven by tick dispatches (watch the dev-server log for `/api/enrich/tick`), and the job finishes without a manual start. Then:

```bash
curl -s $B/screen/titles | python3 -c "import sys,json
for t in json.load(sys.stdin):
    e=t['enrichment'] or {}
    print(t['id'], t['title'], t['year'], t['media_type'], e.get('confidence_label'), e.get('match_method'))"
```

Expected, per the spec: *Forrest Gump*, *Her* and *Spirited Away* are `HIGH`; *Chernobyl* is now `tv`; *Paprika* is not `HIGH`; *Qzxv Plumbline Orchard* has a row with no pick (unresolved), not a missing row.

```bash
curl -s "$B/screen/search?q=Nosferatu%202024&type=movie" | python3 -c "import sys,json;print([(c['title'],c['year'],c['wikidata_qid']) for c in json.load(sys.stdin)][:3])"
curl -s "$B/screen/search?q=severance&type=tv" > /tmp/shelfsprite-w5-show.json
python3 -c "import json;c=json.load(open('/tmp/shelfsprite-w5-show.json'))[0];print(c['title'],c['tvmaze_id'],c['wikidata_qid']);json.dump({'candidate':c,'status':'watched','rating':4},open('/tmp/shelfsprite-w5-add.json','w'))"
curl -s -w '\n%{http_code}\n' -H 'content-type: application/json' -d @/tmp/shelfsprite-w5-add.json $B/screen/titles   # 201
curl -s -w '\n%{http_code}\n' -H 'content-type: application/json' -d @/tmp/shelfsprite-w5-add.json $B/screen/titles   # 409 already in your ScreenSprite library
curl -s -w '\n%{http_code}\n' "$B/screen/search?q=&type=movie"   # 422
```

Correct the *Paprika* title (or whichever title came back `LOW` or unresolved) to the 2006 film, picked from a search:

```bash
PID=$(curl -s $B/screen/titles | python3 -c "import sys,json;print([t['id'] for t in json.load(sys.stdin) if t['title']=='Paprika'][0])")
curl -s "$B/screen/search?q=Paprika%202006&type=movie" | python3 -c "import sys,json;json.dump({'candidate':json.load(sys.stdin)[0]},open('/tmp/shelfsprite-w5-fix.json','w'))"
curl -s -H 'content-type: application/json' -d @/tmp/shelfsprite-w5-fix.json $B/screen/titles/$PID/correct   # confidence_label CORRECTED
curl -s -H 'content-type: application/json' -d '{"force":true}' $B/screen/enrich/start
```

Poll the forced job to `done` as before, then re-read the Paprika title: it must still be `CORRECTED` with the same QID (a forced run never overwrites a correction).

Book and screen jobs side by side:

```bash
curl -s -F file=@lib/server/__tests__/fixtures/sample_goodreads.csv $B/import
curl -s -H 'content-type: application/json' -d '{}' $B/enrich/start &
curl -s -H 'content-type: application/json' -d '{"force":true}' $B/screen/enrich/start &
wait
docker exec ss-w5-pg psql -U postgres -c "select job_id, kind, status, started_at, finished_at from enrich_jobs order by started_at;"
```

Expected: a `books` and a `screen` job were active at the same time, and both reach `done`.

Janitor and the cache:

```bash
curl -s -H 'authorization: Bearer local-verify-secret' $B/enrich/janitor   # repair summary only
docker exec ss-w5-pg psql -U postgres -c "select source, count(*) from catalog_cache group by source order by source;"
```

Expected: the dev-server log shows `screen cache prune { expired: 0, overflow: 0 }`, and the cache holds `screen:wikidata`, `screen:wdqs`, `screen:wikipedia` and `screen:tvmaze` rows beside the book sources.

Clean up: stop the dev server, `docker rm -f ss-w5-pg`, `rm -rf "$VERIFY" /tmp/shelfsprite-w5-*`.

Record what you observed in the ledger. Any divergence from the expectations above is a finding to report, not something to reconcile silently.

- [ ] **Step 5: Commit the docs**

```bash
git add docs/architecture.md docs/conventions.md
git commit -m "docs(screen): document screen catalog, enrichment and job modules (#96)"
```

- [ ] **Step 6: Report to Chase**

This wave adds **no migration**; everything it writes landed with wave 4's. Say so in the report, so the production step list stays wave 4's alone. Report the gate counts, the real-flow observations (including any pick you judged wrong), and the fixture file's size.
