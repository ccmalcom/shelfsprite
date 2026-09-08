# ShelfSprite backlog

**Last updated:** 2026-09-08

The single active work list. It merges two sources:

- `docs/repo-review-2026-09-01.md` — the full repository audit. That file stays as the written
  rationale; this file is what gets worked. Item IDs are carried over unchanged so a backlog entry
  can be read against its original evidence section.
- GitHub issues, most of which arrive through the in-app feedback form.

Open operational items previously stranded in `todo.md` are folded in here too. `todo.md` remains
as the incident/decision log for the Python retirement and the enrichment continuation work; it is
no longer the place to look for what is next.

## Status legend

| Priority | Meaning                                                                   |
| -------- | ------------------------------------------------------------------------- |
| P0       | Release blocker or live security exposure                                 |
| P1       | Address before broadening the invite pool                                 |
| P2       | Planned engineering work; fix opportunistically or in the next few cycles |
| P3       | Polish, maintainability, or optional product enhancement                  |

## P0 — before the next deployment

None open. `SEC-01` closed 2026-09-08; see **Recently closed**.

## P1 — before broadening the invite pool

### DATA-01 — Make account deletion match the product promise

**Source:** repo review · **Area:** data lifecycle / privacy
**Evidence:** `lib/server/purge.ts:57-95`, `app/(main)/settings/page.tsx`, `lib/server/schema.ts:414-447`

Settings says "Deletes ALL your data." `deleteAccountRows` still omits `feedback` and
`feedback_prompt_state` (verified 2026-09-08 — the purge covers taste traits, recommendations,
profile meta, reader archetypes, books, enrichment, user settings, reading goals, taste signals,
enrich jobs, usage events, and user directive, and nothing else). Rate-limit bucket keys can embed
user IDs and survive until the same key is used again. The Supabase Auth identity and invite records
are retained without the product saying so.

The structural hazard is that the purge is a hand-maintained list, and the newest user-owned tables
were the ones missed.

- Decide whether the action means "reset my ShelfSprite data" or "delete my account" including the
  Supabase identity, and say which in the UI.
- Inventory every table holding a user identifier, email, or user-derived content; delete or
  deliberately retain each, and disclose retentions.
- Replace the manual list with a table-driven registry or a test that enumerates user-owned schema
  tables and fails on an unclassified one.
- Add scheduled pruning for dormant rate-limit buckets.

**Done when:** an integration test seeds every user-owned table, deletes the account, proves the
expected rows are gone and a second user's rows are untouched; adding a new user-owned table fails
that test until it is classified.

### DATA-02 — Rename the JSON export or build a real restore path

**Source:** repo review · **Area:** backup / disaster recovery
**Evidence:** `lib/server/export.ts:30-74`, `app/(main)/settings/page.tsx`

Settings calls the JSON download "a complete backup." `exportJsonText` serializes books and taste
signals only — no settings, display name, enrichment, profile metadata or traits, archetype,
reading goals, recommendations, directive, or feedback. There is no JSON restore endpoint; import
accepts CSV. Taste signals reference internal book IDs that would not survive a re-import.

- Immediately change the copy to "library export" / "data export."
- If real backup is a product goal, define a versioned format with stable cross-record identifiers,
  validation, and an explicit restore flow.
- Add a round-trip test: export an account, restore into a fresh database, compare user-visible
  state.
- Separately document Supabase backup/PITR retention, ownership, and a periodic restore drill. A
  user-facing export is not a disaster-recovery plan.

**Done when:** every backup claim names exactly what is recoverable, and the library data has a
documented, tested restore procedure.

### COST-02 — Add abuse, duplication, and budget controls to costly routes

**Source:** repo review · **Area:** reliability / cost control
**Evidence:** `lib/server/ratelimit.ts`, `app/api/recommend/route.ts`, `app/api/profile/*/route.ts`

Catalog search, enrichment start, directive draft, similar books, discovery, and invite requests are
rate-limited. The recommendation and profile-generation family calls Anthropic with no route limit,
idempotency key, or per-user concurrency lock. The configured monthly cap is visibility-only.
Repeat clicks, retries, and multiple tabs can duplicate spend on the shared server key.

Usage recording happens after a successful SDK response and is best-effort, so failed or timed-out
billed requests are missing from local totals. The ledger is not billing truth.

- Add per-user limits and single-flight protection to every costly operation.
- Make long-running POSTs idempotent so a retry resumes or retrieves the same run.
- Add a configurable hard ceiling or circuit breaker for the shared server key, with a softer policy
  for bring-your-own-key users.
- Disable duplicate initiating controls in the UI, keeping the server as the enforcement point.

**Done when:** a test enumerates every Anthropic call site and asserts each has a limit/budget
policy; concurrent identical requests create at most one billed run; an admin can halt shared-key
spend without a deploy; the UI distinguishes tracked estimates from provider billing.

### OPS-02 — Close launch configuration and background-job observability gaps

**Source:** repo review + `todo.md` · **Area:** operations
**Evidence:** `app/api/healthz/route.ts`, `lib/server/http.ts`, `todo.md`

`/healthz` proves the route process is alive, not that the database is usable. Several external-state
items carried over from `todo.md` are still unverified and cannot be checked from source:

- [ ] **Set `FRONTEND_URL=https://shelfsprite.app` on Vercel.** `inviteUser`
      (`lib/server/supabaseAdmin.ts`) builds the invite `redirect_to` from it. It was set on Railway
      and is absent from Vercel, so since cutover Supabase has fallen back to its dashboard Site
      URL. This is an invite-only product and that is the only join path. Needs a redeploy.
- [ ] **Confirm what `FEEDBACK_PROMPTS_ENABLED` was on Railway.** Node defaults it to `true` when
      unset and it is absent from Vercel; if Railway held `false`, cutover silently re-enabled
      targeted feedback prompts. The Railway value was masked before the service went away.
- [ ] **Confirm the janitor actually fires at `17 3 * * *` UTC.** The cron is registered, but Vercel
      runtime-log retention does not reach 03:17 UTC, so absent log lines are a false negative.
      Needs a durable heartbeat row rather than a log query.
- [ ] **Prove tick → tick chaining.** The verification run finished inside its first tick, so no
      tick has ever had to re-arm another. At `CHUNK_BUDGET_MS = 240_000` this library completes in
      one chunk; testing it needs a much smaller budget or a much larger library. Do not test on a
      preview deployment — Vercel SSO intercepts preview ticks and produces the same symptom from a
      different cause.

Alongside those:

- Split liveness from readiness; readiness should run a tightly bounded database query.
- Give scheduled work a durable heartbeat, run ID, success/failure metric, and age-of-oldest-job
  metric, with an alert.
- Add production error tracking or structured log aggregation with alerting for unhandled API
  failures and job stalls.
- Write a short production configuration checklist verified after every environment change.

**Done when:** a broken database fails readiness without taking down liveness; a missed janitor run
or stuck queue alerts before a user reports it; required deployment variables and redirect URLs have
an owner and a repeatable verification procedure.

### PRIV-01 — Explain external data flows before broadening access

**Source:** repo review · **Area:** privacy / user trust
**Evidence:** `app/layout.tsx`, profile/recommendation prompt builders, catalog integrations

Library metadata, ratings, reviews, directives, and derived profile context can go to Anthropic.
Catalog queries go to Google Books and Open Library. Vercel Analytics is mounted globally. There is
no plain-language privacy or data-flow page covering these processors, retention, deletion, or
analytics.

- Add concise privacy and data-flow documentation before onboarding beyond the trusted test group.
- Explain what is sent to Anthropic near key setup and before the first profile or recommendation
  run, and whether shared-key and BYO-key use differ.
- Keep the disclosure consistent with the corrected `DATA-01` and `DATA-02` semantics.

**Done when:** a user can tell which services receive which categories of data and why, and the
deletion, retention, analytics, and backup descriptions agree with actual behavior.

### TEST-01 — Add a small browser-level critical-path suite

**Source:** repo review · **Area:** testing
**Evidence:** no first-party browser E2E suite exists

Component and route coverage is substantial, but nothing verifies the assembled app in a real
browser with routing, cookies, hydration, modals, and responsive layout — exactly the boundaries a
single developer/tester is most likely to miss.

A deliberately small Playwright suite:

1. Invite / login / session refresh and unauthenticated redirects.
2. Import a fixture, browse shelves, edit a book, verify persistence.
3. Enrichment / profile / recommendation with deterministic provider stubs.
4. Export and account deletion.
5. Mobile-width navigation and the principal modals.
6. Automated accessibility checks on the landing page and each primary signed-in screen.

Provider-backed smoke tests run separately and rarely; CI stays deterministic.

**Done when:** the critical suite runs in CI against a fresh test database, retains
screenshots/traces on failure, and covers keyboard navigation.

### BUG-01 — NL discovery returns unrelated results ([#52](https://github.com/ccmalcom/shelfsprite/issues/52))

**Source:** GitHub · **Area:** discovery / recommender
**Evidence:** `/discover`, `lib/server/catalog.ts`, discovery retrieval path

"Help me find my next John Scalzi read" returns no Scalzi books, plus collections and other
off-target results. Discovery is a headline feature and this is a correctness failure in the
deterministic retrieval stage, not the rerank — an author-constrained query is not producing that
author's catalog entries.

Likely overlaps `PROD-01` (canonical-edition ranking) and the `matchScore` author-token handling
recorded in `todo.md`. Investigate retrieval before touching the prompt.

**Done when:** an author-named discovery query returns that author's works ranked first, covered by
a fixture-based test rather than a single live search.

## P2 — next technical-debt cycle

### API-01 — Put consistent bounds on API inputs

**Source:** repo review · **Area:** API correctness / resource safety
**Evidence:** `app/api/books/route.ts`, `app/api/recommend/route.ts`, feedback and profile routes

Validation exists but is uneven: book-list `limit` has a maximum but no minimum and `offset` has no
minimum; recommendation `n` has neither bound; `date_read` checks shape but not whether the date
exists; titles, reviews, feedback bodies, display names, trait claims/notes, and recommendation
notes have no meaningful maximum despite being persisted and prompt-bound; a trimmed trait claim can
end up empty; the add-book API accepts arbitrary source, external identifier, and cover URL values.

Note the deliberate exception: the rating schemas for `POST /books` and `PATCH /books/{id}/feedback`
stay permissive `z.number()` on purpose, with the manual `isValidRating` guard owning the stable 422
message. Do not fold the grid rule into Zod while doing this work.

- Define shared domain schemas with positive pagination bounds, length limits, URL/provider rules,
  and real calendar-date validation.
- Test negative, zero, oversized, empty-after-trim, and invalid-date cases.

**Done when:** every list endpoint has bounded pagination, every user-controlled value that is
stored or sent to an LLM has an intentional size limit, and invalid inputs return 4xx rather than
database 500s.

### UX-01 — Do not render failed data loads as empty states

**Source:** repo review · **Area:** UI reliability
**Evidence:** `app/(main)/library/page.tsx`, `app/(main)/profile/page.tsx`, `app/(main)/settings/page.tsx`

Several SWR consumers default missing data to empty arrays and ignore the error object. A failed
shelf request looks like an empty library; a failed profile request looks like no traits, and the
feedback-prompt effect can still run after a failed trait load; settings usage can sit on
"Loading…" indefinitely.

- Introduce a shared loading/error/empty convention with an explicit retry action.
- Keep previously loaded data visible during revalidation where safe.
- Do not trigger empty-state actions, onboarding, or feedback prompts until a load has succeeded.

**Done when:** network, 401, 403, 429, and 500 states are visibly distinct from legitimate empty
data, and background revalidation failures do not erase stable content.

### PERF-01 — Paginate the library and load only the active shelf

**Source:** repo review · **Area:** frontend / data access performance
**Evidence:** `app/(main)/library/page.tsx`, `app/api/books/route.ts`

The library page eagerly requests multiple shelf datasets at a limit of 500 each and searches and
sorts client-side. That fires several requests on entry, silently truncates large shelves, and makes
counts depend on partial fetches. The profile page also pulls up to 500 books just to build an
evidence lookup.

- Fetch the active tab first; paginate or virtualize results.
- Move search/sort/filter to bounded server queries.
- Add a counts/summary endpoint instead of loading whole shelves for badges.
- Fetch profile evidence books by referenced ID, or return the needed snapshot with traits.

**Done when:** initial library load does not fetch thousands of rows, a user with more than 500
books in a shelf can reach every book, and counts are correct independently of the current page.

### DATA-03 — Make singleton creation and duplicate insertion concurrency-safe

**Source:** repo review · **Area:** database concurrency
**Evidence:** `lib/server/profileMeta.ts:7-14`, user-settings helpers, book creation/deduplication

`ensureProfileMeta` does select-then-insert against a unique singleton, so two simultaneous
first-use requests can both see no row and one can fail. User settings follow the same pattern. Book
deduplication checks existing works in application code and then inserts, so concurrent exact
duplicates pass the check.

- Use `INSERT ... ON CONFLICT` followed by a select for singletons.
- Add per-user uniqueness for strong identifiers such as normalized ISBN, retaining the fuzzy
  `sameWork` check for cases an index cannot express.
- Decide and document whether duplicate editions are allowed before tightening title/author
  uniqueness.

**Done when:** two simultaneous first-use requests both succeed and return the same singleton, and
concurrent exact-identifier creation cannot produce unintended duplicates.

### PERF-02 — Put an expiry and response policy around catalog caching

**Source:** repo review · **Area:** external integrations / caching
**Evidence:** `lib/server/catalogCache.ts`, `lib/server/catalog.ts`

Cache entries never expire, so negative lookups and provider errors become durable. The generic JSON
fetch path handles retries and 404s but does not consistently reject every other non-2xx response
before caching it.

- Require a 2xx before treating provider JSON as catalog data.
- Give successful and negative entries different TTLs; add stale-while-revalidate or an admin
  cache-bust path.
- Add global pruning and observe cache size and hit rate.
- Use small per-host concurrency rather than unrestricted `Promise.all` if provider work is
  parallelized.

**Done when:** provider error documents are never cached as book data, and corrected provider
metadata can appear without a database intervention.

### OPS-03 — Improve request and job observability without retaining unnecessary PII

**Source:** repo review · **Area:** observability
**Evidence:** `lib/server/http.ts`, `lib/server/log.ts`, background enrichment code

Request IDs are exposed only in debug behavior, raw user IDs can be logged, and there is no
checked-in error-tracking or trace integration. Long-running recommendation and enrichment flows
need operation-level timing and failure visibility more than ordinary page routes.

- Return a request ID on every response, propagate it into job/run records, surface it in error UI.
- Pseudonymize user identifiers in general logs; define log access and retention.
- Never log prompt bodies, reviews, tokens, API keys, or authorization headers.
- Add model/provider latency, token, failure, retry, and queue-age metrics.

**Done when:** a user-reported failure can be traced from request to background run without
searching by email, and alerts cover elevated API failures, stuck jobs, and unusual spend.

### SEC-04 — Add defense-in-depth response headers and cache rules

**Source:** repo review · **Area:** web security
**Evidence:** `next.config.mjs` (no `headers()`), API response helpers

No explicit Content Security Policy, referrer policy, or permissions policy is defined in the
repository. Vercel may supply some transport headers, so measure production first rather than
assuming there are none. Personalized API and export responses rely on dynamic behavior and client
`no-store` usage rather than a central policy.

- Measure actual production headers, then add `X-Content-Type-Options`, a referrer policy, and a
  minimal permissions policy.
- Roll out CSP report-only before enforcing, accounting for Next, fonts, cover sources, and Vercel
  Analytics.
- Centralize `Cache-Control: private, no-store` for authenticated responses and downloads.
- Add header tests for representative public, authenticated, admin, and export routes.

### AI-01 — Add prompt-injection and malformed-output evaluations

**Source:** repo review · **Area:** AI robustness
**Evidence:** imported reviews, catalog metadata, profile/recommendation prompt builders

Reviews and external catalog strings are untrusted text embedded in prompts. Impact is bounded by
output validation and React escaping, but quality, spend, and explanation integrity can still
degrade.

- Delimit untrusted data and instruct the model to treat it as evidence, not instructions.
- Enforce the `API-01` limits before prompt construction.
- Build an eval corpus with injection attempts, malformed Unicode, huge reviews, conflicting
  metadata, invalid IDs, and partial model JSON.
- Keep validating recommended IDs against the server-owned candidate set.

### ARCH-01 — Decompose the largest modules along feature boundaries

**Source:** repo review · **Area:** maintainability
**Evidence:** `app/(main)/library/page.tsx` (~1,265 lines), `lib/api.ts` (~1,046),
`components/SetupWizard.tsx` (~827), `lib/server/catalog.ts` (~639)

The largest files mix transport types, data fetching, state transitions, layout, and modal behavior.
They are still readable, but they create cross-feature regressions and large merge contexts.

- Split `lib/api.ts` by domain while keeping one shared fetch/error primitive.
- Extract library tab/query state and modal orchestration as part of the `PERF-01` work.
- Break `SetupWizard` into step components with a typed reducer.
- Separate catalog provider adapters from ranking/merge/cache policy.
- Extract while changing; no standalone rewrite branch.

### ARCH-02 — Retire migration-era comments and historical parity as active architecture

**Source:** repo review · **Area:** documentation debt
**Evidence:** Python/FastAPI and "parity" references across `lib`, `app`, `todo.md`

Some comments now conflict with the current architecture — Drizzle described as introspecting an
Alembic-owned schema, `lib/api.ts` described as a FastAPI client, instructions to keep Node pricing
synchronized with retired Python. Historical line-number citations can make a future maintainer or
agent preserve accidental legacy behavior as a requirement.

- Write a short ADR for the completed Python-to-Next cutover and the authoritative architecture.
- Keep comments explaining user-visible behavior, invariants, and provider surprises; drop stale
  "keep in sync" and retired file/line references as files are touched.
- Archive implementation-wave plans and incident logs rather than mixing them with active docs.
  `todo.md` is now history plus the `OPS-02` checklist; this file is the active list.
- Leave `docs/superpowers/` alone — it is a deliberate historical archive.

### DB-01 — Review the one-connection pool and add evidence-based indexes

**Source:** repo review · **Area:** database performance
**Evidence:** `lib/server/db.ts:29`, `lib/server/schema.ts`

The pool is capped at one connection per runtime instance. That protects a constrained pooler but
serializes database work inside an instance and has already shaped code around not holding a
connection during Anthropic calls. Existing indexes are mostly single-column while common queries
combine user, shelf/status, and time/order fields.

- Confirm Supabase/Vercel connection budgets and make pool size an intentionally validated setting.
- Load test import, library, profile, recommendation, and enrichment traffic before changing it.
- Capture `EXPLAIN (ANALYZE, BUFFERS)` on production-shaped queries before adding composite indexes.

**Done when:** pool size and maximum expected deployment connections are documented, and new indexes
correspond to measured query plans.

### DB-02 — Strengthen database-level domain constraints

**Source:** repo review · **Area:** data integrity
**Evidence:** `lib/server/schema.ts`

Ratings and some goal fields have database checks, but many status, kind, direction, confidence, and
shelf-like values are plain strings validated only by application code. Migrations, scripts, or a
missed route validator can write invalid state.

- Inventory finite-domain columns; add check constraints in small reversible migrations, cleaning
  data before enforcing each one.
- Keep TypeScript/Zod unions generated from or tested against the same allowed values.
- Stay conservative around fields whose value sets intentionally evolve.

### PROD-01 — Resolve catalog canonical-edition ranking behavior

**Source:** repo review + `todo.md` · **Area:** product correctness
**Evidence:** `lib/server/catalog.ts`, `todo.md` BUGS section

The year-DESC tiebreaker in `searchBooks`' comparator floats reissues and study guides above
canonical works — plain `dune` returns Kevin J. Anderson's above Frank Herbert's, confirmed live
2026-08-13 after the `matchScore` fix, which does not address it.

The committed `dune` fixture pool happens to order Herbert first, so no existing fixture can
reproduce it. A fresh recording is needed **in its own fixture file** so it does not overwrite the
pool `catalog-search.test.ts` depends on.

Two candidate signals:

- Open Library `edition_count` — the right signal, not currently in the requested `fields`. The old
  request-parity blocker is gone now that the Python harness is deleted.
- Counting dedup sightings, since `mergeInto` already collapses duplicate editions across all four
  fetches and a canonical work has far more. Needs no URL change and is source-neutral. Untried.

Google's `ratingsCount` was evaluated and rejected: sparse, tiny, and absent from Open Library, so
it behaves as a source preference rather than a tiebreaker.

**Done when:** a dedicated fixture set of known ambiguous titles ranks canonical editions first, and
the ranking stays explainable and provider-independent.

### BUG-02 — Finishing a book should prompt for a review ([#70](https://github.com/ccmalcom/shelfsprite/issues/70))

**Source:** GitHub · **Area:** library UX

Clicking "finished" on a currently-reading book moves it straight to Read with no chance to rate or
review. It should open the rating/review modal, with the text review optional.

This is also the highest-leverage moment to capture an in-app review, and per the product decisions
in-app reviews outweigh metadata inference in the taste profile — so this is a data-quality item as
much as a UX one.

**Done when:** finishing a book opens the review modal, a star rating can be set and a text review
optionally added, and dismissing still completes the shelf move.

### BUG-03 — Book descriptions missing on the To Read shelf ([#69](https://github.com/ccmalcom/shelfsprite/issues/69))

**Source:** GitHub · **Area:** library display

Descriptions do not render for books on the To Read shelf. Determine whether the description is
absent from enrichment for unread books or simply not passed through to the card/detail view on
that tab.

**Done when:** To Read entries show descriptions on the same terms as other shelves, with a test
covering the shelf-specific path.

### PROD-02 — Support alternative or lower-cost models ([#54](https://github.com/ccmalcom/shelfsprite/issues/54))

**Source:** GitHub · **Area:** AI cost / product

Offer model choice so users are not locked to one price point. `todo.md` carries a related
"openrouter instead of only claude" note.

Depends on `COST-02`: pricing, budget policy, and the usage ledger all assume a known model. Any
provider switch has to keep the recommender contract intact — deterministic retrieval produces the
candidates and the model only reranks and explains, so a weaker model degrades explanations, never
invents titles.

**Done when:** model selection is a validated setting, pricing is resolved per model from one owned
module, and unknown-model behavior is explicit rather than a silent default rate.

### PROD-03 — Investigate Claude subscription auth instead of API keys ([#53](https://github.com/ccmalcom/shelfsprite/issues/53))

**Source:** GitHub · **Area:** AI access model

Ask whether users can bring a Claude subscription rather than an API key. This is a feasibility
question first — confirm what Anthropic actually supports for third-party applications before any
design work, since a consumer subscription is not generally usable as an application credential.

**Done when:** the answer is written down with a source and date, and the issue is either closed as
not supported or converted into a scoped design item.

## P3 — polish and developer experience

### OPS-04 — Clean up build, loader, formatting, and generated-artifact warnings

**Source:** repo review · **Area:** developer experience

Verified 2026-09-08 unless noted:

- Formatting is now a CI requirement (`format:check` in `.github/workflows/ci.yml`), and
  `prettier --check .` is clean as of 2026-09-08.
- `tsconfig.check.tsbuildinfo` and the `.design-sync-build/` artifacts are tracked in git. Audit
  whether they are intentional source assets; untrack and add precise ignore rules if not.
- Next infers `/home/chase` as the workspace root because a lockfile exists above the repository.
  Set an explicit Turbopack workspace root in `next.config.mjs`.
- Vitest warns that ESM syntax is loaded through a CommonJS path and the fallback will be removed in
  a future Vite release. Move the config to unambiguous ESM and verify Jest/Next compatibility.
- `npm ls --depth=0` reported an extraneous `@emnapi/runtime`; confirm against a clean `npm ci`
  before treating it as a repository defect.

### UX-02 — Prefer reliability polish over a broad visual redesign

**Source:** repo review · **Area:** product / UI

The interface is cohesive and a general redesign is not warranted. The return is in state clarity
and density:

- Make profile-card actions (confirm / reject / apply-less) unmistakably interactive, especially on
  touch.
- Reduce density or progressively disclose evidence in long taste-profile sections.
- Add responsive visual regression checks for library, profile, setup wizard, and major modals.
- Test 200% zoom, narrow phones, keyboard-only operation, reduced motion, and long title/author
  strings.
- Preserve the existing provenance and confidence language — it is a strong trust feature.

`todo.md` also carries a broader "ui/ux full review" enhancement note; treat that as folded into
this item rather than a separate track.

### Unscheduled enhancements

Carried over from `todo.md` with no committed sequencing:

- Social features — friends, shared activity.
- Invite email delivery through an external service rather than Supabase's default.

## Recently closed

- **OPS-01** — repository CI and dependency automation landed (2026-09-08).
  `.github/workflows/ci.yml` runs the full validation matrix (type-check, ESLint, Prettier, Jest,
  Vitest, `npm run build`) on every pull request and push to `main` from a clean `npm ci`, with no
  environment variables set — verified against a fresh checkout, since every `process.env` read
  under `lib/server/**` is inside a function. A separate `audit` job blocks on
  `npm audit --omit=dev --audit-level=high` and reports the full tree non-blocking.
  `.github/dependabot.yml` batches minor and patch updates while keeping `framework` (Next, React)
  and `database` (drizzle, postgres) in their own pull requests and every major on its own.
  The three high advisories open at the time — `brace-expansion`, `browserslist`, and `js-yaml`
  — were closed with same-major `overrides` pins rather than left for the gate to trip on; see
  "Dependency pins" in `docs/conventions.md`. **Still needs a human step:** the checks are not
  required until branch protection on `main` marks "Validation matrix" and "Dependency audit"
  required, which is a GitHub repository setting, not a file in this repo.

- **SEC-01** — production authentication now fails closed (2026-09-08). `lib/server/authMode.ts`
  is the single validated auth-mode decision, called by both `lib/server/auth.ts` and
  `utils/supabase/middleware.ts`, so the two layers can no longer disagree. Any Supabase variable
  present means the set must be complete; a partial set raises `AuthConfigError` instead of
  downgrading to local mode. Local unauthenticated mode requires `ALLOW_LOCAL_AUTH=true` and a
  non-`production` `NODE_ENV`. A configuration fault answers 503, never 401 and never
  `isAdmin: true`, and `instrumentation.ts` reports it once at server start. Access tokens are now
  checked for `iss` (`<project URL>/auth/v1`, override `SUPABASE_JWT_ISSUER`) alongside audience
  and algorithm — the value was confirmed against the live project's
  `/auth/v1/.well-known/openid-configuration` and against a real signed-in session.

Resolved by PR #68 and its precursors, retained so the review document is not re-read as open work:

- **SEC-02** — Next upgraded to 16.3.4 and the production `npm audit` cleared (`742e77e`).
- **SEC-03** — the `hostname: '**'` pattern is gone from `next.config.mjs`; the allowlist is now
  Open Library plus Google Books, with the plain-HTTP Google entry retained and commented because
  the volumes API still returns `http://` thumbnails and nothing normalizes them yet (`7b0164d`).
  Normalizing cover URLs at ingestion so the HTTP pattern can be dropped is still worth doing —
  fold it into `API-01`'s URL validation.
- **COST-01** — Sonnet 5 priced at its permanent $2/$10 rate; the expired promo switch is removed
  (`2031640`). The review's follow-on recommendation to give pricing one owned module with a source
  URL and `last_verified` date is now part of `PROD-02`.

Closed GitHub issues: [#64](https://github.com/ccmalcom/shelfsprite/issues/64) recommendation
retrieval, [#63](https://github.com/ccmalcom/shelfsprite/issues/63) pinned library filter,
[#60](https://github.com/ccmalcom/shelfsprite/issues/60) reading goals,
[#57](https://github.com/ccmalcom/shelfsprite/issues/57) shelf switching,
[#55](https://github.com/ccmalcom/shelfsprite/issues/55) splash page.

## Definition of done

For every accepted item:

- Add or update automated tests that would have caught the original issue.
- Update user-facing copy and the architecture/operations docs where behavior changes.
- Run the full validation matrix, not just the nearest unit test:

  ```bash
  npm run test:server  # Vitest: lib/server/** and app/api/**
  npm test             # Jest: everything else
  npm run type-check
  npm run lint
  npm run format:check
  npm run build        # required Next segment-config/prerender gate
  ```

- Record intentional exceptions with an owner and a review date.
- Prefer small, independently deployable changes over a repository-wide cleanup branch.
