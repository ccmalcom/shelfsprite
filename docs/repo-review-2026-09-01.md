# ShelfSprite repository review

**Review date:** 2026-09-01  
**Scope:** Full repository review with emphasis on technical debt, security, data integrity, operability, testing, and user experience.  
**Constraint:** This is an audit only. No application code was changed.

## Executive summary

ShelfSprite is in better shape than its development pace might suggest. The codebase has a coherent domain model, unusually good server-side integration coverage, consistent visual design, thoughtful recommendation provenance, and extensive written behavioral context. TypeScript, ESLint, both test suites, and the production build all pass.

The most important risks are concentrated rather than systemic:

1. Production authentication fails open if the Supabase environment variables are missing or incomplete. An unauthenticated request then becomes the local administrator.
2. The installed production dependency tree contains known high-severity vulnerabilities, including the framework and image-processing path.
3. “Delete everything” does not delete every user-owned row, and “complete backup” is neither complete nor restorable. Those are user-trust promises the implementation does not currently meet.
4. Several costly Anthropic routes lack rate limits, idempotency, concurrency controls, or a hard server-key budget. The cost table also began overstating Sonnet 5 usage on the date of this review.
5. There is no repository CI workflow, browser-level test suite, or durable production job/readiness monitoring. The local test investment is strong, but it is not automatically enforced.

I would address `SEC-01` and `SEC-02` before the next deployment, then work through the P1 data-trust and operational items before expanding the invite pool.

## Priority definitions

| Priority | Meaning                                                                   |
| -------- | ------------------------------------------------------------------------- |
| P0       | Release blocker or immediate security exposure                            |
| P1       | Address before broader beta or meaningful user growth                     |
| P2       | Planned engineering work; fix opportunistically or in the next few cycles |
| P3       | Polish, maintainability, or optional product enhancement                  |

## What is already working well

- The repository has strong automated coverage for a project of this age: 258 Jest tests and 529 Vitest/PGlite tests passed.
- Database behavior is tested against PGlite rather than only mocked query builders.
- API handlers consistently resolve a request user and scope most data access by `userId`.
- Recommendation results retain provenance and user-facing explanations instead of presenting AI output as opaque fact.
- The interface has a cohesive visual language, responsive intent, keyboard/focus consideration, and existing contrast tests.
- Import, enrichment, profile, recommendation, feedback, invite, and deletion flows have meaningful unit or integration tests.
- The code contains many valuable behavioral invariants from the migration. The problem is now curating that knowledge, not recovering it.

## Prioritized backlog

### SEC-01 — Fail closed when production authentication is misconfigured

**Priority:** P0  
**Area:** Authentication / configuration  
**Evidence:** `lib/server/auth.ts:22-29`, `lib/server/auth.ts:51-58`, `utils/supabase/middleware.ts:21-22`

When no Supabase URL/JWKS is configured, `verifyRequestUser` returns the `local` user with `isAdmin: true`. The page middleware also becomes a no-op when either public Supabase variable is missing. This is convenient for local development, but a missing or partially configured production/preview environment silently becomes an unauthenticated administrator deployment. Admin APIs rely on the same identity and could expose global invite, feedback, configuration, and usage data.

**Recommendation**

- Permit local unauthenticated mode only behind an explicit opt-in that is rejected in production, or limit it to `NODE_ENV === "development"`.
- Validate the complete Supabase variable set during startup/build and fail clearly when it is incomplete.
- Make API authentication and page middleware share one validated auth-mode decision so they cannot disagree.
- Validate the expected JWT issuer in addition to audience and algorithm.
- Prefer immutable user IDs or trusted app metadata for administrator assignment if the user base expands; an email allowlist is workable but easier to misconfigure.

**Acceptance criteria**

- A production-mode test with no Supabase variables fails closed.
- A production-mode test with only some Supabase variables fails closed with a useful configuration error.
- Local mode requires deliberate configuration and remains covered by a test.
- No unauthenticated request can acquire `isAdmin: true` outside explicit local development.

### SEC-02 — Upgrade and re-audit the production dependency tree

**Priority:** P0  
**Area:** Dependencies / supply chain  
**Evidence:** `package.json:20-36`, `package-lock.json`

The installed production tree reports four high-severity vulnerable packages:

- `next@16.2.9`, with multiple framework advisories; the relevant framework fixes begin at `16.2.11` for the currently reported issues.
- `postcss@8.5.16`; the reported fixes require a newer 8.5.x release.
- `sharp@0.34.5`; the reported advisory is fixed in `0.35.0` or later.
- `nanoid@3.3.17`; the reported advisory is fixed in `3.3.18` or later.

The full tree reports 11 vulnerabilities: 7 high and 4 moderate. The additional findings are development tooling, including a `drizzle-kit`/`esbuild` chain. `npm audit fix` proposes potentially undesirable dependency movement, so this should be a controlled update rather than a blind automatic fix.

**Recommendation**

- Upgrade Next to at least the patched 16.2.x release, then regenerate the lockfile and confirm which transitive `sharp` and `nanoid` versions resolve.
- Upgrade the direct PostCSS dependency beyond the affected range.
- Review the remaining development-only findings manually. Do not accept the audit suggestion to move `drizzle-kit` to an old incompatible line without understanding it.
- Run the complete validation matrix below and manually exercise auth, image covers, imports, enrichment, and recommendations after the upgrade.
- Add automated dependency update PRs and an agreed CI audit threshold.

**Acceptance criteria**

- `npm audit --omit=dev` has no known high or critical findings, or each remaining finding has a documented, time-bounded exception.
- The framework, image optimizer, and catalog-cover paths have regression coverage after the upgrade.
- The resolved versions—not just `package.json` ranges—are verified in the lockfile.

Relevant advisories observed during this review include [Next.js authorization bypass](https://github.com/advisories/GHSA-6gpp-xcg3-4w24), [Next.js denial of service](https://github.com/advisories/GHSA-m99w-x7hq-7vfj), [Next.js rewrite SSRF](https://github.com/advisories/GHSA-p9j2-gv94-2wf4), [Next.js image optimizer SVG DoS](https://github.com/advisories/GHSA-q8wf-6r8g-63ch), [Sharp](https://github.com/advisories/GHSA-f88m-g3jw-g9cj), and [PostCSS](https://github.com/advisories/GHSA-r28c-9q8g-f849).

### DATA-01 — Make account deletion match the product promise

**Priority:** P1  
**Area:** Data lifecycle / privacy  
**Evidence:** `lib/server/purge.ts:57-95`, `app/(main)/settings/page.tsx:563-603`, `lib/api.ts:665-666`, `lib/server/db/schema.ts:414-447`

The UI says “Deletes ALL your data,” but `deleteAccountRows` omits at least the `feedback` and `feedback_prompt_state` user-owned tables. Rate-limit bucket keys can also contain user IDs and survive until incidental cleanup. The Supabase authentication identity and invite/email records appear to be retained, which may be intentional, but the product does not explain that distinction.

This is an example of a known structural hazard: account purge is a hand-maintained table list. Repository instructions explicitly say new user-owned tables must be added, yet the newer feedback tables were missed.

**Recommendation**

- Decide whether this action means “reset all ShelfSprite application data” or “delete my account,” including the Supabase Auth identity.
- Inventory every table that contains a user identifier, email address, user-generated content, or user-derived data.
- Delete or intentionally retain each class, and disclose any retention with purpose and duration.
- Replace or guard the manual list with a table-driven purge registry, database cascades where safe, or a test that discovers user-owned schema tables and fails when a table is unclassified.
- Add scheduled cleanup for dormant rate-limit buckets rather than only cleaning a key when that same key is used again.

**Acceptance criteria**

- An integration test seeds every user-owned table, deletes the account, and proves the expected rows are gone.
- Rows for a second user remain untouched.
- The UI accurately distinguishes application-data deletion, authentication-account deletion, and intentionally retained records.
- Adding a new user-owned table causes a deletion test or explicit classification check to fail.

### DATA-02 — Rename the JSON export or build a real restore path

**Priority:** P1  
**Area:** Backup / disaster recovery  
**Evidence:** `app/(main)/settings/page.tsx:482-505`, `lib/server/export.ts:30-74`

The settings page calls JSON “a complete backup.” It currently exports only books and taste signals. It omits settings, display name, enrichment, profile metadata and traits, archetype, reading goals, recommendations, directive, feedback, and other state. There is no JSON restore endpoint; import accepts CSV. Taste signals also reference internal book IDs that would not necessarily be stable after a future import.

The CSV is a useful portable library export, and the JSON is a useful partial data export. Neither is currently a complete, tested backup.

**Recommendation**

- Immediately use precise language such as “library export” or “data export” unless full restoration is supported.
- If true user backup is a product goal, define a versioned format with stable cross-record identifiers, validation, migrations, and an explicit restore/import flow.
- Add round-trip tests that export a representative account, restore it into a fresh account/database, and compare user-visible state.
- Separately document infrastructure recovery: Supabase backup/PITR capability, retention, ownership, and a periodic restore drill. A user export does not replace a database disaster-recovery plan.

**Acceptance criteria**

- Every backup claim names exactly what is recoverable.
- A “complete backup” can be restored by the user or operator and passes a round-trip test.
- The project has a documented database recovery objective and a tested restore procedure for the irreplaceable library data.

### COST-01 — Correct Sonnet 5 cost accounting

**Priority:** P1  
**Area:** AI cost telemetry  
**Evidence:** `lib/server/anthropic.ts:19-36`

The code changes Sonnet 5 pricing from $2/$10 to $3/$15 per million input/output tokens after 2026-08-31. Anthropic’s current Sonnet 5 announcement says the introductory $2/$10 pricing was made permanent. As of this review date, ShelfSprite therefore overstates Sonnet 5 costs by 50%, including cache rates derived from those values. This does not overcharge users, but it makes the usage screen and warning threshold inaccurate.

**Recommendation**

- Remove the expired promo switch and update the pricing tests to the current permanent rates.
- Put model pricing in one clearly owned module with a source URL and `last_verified` date.
- Consider configuration or a small versioned pricing table so a pricing change does not require hunting through migration-era copies.
- Add an operational reminder or dependency-like review process for price and model lifecycle changes.

**Acceptance criteria**

- Known token fixtures produce totals matching current official rates before and after 2026-08-31.
- Unknown model behavior is explicit; silently using a possibly wrong default should be avoided or clearly alerted.

Source checked on 2026-09-01: [Anthropic, Claude Sonnet 5](https://www.anthropic.com/research/claude-sonnet-5).

### COST-02 — Add abuse, duplication, and budget controls to costly routes

**Priority:** P1  
**Area:** Reliability / cost control  
**Evidence:** `lib/server/ratelimit.ts:10-27`, `app/api/recommend/route.ts`, `app/api/profile/route.ts`, `app/api/profile/update/route.ts`, `app/api/profile/archetype/route.ts`, `app/api/profile/reveal-lines/route.ts`, `app/(main)/settings/page.tsx:511-555`

Catalog search, enrichment start, directive draft, similar books, discovery, and invite requests are rate-limited. The recommendation and profile-generation family also calls Anthropic but lacks equivalent route limits, idempotency keys, or per-user concurrency locks. The configured monthly cap is explicitly visibility-only. Repeated clicks, retries, multiple tabs, or a timed-out client can duplicate spend, especially for invite users using the server’s Anthropic key.

Usage recording happens after a successful response from the SDK and is best-effort. Failed or timed-out billed requests may therefore be missing from local totals. The current ledger should not be treated as billing truth.

**Recommendation**

- Add per-user limits and single-flight/concurrency protection for every costly operation.
- Make long-running POST operations idempotent so a retry can resume or retrieve the same run.
- Add a configurable hard ceiling or global circuit breaker for the shared server key. A separate, softer policy can remain for bring-your-own-key users.
- Disable duplicate initiating controls in the UI, but keep the server as the enforcement point.
- Reconcile operational spend against provider billing and alert on material differences.

**Acceptance criteria**

- A test enumerates all Anthropic call sites and verifies each is assigned a limit/budget policy.
- Concurrent identical requests create at most one billed run.
- An administrator can halt shared-key spend without deploying code.
- The UI distinguishes estimated tracked usage from authoritative provider billing.

### OPS-01 — Add repository CI and dependency automation

**Priority:** P1  
**Area:** Delivery process  
**Evidence:** `package.json:5-18`; no workflow exists under `.github/workflows`

The local checks are good, but nothing in the repository automatically requires them on a branch or pull request. With two test runners and migration-sensitive behavior, manual execution is likely to drift.

**Recommendation**

- Add CI using a clean lockfile install.
- Run type-check, ESLint, Prettier check, Jest, Vitest/PGlite, and a production build.
- Cache dependencies but do not hide lockfile reproducibility failures.
- Add Dependabot or Renovate with grouped low-risk updates and separate framework/database updates.
- Add coverage reporting and a deliberately chosen baseline. Avoid chasing a vanity percentage; protect critical auth, purge, import, and paid-AI flows.

**Acceptance criteria**

- Required branch checks reproduce the validation matrix from a clean environment.
- A broken format, migration, type, route integration, or build test blocks merging.
- Dependency updates arrive automatically and include audit/test results.

### OPS-02 — Close launch configuration and background-job observability gaps

**Priority:** P1  
**Area:** Operations  
**Evidence:** `app/api/healthz/route.ts`, `lib/server/http.ts`, `todo.md`

The health endpoint proves that the route process is alive, but not that the database or critical dependencies are usable. The repository’s active notes also call out unresolved external-state checks: production `FRONTEND_URL`, Supabase redirect allowlists, the feedback-prompt setting, durable janitor invocation, and tick-to-tick chaining. Those cannot be verified from source alone.

**Recommendation**

- Add separate liveness and readiness semantics; readiness should exercise the database with a tightly bounded query.
- Give scheduled/background work a durable heartbeat, run ID, success/failure metric, age-of-oldest-job metric, and alert.
- Create a short production configuration checklist that is verified after every environment change.
- Resolve or explicitly defer the open items in `todo.md`; do not let deployment state live only in a historical log.
- Add production error tracking or structured log aggregation with alerting for unhandled API failures and job stalls.

**Acceptance criteria**

- A broken database fails readiness without taking down the liveness signal.
- A missed janitor run or stuck enrichment queue alerts without a user reporting it.
- Required deployment variables and redirect URLs have an owner and a repeatable verification procedure.

### PRIV-01 — Explain external data flows before broadening access

**Priority:** P1  
**Area:** Privacy / user trust  
**Evidence:** `app/layout.tsx`, profile/recommendation prompt builders, catalog integrations, settings and marketing copy

The app can send library metadata, ratings, reviews, preference directives, and derived profile context to Anthropic. Search/catalog queries go to Google Books and Open Library, and Vercel Analytics is mounted globally. The repository does not provide a plain-language privacy/data-flow page covering these processors, retention, deletion behavior, or analytics.

**Recommendation**

- Add concise privacy and data-flow documentation before onboarding users beyond a trusted test group.
- Explain what is sent to Anthropic near key setup and before the first profile/recommendation run.
- Document whether ShelfSprite’s shared key and a user-provided key have different retention or policy implications.
- Reconcile the disclosure with the corrected deletion and export semantics in `DATA-01` and `DATA-02`.
- Review applicable legal requirements separately; this repository review is not legal advice.

**Acceptance criteria**

- A user can understand which services receive which categories of data and why.
- Deletion, retention, analytics, and backup descriptions agree with actual behavior.

### SEC-03 — Remove the unrestricted remote-image allowlist

**Priority:** P1  
**Area:** Server-side fetch / image processing  
**Evidence:** `next.config.mjs:3-12`

Next Image permits every HTTPS hostname and still permits HTTP Google Books images. The comment describes ShelfSprite as a personal tool with no security concern, but it is now an invite-only multi-user service. An unrestricted optimizer pattern allows arbitrary eligible URLs to be fetched and processed by the deployment’s image path, expanding SSRF/resource-exhaustion exposure and intersecting directly with the current Next/Sharp advisories.

Current external cover usages were found to use `unoptimized` or a raw `img`, making the wildcard appear unnecessary.

**Recommendation**

- Remove the `**` hostname pattern and the HTTP source unless a demonstrated use case requires them.
- Allow only known cover providers, and normalize/validate cover URLs at ingestion.
- Prefer HTTPS and define a fallback for rejected or broken cover URLs.
- Re-test the optimizer behavior after the dependency upgrades in `SEC-02`.

**Acceptance criteria**

- An arbitrary external HTTPS URL cannot be proxied through `/_next/image`.
- Covers from supported providers still render, including missing and malformed cover cases.

### TEST-01 — Add a small browser-level critical-path suite

**Priority:** P1  
**Area:** Testing  
**Evidence:** Jest/Vitest coverage is present; no first-party browser E2E suite was found

Component and route coverage is substantial, but the repository does not verify that the assembled application works in a real browser with routing, cookies, hydration, modals, and responsive layout. These are precisely the boundaries most likely to be missed by a single developer/tester.

**Recommendation**

Start with a deliberately small Playwright suite:

1. Invite/login/session refresh and unauthenticated redirects.
2. Import a fixture, browse shelves, edit a book, and verify persistence.
3. Enrichment/profile/recommendation flows with deterministic provider stubs.
4. Export and account deletion.
5. Mobile-width navigation and the principal modals.
6. Automated accessibility checks on the landing page and each primary signed-in screen.

Run provider-backed smoke tests separately and rarely; CI should stay deterministic.

**Acceptance criteria**

- The critical suite runs in CI against a fresh test database.
- Screenshots/traces are retained on failure.
- Keyboard navigation and automated accessibility checks cover the main flows.

### API-01 — Put consistent bounds on API inputs

**Priority:** P2  
**Area:** API correctness / resource safety  
**Evidence:** `app/api/books/route.ts:16-20`, `app/api/books/route.ts:62-70`, `app/api/recommend/route.ts:11-16`, book feedback and profile routes

Validation exists, but it is uneven. Examples found during review:

- Book-list `limit` has a maximum but no minimum; `offset` has no minimum.
- Recommendation `n` has neither minimum nor maximum.
- `date_read` checks the `YYYY-MM-DD` shape but not whether the date exists.
- Several persisted or prompt-bound strings have no meaningful maximum, including titles, reviews, feedback bodies, display names, trait claims/notes, and recommendation notes.
- A trimmed trait claim can become empty after validation.
- The add-book API accepts arbitrary source, external identifier, and cover URL values even when the UI normally supplies catalog data.

**Recommendation**

- Define shared domain schemas with positive pagination bounds, length limits, URL/provider rules, and real calendar-date validation.
- Apply constraints at both API and database boundaries for important invariants.
- Add tests for negative, zero, excessively large, empty-after-trim, invalid-date, and oversized-payload cases.
- Return consistent 4xx errors instead of letting invalid inputs become database 500s.

**Acceptance criteria**

- Every list endpoint has bounded pagination.
- Every user-controlled value stored or sent to an LLM has an intentional size limit.
- Invalid enum/status/date values cannot be persisted through either application code or direct database writes where practical.

### UX-01 — Do not render failed data loads as empty states

**Priority:** P2  
**Area:** UI reliability  
**Evidence:** `app/(main)/library/page.tsx`, `app/(main)/profile/page.tsx`, `app/(main)/settings/page.tsx`

Several SWR consumers default missing data to empty arrays and ignore the error object. A failed shelf request can therefore look like an empty library. A failed profile request can look like no traits/profile, and the feedback-prompt effect can run after a failed trait load. Settings usage can remain on “Loading…” indefinitely. Similar patterns exist in some admin panels.

**Recommendation**

- Introduce a shared loading/error/empty-state convention with an explicit retry action.
- Keep previously loaded data visible during revalidation where safe.
- Do not trigger empty-state actions, onboarding, or feedback prompts until loading succeeded.
- Give destructive and paid-AI actions distinct error recovery messages rather than generic disappearance or indefinite loading.

**Acceptance criteria**

- Network, 401, 403, 429, and 500 states are visibly distinct from legitimate empty data.
- Every principal page offers retry or a useful next action.
- Background revalidation failures do not erase stable content.

### PERF-01 — Paginate the library and load only the active shelf

**Priority:** P2  
**Area:** Frontend/data access performance  
**Evidence:** `app/(main)/library/page.tsx`, `app/api/books/route.ts`

The library page eagerly requests multiple shelf datasets, each with a limit of 500, and performs search/sort client-side. This creates several requests on entry, silently truncates large shelves, duplicates tab code, and makes counts dependent on partial fetches. The profile page also fetches up to 500 books to construct an evidence lookup.

**Recommendation**

- Fetch the active tab first and paginate or virtualize book results.
- Move scalable search/sort/filter behavior to bounded server queries.
- Add a small counts/summary endpoint rather than loading whole shelves for badges.
- Fetch profile evidence books by referenced IDs or return the needed display snapshot with traits.
- Extract repeated shelf-tab behavior when making this change; avoid a standalone rewrite solely for component purity.

**Acceptance criteria**

- Initial library load does not fetch thousands of book rows.
- A user with more than 500 books in a shelf can reach every book.
- Counts remain correct independently of the current page.

### DATA-03 — Make singleton creation and duplicate insertion concurrency-safe

**Priority:** P2  
**Area:** Database concurrency  
**Evidence:** `lib/server/profileMeta.ts:7-14`, user-settings helpers, book creation/deduplication

`ensureProfileMeta` performs select-then-insert against a unique singleton. Two simultaneous first-use requests can both see no row and one can fail the insert. User-settings creation follows a similar pattern. Book deduplication checks existing works in application code and then inserts, allowing concurrent exact duplicates to pass the check.

**Recommendation**

- Use `INSERT ... ON CONFLICT DO NOTHING/UPDATE` followed by a select for singleton rows.
- Add concurrent-call integration tests.
- Add exact per-user uniqueness for strong identifiers such as normalized ISBN where product behavior permits it; retain fuzzy `sameWork` checks for cases a database index cannot express.
- Decide and document whether duplicate editions are allowed before tightening title/author uniqueness.

**Acceptance criteria**

- Two simultaneous first-use requests both succeed and return the same singleton.
- Concurrent exact-identifier book creation cannot produce unintended duplicates.

### PERF-02 — Put an expiry and response policy around catalog caching

**Priority:** P2  
**Area:** External integrations / caching  
**Evidence:** `lib/server/catalogCache.ts`, `lib/server/catalog.ts`

Catalog cache entries do not expire. Metadata may be slow-changing, but it is not immutable, and negative lookups or provider errors can become durable. The generic JSON fetch path handles retries and 404s but does not consistently reject every other non-2xx JSON response before caching/using it.

**Recommendation**

- Require a successful 2xx response before treating provider JSON as catalog data.
- Give successful and negative cache entries different TTLs.
- Add stale-while-revalidate behavior or an administrative cache-bust path for corrections.
- Add global pruning and observe cache size/hit rate.
- If parallelizing provider work, use small per-host concurrency and quota controls rather than unrestricted `Promise.all`.

**Acceptance criteria**

- 4xx/5xx provider error documents are never cached as book data.
- Corrected provider metadata can appear without a database intervention.
- Provider request volume remains within documented limits.

### OPS-03 — Improve request and job observability without retaining unnecessary PII

**Priority:** P2  
**Area:** Observability  
**Evidence:** `lib/server/http.ts`, `lib/server/log.ts`, background enrichment/job code

Structured console logging is a good start, but request IDs are exposed only in debug behavior, raw user IDs can be logged, and there is no checked-in error-tracking/trace integration. Long-running recommendation/enrichment flows need operation-level timing and failure visibility more than ordinary page routes.

**Recommendation**

- Generate and return a request ID on every response, propagate it through job/run records, and show it in error UI.
- Add error aggregation and latency/error-rate dashboards per route/operation.
- Pseudonymize user identifiers in general logs and define log access/retention.
- Never log prompt bodies, reviews, tokens, API keys, or authorization headers.
- Add model/provider latency, token, failure, retry, and queue-age metrics.

**Acceptance criteria**

- A user-reported failure can be traced from request to background run without searching by email.
- Alerts cover elevated API failures, provider failures, stuck jobs, and unusual spend.
- A documented logging policy lists prohibited fields and retention.

### ARCH-01 — Decompose the largest modules along feature boundaries

**Priority:** P2  
**Area:** Maintainability  
**Evidence:** `app/(main)/library/page.tsx` (~1,265 lines), `lib/api.ts` (~1,046), `components/SetupWizard.tsx` (~827), `lib/server/catalog.ts` (~639), settings/profile pages (~600 each)

The largest files now mix transport types, data fetching, state transitions, visual layout, and modal behavior. They are still understandable, but rapid feature additions will increasingly create cross-feature regressions and large merge contexts for AI-assisted work.

**Recommendation**

- Split `lib/api.ts` by domain while retaining one shared fetch/error primitive.
- Extract library tab/query state, reusable shelf results, and modal orchestration when the pagination work is done.
- Break SetupWizard into explicit step components with a typed state machine or reducer.
- Separate catalog provider adapters from ranking/merge/cache policy.
- Use “extract while changing” rather than a broad rewrite; preserve existing tests around each seam.

**Acceptance criteria**

- Feature modules expose small typed interfaces and do not import page-local UI state.
- Changed behavior remains covered during each extraction.
- No single refactor attempts to redesign all major modules at once.

### ARCH-02 — Retire migration-era comments and historical parity as active architecture

**Priority:** P2  
**Area:** Documentation debt  
**Evidence:** references to Python/FastAPI, “parity,” migration waves, and cutover throughout `lib`, `app`, `docs/superpowers`, and `todo.md`

The repository contains extensive and often excellent migration evidence, but some comments now conflict with the current architecture. Examples include Drizzle code described as only introspecting Alembic-owned schema, `lib/api.ts` described as a FastAPI client, and instructions to keep Node pricing synchronized with retired Python. Historical line-number citations and byte-parity notes can make future maintainers or coding agents preserve accidental legacy behavior as a product requirement.

**Recommendation**

- Create a short ADR describing the completed Python-to-Next cutover and the authoritative current architecture.
- Keep comments that explain user-visible behavior, invariants, surprising provider behavior, or safety constraints.
- Archive implementation-wave plans and incident logs rather than mixing them with active product documentation.
- Replace `todo.md` with a concise active backlog/status list and link to archived history.
- Remove stale “keep in sync” and retired file/line references as files are touched.

**Acceptance criteria**

- A new contributor can identify the authoritative runtime, schema owner, and active roadmap without reading migration plans.
- Current comments explain why behavior matters, not only how the retired implementation behaved.

### DB-01 — Review the one-connection pool and add evidence-based indexes

**Priority:** P2  
**Area:** Database performance  
**Evidence:** `lib/server/db.ts:29`, `lib/server/db/schema.ts`, recommendation/profile comments describing `max: 1`

The server pool is capped at one connection per runtime instance. That protects a constrained pooler, but it serializes database operations within an instance and has already shaped code around avoiding a held connection during Anthropic calls. Existing indexes are mostly single-column; common queries combine user, shelf/status, and time/order fields.

**Recommendation**

- Confirm Supabase/Vercel connection budgets and make the per-instance pool size an intentionally validated setting.
- Load test representative import, library, profile, recommendation, and enrichment traffic before changing it.
- Capture `EXPLAIN (ANALYZE, BUFFERS)` for slow production-shaped queries.
- Consider composite indexes for observed patterns such as user+shelf/order, user+status/time, and user+run/status—but only after query evidence.

**Acceptance criteria**

- Pool size and expected maximum deployment connections are documented.
- Changes are supported by latency/load measurements rather than intuition.
- New indexes correspond to measured query plans and do not duplicate existing coverage.

### DB-02 — Strengthen database-level domain constraints

**Priority:** P2  
**Area:** Data integrity  
**Evidence:** `lib/server/db/schema.ts`

Ratings and some goal fields have database checks, while many status, kind, direction, confidence, and shelf-like values are plain strings whose validity depends on application code. That is adequate during rapid iteration but permits invalid state from migrations, scripts, or a missed route validator.

**Recommendation**

- Inventory finite-domain columns and add check constraints in small, reversible migrations.
- Clean and verify existing data before enforcing each constraint.
- Keep TypeScript/Zod unions generated from or tested against the same allowed values to avoid drift.
- Be conservative around fields whose values intentionally evolve.

**Acceptance criteria**

- Critical workflow states cannot take impossible values at the database boundary.
- Application enums and database constraints have a drift test or single source of truth.

### OPS-04 — Clean up build, module-loader, formatting, and generated-artifact warnings

**Priority:** P3  
**Area:** Developer experience  
**Evidence:** build/test output, `.gitignore`, tracked build metadata

The validation run exposed small baseline issues:

- Next inferred `/home/chase` as the workspace root because another lockfile exists above the repository.
- Vitest warns that ESM syntax is being loaded through a CommonJS path and that the fallback will be removed in a future Vite release.
- Prettier reports only `assets/reader-types/README.md` as unformatted.
- `tsconfig.check.tsbuildinfo` and `.design-sync-build` artifacts appear tracked despite being generated/tooling-oriented.
- `npm ls --depth=0` reports an extraneous `@emnapi/runtime` package in the current installation.

**Recommendation**

- Set the appropriate Turbopack workspace root in `next.config.mjs`, or otherwise remove the environmental ambiguity.
- Move the Vitest config to an unambiguous ESM form and verify Jest/Next config compatibility.
- Format the one documentation file and make formatting a CI requirement.
- Audit generated artifacts, remove them from version control if they are not intentional source assets, and add precise ignore rules.
- Verify dependency installation from a clean `npm ci` before treating the extraneous package as a repository defect.

### SEC-04 — Add defense-in-depth response headers and cache rules

**Priority:** P2  
**Area:** Web security  
**Evidence:** `next.config.mjs`, API response helpers

The repository does not define an explicit Content Security Policy, referrer policy, permissions policy, or other baseline response headers. The hosting platform may supply some transport/security headers, so this is not proof that production has none. Personalized API/export responses also rely mostly on dynamic behavior and client `no-store` usage rather than a central explicit private/no-store response policy.

**Recommendation**

- Measure actual production headers first.
- Add `X-Content-Type-Options`, an appropriate referrer policy, and a minimal permissions policy.
- Roll out CSP in report-only mode, then enforce after accounting for Next, fonts, cover sources, and Vercel Analytics.
- Centralize `Cache-Control: private, no-store` for authenticated/user-specific API responses and downloads.
- Add automated header tests for representative public, authenticated, admin, and export routes.

### AI-01 — Add prompt-injection and malformed-output evaluations

**Priority:** P2  
**Area:** AI robustness  
**Evidence:** imported reviews, catalog metadata, profile/recommendation prompt builders

Reviews and external catalog strings are untrusted text embedded in prompts. A malicious or accidental instruction in those fields can steer profile or recommendation output. The impact is bounded by output validation and React escaping, but quality, spend, and explanation integrity can still degrade.

**Recommendation**

- Delimit untrusted data clearly and tell the model to treat it as evidence, not instructions.
- Enforce the input limits from `API-01` before prompt construction.
- Add an evaluation corpus containing prompt injection, malformed Unicode, huge reviews, conflicting metadata, invalid IDs, and partial/malformed model JSON.
- Continue validating recommended IDs against the server-owned candidate set.

### UX-02 — Prefer reliability polish over a broad visual redesign

**Priority:** P3  
**Area:** Product/UI  
**Evidence:** representative marketing, library, profile, discovery, and reader-type visuals

The interface is cohesive and distinctive; a general redesign is not warranted. The best UI return is in state clarity and density:

- Make profile-card actions such as confirm/reject/apply-less look unmistakably interactive, especially on touch devices.
- Reduce density or progressively disclose evidence in long taste-profile sections.
- Add responsive visual regression checks for the library, profile, setup wizard, and major modals.
- Test 200% zoom, narrow phones, keyboard-only operation, reduced motion, and long book/author strings.
- Preserve the existing provenance/confidence language, which is a strong trust feature.

### PROD-01 — Resolve known catalog canonical-edition ranking behavior

**Priority:** P2  
**Area:** Product correctness  
**Evidence:** `lib/server/catalog.ts`, active notes in `todo.md`

The current ranking can prefer a newer reissue, study guide, or less-canonical edition when match/cover/ISBN signals tie because publication year is used as a descending tiebreaker. This is already recognized in the project notes and should remain a tracked product correctness issue.

**Recommendation**

- Build a fixture set of known ambiguous titles and editions.
- Prefer canonical work/edition signals, publisher quality, language, and edition type before recency.
- Keep the ranking explainable and provider-independent where possible.
- Evaluate changes against the fixture set rather than tuning a few live searches.

## Suggested implementation order

### Before the next deployment

1. `SEC-01` — fail-closed production authentication.
2. `SEC-02` — production dependency upgrades and audit.
3. `SEC-03` — restrict remote image sources.
4. Verify external production configuration items in `OPS-02`.

### Before inviting a broader test group

1. `DATA-01` and `DATA-02` — deletion and backup truthfulness.
2. `COST-01` and `COST-02` — accurate telemetry and spend protection.
3. `OPS-01` and `TEST-01` — CI and critical browser tests.
4. `PRIV-01` — data-flow disclosure.
5. `UX-01` — visible error and retry states.

### Next technical-debt cycle

1. `API-01`, `DATA-03`, and `DB-02` — stronger invariants.
2. `PERF-01`, `PERF-02`, and `DB-01` — measured scaling work.
3. `OPS-03`, `ARCH-01`, and `ARCH-02` — maintainability and observability.
4. Remaining P2/P3 product polish.

## Validation performed

| Check                     | Result | Notes                                                                                                                 |
| ------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------- |
| `npm run type-check`      | Pass   | TypeScript application check passed.                                                                                  |
| `npm run lint`            | Pass   | ESLint passed.                                                                                                        |
| `npm run format:check`    | Fail   | Only `assets/reader-types/README.md` was reported.                                                                    |
| `npm test -- --runInBand` | Pass   | 29 suites, 258 tests.                                                                                                 |
| `npm run test:server`     | Pass   | 67 files, 529 tests; Vitest emitted the ESM/CommonJS loader warning described in `OPS-04`.                            |
| `npm run build`           | Pass   | Passed once Google Fonts network access was available; Next emitted the workspace-root warning described in `OPS-04`. |
| `npm audit --omit=dev`    | Fail   | 4 high-severity vulnerable packages in the production tree.                                                           |
| `npm audit`               | Fail   | 11 total: 7 high, 4 moderate.                                                                                         |

The first build attempt could not reach Google Fonts in the restricted environment; this was not an application compile failure. The successful build demonstrates correctness with network access, while also revealing that font availability is a build-time dependency. Self-hosting the fonts would improve offline/reproducible builds, but it is lower priority than the items above.

## Review method and limitations

The review covered repository structure, package and build configuration, authentication and authorization, API routes, schema and migrations, deletion/export/import behavior, Anthropic usage and spend controls, catalog integrations, background jobs, UI data-loading patterns, representative visual assets, tests, documentation, and tracked operational notes. I also ran the complete local validation matrix and current dependency audit.

This was a static/local review, not a penetration test or production incident audit. I did not inspect live Vercel, Supabase, Anthropic, DNS, analytics, or email-provider configuration, production data/query plans, actual response headers, or provider billing. Items that depend on those systems are explicitly phrased as verification work rather than confirmed production defects.

## Definition of done for this backlog

For each accepted item:

- Add or update automated tests that would have caught the original issue.
- Update user-facing copy and current architecture/operations documentation where behavior changes.
- Run the full validation matrix, not only the nearest unit test.
- Record intentional exceptions with an owner and review date.
- Prefer small, independently deployable changes over a repository-wide cleanup branch.
