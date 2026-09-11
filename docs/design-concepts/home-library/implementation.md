# Home and Library implementation

September 11, 2026. Approved by Chase: Ink & Paper UI with Ember & Ivory colors; explicit authorization to implement followed the selection.

## Shipped in this working tree

- Shared application shell: 220px desktop rail, compact logo/Account header below 1024px, five opaque bottom destinations, and reserved safe-area space. Settings, conditional Admin, feedback, and sign-out remain accessible. Existing route names remain.
- Home: recommendations first, saved book preview linked to the to-read shelf, two current reads with finish/review, compact reader identity, and compact annual goals. All displayed books and goals come from the existing API. There are no fabricated recommendations or personalized claims. Full Profile identity/analysis is retained.
- Library: list browsing, wrapping titles, larger covers, numeric half ratings, search, sticky per-shelf sorting, favorites and rating-band filters, all five shelves, Add book, review queue, and match-correction queue. Unrated read books now appear directly in the list as well as the queue. Filters preserve the existing whole-star band semantics: e.g. the 4 band includes 4 and 4.5.
- Warm colors are scoped to the application shell. Existing public pages retain their palette. Shared Tailwind color tokens now support alpha modifiers through RGB channels; hex values remain for direct CSS consumers. Keep both representations in sync.
- Feedback uses the existing submission modal through Help & feedback. Completion prompts are retained. Logo and sprites are unchanged. Broken or absent covers use a neutral book icon.

No API, auth, tenancy, database, recommendation-generation, import, or deployment changes. Discover and recommendation screens inherit the shell/palette but keep their existing content and behavior. No new theme picker or navigation rename. Existing 500-book shelf fetch limits remain; this work does not add pagination.

## Verification

- Jest: 34 suites, 294 tests passed, including current-profile recommendation gating and last-current-read review lifetime/failure tests.
- Vitest: 79 suites, 624 tests passed on the final full run. An initial rate-limit test failed during the concurrent run, then passed in isolation and in the full rerun.
- Browser: 24 interaction/state checks passed against actual Next.js pages in an isolated local copy, driven through Chrome with intercepted synthetic API responses. No account credentials, real database writes, submissions to others, or paid AI calls. Home and Library checked at 320, 390, 768, and 1440px. Reading actions, filters, sorting persistence, queues, Account/feedback, Admin access, empty/loading/error states, stale/absent profiles, broken covers, and zero-served recommendation runs exercised. Server integration and real account mutations were not exercised in this browser fixture.
- Type check, lint, full formatting check, and the standard Turbopack production build passed. Existing intentional full-document auth navigation produces Next lint warnings; those auth boundaries are retained.

## Handoff

Chase authorized committing the completed design and implementation. The application has not been deployed. The original concept comparison remains in `index.html`; it shows the two original alternatives, not screenshots of the mixed implementation. The original design review remains unchanged.

Next-session prompt:

> Read the repository instructions, `docs/frontend.md`, and `docs/design-concepts/home-library/implementation.md`. The locked direction is Ink & Paper’s layout with Ember & Ivory’s warm palette. Home, Library, and the shared shell are implemented. Preserve the existing API and modal lifetimes. Recheck Git state and use the validation notes before changing or committing anything. Continue only with the work Chase requests.
