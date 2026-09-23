# Architecture — ShelfSprite

## Runtime shape

ShelfSprite is one TypeScript/Next.js application rooted at the repository root, deployed on Vercel. Browser code
uses the typed client in `lib/api.ts`, which sends same-origin requests to `/api` route
handlers under `app/api/`. Those handlers call the application modules in
`lib/server/`; there is no separate backend service or worker process.

Supabase supplies authentication and the Postgres database. `lib/server/auth.ts` verifies
Supabase bearer tokens and derives the tenant key from the JWT subject. `lib/server/http.ts` wraps
API handlers with authentication, admin checks, error mapping, request logging, and optional
timing headers. Page session middleware lives in `proxy.ts` and excludes `/api`, because
API routes enforce their own authentication. It rewrites an unauthenticated `/` to the public
marketing page at `/welcome` and redirects every other unauthenticated page to `/login`; see
`docs/frontend.md` for why that one is a rewrite rather than a redirect.

`lib/server/db.ts#getDb` creates the drizzle/postgres-js client, and
`lib/server/schema.ts` declares the checked-in database shape. Connections use
`prepare: false` for the Supabase transaction-mode pooler. Schema changes are generated and
applied with drizzle-kit from `drizzle/`.

## Server module map

### API, identity, and persistence

- `db.ts` / `schema.ts` — database client and drizzle tables, indexes, constraints, and inferred
  row types.
- `auth.ts` — Supabase ES256 JWT verification, local single-user mode, and admin-email
  classification (`verifyRequestUser`, `authEnabled`, `isAdminEmail`).
- `http.ts`, `errors.ts`, `log.ts` — the `withApi` route wrapper, stable API errors, request IDs,
  structured request logs, and `Server-Timing` support.
- `ratelimit.ts` — Postgres fixed-window limits used by catalog, enrichment, recommendation,
  discovery, and other protected routes (`checkRateLimit`, `RATE_LIMITS`).
- `config.ts`, `settings.ts`, `crypto.ts` — application configuration, per-user settings, and
  encryption/decryption of stored user secrets.
- `claude.ts`, `anthropic.ts`, `claudeErrors.ts` — per-user Anthropic key resolution, injectable
  Claude clients/tool-input extraction, usage-cost recording through `trackedCreate`, and shared
  user-facing failures.
- `models.ts` — per-operation Claude model selection (`modelFor`). Each operation reads its own
  `MYLIBRARY_MODEL_<OP>` override at call time and otherwise keeps its historical model; the
  global `MYLIBRARY_MODEL` reaches only profile and rerank.
- `serialize.ts` and `rating.ts` — stable response/prompt serialization and the dependency-free
  half-star domain rules. These are behavior modules, not generic formatting conveniences.
- `feedbackStatus.ts` — dependency-free feedback triage vocabulary shared by route handlers and
  client components.
- `github.ts` — outbound GitHub issue calls, webhook-signature verification, and all `GITHUB_*`
  environment reads.
- `adminFeedback.ts` — the admin feedback wire shape and email lookup shared by all three admin
  feedback routes.

### Import, library, and export

- `import-csv.ts` — CSV parsing, format detection, field normalization, canonical output, and
  preview construction (`parseImport`, `buildImportPreview`, `stringifyCanonical`).
- `import-upload.ts` — in-memory upload validation, strict decoding, and the 10 MiB upload bound
  (`readCsvUpload`, `MAX_IMPORT_BYTES`).
- `import-books.ts#importRows` — user-scoped insert/update matching by external ID, ISBN, or
  normalized title/author. Its update allowlist excludes `appRating`, `appReview`, and
  `feedbackUpdatedAt`, so an import does not clobber in-app feedback.
- `books.ts` — book and enrichment response shaping (`bookOut`, `bookSummary`) plus the canonical
  shelf vocabulary. Book mutations themselves live in the corresponding `app/api/books/**`
  route handlers and are scoped by `userId`.
- `export.ts` — user-scoped CSV and JSON backup generation (`buildExport`, `exportJsonText`).
- `purge.ts` — transactional row-deletion primitives for profile, library, and account resets.
  It deletes enrichments before books for foreign-key safety.
- `recs.ts` — recommendation response shaping, the rejection-reason vocabulary, and creation or
  matching of library books from accepted recommendations.

### ScreenSprite (movies & TV)

User-facing name ScreenSprite; code, routes and tables say `screen`. Opt-in per user
(`user_settings.screen_enabled`); design in `docs/superpowers/specs/2026-09-22-screen-media-design.md`.

- `screenSettings.ts` — the opt-in flag (`isScreenEnabled`, `requireScreenEnabled`,
  `setScreenEnabled`). Toggling stamps `screen_toggled_at` and sets a profile rebuild reason.
- `titles.ts` — title row types, effective rating/review (`app_* ?? letterboxd_*`; null means
  unrated, there is no 0 sentinel in storage), profile eligibility, `titleOut`, and
  `normalizeTitleKey` (Unicode-safe; not `dedup.normalizeTitle`).
- `letterboxd.ts` — the Letterboxd ZIP reader: declared sizes checked before inflating, allowlisted
  root entries only, diary/review rows joined to films by exact (Name, Year) because their URIs
  point at entries, and only the `Favorite Films` column of `profile.csv`.
- `importTitles.ts` — ownership-allowlisted upsert (`LETTERBOXD_OWNED_FIELDS`); a first import
  enables screen in the same transaction.
- `screenPurge.ts` — screen row deletion used by the profile, account and screen-library purges.
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

Routes: `POST /api/screen/import`, `GET|PUT /api/settings/screen`, `GET /api/screen/titles`,
`GET|PATCH|DELETE /api/screen/titles/{id}`, `DELETE /api/screen/library`, `POST /api/screen/enrich/start`,
`GET /api/screen/enrich/active`, `GET /api/screen/search`, `POST /api/screen/titles`,
`POST /api/screen/titles/{id}/correct`, `POST /api/screen/recommend`,
`GET /api/screen/recommendations`, `POST /api/screen/recommendations/{id}/feedback`.

### Catalog and enrichment

- `catalogCache.ts` — Postgres-backed catalog response cache keyed by request URL.
- `catalog.ts` — Open Library and Google Books HTTP clients, throttling/statistics, normalization,
  manual search/ranking, ISBN lookup, subject/author/query expansion, and description lookup for an
  already-resolved match (`openlibraryWorkDescription`, `googleBooksVolumeDescription`, and the
  `catalogDescription` dispatcher over the two). Its exported `Candidate` is the common catalog
  record used downstream.
- `dedup.ts` and `similarity.ts` — shared title/author normalization, same-work checks, and
  deterministic title similarity (`normalizeTitle`, `sameWork`, `titleSim`, `STRONG_SIM`).
- `enrichment.ts` — selects eligible books, resolves ISBN before title/author search, scores
  candidates, persists a result per book, and reports `HIGH`/`MEDIUM`/`LOW` or unresolved
  outcomes (`resolveOne`, `scoreCandidates`, `persistResolution`, `enrichLibrary`).
- `enrichmentJobs.ts` — durable background-job records, one-active-job handling, conditional lease
  claims, stale-job repair, time-bounded chunks, persisted-progress recounts, and continuation
  decisions (`createOrGetActiveJob`, `claimJob`, `runClaimedChunk`, `repairActiveJobs`).
- `enrichmentDispatch.ts` — `CRON_SECRET` validation and post-response dispatch of only a job ID
  to `/api/enrich/tick` through Next's `after()`.

Synchronous enrichment is exposed at `POST /api/enrich`. The serverless background flow uses
`POST /api/enrich/start`, `GET /api/enrich/status/{job_id}`, internal
`POST /api/enrich/tick`, and the janitor route. It does not rely on a resident queue worker.

Background enrichment only ever considers books with an effective rating (`candidateRows` in
`enrichmentJobs.ts`), so unrated books — the whole to-read shelf — are outside every run, forced
or not. Two paths compensate, and both are load-bearing for descriptions on that shelf:
`POST /api/books` persists the `description` the caller already holds from the catalog, and
`GET /api/books/[id]/description` lazily fills a still-empty one from the resolved match when the
detail view asks. The lazy route is never an error path: no catalog match, or a match with no
blurb, answers 200 with a null description, and its write is scoped to a still-null row so a
concurrent enrichment or user correction wins.

### Taste profile and reveal

- `profileTiers.ts` — groups effective ratings into ordered tier payloads enriched with catalog
  metadata (`buildTiers`, `tierFor`, `bookPayload`).
- `profileFeedback.ts` — gathers confirmed, edited, rejected, and downweighted traits plus
  more/less-like signals, favorites, and the user directive; it turns them into profile prompt
  guidance and prevents rejected claims from returning as close paraphrases.
- `profileBuild.ts` — builds the full metadata-driven profile prompt, calls Claude with a
  structured trait tool, validates cited IDs, and transactionally replaces the proposed trait set
  (`extractTasteProfile`, `persistProposedTraits`).
- `profileUpdate.ts` — detects changed books and feedback, assembles a bounded incremental prompt,
  performs a minimal trait revision, or falls back to a full rebuild when correction/exclusion
  semantics require one (`booksChangedSince`, `collectUpdateInputs`, `updateTasteProfile`).
- `profileMeta.ts` and `traits.ts` — profile dirty-state row creation and trait response shaping.
- `archetype.ts` / `archetypeDerive.ts` — the four-axis, 16-code reader-archetype definition and
  Claude-assisted derivation persisted per user (`scoresToCode`, `deriveArchetype`).
- `revealLines.ts` — idempotent generation and persistence of short reveal lines only for traits
  that do not already have one (`generateRevealLines`). Profile highlights are computed directly
  by `app/api/profile/highlights/route.ts` from the user's rated, enriched books.

### Recommendation and discovery

- `recSignal.ts` — the single assembled recommendation signal: loved/rated books, subjects,
  authors, languages, existing-library dedup sets, traits, feedback, rejection history, and the
  user directive (`buildSignal`, `isColdStart`). `buildBookSignal` creates the book-anchored form
  used by “more like this.”
- `recAssemble.ts` — deterministic Stage 1 retrieval. `metadataPool`, `seedPool`, and
  `discoveryPool` query real catalog sources; `assemble` removes owned/duplicate/ineligible
  editions, applies language/series/author rules, tracks provenance, and caps the pool before any
  rerank.
- `recFilters.ts` — reusable language, series, fuzzy-duplicate, learner-edition, author-cap,
  directive, and discovery constraints.
- `recPrompts.ts` / `recommendRun.ts` — query-seed and rerank prompt construction plus the main
  two-stage orchestration. `runRecommend` persists only validated catalog candidates returned by
  the rerank tool.
- `recSimilarPrompts.ts` / `recSimilarRun.ts` — ephemeral, book-anchored retrieval and reranking
  for `POST /api/books/{id}/similar`.
- `recDiscoverPrompts.ts` / `recDiscoverRun.ts` — interprets a natural-language request into
  catalog queries and supported constraints, retrieves from both catalog sources, then returns an
  ephemeral reranked result for `POST /api/discover`.

Claude may propose search queries and rank the bounded candidate pool, but it cannot introduce a
book that Stage 1 did not retrieve. Candidate IDs cited by tool output are validated before results
are returned or stored.

### Directives, feedback, and administration

- `directive.ts` / `directiveDistill.ts` — normalization of persisted directive constraints and
  an ephemeral Claude-assisted authoring flow. The persisted directive steers profile prompts and
  supported recommendation filters.
- `feedbackPrompts.ts` — eligibility and state for one-time and repeatable in-product feedback
  prompts. Feedback and taste-signal writes are implemented in their `app/api/**` handlers and
  update profile dirty-state timestamps.
- Admin feedback triage uses `GET /api/admin/feedback`, `PATCH /api/admin/feedback/[id]`, and
  `POST /api/admin/feedback/[id]/github-issue`. `POST /api/github/webhook` is public by necessity
  and self-authenticates every request with an HMAC signature before updating linked feedback.
- `invites.ts` — invite creation, Supabase-user backfill, revocation/purge sequencing, and roster
  reads (`createInvite`, `backfillFromSupabase`, `revokeUser`, `listRoster`). Its transaction
  boundaries intentionally differ by operation.
- `inviteRequests.ts` — the public waitlist: normalization, submission, listing, and review
  stamping (`submitInviteRequest`, `listInviteRequests`, `markReviewed`). Emails are lowercased and
  trimmed here on every insert _and_ every lookup, because the unique index is on the raw column
  rather than a functional index. `submitInviteRequest` is idempotent on the normalized email and
  keeps `.onConflictDoNothing()` on the insert: the preceding select is only an optimization for
  the non-racing path, and the conflict clause is what actually holds under concurrency by turning
  a second writer's unique violation into a no-op instead of a distinguishable 500.
- `supabaseAdmin.ts` — server-only GoTrue admin transport for inviting, listing, and deleting
  users. It uses the Supabase `apikey` header and exposes an injectable fetch seam for tests.

`POST /api/invite-requests` is public (`requireAuth: false`) because its entire audience is signed
out. Every accepted outcome — new email, duplicate email, honeypot — returns the same
`200 {"ok": true}`; only 422 (Zod rejected the address) and 429 differ. A distinguishable response
would make the endpoint an oracle for "is this email already known to ShelfSprite", which on an
invite-only product leaks the user list. Its rate limit is the one entry in `RATE_LIMITS` keyed by
client IP rather than by authenticated user, and it deliberately does not use
`rateLimitExceededResponse` — that helper's `{"error": ...}` shape exists only for byte-parity with
the retired Python SlowAPI handler, and this route has no Python ancestor.

The three admin routes are `GET /api/admin/invite-requests` and
`POST /api/admin/invite-requests/{id}/approve|decline`. Approve is deliberately **not**
transactional, for the same reason `createInvite` is not: the GoTrue write cannot be rolled back,
so the irreversible remote call goes first and the local stamp follows. A failure after the invite
leaves a sent invite beside a still-pending row, which is visible, harmless, and cleared by
approving again.

## Locked product decisions

1. **Goodreads CSV export is the only ingest path, with import-once semantics.** Never scrape
   Goodreads or call its API. Import seeds the library and must never overwrite in-app
   `app_rating` or `app_review` values.
2. **The recommender is two-stage.** Deterministic retrieval produces real catalog candidates;
   Claude then reranks and explains that bounded set. The LLM is never the recommender itself and
   cannot invent titles into the result.
3. **Enrichment is the foundation.** Every book receives a `resolution_confidence` of
   `HIGH`, `MEDIUM`, or `LOW`; ambiguous matches deliberately remain `LOW` for later correction.
4. **Taste profiles are metadata-driven.** Cold-start signal comes from ratings plus enriched
   metadata grouped by tier; written in-app reviews become higher-weight direct evidence.
5. **Evals are a later-phase differentiator.** Evaluation work is product strategy, not a reason
   to weaken deterministic retrieval or enrichment guarantees now.
