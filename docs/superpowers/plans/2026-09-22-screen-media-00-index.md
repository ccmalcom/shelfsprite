# ScreenSprite (movies & TV) + compact trait rows: plan index and cross-wave contract

> **For agentic workers:** this file is not executed. It orders the wave plans and fixes the names
> and types that more than one wave relies on. Each wave plan repeats the constraints it needs,
> so an executor reads **its wave plan, this index, and the spec**, in that order.

**Spec:** `docs/superpowers/specs/2026-09-22-screen-media-design.md` (approved 2026-09-22, spike
folded in). The spec's §0 "Decisions locked" are fixed requirements. Where a wave plan and the
spec disagree, stop and report; do not pick one silently.

**Issues:** #96 (ScreenSprite), #97 (compact trait rows). **Branch:** `feat/screen-media`. One PR
for the whole branch closes both.

---

## Why several plans

The spec covers seven independently testable waves. One plan document would run past 15,000 lines
and no execution session could hold it. Each wave plan below produces working, gated software on
its own and is executed in its own fresh session (plan and execution are separate sessions).

## Wave order

Spec §11 asked `writing-plans` to confirm its order. Confirmed with one change: **manual add moves
from wave 4 to wave 5**, because its search needs the screen catalog client that wave 5 builds.
Wave numbers keep the spec's numbering (wave 3 was the spike, already done).

| Wave | Plan | Delivers | Depends on |
|---|---|---|---|
| 1 | `2026-09-22-screen-media-w1-trait-rows.md` | #97 compact expandable trait rows, `?trait=` deep link | — |
| 2 | `2026-09-22-screen-media-w2-models-run-boundary.md` | per-operation model settings, Opus 5.5 pricing row, `markProfiled` start-of-run cutoff, `profile_meta.rebuild_reason` | — |
| 4 | `2026-09-22-screen-media-w4-schema-import.md` | all screen tables and columns (one migration), screen opt-in flag, Letterboxd ZIP import, title list/edit/delete routes, purge and export | 2 |
| 5 | `2026-09-22-screen-media-w5-catalog-enrichment.md` | Wikidata/Wikipedia/TVmaze clients, movie resolution, TV crosswalk, `enrich_jobs.kind`, screen jobs, manual add, LOW correction, cache retention | 4 |
| 6 | `2026-09-22-screen-media-w6-unified-profile.md` | screen tiers, screen prompt variant, typed title evidence, incremental update, opt-out, title signals, dirty-state | 2, 4, 5 |
| 7 | `2026-09-22-screen-media-w7-screen-recs.md` | screen signal, Stage 1 pools, rerank, persistence, feedback | 5, 6 |
| 8 | `2026-09-22-screen-media-w8-screen-ui.md` | section switcher, `/screen`, `/screen/library`, `/screen/profile`, settings card, profile title evidence, branding | 1, 4–7 |

Waves 1 and 2 are independent of each other and may run in either order. Waves 4–8 run in order.

## Global constraints (every wave)

Every wave plan repeats these. They are verbatim project rules, not suggestions.

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
- **Long-running routes** export the literal `export const maxDuration = 300;` — never an imported
  binding. Every new one is added to `app/api/enrich/enrich-max-duration.test.ts`.
- **Tenancy.** Every query on a user-owned table filters by `user_id`; every route test includes a
  second user whose ids are rejected (404, never 403 that leaks existence).
- **Schema changes.** Edit `lib/server/schema.ts`, run `npm run db:generate`, read the generated
  SQL, and mirror the change in `lib/server/__tests__/helpers/pglite.ts` (the test database is
  hand-written SQL, not generated) plus `loadSeed`'s key/JSON/timestamp/sequence lists when a seed
  needs the table. `books` is never dropped or recreated. Applying a migration to production is
  Chase's step, not the executor's; the plan's final task lists the command for him.
- **`.tsx` string literals are ASCII-only**; put a non-ASCII value in an expression container
  (`{'\u2026'}`), never in a bare JSX attribute. `text-base` is a colour, not a size.
- **Copy.** User-facing copy says **ScreenSprite**; code, routes, tables and settings keys say
  `screen` (spec decision 13).
- **Git.** Work on `feat/screen-media`. Chase commits manually by default: a plan's "Commit" step
  runs only when Chase has authorized commits for that execution session; otherwise stage the
  listed paths and leave them. Plain commit messages, no `Co-Authored-By` trailer; end each with
  the `Claude-Session:` line from the session's attribution instructions. Subjects:
  `feat(profile): … (#97)` for wave 1, `feat(screen): … (#96)` or `fix(profile): … (#96)` after.
- **Next.js here is not the Next.js you know.** Before writing route, page or `next/image` code,
  read the relevant guide in `node_modules/next/dist/docs/`.

---

## Cross-wave contract

These names and shapes are fixed. A wave that **produces** one must use it exactly; a wave that
**consumes** one may rely on it without re-reading the producing wave's plan. Changing one is a
plan change: stop and report.

### Database (drizzle names in `lib/server/schema.ts`)

**Wave 2** adds `profileMeta.rebuildReason` → `rebuild_reason varchar` nullable, and `profileMeta.rebuildRequestedAt` → `rebuild_requested_at timestamp` nullable (stamped by every `setRebuildReason` call).

**Wave 4** adds everything else in one migration:

- `userSettings.screenEnabled` → `screen_enabled boolean not null default false`;
  `userSettings.screenToggledAt` → `screen_toggled_at timestamp` nullable.
- `enrichJobs.kind` → `kind varchar not null default 'books'`. The partial unique index
  `uq_enrich_jobs_active_user` is replaced by `uq_enrich_jobs_active_user_kind` on
  `(user_id, kind) where status in ('pending','running')`. (Only wave 5 writes `'screen'`.)
- `tasteTraits.exhibitTitleIds` → `exhibit_title_ids json`; `tasteTraits.contrastTitleIds` →
  `contrast_title_ids json`; both nullable.
- `tasteSignal.targetTitleId` → `target_title_id integer` nullable.
- `titles` (export `titles`):
  `id serial pk`, `userId user_id varchar not null default 'local'`,
  `mediaType media_type varchar not null` (`'movie' | 'tv'`),
  `title varchar not null`, `year integer`,
  `status varchar not null` (`'watched' | 'watching' | 'dropped' | 'want'`),
  `letterboxdRating letterboxd_rating numeric(2,1) mode:'number'`,
  `appRating app_rating numeric(2,1) mode:'number'`,
  `letterboxdReview letterboxd_review text`, `appReview app_review text`,
  `lastWatchedOn last_watched_on date (mode 'string')`,
  `letterboxdUri letterboxd_uri varchar`, `wikidataQid wikidata_qid varchar`,
  `tvmazeId tvmaze_id integer`,
  `isFavorite is_favorite boolean not null default false`,
  `excludeFromProfile exclude_from_profile boolean not null default false`,
  `feedbackUpdatedAt feedback_updated_at timestamp`,
  `createdAt created_at timestamp not null default now()`, `updatedAt updated_at timestamp`.
  Indexes/constraints: `ix_titles_user_id`; partial unique `uq_titles_user_letterboxd_uri`
  `(user_id, letterboxd_uri) where letterboxd_uri is not null`; `uq_titles_user_wikidata_qid`
  `(user_id, wikidata_qid) where wikidata_qid is not null`; `uq_titles_user_tvmaze_id`
  `(user_id, tvmaze_id) where tvmaze_id is not null`; checks `ck_titles_media_type`,
  `ck_titles_status`, `ck_titles_letterboxd_rating_half_step` and `ck_titles_app_rating_half_step`
  (null or 0.5–5.0 on the half grid — **0 rejected**).
- `titleEnrichment` (table `title_enrichment`): `id serial pk`,
  `titleId title_id integer not null` (unique index `ix_title_enrichment_title_id`, FK
  `title_enrichment_title_id_fkey` → `titles.id`), `wikidataQid`, `tvmazeId integer`,
  `wikipediaPage wikipedia_page varchar`, `genres json`, `directors json`, `creators json`,
  `writers json`, `countries json`, `originalLanguage original_language varchar`,
  `basedOn based_on json` (list of `{qid, title, author}`), `mainSubjects main_subjects json`,
  `series json`, `productionCompanies production_companies json`, `sitelinks integer`,
  `description text`, `descriptionSource description_source varchar` (`'wikipedia' | 'tvmaze'`),
  `descriptionUrl description_url varchar`, `imageUrl image_url varchar`,
  `resolutionConfidence resolution_confidence double precision not null`,
  `confidenceLabel confidence_label varchar` (`HIGH | MEDIUM | LOW | CORRECTED`),
  `matchMethod match_method varchar`,
  `identitySource identity_source varchar not null default 'auto'`
  (`'auto' | 'manual' | 'corrected'`),
  `duplicateOfTitleId duplicate_of_title_id integer`, `rawResponse raw_response json`,
  `resolvedAt resolved_at timestamp not null default now()`. The people/genre lists are JSON
  arrays of label strings; `series` and `productionCompanies` are arrays of `{qid, label}`.
- `titleRecommendations` (table `title_recommendations`), per spec §6.6: `id`, `userId`,
  `runId run_id varchar not null`, `rank integer not null`, `mediaType`, `mediaFilter
  media_filter varchar not null` (`'both' | 'movie' | 'tv'`), `title`, `year`, `wikidataQid`,
  `tvmazeId integer`, `imageUrl`, `genres json`, `description text`, `retrievalPool
  retrieval_pool varchar`, `seedReason seed_reason varchar`, `score double precision not null`,
  `rationale text`, `groundedTraitIds json`, `groundedBookIds json`, `groundedTitleIds
  grounded_title_ids json`, `status varchar not null` (`served | accepted | rejected |
  already_watched`), `userNote user_note text`, `rejectReasons reject_reasons json`, `createdAt`.
  Indexes `ix_title_recommendations_user_id`, `ix_title_recommendations_run_id`.

### Server modules

| Module | Wave | Exports relied on by later waves |
|---|---|---|
| `lib/server/models.ts` | 2 | `type ModelOperation = 'profile' \| 'rerank' \| 'seed' \| 'archetype' \| 'distill' \| 'reveal'`; `modelFor(op: ModelOperation): string`. Env overrides `MYLIBRARY_MODEL_PROFILE`, `_RERANK`, `_SEED`, `_ARCHETYPE`, `_DISTILL`, `_REVEAL`; profile and rerank fall back to `MYLIBRARY_MODEL`, then `claude-sonnet-5`; the other four default to `claude-haiku-4-5-20251001`. `profileModel()` and `rankModel()` remain as thin wrappers. |
| `lib/server/profileMeta.ts` | 2 | `type RebuildReason = 'screen_enabled' \| 'screen_disabled' \| 'title_deleted' \| 'screen_library_deleted'`; `setRebuildReason(db: Db, userId: string, reason: RebuildReason): Promise<void>` and `readRebuildReason(db: Db, userId): Promise<string \| null>` (a transaction handle satisfies `Db` structurally, as `markProfiled` already relies on; upserts the row; first reason wins for the label, but every call stamps `rebuild_requested_at`). |
| `lib/server/profileBuild.ts` | 2 | `markProfiled(tx, kind, userId, runStartedAt: string, observedRebuildReason?: string \| null)` and `persistProposedTraits(db, userId, traits, validIds, kind, runStartedAt: string, observedRebuildReason?: string \| null, opts: PersistOptions = {})` — the timestamp is captured with `utcnowTs()` **before** the Claude call. A `'full'` persist clears `rebuild_reason` only when it still equals the value read at run start **and** `rebuild_requested_at` is null or older than `runStartedAt`, so any request made mid-run survives. Wave 6 adds the trailing `opts`: `interface PersistOptions { validTitleIds?: Set<number>; expectedScreenToggledAt?: string \| null }` (screen variant only). |
| `lib/server/screenSettings.ts` | 4 | `isScreenEnabled(db: Db \| DbTx, userId): Promise<boolean>`; `requireScreenEnabled(db, userId): Promise<void>` (throws `ApiError(403, SCREEN_DISABLED_MESSAGE)`); `SCREEN_DISABLED_MESSAGE = 'ScreenSprite is not enabled for this account.'`; `readScreenToggledAt(db, userId): Promise<string \| null>`; `setScreenEnabled(tx, userId, enabled: boolean)` (stamps `screen_toggled_at`; wave 6's opt-out calls it); `countTitles(db, userId)`. |
| `lib/server/titles.ts` | 4 | `type TitleRow`, `type TitleEnrichmentRow`; `effectiveTitleRating(row): number \| null` (`app_rating ?? letterboxd_rating`); `effectiveTitleReview(row): string \| null`; `isTitleProfileEvidence(row): boolean` (dropped → true; want → false; watched/watching → rated; `excludeFromProfile` → false); `titleOut(row, enr): TitleOut`; `interface TitleOut` (below); `normalizeTitleKey(title: string, year: number \| null): string` (NFKC, lowercase, non-Latin letters kept, whitespace collapsed — used for dedup and import matching). |
| `lib/server/letterboxd.ts` | 4 | `readLetterboxdZip(bytes: Uint8Array): LetterboxdExport` (throws `ApiError(413, …)` when declared or inflated sizes exceed the bounds, `ApiError(422, …)` on a malformed ZIP or missing columns); `interface LetterboxdFilm { uri: string; name: string; year: number \| null; status: 'watched' \| 'want'; rating: number \| null; review: string \| null; lastWatchedOn: string \| null; favorite: boolean }`. |
| `lib/server/importTitles.ts` | 4 | `importLetterboxdFilms(db, userId, films): Promise<{ inserted: number; updated: number; unchanged: number }>` — one transaction; also enables screen (sets `screen_enabled`, `screen_toggled_at`, and `rebuild_reason = 'screen_enabled'` when it was off). |
| `lib/server/screenPurge.ts` | 4 | `deleteScreenLibraryRows(tx, userId)`; `deleteTitleRecommendationRows(tx, userId)`. `purge.ts` calls them from `deleteProfileRows` (title recs) and `deleteAccountRows` (everything). |
| `lib/server/screenCatalog.ts` | 5 | `type CatalogResult<T> = { kind: 'ok'; value: T } \| { kind: 'empty' } \| { kind: 'retryable'; reason: string }`; `interface Deadline { remainingMs(): number }`; `wikidataSearch`, `wikidataEntities`, `wikidataSparql`, `wikipediaSummary`, `tvmazeSingleSearch`, `tvmazeShow`, `tvmazeSearch` — each takes `(db, …, deadline)` and returns a `CatalogResult`. |
| `lib/server/screenMatch.ts` | 5 | `screenNormalize(title: string): string`; `screenSimilarity(a, b): number`; `titleVariants(title: string): string[]`. |
| `lib/server/screenEnrichment.ts` | 5 | `resolveMovies(db, titles, deadline)`; `resolveTv(db, titles, deadline)`; `persistTitleResolution(tx, titleId, resolution)`; `interface ScreenCandidate` (the common catalog record for manual add, correction, and recommendation candidates: `{ media_type, title, year, wikidata_qid, tvmaze_id, image_url, description, description_source, description_url, wikipedia_page, genres, directors, creators, writers, countries, original_language, based_on, main_subjects, series, production_companies, sitelinks }`); `fetchScreenMetadata(db, qids: string[], deadline): Promise<CatalogResult<Map<string, ScreenCandidate>>>`; `ScreenCandidateSchema` (Zod; image and description hosts allow-listed); `candidateEnrichmentValues(candidate)`; `findIdentityClash(tx, userId, titleId, qid, tvmazeId): Promise<{ id: number; title: string } \| null>`; `isTitleIdentityViolation(error): boolean` (a hit on `uq_titles_user_wikidata_qid` or `uq_titles_user_tvmaze_id`). |
| `lib/server/enrichmentJobs.ts` | 5 | `type JobKind = 'books' \| 'screen'`; `findActiveJob(db, userId, kind: JobKind = 'books')`; `createOrGetActiveJob(db, userId, options, create?, kind: JobKind = 'books')`; `screenEnrichmentRunner(userId)`; the tick route dispatches on the claimed row's `kind`. |
| `lib/server/screenTiers.ts` | 6 | `buildScreenTiers(db, userId): Promise<ScreenTiers>` (`Map<string, Record<string, unknown>[]>` per medium: keys `movie`, `tv`, each an ordered tier map); `titlePayload(row, enr)`. |
| `lib/server/screenProfile.ts` | 6 | `screenVariantActive(db, userId): Promise<boolean>` (enabled **and** at least one eligible title); `titlesChangedSince(db, since, userId): Promise<TitleRow[]>` (no eligibility filter; includes titles whose `title_enrichment.resolved_at > since`). |
| `lib/server/screenOptOut.ts` | 6 | `previewScreenOptOut(db, userId): Promise<{ traits: number; confirmed: number }>`; `disableScreen(db, userId): Promise<{ traits_removed: number }>`. |
| `lib/server/screenSignal.ts`, `screenAssemble.ts`, `screenRecPrompts.ts`, `screenRecommendRun.ts`, `screenRecs.ts` | 7 | `runScreenRecommend(db, client, userId, { mediaFilter, n? })`; `blocksScreenRecs(t)` (only profile-evidence title changes block a run); `titleRecOut(row): TitleRecOut`; `SCREEN_REJECT_REASONS = ['wrong_genre', 'too_dark', 'too_long', 'not_now', 'overhyped', 'wrong_vibe']`; `ensureScreenTitle(tx, userId, rec, 'want' \| 'watched', candidate)` (an existing title comes back unchanged; a new one has `feedback_updated_at` null); `fetchRecCandidate(db, rec)`. `claudeErrors.ts` gains `SCREEN_REBUILD_REQUIRED_MESSAGE`, `SCREEN_TIMEOUT_MESSAGE`, `screenStaleMessage(books, titles)`. |

### HTTP routes

| Route | Wave | Notes |
|---|---|---|
| `GET /api/profile/status` gains `rebuild_reason` | 2 | dirty when set |
| `GET /api/settings/screen`, `PUT /api/settings/screen` `{ enabled }` | 4 (enable, plain disable), 6 (disable becomes opt-out) | `GET` returns `{ enabled, toggled_at, title_count }`; `PUT` returns the same, and a disable adds `traits_removed` (wave 6) |
| `GET /api/settings/screen/opt-out-preview` | 6 | `{ traits, confirmed }` |
| `POST /api/screen/import` (multipart field `file`, ZIP) | 4 (import), 5 (queues the screen job; response gains `job`) | wave 4: `{ inserted, updated, unchanged }`; from wave 5 always `{ inserted, updated, unchanged, job: PublicJob }`. Rate limit `RATE_LIMITS.screenImport = { limit: 5, windowSeconds: 60 }` |
| `GET /api/screen/titles` | 4 | `TitleOut[]`; query `type=movie\|tv`, `status=` |
| `GET/PATCH/DELETE /api/screen/titles/[id]` | 4 | PATCH body `{ rating?, review?, status?, is_favorite?, exclude_from_profile? }` → `TitleOut`; `rating: 0` clears `app_rating`, `review: ''` clears `app_review`. DELETE → `{ id, title, removed: true }` |
| `DELETE /api/screen/library` | 4 | spec §7.6 "Delete screen library"; not gated on the opt-in. → `{ titles_removed, title_recommendations_removed, title_signals_removed, traits_removed, recommendations_removed, profile_reset: true }` |
| `GET /api/screen/search?q=&type=movie\|tv` | 5 | `ScreenCandidate[]`; 422 on an empty or over-200-character `q` or a bad `type`; **503** `{detail}` when the catalog does not answer in time; 429 via `RATE_LIMITS.screenSearch = { limit: 30, windowSeconds: 60 }` |
| `POST /api/screen/titles` | 5 | manual add: `{ candidate: ScreenCandidate, status, rating?, review? }` → 201 `TitleOut`; 409 `"<title>" is already in your ScreenSprite library.` |
| `POST /api/screen/titles/[id]/correct` | 5 | `{ candidate: ScreenCandidate }` → `TitleOut` (label `CORRECTED`, `identity_source: 'corrected'`); 409 `That pick is already in your ScreenSprite library as "<title>".` (or without the title when the unique index catches a race) |
| `POST /api/screen/enrich/start` (`maxDuration = 300`), `GET /api/screen/enrich/active` | 5 | start body `{ force?: boolean, limit?: number \| null }` → `PublicJob` (`{ job_id, status, progress, total, error, started_at, finished_at }`), 429 via `RATE_LIMITS.screenEnrichStart = { limit: 5, windowSeconds: 60 }`; active → `{ job: PublicJob \| null }`; status via the shared `GET /api/enrich/status/[job_id]` |
| `POST /api/taste-signal` accepts `target_kind: 'title'` + `target_title_id` | 6 | |
| `GET /api/profile` trait rows gain `exhibit_title_ids`, `contrast_title_ids` | 6 | |
| `POST /api/screen/recommend` (`maxDuration = 300`), `GET /api/screen/recommendations`, `POST /api/screen/recommendations/[id]/feedback` | 7 | recommend body `{ media_filter?: 'both' \| 'movie' \| 'tv', n?: 1–20 }` (absent body = defaults) → `{ run_id: string \| null, served, media_filter, candidates, …, recommendations }`; `run_id: null` means nothing persisted. 400 gate messages as the book route plus `SCREEN_REBUILD_REQUIRED_MESSAGE`; 504 on the time budget; 429 via `RATE_LIMITS.screenRecommend = { limit: 3, windowSeconds: 60 }`. Recommendations → `TitleRecOut[]` (latest run, rank order) or `[]`. Feedback body `{ status: 'accepted' \| 'already_watched' \| 'rejected', reject_reasons?: string[] (non-empty, rejected only), user_note?: string \| null }` → `{ id, status, user_note, reject_reasons, title: TitleOut \| null }` |

### `TitleOut` (wave 4; wave 5 fills `enrichment`)

```ts
export interface TitleOut {
  id: number;
  media_type: 'movie' | 'tv';
  title: string;
  year: number | null;
  status: 'watched' | 'watching' | 'dropped' | 'want';
  rating: number | null; // effective
  app_rating: number | null;
  letterboxd_rating: number | null;
  review: string | null; // effective
  app_review: string | null;
  letterboxd_review: string | null;
  last_watched_on: string | null;
  is_favorite: boolean;
  exclude_from_profile: boolean;
  wikidata_qid: string | null;
  tvmaze_id: number | null;
  created_at: string;
  enrichment: {
    confidence_label: string | null;
    resolution_confidence: number;
    match_method: string | null;
    identity_source: 'auto' | 'manual' | 'corrected';
    image_url: string | null;
    description: string | null;
    description_source: 'wikipedia' | 'tvmaze' | null;
    description_url: string | null;
    wikipedia_page: string | null;
    genres: string[];
    directors: string[];
    creators: string[];
    duplicate_of_title_id: number | null;
  } | null;
}
```

### Frontend

- **Wave 1** moves the trait list out of `app/(main)/profile/page.tsx` into
  `components/profile/TraitsSection.tsx` and `components/profile/TraitRow.tsx`. `TraitRow` takes
  an optional `titleEvidence?: Map<number, TitleEvidence>` prop, unused until wave 8, where
  `interface TitleEvidence { id: number; title: string; year: number | null; media_type: 'movie' | 'tv' }`
  is exported from `components/profile/TraitRow.tsx`.
- **Wave 8** moves the profile page body into `components/profile/ProfileView.tsx` so `/profile`
  and `/screen/profile` render the same view.
- `lib/api.ts` gains screen calls and SWR keys in wave 8 only; waves 4–7 are exercised by route
  tests and by `curl` against the local dev server.
- **Wave 8's client surface** (`lib/api.ts`): `screenApi` (every call throws `ApiRequestError(status,
  detail)` whose `message` is the route's `detail`); SWR keys `SCREEN_SETTINGS_KEY = 'screen-settings'`,
  `SCREEN_TITLES_KEY = 'screen-titles'`, `SCREEN_RECS_KEY = 'screen-recommendations'`,
  `SCREEN_ACTIVE_JOB_KEY = 'screen-enrich-active'`, `REVEAL_TITLES_KEY = 'reveal-titles'`,
  `BOOKS_ALL_KEY = 'books-all'`; `SCREEN_REJECT_REASONS` labels; `Trait` gains optional
  `exhibit_title_ids`/`contrast_title_ids` and `ProfileStatus` optional `changed_titles`/`changed_title_ids`.
  `lib/nav.ts` gains `sectionFor(pathname)` and `SCREEN_NAV_ROUTES`. `recordTasteSignal` is unchanged: v1 has
  no title-signal control (wave 8 decision 6).

### Decisions this planning pass made (spec left them to the plan)

1. **Seed prompt carries the owned-title list** (spec §6.3 left the choice to the plan). As
   `Title (Year)` strings joined by `; `, most recently watched first, capped at 800 entries —
   about 5k tokens on the seed model for a 500-title library, cheaper than over-generating and
   re-resolving. It also asks for 20 comparables and still drops owned results after resolution.
2. **Film and TV subclass sets are a checked-in generated file**, `lib/server/screenClasses.json`,
   produced by `scripts/screen-classes.ts` (one SPARQL `P279*` walk per root, run by the
   controller, never at request time). The sets change rarely and a request-time walk is slow.
3. **All screen migrations land in wave 4**, so production takes one screen migration. Wave 2's
   `rebuild_reason` is separate because wave 2 ships book-affecting fixes that do not need screen.
4. **Manual add moves to wave 5** (see Wave order).
