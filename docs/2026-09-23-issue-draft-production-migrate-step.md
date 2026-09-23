# Issue draft: make production migrations part of the deploy, not a merge-time reminder

Draft only — not opened. Written 2026-09-23 after PR #98.

## Problem

A PR that adds a drizzle migration can only go live safely if the migration has run against
production first. Today that ordering exists only as a note in the PR body ("Before merge: run
`npm run db:migrate`"). PR #98 merged at 15:49Z with that note in place; the live app failed at
15:53Z (`/api/settings/*` 500s on the new `user_settings` columns) and stayed broken until the
migration was run by hand at ~17:08Z. `build` is plain `next build`; nothing in the deploy path
runs migrations.

## Options

1. **Production-only migrate step in the deploy.** A `vercel-build` (or `prebuild`) script that
   runs `drizzle-kit migrate` only when `VERCEL_ENV=production`, then `next build`. Deploy and
   migrate become one step. Caveats: the build must have `DATABASE_URL`; a failed migration fails
   the deploy (which is the point); preview builds must be excluded so a feature branch never
   migrates production.
2. **Migrate on merge, then deploy.** Turn off Vercel's auto-deploy for `main`; a GitHub Action on
   push to `main` runs the migration and then calls a Vercel deploy hook. Cleaner separation, more
   moving parts, and the Action needs the production database URL as a secret.
3. **Expand/contract discipline only.** Keep manual migrations, but require that code tolerates the
   previous schema for one release (nullable columns, feature-flagged reads). Cheapest to set up,
   relies on review catching every case, and #98's `user_settings` reads would still have needed
   the flag.

## Recommendation

Option 1 is the smallest change that removes the ordering from human memory, provided the
production-only guard is tested (a preview deploy must not touch production). Option 3 is a good
habit regardless and pairs with either 1 or 2.

## Done when

- A PR that adds a migration can be merged without a manual step, or CI blocks the merge until the
  migration has run.
- The CLAUDE.md "Before merging a PR that adds a migration" rule is updated to describe the
  automated path.
