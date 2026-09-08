# Conventions & Gotchas — ShelfSprite

## TypeScript / TSX

- **`Modal`** (`components/ui/Modal.tsx`) takes `labelId`, `onClose`, and an optional `className`.
  It has no `title` prop; render the heading inside the modal with `id={labelId}`.
- **No non-ASCII characters inside JavaScript string literals in `.tsx` files.** Turbopack can
  reject them. Unicode is fine in JSX text nodes. In a JavaScript expression use an escape when
  needed; in a bare JSX attribute, an escape is not processed and appears as literal text.
  This half of the rule has shipped a visible defect at least once: the `/library` search box read
  `Search title or author\u2026` in production, because the escape sat in a bare
  `placeholder="\u2026"`. Put such a value in an expression container instead, so the escape is
  processed and the source stays ASCII: `placeholder={'\u2026'}`.
- **`text-base` is a COLOR, not a font size.** `tailwind.config.ts` registers a color named `base`
  (`var(--bg)`), and Tailwind's `text-*` namespace serves both `fontSize` and `textColor` with
  `textColor` registered later, so `text-base` compiles to `color: var(--bg)` and emits no font
  size at all. Written for emphasis on a colored surface (`bg-accent text-base`) that is correct
  and intentional. Written meaning "1rem body text" it paints the copy in the page background and
  the text vanishes. The responsive form is the dangerous one: `text-muted sm:text-base` looks
  right on mobile and goes invisible at `sm`, because the variant lands later in the cascade than
  the unprefixed color. For a body size use an explicit value such as `text-[1rem]`. The same
  shadowing applies to any other color token that collides with a font-size name.
- **No IIFEs inside JSX.** Compute derived values as ordinary variables at the top of the
  component.
- **Never render ratings with `'★'.repeat(rating)`.** `repeat` truncates 4.5 to four stars. Use
  `<StarRating readOnly>`, or render full stars plus an explicit half glyph.
- **Rating-keyed response objects do not preserve numeric display order.** V8 emits integer-like
  object keys before other keys, so consumers of `by_star` and `by_tier` must sort numerically.
  Do not remove a client-side sort just because the server inserted keys in the desired order.

## Git

- Treat the user's working tree as authoritative. Use read-only history commands such as
  `GIT_PAGER=cat git diff`, `git log`, and `git show` while inspecting or verifying work. Do not
  commit on the user's behalf.

## Data invariants

- **`books` is never dropped or recreated by a migration.** It contains irreplaceable ratings and
  reviews. Add or alter columns in place and inspect generated migration SQL before applying it.
- **Purge behavior is deliberate.** `deleteProfileRows` removes derived profile data and
  recommendations but keeps books. The library reset adds book/enrichment deletion. `TasteSignal`
  and `EnrichJob` rows survive both resets and are removed only by `deleteAccountRows`. Wire every
  new user-owned table into account deletion.
- **Review requires a rating.** Book creation and feedback updates reject review text on an unrated
  book, except for the existing DNF feedback rule. `BookEditModal` and `AddBookModal` enforce the
  same contract client-side.
- **Profile dirty-state includes more than rating changes.** Rated, DNF, or favorited books changed
  after `lastProfiledAt` dirty the profile. A correction timestamp in
  `profileMeta.enrichmentCorrectedAt`, trait verdicts, taste signals, and recommendation feedback
  also participate in rebuild/update decisions.
- **`excludeFromProfile` keeps a book tracked while removing its metadata from taste analysis.**
  Toggling it is a feedback change. `buildTiers` filters excluded books, and an exclusion-only
  change can require a full rebuild because an incremental prompt cannot retract missing metadata.
- Ratings use half-star steps. Database columns remain `numeric(2,1)` with drizzle
  `mode: 'number'`; `0` is a clear/unrated sentinel, not a rating.

## Search and recommender

- **The LLM is not the recommender.** `recAssemble.ts` performs deterministic retrieval against
  real catalogs; Claude may seed searches and then rerank only the bounded candidate pool.
- Search ranking and enrichment matching use different normalization rules. Keep manual search in
  `catalog.ts`; keep same-work and title similarity behavior in `dedup.ts` and `similarity.ts`.
  Do not merge paths merely because both normalize titles.
- **Unknown-language candidates always pass.** When the library has no language signal, the
  recommender defaults its allowed known language to English.
- Cold-start thresholds live in `recSignal.ts`; pool-size knobs live in `recAssemble.ts`; author,
  language, series, duplicate, learner-edition, and directive filters live in `recFilters.ts`.
  Adjust the owning module, not tests or callers.
- Series gating detects the supported numbered-title convention; do not imply that arbitrary
  series metadata exists when the catalog record does not provide it.
- Recommendation decisions are durable signal. Accepted and already-read recommendations create
  or match a library book; rejected recommendations remain excluded from future candidate sets and
  can retain structured reasons and notes.
- When landing a recommendation in the library, preserve its description, cover, and subjects in
  the stub enrichment. That row prevents ordinary enrichment from treating the book as unresolved.

## Profile

- `updateTasteProfile` is the normal path after edits; it falls back to a full
  `extractTasteProfile` rebuild when there is no prior profile or incremental evidence is
  insufficient.
- Recommendations require a built, current profile. `runRecommend` rejects a missing profile or
  relevant book changes since `lastProfiledAt`.
- Trait verdicts and weights are user feedback. Confirmed traits survive later builds, rejected
  claims are filtered, downweighted traits are softened, and each verdict dirties the profile.
- Taste signals are durable positive or negative evidence. Recommendation-kind signals retain a
  snapshot so deleting recommendation rows does not erase the steering input.
- `/profile/subjects` aggregates enrichment subjects for rated books by tier, normalizes casing,
  and caps each book's subject contribution.

## SWR cache and frontend state

- After setup/import mutations, refresh the shared stats cache with fresh data:
  `await mutate('stats', api.stats(), { revalidate: false })`. A bare `mutate('stats')` may not
  refetch when no mounted component subscribes to the key.
- `LibraryGate` latches its setup-versus-ready decision on the first stats load. The wizard advances
  it through `onComplete`; do not make the gate reactively swap out as soon as a book is imported.

## Manual add

- Manual add is search-and-pick only: stored books come from real catalog hits, never free-typed
  titles. Same-work duplicates return 409 and are surfaced as already in the library.

## Linting and formatting

- ESLint and Prettier are configured at the repository root. Run `npm run lint`,
  `npm run format:check`, and the rest of the gates documented in `CLAUDE.md` from that directory.
- Prettier's scope includes `.github/`, so workflow and Dependabot YAML has to be Prettier-clean
  like everything else. `.prettierignore` lists the deliberate exclusions and says why for each.

## Continuous integration

`.github/workflows/ci.yml` runs the validation matrix on every pull request and every push to
`main`. It is the same six commands `CLAUDE.md` lists, in one `verify` job, plus a separate
`audit` job.

- **The job sets no environment variables, and that is load-bearing.** Every `process.env` read
  under `lib/server/**` happens inside a function rather than at module load, so a checkout with no
  local configuration file type-checks, tests, and builds. If a gate ever starts needing
  configuration, the fix is the module-load-time read, not a secret in CI — putting production
  credentials behind a compile gate is how they leak.
- Each gate carries `if: ${{ !cancelled() && steps.install.outcome == 'success' }}` so one failure
  reports alongside the others instead of hiding them. They skip only when `npm ci` itself failed.
- Actions are pinned by major version and kept current by Dependabot. Check the real latest tag
  before hand-editing one; `actions/checkout` and `actions/setup-node` are further along than the
  `v4` that most examples still show.

`npm audit --omit=dev --audit-level=high` is the blocking threshold. It scopes the gate to what
actually reaches the Vercel runtime, so a high advisory in build-only tooling reports without
wedging the branch; the full-tree `npm audit` runs beside it as `continue-on-error`. The four
moderate advisories that survive there are the `drizzle-kit → @esbuild-kit → esbuild` chain, whose
only npm-offered fix is a major _downgrade_ of drizzle-kit to 0.18.1.

## Dependency pins

The `overrides` block in `package.json` carries security pins for transitive packages whose direct
parents have not released. Each entry is a patched version within the same major, so no consumer
sees an API change:

- `js-yaml@3` → `^3.15.1`. Reached through `ts-jest → @jest/transform → babel-plugin-istanbul →
@istanbuljs/load-nyc-config`, which calls `yaml.safeLoad` — removed in js-yaml 4. Pinning inside
  3.x is deliberate; bumping this to 4 or 5 would break coverage runs that read a YAML nyc config.
- `brace-expansion@1|2|5` → `^1.1.18` / `^2.1.4` / `^5.0.9`. Three majors are installed at once
  across the ESLint and Jest trees and each had its own advisory, so each needs its own pin.
- `browserslist` → `^4.28.7`, via `autoprefixer` and `ts-jest`.

`@eslint/eslintrc`'s nested `js-yaml` pin is separate and predates these. Re-check the whole block
whenever `npm audit` goes quiet — a pin that is no longer doing anything is worth removing.
