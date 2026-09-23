# ScreenSprite: movies & TV with a unified taste profile — design

**Date:** 2026-09-22
**Status:** written spec approved 2026-09-22; spike run and folded in (§2.1, decisions 14–18)
**Issues:** [#96](https://github.com/ccmalcom/shelfsprite/issues/96) — "Would be cool to also have
this track/recommend tv and movies … I feel like drawing on the reading library could help
recommendations"; [#97](https://github.com/ccmalcom/shelfsprite/issues/97) — "make taste traits
section collapsible maybe? Just a wall to scroll past right now"
**Branch:** `feat/screen-media`, cut from `main` at `c5711a6`. All work for both issues lands here.

ShelfSprite gains an opt-in **screen** section, branded **ScreenSprite**: a library of movies and TV shows, a Letterboxd import
for movies, manual search-and-add for both, and screen recommendations. The two media share **one
taste profile**, so a trait can cite a novel and a film, and a user with a book-built profile and no
rated films can still get useful screen recommendations. Book pages do not change unless screen is
enabled, and even then only Profile changes.

Issue #97 rides the same branch as its own early wave: the Taste traits section becomes compact,
expandable rows. It is book-only and has no dependency on the screen work.

Every section below was adversarially reviewed by Codex against the repository before approval
(see [Review provenance](#13-review-provenance)). Findings are folded in; the notable ones are
called out where they changed the design.

---

## 0. Decisions locked (do not relitigate)

1. **One app, not a sister app.** Screen is a separate opt-in section inside ShelfSprite. Book pages
   stay unchanged; the media meet only in the taste profile and archetype.
2. **One unified taste profile** built from book and screen evidence.
3. **v1 covers movies and TV.** Movies import from a Letterboxd export; TV (and movies) can be added
   manually by search. No TV importer in v1.
4. **The TV unit is the whole show:** one rating plus a status.
5. **One screen library** for movies and TV, filterable by type; a screen recommendation run can
   return either, with a Both | Movies | TV filter.
6. **Parallel screen tables.** Book tables do not change shape; the profile is extended additively.
7. **Catalog:** Wikidata (CC0) for identity and metadata, Wikipedia (CC BY-SA) for descriptions and
   movie images, TVmaze (CC BY-SA) for TV summaries and posters. **TMDB is ruled out**: its API terms
   (last updated 2023-10-20) forbid use "in connection with … a machine learning (ML) or artificial
   intelligence (AI) based Application", which the Claude rerank is. OMDb is ruled out by its
   personal-use-only terms.
8. **Images are hotlinked, never copied.** Wikipedia poster files are non-free (fair use scoped to
   their article); ShelfSprite shows them by URL only and never on the public marketing page.
9. **Navigation is a Books | Screen section switcher** that swaps the nav set.
10. **Per-operation model settings**, each defaulting to the model that operation uses today.
    Adopting Opus 5.5 is a separate follow-up.
11. **A retrieval-quality spike gates the implementation plan** (§2).
12. **Issue #97 design:** compact expandable trait rows (not a collapsible section, not top-N).
13. **The section's user-facing name is ScreenSprite** (§7.11). It is a branded section of
    ShelfSprite, not a separate app or domain. Code identifiers stay `screen` so the name can change
    without a migration.

Added 2026-09-22 after the spike (§2.1):

14. **Wikipedia posters are hotlinked as designed.** The spike showed 545 of 553 movie images are
    non-free posters hosted on English Wikipedia, not Commons, and Commons calls hotlinking
    "possible, but not recommended". Chase accepted that risk. Decision 8 still applies: by URL
    only, never on the public page.
15. **Letterboxd likes are not imported.** The Letterboxd profile's Favorite Films (up to four)
    import as `is_favorite`; further favorites are toggled in-app, as for books.
16. **Manual add mirrors books:** rating optional; a review requires a rating
    (`AddBookModal.tsx`).
17. **Watched-but-unrated films import as `watched`.** They feed recommendation dedup and can be
    rated later; they are not profile evidence until rated (§3.2).
18. **Letterboxd-logged TV becomes TV.** An entry that resolves to a TV series with a TVmaze
    crosswalk is stored as `media_type = 'tv'` (§3.4).

---

## 1. Preconditions (verified 2026-09-22 against source, not assumed)

| Precondition | Status | Evidence |
|---|---|---|
| Trait evidence is bare book-id arrays | ✅ | `lib/server/schema.ts:43-44` (`exhibits`, `contrasts` json); `lib/server/profileBuild.ts:278-279` validates via `asIdList(…, validIds)` |
| Profile rebuild replaces only `proposed` traits; confirmed/edited survive | ✅ | `lib/server/profileBuild.ts:264-267` |
| Locked (confirmed/edited) claims are fed back as "do not output or contradict" | ✅ | `lib/server/profileFeedback.ts:115-120` |
| DNF books are profile evidence even unrated | ✅ | `lib/server/profileTiers.ts:79-83` |
| Clearing an in-app book rating falls back to the imported one; DNF may carry an unrated review | ✅ | `app/api/books/[id]/feedback/route.ts:61,68-72` |
| `markProfiled` stamps completion time, so an edit made during a run is marked profiled | ✅ (bug) | `lib/server/profileBuild.ts:162-167`, called at `:285` |
| Profile dirtiness never looks at enrichment timestamps; no generic dirty flag | ✅ | `app/api/profile/status/route.ts:53-66` |
| Clear library also resets the profile | ✅ | `app/api/library/route.ts:9-12`; `lib/server/purge.ts:20-30` |
| `normalizeTitle` strips subtitles, parentheticals and all non-`[a-z0-9 ]`; `ratio('', '')` is `1.0` | ✅ | `lib/server/dedup.ts:3-10`; `lib/server/similarity.ts:128-132` |
| The catalog client returns `null` both for 404 and after exhausting retries; `Retry-After` is uncapped | ✅ | `lib/server/catalog.ts:110,118-131` |
| Unresolved book enrichment persists as `LOW` / confidence 0 / `unresolved` | ✅ | `lib/server/enrichment.ts:149-155` |
| One active enrich job per user (partial unique index), book-only candidate selection | ✅ | `lib/server/schema.ts` `uq_enrich_jobs_active_user`; `lib/server/enrichmentJobs.ts:292-299` |
| `catalog_cache` entries never expire | ✅ | `lib/server/catalogCache.ts:1-5` |
| `next/image` covers go through the `/_next/image` optimizer with a host allowlist | ✅ | `components/BookCover.tsx:3,18`; `next.config.*` `remotePatterns` |
| Model selection: profile and rerank read `MYLIBRARY_MODEL` (default `claude-sonnet-5`); seed, archetype, distill and reveal are hardcoded to `claude-haiku-4-5-20251001` | ✅ | `lib/server/profileBuild.ts:22-24`; `lib/server/recPrompts.ts:22,70-72`; `archetypeDerive.ts:17`; `directiveDistill.ts:14`; `revealLines.ts:26` |
| Every Claude call forces its tool (`tool_choice: {type:'tool'}`) | ✅ | 11 call sites (grep `tool_choice` in `lib/server`) |
| `MODEL_PRICING` has no Opus entry; unknown models bill at a $3/$15 fallback | ✅ | `lib/server/anthropic.ts:25-35` |
| Nav: 5 primary routes shared by desktop rail and mobile bottom nav | ✅ | `lib/nav.ts` `NAV_ROUTES`; `components/BottomNav.tsx`, `components/NavBar.tsx` |
| Next's app router navigates with `history.pushState` (no `hashchange`) | ✅ | `node_modules/next/dist/client/components/app-router.js` (~line 64) |
| Trait status vocabulary is `proposed` / `edited` / `confirmed` / `rejected` | ✅ | `app/(main)/profile/page.tsx:170-182` |
| No tests cover the profile trait UI today | ✅ | no matches in `app/__tests__`, `components/__tests__` |

---

## 2. The spike (gates the implementation plan)

A throwaway investigation, run before `writing-plans`, using Chase's real Letterboxd export. Its
code is not kept. It must answer, with numbers:

1. **Export shape:** the real file list and columns (`ratings.csv`, `diary.csv`, `watchlist.csv`,
   `reviews.csv`, and whether a `watched.csv` exists for watched-but-unrated films); whether
   `Letterboxd URI` is a `boxd.it` short link.
2. **Movie resolution:** HIGH / MEDIUM / LOW / unresolved shares under the §4.3 rules; tune the 0.9
   similarity and 0.1 margin thresholds on this data.
3. **Wikidata dates:** how many films carry multiple P577 publication dates.
4. **TV crosswalk:** the exact Wikidata property holding a TVmaze series ID, and its coverage for
   shows Chase would add.
5. **Throughput:** real per-title enrichment time under each host's rate limits (Wikidata query
   service, Wikipedia REST, TVmaze ≥20 calls / 10 s).
6. **Coverage:** how often a description or image is missing; whether metadata (genre, director,
   based_on, main subject) is rich enough to ground specific traits — produce two or three example
   traits by hand from the top and bottom tiers.
7. **Retrieval quality:** run each Stage 1 pool (§6.3) seeded from real data — metadata, adaptation
   bridge, and both seed kinds (comparable titles; themes) with actually generated seed output —
   including a books-only-profile case and a TV-only case. Candidates must not be junk.
8. **Images and attribution:** hotlinking permission for `upload.wikimedia.org` and
   `static.tvmaze.com`; the exact attribution wording Wikipedia (CC BY-SA) and TVmaze require.

If the spike shows Wikidata retrieval is not viable, stop and return to design; do not plan around it.

### 2.1 Spike results (run 2026-09-22)

**Verdict: viable.** It used Chase's real Letterboxd export (562 films watched or on the
watchlist) and his ShelfSprite backup (222 books, 148 loved). The code was throwaway, and the
sections below already carry the resulting rule changes. Measured:

1. **Export shape.** The ZIP holds `profile.csv`, `watched.csv`, `ratings.csv`, `diary.csv`,
   `reviews.csv`, `watchlist.csv`, `comments.csv`, `likes/films.csv`, `lists/*.csv`, and the
   directories `deleted/` and `orphaned/`. Every `Letterboxd URI` is a `boxd.it` link, **but the
   one in `diary.csv` and `reviews.csv` points at the entry, not the film**: 0 of 43 diary rows
   joined by URI, while 43/43 diary and 16/16 review rows joined by `(Name, Year)`. `watched.csv`
   is the superset (530 films, 439 unrated). `(Name, Year)` was unique; `Name` alone was not.
   `profile.csv` carries PII beside `Favorite Films`, so only that column is read.
2. **Movie resolution** under the revised §4.3: **HIGH 97.3%, MEDIUM 1.8%, LOW 0.9%, unresolved 0**.
   A random sample of 25 HIGH was 25/25 correct, and all 10 MEDIUM were correct. The 0.9 / 0.1
   thresholds stand. The first pass (fuzzy search only, English labels only) reached 93% HIGH with
   10 unresolved, and it failed on the most famous films; see finding 2a.
   - 2a. **Wikidata `mul` labels.** Items such as *Forrest Gump* (Q134773) and *Toy Story* (Q171048)
     have no `en` label, only `mul`. Every label read and exact-label match must use `en` and `mul`.
   - 2b. **Short, common titles** (*Old*, *Her*, *Pig*, *Nosferatu* 2024) never appear in the
     top 20 results of `wbsearchentities`. An exact title + year lookup must run first.
   - 2c. **Same title, same year:** 19 cases, broken by an enwiki article (12) or popularity (7).
3. **Dates.** 184 of 557 resolved films carry more than one P577 year; 43 span more than a year.
   "Any P577 year counts" is required.
4. **TV crosswalk:** **P8600** ("TV Maze series ID"). 96% of 272 popular TVmaze shows cross-walk
   (39/42 of shows premiering 2020 on), as did 8/8 hypothetical adds and 10/10 book-derived seeds.
   Letterboxd logs some TV: 8 of 562 entries resolved to TV items, and 6 of those cross-walk.
5. **Throughput** (cold cache): about 0.25 s per film, so the whole export takes about 2.5 minutes,
   one or two chunks. Stage A SPARQL took 10 s, entity fetches 49 s, and each Wikipedia summary
   0.145 s. Wikimedia robot policy: Action API ≤ 5 req/s at concurrency 1; REST ≤ 5 req/s at
   concurrency 3. Two 429s arrived during a search burst, with `Retry-After` of about 20 s.
6. **Coverage** (557 resolved): country 100%, genre 100%, enwiki 100%, description 99%, image 99%,
   original language 99%, director 99%, screenwriter 95%, main subject 47%, based on 43%. Genres
   are generic ("drama film"). Hand-written traits from the tiers needed **series (P179)** (e.g.
   "franchise sequels land in the bottom tier") and **production company (P272)** (e.g. "the
   1990s–2000s Disney and DreamWorks animated films are comfort favourites"), so both are added
   to §4.5.
7. **Retrieval quality:**
   - **Metadata pool:** 648 unowned real films (e.g. *The Prestige*, *The Great Mouse Detective*).
     A few near-empty entries ("Talk 2 Me", 0 sitelinks) mean a popularity floor is needed.
   - **Comparable-title seeds** resolve reliably **only with a year**: *Us*, *Barbarian*, *Moon* and
     *Talk to Me* failed without one and resolved with one. 12 of 30 were already watched.
   - **Theme seeds failed.** "first contact", "space exploration", "cult" and "absurdist comedy"
     returned nothing; "black comedy" returned *Terminator 2*; "social class" returned *Jaws*.
     Themes are dropped as a retrieval kind (§6.3).
   - **Adaptation bridge** on the real library: 49 loved books had at least one adaptation. **41
     of 102 candidates came only through the book's series item** (P179 → P144): *3 Body Problem*,
     *Murderbot*, *The Expanse*, *The Dark Tower*. There was junk without a floor (*Bikini
     Frankenstein*).
   - **Books-only case** (seeds written from book tiers alone): 20/20 films resolved (14
     unwatched) and 10/10 shows resolved and cross-walked.
   - **TV-only case:** the metadata pool is thin (14 candidates from 8 shows); Wikidata creator data
     for TV is sparse. TVmaze `singlesearch` found 8/8 shows exactly.
   - Caveat: the spike's seeds were written by Opus 5.5 in-session, not by the production seed
     model (Haiku 4.5).
8. **Images and attribution.** TVmaze permits hotlinking its image CDN, and linking back to TVmaze
   satisfies CC BY-SA. Movie images: 545/553 are enwiki-local non-free posters, 8 are Commons files
   (decision 14). Wikipedia text is CC BY-SA and credited per §7.

---

## 3. Data model and ingest

### 3.1 Opt-in

`user_settings` gains `screen_enabled boolean not null default false` and `screen_toggled_at
timestamp`. A first Letterboxd import sets `screen_enabled` in the same transaction as the insert.
While it is false, no screen UI renders and no screen data enters any profile build. Opt-out
behavior is §5.7.

### 3.2 `titles`

Tenant-scoped by `user_id` like every other table.

| Column | Notes |
|---|---|
| `id` serial PK, `user_id` | |
| `media_type` | `'movie'` \| `'tv'` |
| `title`, `year` | |
| `status` | `'watched'` \| `'watching'` \| `'dropped'` \| `'want'` |
| `letterboxd_rating`, `app_rating` | `numeric(2,1)`, **`mode: 'number'`** (load-bearing, as on books), both nullable. Check constraint: null or on the 0.5 grid from 0.5 to 5.0 — **rejects 0** (unlike `ck_books_goodreads_rating_half_step`, which allows the book sentinel). |
| `letterboxd_review`, `app_review` | text |
| `last_watched_on` | date |
| `letterboxd_uri` | unique `(user_id, letterboxd_uri)` where not null |
| `wikidata_qid` | unique `(user_id, wikidata_qid)` where not null — movie identity |
| `tvmaze_id` | unique `(user_id, tvmaze_id)` where not null — TV identity |
| `is_favorite`, `exclude_from_profile` | boolean, default false |
| `feedback_updated_at` | bumped on **every** change (rating, review, status, favorite, exclusion, delete) |
| `created_at`, `updated_at` | |

**Rating semantics.** Effective rating is `app_rating ?? letterboxd_rating`. A mutation carrying `0`
clears `app_rating` (the Letterboxd rating shows again), exactly as books; the manual
`isValidRating` guard owns the 422, not the Zod schema. `letterboxd_rating` uses **null for
unrated**; there is no 0 sentinel in screen storage.

**Profile eligibility.** `dropped` behaves like DNF: evidence even unrated, and may carry an unrated
review. `want` is never evidence. `watched`/`watching` count only when rated. A review without an
effective rating is rejected unless the title is `dropped` (same guard shape as books).

**Review precedence.** `app_review ?? letterboxd_review`; clearing `app_review` reveals the
Letterboxd one.

### 3.3 `title_enrichment`

One row per title (FK to `titles.id`, unique): `wikidata_qid`, `tvmaze_id`, `wikipedia_page`,
`genres`, `directors`, `creators`, `writers`, `countries`, `original_language`, `based_on`
(json list of `{qid, title, author}`), `main_subjects`, `series`, `production_companies`,
`sitelinks` (integer popularity signal), `description`, `description_source`
(`wikipedia` \| `tvmaze`, plus the source URL for attribution), `image_url` (hotlinked),
`resolution_confidence` (numeric), `confidence_label`, `match_method`, `identity_source`
(`auto` \| `manual` \| `corrected`), `duplicate_of_title_id` (nullable), `resolved_at`, and a
**trimmed** raw payload. Cast is deliberately omitted: Wikidata's P161 is not in billing order.

### 3.4 Letterboxd import

- **Upload:** the export ZIP as one file, processed in memory under the existing 10 MiB upload
  bound. Only the named entries are read; each entry has a decompressed-size bound and the total is
  capped, checked **before** buffering (ZIP-bomb guard). Adds a small unzip dependency (e.g.
  `fflate`); the plan must add it before any dispatched task needs it.
- **Files read:** `watched.csv` (every watched film, `watched`, rated or not), `ratings.csv`,
  `watchlist.csv` (`want`), `diary.csv` (latest watch date), `reviews.csv` (most recent review
  wins), and only the `Favorite Films` column of `profile.csv` (sets `is_favorite`). Nothing else
  is read: `likes/`, `lists/`, `comments.csv`, `deleted/` and `orphaned/` are ignored, and so are
  the other `profile.csv` columns, which hold PII.
- **Joins inside the export:** `watched`, `ratings`, `watchlist` and the favourites carry
  **film** URIs and join on `Letterboxd URI`. `diary` and `reviews` URIs point at the entry, so
  those rows join to their film by exact `(Name, Year)` (§2.1 finding 1).
- **Media type:** rows are inserted as `movie`. Enrichment converts a title to `tv` when its
  resolved item is a TV series (a subclass of Q5398426) with a P8600 TVmaze ID; that ID becomes
  its identity. TV specials and TV films stay `movie` (decision 18).
- **Matching:** `letterboxd_uri` first; then Unicode-safe normalized title + year **only when exactly
  one** existing title matches; otherwise insert. A later identity clash surfaces as a possible
  duplicate (§4.4, §7.3); nothing merges silently.
- **Ownership (explicit allowlist, like `UPDATE_ELIGIBLE_FIELDS`):** Letterboxd owns
  `letterboxd_rating`, `letterboxd_review`, `letterboxd_uri`, and `last_watched_on` (later of stored
  and imported). `status` is set on insert and may only be **promoted** `want → watched` by a
  re-import, never demoted. `is_favorite` may be set true by import but is never cleared by it. A
  value absent from the export never overwrites a stored one. Rows missing from a re-import are
  never deleted. `app_*` columns are never touched (import-once).
- **After import:** start a screen enrichment job (§4.6).

### 3.5 Manual add

Search (Wikidata for movies; TVmaze plus Wikidata for TV), pick an entry, set status and optionally
a rating. As with `AddBookModal`, the rating is optional and a review requires one (decision 16).
The pick fixes identity immediately (`identity_source = manual`, label `HIGH`).

### 3.6 Export and purge

The JSON export gains a versioned section with `titles`, `title_enrichment`,
`title_recommendations`, and title-targeted taste signals. The CSV export stays book-only. Purge
scope per action is in §7.6; every purge deletes enrichment before titles for FK safety.

---

## 4. Enrichment and catalog resolution

### 4.1 Catalog clients — `lib/server/screenCatalog.ts`

Wikidata (Action API `wbsearchentities` / `wbgetentities`, SPARQL query service), Wikipedia REST
page summary, TVmaze. Per-host throttles follow published limits: Wikidata Action API ≤ 5 req/s at
concurrency 1, Wikipedia REST ≤ 5 req/s, TVmaze ≤ 20 calls / 10 s. The User-Agent names the app and
a contact website, following `catalog.ts`. **Every label read uses languages `en|mul`, and every
exact-label SPARQL match uses both `@en` and `@mul`** (§2.1 finding 2a). GET
responses go through `catalog_cache` with screen-specific `source` values. Two deliberate
departures from the book client:

- **Failure is not "no match."** Results distinguish a definite empty result from a retryable
  failure (network error, 5xx, or 429 after retries). Only a definite empty result may be persisted
  as unresolved; a failed title stays unenriched and is retried by the next chunk.
- **Deadline everywhere.** The chunk's remaining time is threaded into every request, retry and
  metadata hop, and `Retry-After` is capped. Work that runs out of time is deferred, never recorded
  as unresolved.

### 4.2 Cache retention

Screen sources in `catalog_cache` are bounded by age (90 days) and count (oldest first beyond
50,000 screen rows), pruned by the existing enrich janitor route. Book cache entries are untouched.

### 4.3 Movie resolution — `lib/server/screenEnrichment.ts`

Screen-specific comparison; the book helpers are **not** reused (§1: they manufacture false HIGHs on
non-Latin titles). Full title, NFKC, lowercased, non-Latin letters kept; an empty normalized title
never matches. Similarity is the existing `similarity.ts` ratio on these screen-normalized strings.

**Candidate lookup, in order** (§2.1 findings 2a–2b):

1. **Stage A — exact title + year, batched SPARQL.** Label or `en`/`mul` alias exactly equal to the
   title or one of its variants (as given, title case, lower case, and for a trailing parenthetical
   such as "(First Sequence)", the base title and "Base: Parenthetical"). Restrict to film or TV
   program classes in the query. Batches of about 100 titles.
2. **Stage B — `wbsearchentities` (limit 10)**, only for titles with no Stage A film matching the
   year exactly (10 of 562 in the spike).
3. **`wbgetentities`** (50 per call, `languages=en|mul`) for all candidates, then classify each by
   P31 against precomputed film / TV-program subclass sets. A SPARQL `P279*` walk run once caches
   848 film and 507 TV-program classes.

**Labels:**

- **HIGH:** exact normalized full title (label or alias, incl. variants), exact year (any P577 date
  counts; P580 for TV), and exactly one such candidate after these tie-breaks:
  - A film beats a TV item. Letterboxd is a film log.
  - The only candidate with an enwiki article wins.
- **MEDIUM:** either
  - similarity ≥ 0.9, year within ±1, and a ≥ 0.1 margin over the runner-up; or
  - an exact tie broken by **popularity**: the leader has at least 2× the runner-up's sitelinks.
    The spike broke 7 of 7 ties this way, all correctly.
- **LOW:** any other case with candidates (kept for correction, per product rule 4).
- **Unresolved:** stored exactly as books do — `confidence_label = 'LOW'`, numeric 0,
  `match_method = 'unresolved'`.

Thresholds were validated by the spike (§2.1 finding 2).

### 4.4 Identity

Movie identity is the Wikidata QID; TV identity is the TVmaze ID. A show's Wikidata QID is a
metadata bonus via the crosswalk property and may be absent.

- Forced background re-runs refresh metadata for the current identity but **never** change a
  `manual` or `corrected` identity.
- **Correction** (user picks the right entry): sets `titles.wikidata_qid` or `tvmaze_id`, replaces
  enrichment metadata, sets `confidence_label = 'CORRECTED'` and `identity_source = 'corrected'`,
  and stamps `profile_meta.enrichment_corrected_at` — one tenant-scoped transaction, as the book
  correction route does.
- **Clash:** a resolved QID that another title of the same user already holds is recorded as
  `duplicate_of_title_id`; `titles.wikidata_qid` stays null. The unique index holds and the job
  continues.

### 4.5 Metadata

From Wikidata: genre (P136), director (P57), screenwriter (P58), creator (P170), country of origin
(P495), original language (P364), based on (P144) with each source's author (P50), main subject
(P921), **part of the series (P179)** and **production company (P272)**. The spike's hand-written
traits needed the last two (§2.1 finding 6). Description from the enwiki summary; TV prefers the TVmaze summary (HTML stripped). Image:
Wikipedia summary thumbnail (movies), TVmaze image (TV). Sitelink count is stored as the
popularity signal used by tie-breaks (§4.3) and the retrieval floor (§6.3).

### 4.6 Background jobs

Reuse `enrich_jobs` and its lease machinery. Add `kind` (`'books'` default \| `'screen'`) and change
the one-active-job partial unique index to `(user_id, kind)`. **Thread `kind` through every step:**
insert, active-job lookup, unique-conflict recovery, raw-row hydration, candidate selection and the
progress recount. Existing tests pin the book default.

- `/api/enrich/tick`, `/api/enrich/status/[job_id]` and the janitor stay shared and dispatch on
  `kind`.
- New `app/api/screen/enrich/start/route.ts` exports the literal `maxDuration = 300` (never an
  imported binding). New `GET /api/screen/enrich/active` returns the user's active screen job so a
  reload recovers progress.
- Screen candidates are **all** titles (the want list needs identity for dedup and images).
  Time-bounded by `CHUNK_BUDGET_MS`; progress recounted from `title_enrichment` rows with
  `resolved_at >= started_at`; `progress: 0, total: 0` passed explicitly at insert via
  `NewJobValues`.

---

## 5. The unified taste profile

### 5.1 Books-only identity

When screen is disabled or there are no eligible titles, the full and update prompts, **both system
prompts**, and both tool schemas (`record_taste_traits`, `revise_taste_traits`) are byte-identical
to today. A golden test pins this. Every existing guard, including the no-rated-books 400, is
unchanged in this mode.

### 5.2 Screen variant

Used when screen is enabled and at least one title is eligible. It has its own system prompts and
tool descriptions that permit citations from either medium.

- After `LIBRARY DATA (JSON)` it appends `SCREEN DATA (JSON)`, built by a new `screenTiers.ts`
  under the same rules as `profileTiers.ts` (ordered `Map`, `pyJsonDumps`, explicit `ORDER BY`).
  Tier order: `'5','4.5','4','3.5','3','<=2','dropped','rejected'`. Separate tiers per medium,
  because rating habits differ between Goodreads and Letterboxd.
- Per-title payload, fixed key order: `id`, `type`, `title`, `year`, `genres` (≤8), directors or
  creators, `based_on`, `watched_year`, `review` (only when present, trimmed to 1000 chars).
- Prompt additions: evidence may span media; phrase cross-medium traits medium-neutrally; the
  polarity rule applies to title evidence; per-medium tier sizes are stated as sent and as total.
- The no-rated-evidence guard accepts either medium. Favorite titles join the favorites line as
  favorite films and shows.

### 5.3 Volume cap

Priority groups: reviewed and dropped, then favorites, then 5-star and ≤2-star, then the rest.
Within a group: most recent `last_watched_on`, nulls last, then `id`. Hard cap of 300 titles; 50
rejected screen recommendations. No movie/TV quota.

### 5.4 Typed evidence

`taste_traits` gains `exhibit_title_ids` and `contrast_title_ids` (json, nullable). The
screen-variant tools gain `exhibit_titles` and `contrast_titles`. Title ids are validated against
**the titles actually transmitted in that prompt** (tiers for a full build; the meta map for an
update). The screen variant drops a trait with no valid exhibit in either medium; the book
variant's rules are untouched.

### 5.5 Incremental update

The title detector does **not** filter by current eligibility (unlike `booksChangedSince`): changed
titles go to the model with their current rating and status, so "no longer evidence" is visible.
The update prompt carries changed titles **plus already-cited titles**, with metadata, rating and
status. A title whose `title_enrichment.resolved_at` is later than `last_profiled_at` counts as
changed. Deleting a title, enabling or disabling screen set a rebuild reason instead of taking the
incremental path.

### 5.6 Run-boundary fixes (also affect books)

- `markProfiled` is passed the **start-of-run** timestamp instead of stamping completion, so an edit
  made during inference stays pending. This fixes an existing book bug (§1).
- `profile_meta` gains `rebuild_reason`. The status route reports it as dirty; `POST
  /profile/update` escalates to a full rebuild while it is set; a completed full rebuild clears it.

### 5.7 Opt-out

Disabling screen, in one transaction: deletes **every trait with at least one title reference**
(any status, including confirmed, edited and mixed-evidence), clears the stored archetype, sets
`rebuild_reason`, and stamps `screen_toggled_at`. The confirmation first warns "N traits drew on
your viewing history and will be removed, including M you confirmed."

Profile, archetype and reveal-line writes compare `screen_toggled_at` **inside** their persisting
transaction against the value read at run start; a mismatch writes nothing.

Deleting is chosen over "mark for reassessment": opt-out is rare, deletion is deterministic, and the
cost (losing confirmations on mixed traits) is disclosed before it happens.

### 5.8 Archetype, reveal lines, highlights

The archetype derives from the unified traits; its reader-voiced copy is unchanged in v1. Reveal
lines are claim rewrites without citations, so they need no media filter and go with their trait.
Profile highlights stay book-only in v1.

### 5.9 Signals

`taste_signal` gains `target_title_id` and `target_kind = 'title'`. The route validates title
ownership, rejects mismatched target fields, and the export includes title targets.
`profileFeedback` reads title signals only in the screen variant.

### 5.10 Display

Covered in §7.5 and §8.

---

## 6. Screen recommendations

### 6.1 Scope

One run, `POST /api/screen/recommend`, with `media_filter` Both | Movies | TV. Screen "more like
this" and screen Discover are deferred. Book recommendations are unchanged except that unified trait
claims flow into the book signal, as traits already do.

### 6.2 Gate and signal

- **Gate:** mirrors `runRecommend`: blocked while books or titles changed since the last build or
  `rebuild_reason` is set. No loved-titles requirement (a book-built profile suffices). Screen rec
  feedback stamps `profile_meta.rec_feedback_updated_at` so status shows dirty, but, as for books,
  does not block the server gate. The UI blocks in the same states as Home (§7.2).
- **Signal (`screenSignal.ts`):** non-rejected traits with weight and status (reusing the book
  signal's trait loading), a **loved-books sample** (id, title, author, rating), loved titles
  (effective ≥ 4, sample 20), top genres and creators, original languages, favorites, rejected
  screen recs with notes, title more/less-like signals, the directive. Dedup sets: every title's
  QID, TVmaze ID and normalized title + year, including `want`.

### 6.3 Stage 1 retrieval — `screenAssemble.ts`

Real catalog items only. **Popularity floor for every pool:** a candidate must have an enwiki
article and at least 10 sitelinks. The spike's junk ("Talk 2 Me", *Bikini Frankenstein*) all
fell below it.

- **Metadata pool:** films and series sharing a genre and a director, creator or writer with a
  loved title, ranked by the number of shared people, then genres, then sitelinks.
- **Adaptation-bridge pool:** films and series whose `based_on` (P144) is either **the loved book's
  work item or that work's series item** (the work's P179). The series hop produced 41 of 102
  bridge candidates in the spike, including *3 Body Problem*, *Murderbot*, *The Expanse* and
  *The Dark Tower*.
  - **Title match:** the book's full title (Unicode-safe) with the Goodreads series suffix
    stripped (e.g. "(Red Rising Saga, #1)"), against `en`/`mul` labels and aliases.
  - **Author match:** the source author's `en`/`mul` label must equal the book's author or an
    additional author as an **order-insensitive token set**, so "Liu Cixin" matches "Cixin Liu".
    Any-language labels produced false mismatches ("Stifn king").
  - **Caps:** at most 3 candidates per book, and each candidate once however many books hit it.
  - **Provenance:** `seed_reason` stores the source-work (or series) QID and the matched book id.
    The rationale may say "adaptation of …" only for candidates from this pool.
- **Seed pool:** Claude proposes **comparable titles only**, each with media type and **year**
  (film release year or series premiere year). The spike's theme seeds did not resolve usefully,
  so themes are not a retrieval kind (§2.1 finding 7). A theme belongs in the seed's
  `seed_reason` text, not in the lookup. Movies resolve through the §4.3 Stage A lookup (title +
  year); shows resolve through TVmaze `singlesearch` and then the crosswalk.
  - The seed prompt carries the owned-title list, or the call over-generates: 12 of 30 spike seeds
    were already watched. The plan picks one based on prompt size (a 500-title library).
  - Only resolved items enter.
- **TV candidates** must map to a TVmaze ID through the crosswalk before entering the pool; unmapped
  shows are dropped. For TV, the metadata pool is expected to be thin (§2.1: 14 candidates from 8
  shows), so seeds carry most TV recall.
- **Assemble:** drop owned and duplicate titles, drop previously rejected, cap 2 per director or
  creator, apply the media filter and the directive's hard constraints with an explicit mapping
  (year range → release year; `exclude_subjects` → genres and main subject; `exclude_authors` →
  adaptation source author; languages → original language; a missing value passes). Cap the pool
  at 60 with a reserved share for seed-only candidates (mirrors `SEED_RESERVE_SHARE`).

### 6.4 Time budget

One request deadline inside the route's literal `maxDuration = 300`: seeds ≤ 45 s (SDK request
aborted at the limit), retrieval until 180 s, rerank gets the remainder, 20 s reserved for
persistence.

### 6.5 Stage 2 rerank

Tool `rank_screen_recommendations`. Each pick carries candidate id, score, rationale,
`grounded_trait_ids`, `grounded_book_ids` and `grounded_title_ids`, all validated against what the
prompt carried. Claude cannot add a candidate. A rerank that survives none of its citations mints
no run (issue #64 behavior).

### 6.6 Persistence and reads

`title_recommendations`: `id` serial PK, `user_id`, `run_id`, `rank`, `media_type`,
`media_filter`, `title`, `year`, `wikidata_qid`, `tvmaze_id`, `image_url`, `genres`,
`description`, `retrieval_pool`, `seed_reason`, `score`, `rationale`, `grounded_trait_ids`,
`grounded_book_ids`, `grounded_title_ids`, `status` (`served` \| `accepted` \| `rejected` \|
`already_watched`), `user_note`, `reject_reasons`, `created_at`. `GET /api/screen/recommendations`
returns the latest run across filters.

### 6.7 Feedback — `POST /api/screen/recommendations/[id]/feedback`

- **accepted / already_watched:** idempotent match on QID, TVmaze ID, or title + year. An existing
  title is returned **unchanged** (no status, rating or review overwrite). A new row gets `want` or
  `watched` plus a `title_enrichment` row populated from the candidate (`identity_source = 'auto'`).
- **rejected:** reasons from a screen-specific list `SCREEN_REJECT_REASONS` (the book list without
  `tried_author`; `too_long` means runtime or season count).
- Transactional and tenant-scoped; stamps `rec_feedback_updated_at`.

### 6.8 Models, cost and limits

Per-operation model settings, each defaulting to today's model:

| Operation | Default |
|---|---|
| profile | `MYLIBRARY_MODEL` → `claude-sonnet-5` |
| rerank | `MYLIBRARY_MODEL` → `claude-sonnet-5` |
| seed | `claude-haiku-4-5-20251001` |
| archetype | `claude-haiku-4-5-20251001` |
| distill | `claude-haiku-4-5-20251001` |
| reveal | `claude-haiku-4-5-20251001` |

Book and screen paths read the same settings. `MODEL_PRICING` gains `claude-opus-5-5` at $4 / $20
per MTok (cache write and read per the published rates) so a later switch records cost correctly.
Screen calls record through `trackedCreate` as `screen_rec_seed` and `screen_rec_rank`.
`RATE_LIMITS` gains `screenRecommend`.

---

## 7. Screen UI

**Principle:** no book page gains a control unless screen is enabled, and even then only Profile
changes.

### 7.1 Navigation

A **Books | Screen** segmented switch at the top of the desktop rail and in the mobile header,
rendered only when screen is enabled. The screen nav set is For you (`/screen`), Library
(`/screen/library`) and Profile (`/screen/profile`, rendering the same unified profile). The active
section derives from the pathname (`/screen` exactly or `/screen/*`), never stored. The book nav set
is untouched; the mobile bottom nav never exceeds 5 items. With screen disabled, `NAV_ROUTES`
behaves exactly as today, and visiting `/screen/*` redirects to `/settings#screen`.

### 7.2 For you — `/screen`

Run button with the Both | Movies | TV filter, and recommendation cards (tile, year, type,
rationale, grounding chips). Blocked in the same states as Home: status loading, no profile, or
dirty, with the same messages. An empty rerank shows "nothing new" and never re-presents an old run
as new.

- **Chip destinations:** trait → `/screen/profile?trait=<id>` (§8); title → the title detail modal;
  book → the existing book detail modal opened **read-only on the Screen page**, so no book page
  changes. Deleted evidence renders as plain text.
- **Actions:** Want to watch / Already watched / Not for me. The reject picker is extracted from the
  swipe page into a presentational component taking a reasons list and a submit callback; screen
  uses its own vocabulary and endpoint.

### 7.3 Library — `/screen/library`

Grid of `TitleTile`s with type and status filters and a sticky sort (`useStickySort`). Title detail
modal: half-star rating, status, review, favorite, exclude from profile, and source attribution.
Rating and review semantics are §3.2's. LOW-confidence titles offer correction (search, pick; §4.4).
**Merging is not in v1:** a title with `duplicate_of_title_id` shows a "Possible duplicate" badge
with a "Remove this one" action. "Add title" modal: search, pick, set status and rating. Neither
screen route is behind `LibraryGate`; each has its own empty state (import from Letterboxd, or add a
title).

### 7.4 Settings — "ScreenSprite — movies & TV" (`#screen`)

Enable toggle; Letterboxd import (ZIP upload with a progress view that polls the screen job and
recovers it via `GET /api/screen/enrich/active` after reload or modal close; "Retry enrichment"
restarts the job without re-importing); "Delete screen library"; disabling shows the §5.7 warning
before committing.

### 7.5 Profile evidence

Trait rows (§8) **and** the reveal flow (`lib/revealBeats.ts`) resolve evidence through two id
namespaces — a book map and a title map — with a film/TV marker on titles, only when screen is
enabled.

### 7.6 Destructive actions

Each confirmation names the media affected and the shared-profile consequence.

| Action | Deletes | Keeps |
|---|---|---|
| Clear library (books) | books, their enrichment, the shared profile, both recommendation tables | titles |
| Delete screen library | titles, their enrichment, screen recommendations, title signals, the shared profile | books |
| Reset profile | traits, archetype, both recommendation tables, `profile_meta` | both libraries |
| Delete account | everything | — |

### 7.7 Cache invalidation

Disabling screen and deleting the screen library invalidate traits, archetype, reveal, profile
status and every screen key. Every title rating, review, favorite, exclusion, correction and screen
rejection invalidates profile status. Use the three-argument `mutate(key, undefined, { revalidate:
true })` when the destination page is not mounted.

### 7.8 Images

`TitleTile` renders with `next/image` `unoptimized`, so the browser loads directly from
`upload.wikimedia.org` or `static.tvmaze.com` and nothing is re-encoded or cached by ShelfSprite
(the optimizer would copy the image and widen the `remotePatterns` SSRF allowlist). A missing or
failed image falls back to a typographic tile in the display face on the warm palette.

### 7.9 Attribution

Each description shows its source with license and link ("From Wikipedia", CC BY-SA, linking the
article; TVmaze credited with a link). A footer on `/screen/*` credits Wikidata, Wikipedia and
TVmaze. The link back to TVmaze satisfies TVmaze's CC BY-SA requirement, per its API page
(§2.1 finding 8). The Wikipedia credit names the article and links it, together with CC BY-SA.

### 7.10 Marketing page

Unchanged in v1.

### 7.11 Branding — ScreenSprite

User-facing copy calls the section **ScreenSprite**; code, routes, tables and settings keys stay
`screen`.

- **Wordmark:** while in the screen section (`/screen`, `/screen/*`), the rail and mobile-header
  wordmark reads ScreenSprite; everywhere else it reads ShelfSprite. The home link from the
  ScreenSprite wordmark goes to `/screen`.
- **Switcher labels** stay short — **Books | Screen** — so the switcher fits beside the wordmark at
  390 px.
- **Settings** card title: "ScreenSprite — movies & TV"; the opt-in copy, import modal and
  destructive confirmations name ScreenSprite.
- **Page headings** (`PageHeading`) on `/screen` and `/screen/library` use the ScreenSprite name.
- The `<title>` for screen pages uses ScreenSprite.
- A ScreenSprite mascot or logo variant (cf. `components/ShelfSprite.tsx`, `ReaderSprite.tsx`) is a
  follow-up (§12); v1 reuses the existing mark with the ScreenSprite wordmark.

---

## 8. Issue #97 — compact trait rows

Book-only; its own early wave on this branch; no dependency on the spike.

- **Collapsed row:** polarity badge, claim clamped to two lines, confidence percentage, status badge
  for any non-`proposed` status (`edited`, `confirmed`, `rejected`), the low-weight marker, rejected
  dimming, and a chevron. The header is a `<button>` with `aria-expanded` and `aria-controls`,
  following `TasteHero`'s disclosure pattern. Rows are independent disclosures, all start
  collapsed, and open state is not persisted.
- **Expanded panel:** full claim, examples ("e.g."), contrasts ("unlike"), title exhibits with a
  film/TV marker when screen is enabled, verdict buttons, and **Reword**. Clicking the claim toggles
  the row instead of entering edit; the helper copy changes to match.
- **Editing:** the row cannot collapse while editing; Save or Cancel exits (Cmd/Ctrl+Enter and
  Escape unchanged).
- **Deep link:** `?trait=<id>` on `/profile` or `/screen/profile`, read with `useSearchParams`
  (reactive to client navigation, unlike a hash) and applied **after traits load**: expands and
  scrolls to that row. An unknown id does nothing; a trait hidden by the current filter resets the
  filter to All first.
- **Unchanged:** the All/Loves/Avoids filter, edit/verdict/weight API calls, SWR mutations, toasts.

---

## 9. Migrations

All generated by drizzle-kit from `lib/server/schema.ts`, SQL inspected, applied through the
documented workflow; production shape verified afterwards with `information_schema.columns`, never
from schema comments.

- New tables: `titles`, `title_enrichment`, `title_recommendations`.
- `user_settings`: `screen_enabled`, `screen_toggled_at`.
- `enrich_jobs`: `kind` (default `'books'`); replace `uq_enrich_jobs_active_user` with a
  `(user_id, kind)` partial unique index.
- `taste_traits`: `exhibit_title_ids`, `contrast_title_ids`.
- `taste_signal`: `target_title_id`.
- `profile_meta`: `rebuild_reason`.

---

## 10. Testing and verification

**Runners.** New `lib/server/**` and `app/api/**` code under Vitest (`npm run test:server`);
components and pages under Jest (`npm test`). Both, plus `type-check`, `lint`, `format:check` and
`npm run build`, gate every wave.

**Load-bearing tests** (each mutation-tested: break the invariant, confirm red):

- Books-only byte identity of both profile prompts, both system prompts and both tool schemas
  (golden).
- `markProfiled` start-of-run cutoff: an edit during a run stays pending.
- Opt-out: title-citing traits deleted (including confirmed), book-only traits untouched, archetype
  cleared, in-flight run writes nothing.
- Screen title matching: non-Latin and empty-normalized titles never produce a false HIGH.
- Transport: a retryable failure never persists unresolved.
- `enrich_jobs.kind`: a book job and a screen job can be active together; book behavior unchanged.
- Import ownership: re-import never touches `app_*`, never demotes status, never deletes rows.
- Tenancy: every new route and query rejects another user's ids.
- ZIP bounds: oversized entries and total are rejected before buffering.
- Literal `maxDuration = 300` on every new long-running route (extend the existing
  `enrich-max-duration` test).

**Fixtures.** Catalog calls use the existing HTTP-replay harness; Wikidata, Wikipedia and TVmaze
fixtures are recorded by the controller (Codex's sandbox has no network). Letterboxd fixtures are
synthetic, shaped from the spike's findings, never Chase's real export.

**Real-flow verification** (required before any wave is called done): against an isolated local
database, import a real-shaped Letterboxd ZIP, run enrichment to completion, build the unified
profile, run screen recommendations with each filter, accept/reject, correct a LOW title, disable
and re-enable screen, and exercise #97's rows and `?trait=` deep link — in a real browser at 390 px
and 1440 px.

---

## 11. Suggested wave order (for `writing-plans` to confirm)

1. **#97 compact trait rows** (independent, book-only).
2. **Model settings + `markProfiled` cutoff + `rebuild_reason`** (small, book-affecting fixes that
   later waves build on).
3. ~~Spike~~ — done 2026-09-22; results in §2.1 and folded into §3–§6.
4. Schema + Letterboxd import + manual add.
5. Screen catalog, enrichment and jobs.
6. Unified profile.
7. Screen recommendations.
8. Screen UI and settings.

One pull request for the branch closes #96 and #97.

---

## 12. Out of scope (follow-ups)

- Where-to-watch availability.
- Screen "more like this" and screen Discover.
- A TV importer (IMDb CSV or Trakt).
- Duplicate merging.
- Book recommendations drawing on screen evidence beyond trait text (e.g. books adapted into loved
  films).
- Profile highlights including screen titles; archetype copy that speaks to film.
- Opus 5.5 adoption for profile and rerank: requires replacing forced `tool_choice` at all 11 call
  sites (a 400 on Opus 5.5), larger `max_tokens` with streaming (thinking cannot be disabled), and an
  A/B run on a real library. A separate issue.
- Screen screenshots on the marketing page.
- A ScreenSprite mascot or logo variant.
- Letterboxd likes and custom lists (list names can invert rating meaning, e.g. "Favorite Bad
  Movies").
- Theme-based retrieval (the spike found Wikidata genre/subject coverage too sparse; §2.1).

---

## 13. Review provenance

Each section was reviewed adversarially by Codex (read-only, against this repository) before it
was presented; findings were verified against source before being accepted.

| Section | Codex thread | Findings | Outcome |
|---|---|---|---|
| Data model & ingest | `01a0cbbd-634b-7793-b7f3-0e45dd4178f7` | 11 | all accepted (3 carried into later sections) |
| Enrichment & catalog | `01a0cbc2-59ca-77d0-9efa-54b006f29311` | 11 | 10 accepted, 1 already covered |
| Unified profile | `01a0cbcb-5241-7cd1-9aaa-034c617f54c8` | 13 | all accepted; opt-out simplified to deletion |
| Screen recommendations | `01a0cbd3-7e5e-7641-a9ed-e16cc76f407a` | 10 | 9 accepted (1 partially); model-config nit overridden by owner |
| Screen UI | `01a0cbd9-2c27-7371-adc7-e361aaf9d321` | 12 | all accepted; duplicate merge deferred |
| #97 trait rows | `01a0cbde-9f3f-78b0-9852-1d11ab13ad72` | 3 (partial — Codex usage limit) | all accepted; remainder self-reviewed |
