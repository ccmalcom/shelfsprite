# Reading Goals + Year Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Controller: read Global Constraints and Execution Strategy once, then read exactly one task's text
> per dispatch.** Never hold this whole document resident — a 2,200-line plan sitting in context is
> re-read at every turn for the life of the session, while re-reading the one task you need costs that
> once. Every task below carries a `**Dispatch:**` line naming its executor, its model, and its focused
> gate, so no task requires reading its neighbours.

**Goal:** Let a ShelfSprite user set typed reading goals for a calendar year and see them, alongside that year's reading statistics, in one "Your 2026" card on the home page.

**Architecture:** A new `reading_goals` table stores only goal *definitions*. All progress and all statistics are derived on read from one query over the user's `read`-shelf books left-joined to `enrichment` — there is no stored counter anywhere. Pure counting functions in `lib/server/goals.ts` take rows rather than a `Db`, so every rule is unit-testable without a database.

**Tech Stack:** Next.js App Router route handlers, drizzle-orm + drizzle-kit (Postgres/Supabase), Zod for request validation, SWR + a typed fetch client in `lib/api.ts`, Tailwind, Vitest (server) and Jest (everything else), PGlite for in-memory route tests.

**Spec:** `docs/superpowers/specs/2026-08-24-reading-goals-design.md` — read it before Task 1. This plan argues from that spec; where the two disagree, the spec wins and the plan is wrong.

## Global Constraints

- **Do not run `git commit` or `git add`.** Chase commits manually, by standing preference. Each task ends by running its gates and reporting; leave the working tree dirty.
- **Both test runners are required for a pass.** `npm run test:server` (Vitest — owns `lib/server/**` and `app/api/**`) and `npm test` (Jest — owns everything else). Running one is not a test pass.
- **Vitest's `include` is `*.test.ts` only.** A `.tsx` test file is Jest's by construction; do not try to make Vitest run the component test.
- **`npm run build` is a required gate**, not optional: it is the only thing that catches Next segment-config and prerender failures.
- **Never run `drizzle-kit pull`.** See spec §4.1. Hand-author the new table; touch no existing table.
- **Every query filters on `ctx.user.userId`.** A row belonging to another user must be invisible, and a mismatched id returns **404, not 403**.
- **Do not modify** `lib/server/rating.ts`, `lib/server/serialize.ts`, or any existing table's columns. `lib/server/rating.ts` must stay dependency-free.
- Ratings serialize as `4` for whole and `4.5` for half stars; this plan never touches rating values, only reads them indirectly. Do not "fix" anything in that area.
- Progress and statistics are **never clamped**. `112/100` is correct output; only the rendered bar width is clamped.

---

## Execution Strategy (subagent-driven)

A controller session dispatches this plan one task at a time. The controller owns scope, adjudication,
the database, and the browser; executors write code. Three facts decide everything below: a controller
turn costs its entire context every turn, Codex runs on a separate quota but has **no network and no
secrets**, and a gate command that matches zero tests exits 0 and reads as a pass.

### Measured gate cost — this repo, 2026-08-24, all green at `b10e9bd`

| Gate | Command | Time | Who runs it |
|---|---|---|---|
| Server suite (63 files, 487 tests) | `npm run test:server` | **124 s** | controller, once per wave |
| One server test file | `npx vitest run <file>` | 5–12 s | executor, every dispatch |
| Jest suite (221 tests) | `npm test` | 5 s | executor + controller |
| Typecheck | `npm run type-check` | 2 s | executor, every dispatch |
| Lint | `npm run lint` | 7 s | executor, every dispatch |
| Format | `npm run format:check` | 4 s | executor, on touched files only |
| Next build | `npm run build` | — | **controller only** |

**Never name `npm run test:server` in a Codex brief.** At 124 s and growing it can eat a ~10-minute
dispatch budget that must also cover Codex's own exploration, and the controller re-runs it each wave
regardless. Name the one test file instead. Tasks 1, 5, and 7 each end with a full-suite step: that
step belongs to the controller's wave gate, not to the dispatch.

The project `Stop` hook (`.claude/hooks/on_stop.py`) runs `tsc`, `eslint`, and **`prettier --check`**
on changed files at the end of every controller turn. A dispatch that skips `prettier --write` on its
own touched files fails the controller's turn on formatting after reporting green.

### What no executor can run here

Structural, not flaky. **Never read the absence of one of these from a report as a pass:**

- `npm run build` — Next fetches Google Fonts at build time; the sandbox has no network. The controller
  runs it every wave. It is the only gate that catches segment-config and prerender failures, and this
  plan adds three route segments.
- `npm run db:migrate` and any drizzle command that connects — `drizzle.config.ts` loads the local
  secrets file for `DATABASE_URL`. **Never name that file in a dispatch, and never ask an executor to
  read it.** Task 1 Step 7 is controller work, full stop. (`drizzle-kit generate` is offline and would
  work, but it runs through the same config, so Task 1 stays with the controller as a unit.)
- `npm install` — nothing here needs it. Every package this plan uses is already in `package.json`:
  `zod`, `swr`, `@electric-sql/pglite`, `vitest`, `ts-jest`, `jest-environment-jsdom`,
  `@testing-library/react`, `@testing-library/jest-dom`. Verified 2026-08-24.
- Anything in a browser. Task 11 Step 2 is the controller's, per the standing verification rule:
  tests passing is not evidence the flow works.

### Waves — hand off after each one

A controller that reads all eleven tasks as one run climbs to a 260k context floor and pays ~23k
units/turn; one that restarts every 2–3 tasks pays ~13k. **Do not start the next wave's first task in
the session that finished the previous wave.** The ledger under `.superpowers/sdd/` is the state of
record and must be current after *every* task, not batched at the end — a handoff is only cheap because
the next session reconstructs everything from disk. Never park a loaded controller between waves; end
the session instead, because an expired prompt cache re-reads the whole context at 12.5× the price.

| Wave | Tasks | Executor | Controller does |
|---|---|---|---|
| 0 (pre-flight) | — | Codex, read-only | Plan review (below); triage findings into this doc before any code |
| 1 | 1, 2 | Task 1 controller · Task 2 Codex | `db:migrate`, read the generated SQL, full suite + `build` |
| 2 | 3, 4, 5 | Codex ×3, sequential | full suite + `build` |
| 3 | 6, 7, 8 | Codex ×3 (6 ∥ 7) | full suite + `build` |
| 4 | 9, 10 | Task 9 Codex · Task 10 Claude/Sonnet 5 | browser-verify both surfaces, full suite + `build` |
| 5 | 11 | Controller | everything |

**Parallel-safe pairs:** 6 ∥ 7 (disjoint files: `lib/server/purge.ts` vs `app/api/books/[id]/shelf/`)
and 9 ∥ 10 (disjoint components, disjoint pages). **Strictly sequential:** 3 → 4 (both edit
`app/api/goals/route.ts`) and 2 → 3/4/5 (they import its exports).

### Executor and model assignment

| Task | Executor | Model | Why |
|---|---|---|---|
| 1 Table + migration | **Controller** | Opus 5 | Runs drizzle commands backed by local secrets; Step 3 is a STOP gate needing judgment |
| 2 Counting rules | **Codex** `--write` | companion default | Pure functions, no DB, complete test bodies already in the plan — the best fit here, and the riskiest task, so it gets the separate quota plus a full Claude review |
| 3 `GET /goals` | **Codex** `--write` | companion default | Self-contained route + PGlite test, ~10 s gate |
| 4 `POST /goals` | **Codex** `--write` | companion default | Same; **fresh dispatch, not a resume of Task 3** |
| 5 `PATCH`/`DELETE` | **Codex** `--write` | companion default | Same |
| 6 Purge | **Codex** `--write` | companion default | ~15 lines across three files, one named gate |
| 7 `date_read` stamp | **Codex** `--write` | companion default | Only behavior change to an existing endpoint; its test file must be created (see task) |
| 8 Client types | **Codex** `--write` | companion default | Mechanical; or fold into the wave 3→4 handoff turn if the controller is still cheap |
| 9 YearCard | **Codex** `--write` | companion default | A real jest gate exists and runs in 5 s |
| 10 Settings section | **Claude subagent** | **Sonnet 5** | No automated test exists for this component; the work is copying established styling from `components/admin/UsageTab.tsx:50` and matching the settings page — visual judgment with no gate, which is exactly where a literal executor is weakest |
| 11 Full gate + manual | **Controller** | Opus 5 | `build` + browser |

No task here suits Haiku: every one writes against typed cross-file contracts, and the two cheapest
(6, 8) are cheaper still as Codex dispatches on the separate quota.

Escalation rule: if a Codex task returns INCOMPLETE or blocked twice, do not resume a third time —
re-dispatch it to a Claude subagent on **Opus 5** with the failure report pasted in.

### Wave 0 — Codex plan review (run this before Task 1)

Read-only, and the highest value-per-minute step available: this plan asserts dozens of checkable facts
in one place and checking them is pure lookup. Write the prompt to a file, then:

```bash
CX='node /home/chase/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/codex-companion.mjs'
$CX task "$(cat /path/to/review-prompt.txt)"     # NO --write
```

The prompt names the symbols to check, one per line, and ends with the standing-rules block:

```
Read-only review. Do not edit any file.

Review docs/superpowers/plans/2026-08-24-reading-goals.md against the real repo. It asserts these
symbols and signatures:
  - the readingGoals table's helpers vs what lib/server/schema.ts already imports
  - makeTestDb / Seed / order / SEQ_TABLES in lib/server/__tests__/helpers/pglite.ts
  - deleteAccountRows in lib/server/purge.ts and its exact returned key set
  - withApi and the ctx.user.userId shape, as used by every route in app/api/
  - get/post/patch/del and the `api` object in lib/api.ts
  - Card, Field, Input, Button, useToast exported from components/ui
  - StatsStrip's mount point in app/(main)/page.tsx and the Card sections in app/(main)/settings/page.tsx
  - every column the counting rules read: books.shelf, books.date_read, books.page_count,
    books.author, and the enrichment columns the join uses
Report any that do not exist, have a different signature, or live somewhere else.

Also check behavior, not just symbols: where the plan's code claims to reproduce existing behavior in
a neighbouring route or helper, compare them and report any divergence.

If a claim is correct, do NOT list it. I want an actionable list, not an audit.
```

Triage every finding against the repo yourself before editing this plan. An unverified review finding
propagated into later dispatches is contaminating when wrong: the *observation* is usually right, the
*conclusion* often is not.

### Standing rules — paste into every Codex dispatch

```
Treat every code block and file:line citation you are given as an UNVERIFIED SKETCH. Check every
symbol, type, column, and function name against the real repo before using it, and report any
deviation you find rather than silently adapting. Do not invent `any` to work around a type that
does not exist.

Do not run git commit, cherry-pick, merge, push, or deploy. Chase does all of those by hand.
Run `npx prettier --write` only on files you touched. Never format the repo.

Always use `git --no-pager` or prefix with `GIT_PAGER=cat`. A paged git command hangs your shell.

You cannot run these — do not try, and report the blocker instead of inventing a result:
  - npm run build (no network: Next fetches Google Fonts)
  - npm run db:migrate, or any drizzle command that connects to a database
  - npm install (no network)
  - anything in a browser
Never read, print, or reference the repository's local secrets file for any reason.
If a step needs one of these, say so and stop; never fabricate a value you could not measure.

Do not run `npm run test:server`. It is a 124-second suite and the controller runs it. Run only the
specific test files named below.

If the task tells you to edit something you cannot find, do NOT invent the edit and do NOT silently
skip it. Locate it, and if it genuinely is not there, say so plainly and stop.

Record what you actually observe, not what this plan predicts.
```

### Task-execution dispatch template

One task per dispatch, task text lifted verbatim from this document. **Decide `--write` at dispatch:**
a thread's sandbox is fixed at creation, so a read-only thread can never be rescued into an editing one,
and a resumed thread that needs an edit fails on permissions with nothing changed. Resume is reliable
for questions and re-running gates only; **any round that requires an edit is a fresh dispatch**, and a
fresh agent knows nothing of the prior thread — paste the current body of whatever it must change, and
list the DO-NOTs explicitly.

```
Execute Task [N] of docs/superpowers/plans/2026-08-24-reading-goals.md exactly as written. Read the
plan's Global Constraints and Execution Strategy sections first.

[PASTE THE TASK TEXT VERBATIM]

[standing rules block]

VERIFICATION — run ALL of these, regardless of what the task step lists:
  [the task's focused test command, from its Dispatch line]
  npm run type-check
  npx eslint [files you touched]
  npx prettier --write [files you touched]

Expected to be RED before your fix, by test name: [name them individually — never by count].

When done, report: files touched, commands run with their actual output, and any place the plan
disagreed with the real repo.
```

Paste that verification block verbatim and then add task-specific gates. Editing down from it is safe;
composing up from memory is how `prettier` goes missing and the controller's turn fails on formatting
after three green gates.

**Before sending, confirm the gate matches something.** Gates that match zero tests exit 0 and read as
a pass — the dangerous failure produces no output rather than a red X. One command each, run once the
test file exists:

```bash
npx vitest list 'app/api/goals/[id]/route.test.ts'             # vitest: does it claim this file?
npx jest --listTests components/__tests__/YearCard.test.tsx    # jest: does it claim this file?
```

Quote any path containing `[id]`. Verified 2026-08-24: vitest matches bracketed paths correctly when
quoted or backslash-escaped. Vitest's `include` is `lib/server/**/*.test.ts` and `app/api/**/*.test.ts`
— **`.ts` only** — so `components/__tests__/YearCard.test.tsx` is jest's by construction, and `npm test`
is jest alone, not "the test suite".

### Reviewing what comes back — run this on every returned task

- `git status --short --untracked-files=all` — did it touch only the intended files? A killed run does
  not roll back partial edits, so check the tree before believing any report of having applied nothing.
- Re-run the gates yourself. Green tests are not proof of a correct primitive.
- Verify factual claims rather than spot-checking them. Observations are reliable; attributions need
  checking, including a STOP's — verify the finding, not the framing.
- Check the diff for formatting churn: `prettier --write` on a touched file reformats pre-existing code.
- Re-review anything added beyond what was asked. Those are the parts nobody specified.
- **Mutation-test Task 2 before accepting it** (about three minutes): break one counting rule
  deliberately — flip the `new_authors` first-read comparison, or drop the `date_read` year filter — and
  confirm a *named* test goes red. If nothing does, the rule is documentation, not engineering. Task 2
  is where every number the user sees comes from; the routes are plumbing.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `lib/server/goals.ts` | Goal vocabulary, pure counting rules, `yearStats`, and the single db loader `loadReadRows`. All the thinking lives here. |
| `lib/server/__tests__/goals.test.ts` | Unit tests for every rule, no database. |
| `app/api/goals/route.ts` | `GET` (goals + stats + suggestions) and `POST` (create). |
| `app/api/goals/route.test.ts` | Route tests on PGlite. |
| `app/api/goals/[id]/route.ts` | `PATCH` (target only) and `DELETE`. |
| `app/api/goals/[id]/route.test.ts` | Route tests on PGlite. |
| `components/YearCard.tsx` | The home-page "Your 2026" card: numbers, genres, authors, goals. |
| `components/__tests__/YearCard.test.tsx` | Jest/RTL rendering tests. |
| `components/ReadingGoalsSettings.tsx` | Settings-page management section (list, edit target, delete, add form). |

**Modified**

| File | Change |
|---|---|
| `lib/server/schema.ts` | Add the `readingGoals` table. Nothing else. |
| `drizzle/` | One generated migration. |
| `lib/server/__tests__/helpers/pglite.ts` | `create table reading_goals`, plus `Seed`, `order`, and `SEQ_TABLES` entries. |
| `lib/server/purge.ts` | Delete goals in `deleteAccountRows`; add `goals_removed`. |
| `lib/server/__tests__/purge-routes.test.ts:283` | The `toEqual` assertion gains `goals_removed`. |
| `app/api/books/[id]/shelf/route.ts` | Stamp `date_read` on a transition to `read`. |
| `app/api/books/[id]/shelf/route.test.ts` **(create — no shelf route test exists anywhere in the repo, verified 2026-08-24)** | Stamping tests. |
| `lib/api.ts` | `Goal`, `YearStats`, `GoalsResponse` types; four methods; `GOALS_KEY`. |
| `app/(main)/page.tsx` | Mount `YearCard` under `StatsStrip`. |
| `app/(main)/settings/page.tsx` | Mount `ReadingGoalsSettings` as a new `<Card>` section. |

---

## Task 1: Table, migration, and test-database fidelity

**Dispatch:** Controller (Opus 5), not Codex. Steps 2 and 7 run drizzle-kit through a config that loads local secrets, and Step 3 is a STOP gate needing judgment; the whole task is ~10 minutes of controller work. **Step 6's `npm run test:server` is a wave gate, not a per-step gate** — `npx vitest run lib/server/__tests__/purge-routes.test.ts` (~8 s) proves `makeTestDb()` still builds, because a malformed `create table` fails there just as loudly.

**Files:**
- Modify: `lib/server/schema.ts` (add one table; touch nothing else)
- Create: `drizzle/00XX_<generated_name>.sql` (via drizzle-kit, name is auto-generated)
- Modify: `lib/server/__tests__/helpers/pglite.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `schema.readingGoals` with fields `id: number`, `userId: string`, `year: number`, `kind: string`, `subject: string | null`, `target: number`, `createdAt: string`. Every later task reads or writes through this.

> **Read spec §4.1 before editing `schema.ts`.** The file header says it is `drizzle-kit pull` output and must not be hand-edited. That guard is about *existing* introspected tables drifting from real column types. This table does not exist anywhere yet, so there is nothing to drift from. Hand-add it, leave every other table alone, and never run `drizzle-kit pull`.

- [ ] **Step 1: Add the table to `lib/server/schema.ts`**

Append at the end of the file. `index`, `unique`, `check`, `integer`, `varchar`, `serial`, `timestamp`, and `sql` are all already imported at the top — verify rather than re-importing.

```ts
export const readingGoals = pgTable(
  'reading_goals',
  {
    id: serial().primaryKey().notNull(),
    userId: varchar('user_id').default('local').notNull(),
    year: integer().notNull(),
    kind: varchar().notNull(), // 'books' | 'genre' | 'new_authors' | 'pages'
    subject: varchar(), // NOT NULL exactly when kind = 'genre'
    target: integer().notNull(),
    createdAt: timestamp('created_at', { mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index('ix_reading_goals_user_id').using(
      'btree',
      table.userId.asc().nullsLast().op('text_ops')
    ),
    unique('uq_reading_goal').on(table.userId, table.year, table.kind, table.subject),
    check('ck_reading_goals_target_positive', sql`${table.target} > 0`),
    check('ck_reading_goals_kind', sql`${table.kind} in ('books', 'genre', 'new_authors', 'pages')`),
    check(
      'ck_reading_goals_subject',
      sql`(${table.kind} = 'genre') = (${table.subject} is not null)`
    ),
  ]
);
```

- [ ] **Step 2: Generate the migration**

Run: `npx drizzle-kit generate`
Expected: one new `drizzle/00XX_*.sql` and an updated `drizzle/meta/` snapshot.

- [ ] **Step 3: Read the generated SQL before it ever touches a database**

Run: `cat drizzle/00XX_*.sql` (the newest file)
Expected: exactly one `CREATE TABLE "reading_goals"`, one unique constraint, one index, three CHECK constraints. **If it contains any `ALTER TABLE` or `DROP` against an existing table, stop and report** — that means `schema.ts` drifted from the snapshot and this plan's assumptions do not hold.

- [ ] **Step 4: Add the table to the PGlite test database**

In `lib/server/__tests__/helpers/pglite.ts`, append to the `pg.exec` template literal, after the `invite_requests` block. The helper uses `text` where the real schema uses `varchar` (matching every other table there) and does carry check constraints (`books` does — see its rating checks):

```sql
    create table reading_goals (
      id serial primary key,
      user_id text not null default 'local',
      year integer not null,
      kind text not null,
      subject text,
      target integer not null,
      created_at timestamp not null default current_timestamp,
      constraint uq_reading_goal unique (user_id, year, kind, subject),
      constraint ck_reading_goals_target_positive check (target > 0),
      constraint ck_reading_goals_kind check (kind in ('books', 'genre', 'new_authors', 'pages')),
      constraint ck_reading_goals_subject check ((kind = 'genre') = (subject is not null))
    );
```

- [ ] **Step 5: Wire the seed loader**

Three separate places in the same file, all hand-maintained lists:

1. `Seed` interface — add `reading_goals?: Record<string, unknown>[];`
2. the `order` array — add `'reading_goals'` **after** `'books'` (order only matters for FK-bearing tables; goals have no FK, but keep it grouped with user data)
3. the `SEQ_TABLES` array — add `'reading_goals'`, so an explicit-id seed row does not leave the serial at 1 and collide with the first route insert

- [ ] **Step 6: Prove the test database accepts the table**

Create a temporary check by running the existing server suite — it constructs `makeTestDb()` in dozens of files, so a malformed `create table` fails loudly and immediately.

Run: `npm run test:server`
Expected: PASS, unchanged from before this task. A syntax error in the new SQL shows up as every server test failing at `makeTestDb`.

- [ ] **Step 7: Apply the migration to the dev database**

Run: `npm run db:migrate`
Expected: the new migration applies cleanly. Per `docs/hosting.md:174-192` migrations are manual and never part of `npm run build`.

- [ ] **Step 8: Report — do not commit**

Report the generated migration filename and the SQL you read in Step 3.

---

## Task 2: Counting rules and year statistics (`lib/server/goals.ts`)

**Dispatch:** Codex, `--write`, one fresh dispatch (Wave 1). Pure functions, no database, no network, complete test bodies already in the plan — the best-fit task here. Focused gate: `npx vitest run lib/server/__tests__/goals.test.ts`. Do not name `npm run test:server`. State expected-red by test name, never by count. Mutation-test the result before accepting it (see Execution Strategy).

**Files:**
- Create: `lib/server/goals.ts`
- Test: `lib/server/__tests__/goals.test.ts`

**Interfaces:**
- Consumes: `subjectHits` from `lib/server/recFilters.ts`, `pyTitle` and `todayIsoDate` from `lib/server/serialize.ts`, `schema` + `Db` from `lib/server/db.ts`.
- Produces — every later task depends on these exact names:
  - `GOAL_KINDS: readonly ['books','genre','new_authors','pages']`, `type GoalKind`
  - `interface GoalRow { book: { author: string|null; dateRead: string|null; pageCount: number|null }; subjects: string[]|null }`
  - `interface GoalDef { year: number; kind: GoalKind; subject: string|null; target: number }`
  - `interface GoalCount { progress: number; unknown: number }`
  - `countForGoal(rows: GoalRow[], goal: GoalDef): GoalCount`
  - `interface GoalOut { id, year, kind, subject, target, progress, unknown, done }`
  - `goalOut(row: typeof schema.readingGoals.$inferSelect, count: GoalCount): GoalOut`
  - `topSubjects(rows: GoalRow[], limit?: number): string[]`
  - `interface YearStats { books, pages, unknown_pages, authors, new_authors, undated, top_genres: {subject,count}[], top_authors: {author,count}[] }`
  - `yearStats(rows: GoalRow[], year: number): YearStats`
  - `currentYear(): number`
  - `loadReadRows(db: Db, userId: string): Promise<GoalRow[]>`

This is where the thinking is. TDD it properly: the tests below are the specification, and they run without a database.

- [ ] **Step 1: Write the failing tests**

Create `lib/server/__tests__/goals.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { countForGoal, yearStats, topSubjects, type GoalRow } from '../goals';

function row(
  dateRead: string | null,
  opts: { author?: string | null; pages?: number | null; subjects?: string[] | null } = {}
): GoalRow {
  return {
    book: {
      author: opts.author === undefined ? 'Author A' : opts.author,
      dateRead,
      pageCount: opts.pages === undefined ? 300 : opts.pages,
    },
    subjects: opts.subjects === undefined ? ['Fiction'] : opts.subjects,
  };
}

const def = (over: Partial<Parameters<typeof countForGoal>[1]> = {}) => ({
  year: 2026,
  kind: 'books' as const,
  subject: null,
  target: 10,
  ...over,
});

describe('countForGoal — books', () => {
  it('counts only books dated inside the year', () => {
    const rows = [row('2026-01-01'), row('2026-12-31'), row('2025-12-31'), row('2027-01-01')];
    expect(countForGoal(rows, def())).toEqual({ progress: 2, unknown: 0 });
  });

  it('ignores a read book with no date', () => {
    expect(countForGoal([row(null), row('2026-05-05')], def())).toEqual({
      progress: 1,
      unknown: 0,
    });
  });
});

describe('countForGoal — genre', () => {
  const genre = def({ kind: 'genre', subject: 'History' });

  it('matches a subject case-insensitively', () => {
    const rows = [row('2026-03-01', { subjects: ['history'] })];
    expect(countForGoal(rows, genre).progress).toBe(1);
  });

  it('matches on a whole word inside a longer subject', () => {
    const rows = [row('2026-03-01', { subjects: ['Art history'] })];
    expect(countForGoal(rows, genre).progress).toBe(1);
  });

  it('does not match a substring that is not a whole word', () => {
    const rows = [row('2026-03-01', { subjects: ['Historiography'] })];
    expect(countForGoal(rows, genre).progress).toBe(0);
  });

  it('counts a book once even when several subjects match', () => {
    const rows = [row('2026-03-01', { subjects: ['History', 'Art history'] })];
    expect(countForGoal(rows, genre).progress).toBe(1);
  });

  it('skips books with no enrichment subjects', () => {
    const rows = [row('2026-03-01', { subjects: null }), row('2026-04-01', { subjects: [] })];
    expect(countForGoal(rows, genre).progress).toBe(0);
  });
});

describe('countForGoal — new_authors', () => {
  const na = def({ kind: 'new_authors' });

  it('counts an author never read before the year', () => {
    const rows = [row('2026-02-01', { author: 'Chiang' })];
    expect(countForGoal(rows, na).progress).toBe(1);
  });

  it('does not count an author first read in a prior year', () => {
    const rows = [row('2019-02-01', { author: 'Le Guin' }), row('2026-02-01', { author: 'Le Guin' })];
    expect(countForGoal(rows, na).progress).toBe(0);
  });

  it('counts two books by the same new author once', () => {
    const rows = [row('2026-02-01', { author: 'Chiang' }), row('2026-06-01', { author: 'Chiang' })];
    expect(countForGoal(rows, na).progress).toBe(1);
  });

  it('skips books with a null author', () => {
    expect(countForGoal([row('2026-02-01', { author: null })], na).progress).toBe(0);
  });
});

describe('countForGoal — pages', () => {
  it('sums page counts and reports unknowns separately', () => {
    const rows = [
      row('2026-01-01', { pages: 300 }),
      row('2026-02-01', { pages: 120 }),
      row('2026-03-01', { pages: null }),
      row('2025-01-01', { pages: 999 }),
    ];
    expect(countForGoal(rows, def({ kind: 'pages', target: 1000 }))).toEqual({
      progress: 420,
      unknown: 1,
    });
  });
});

describe('yearStats', () => {
  const rows = [
    row('2026-01-01', { author: 'Le Guin', pages: 300, subjects: ['Fiction', 'Science fiction'] }),
    row('2026-02-01', { author: 'Le Guin', pages: null, subjects: ['Fiction'] }),
    row('2026-03-01', { author: 'Chiang', pages: 250, subjects: ['Fiction'] }),
    row('2019-01-01', { author: 'Le Guin', pages: 400, subjects: ['Fiction'] }),
    row(null, { author: 'Nobody', pages: 100, subjects: ['History'] }),
  ];

  it('counts books, pages, unknown pages and authors for the year only', () => {
    const s = yearStats(rows, 2026);
    expect(s.books).toBe(3);
    expect(s.pages).toBe(550);
    expect(s.unknown_pages).toBe(1);
    expect(s.authors).toBe(2);
  });

  it('agrees with the new_authors goal kind on identical input', () => {
    expect(yearStats(rows, 2026).new_authors).toBe(
      countForGoal(rows, def({ kind: 'new_authors' })).progress
    );
  });

  it('counts each subject once per book, most common first', () => {
    expect(yearStats(rows, 2026).top_genres).toEqual([
      { subject: 'Fiction', count: 3 },
      { subject: 'Science Fiction', count: 1 },
    ]);
  });

  it('ranks authors by books read in the year', () => {
    expect(yearStats(rows, 2026).top_authors[0]).toEqual({ author: 'Le Guin', count: 2 });
  });

  it('counts undated read books from every year, ignoring the requested year', () => {
    expect(yearStats(rows, 2026).undated).toBe(1);
    expect(yearStats(rows, 2019).undated).toBe(1);
  });

  it('returns zeroed stats for a year with no dated reads', () => {
    const s = yearStats(rows, 2030);
    expect(s.books).toBe(0);
    expect(s.top_genres).toEqual([]);
    expect(s.top_authors).toEqual([]);
  });
});

describe('topSubjects', () => {
  it('ranks normalized subjects across every read book, not just one year', () => {
    const rows = [
      row('2026-01-01', { subjects: ['fiction'] }),
      row('2019-01-01', { subjects: ['FICTION', 'history'] }),
    ];
    expect(topSubjects(rows, 10)).toEqual(['Fiction', 'History']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/server/__tests__/goals.test.ts`
Expected: FAIL — cannot resolve `../goals`.

- [ ] **Step 3: Write the implementation**

Create `lib/server/goals.ts`:

```ts
/**
 * Reading goals: the goal vocabulary, the counting rules, and the year card's
 * statistics. Progress is ALWAYS derived by recounting persisted rows -- there is
 * no stored counter and there must never be one (see the design spec, §3).
 *
 * Everything except loadReadRows is pure and takes rows, so the rules are testable
 * without a database.
 */
import { and, asc, eq } from 'drizzle-orm';
import { schema, type Db } from './db';
import { subjectHits } from './recFilters';
import { pyTitle, todayIsoDate } from './serialize';

export const GOAL_KINDS = ['books', 'genre', 'new_authors', 'pages'] as const;
export type GoalKind = (typeof GOAL_KINDS)[number];

/** Cap mirrors app/api/profile/highlights/route.ts -- only a book's first 8 subjects count. */
const SUBJECTS_PER_BOOK = 8;
const TOP_N = 5;
const SUGGESTION_LIMIT = 30;

/** One read-shelf book of one user, plus its enrichment subjects. */
export interface GoalRow {
  book: { author: string | null; dateRead: string | null; pageCount: number | null };
  subjects: string[] | null;
}

export interface GoalDef {
  year: number;
  kind: GoalKind;
  subject: string | null;
  target: number;
}

export interface GoalCount {
  progress: number;
  unknown: number;
}

export interface GoalOut {
  id: number;
  year: number;
  kind: GoalKind;
  subject: string | null;
  target: number;
  progress: number;
  unknown: number;
  done: boolean;
}

export interface YearStats {
  books: number;
  pages: number;
  unknown_pages: number;
  authors: number;
  new_authors: number;
  undated: number;
  top_genres: { subject: string; count: number }[];
  top_authors: { author: string; count: number }[];
}

export function currentYear(): number {
  return Number(todayIsoDate().slice(0, 4));
}

/** ISO date strings compare lexicographically, which is why these are plain string tests. */
function inYear(dateRead: string | null, year: number): boolean {
  return dateRead !== null && dateRead.slice(0, 4) === String(year);
}

function beforeYear(dateRead: string | null, year: number): boolean {
  return dateRead !== null && dateRead < `${year}-01-01`;
}

/** Authors with at least one read book dated before `year`. */
function priorAuthors(rows: GoalRow[], year: number): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    if (beforeYear(r.book.dateRead, year) && r.book.author) out.add(r.book.author);
  }
  return out;
}

function countNewAuthors(rows: GoalRow[], year: number): number {
  const prior = priorAuthors(rows, year);
  const fresh = new Set<string>();
  for (const r of rows) {
    if (!inYear(r.book.dateRead, year)) continue;
    const a = r.book.author;
    if (!a || prior.has(a)) continue;
    fresh.add(a);
  }
  return fresh.size;
}

/**
 * Subject -> number of books. Each subject counts once per book, and only a book's
 * first 8 subjects are considered. Insertion order is preserved, so the stable sort
 * in the callers breaks ties by first-seen -- matching the highlights route.
 */
function subjectCounts(rows: GoalRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const seen = new Set<string>();
    for (const raw of (r.subjects ?? []).slice(0, SUBJECTS_PER_BOOK)) {
      const subject = pyTitle(String(raw).trim());
      if (!subject || seen.has(subject)) continue;
      seen.add(subject);
      counts.set(subject, (counts.get(subject) ?? 0) + 1);
    }
  }
  return counts;
}

export function countForGoal(rows: GoalRow[], goal: GoalDef): GoalCount {
  const inPeriod = rows.filter((r) => inYear(r.book.dateRead, goal.year));

  switch (goal.kind) {
    case 'books':
      return { progress: inPeriod.length, unknown: 0 };

    case 'genre': {
      const term = (goal.subject ?? '').toLowerCase();
      if (!term) return { progress: 0, unknown: 0 };
      const n = inPeriod.filter((r) =>
        (r.subjects ?? []).some((s) => subjectHits(term, String(s).toLowerCase()))
      ).length;
      return { progress: n, unknown: 0 };
    }

    case 'new_authors':
      return { progress: countNewAuthors(rows, goal.year), unknown: 0 };

    case 'pages': {
      let pages = 0;
      let unknown = 0;
      for (const r of inPeriod) {
        if (r.book.pageCount === null) unknown += 1;
        else pages += r.book.pageCount;
      }
      return { progress: pages, unknown };
    }
  }
}

export function goalOut(
  row: typeof schema.readingGoals.$inferSelect,
  count: GoalCount
): GoalOut {
  return {
    id: row.id,
    year: row.year,
    kind: row.kind as GoalKind,
    subject: row.subject,
    target: row.target,
    progress: count.progress,
    unknown: count.unknown,
    done: count.progress >= row.target,
  };
}

/** Goal-creation suggestions: the user's own subject vocabulary, every year included. */
export function topSubjects(rows: GoalRow[], limit = SUGGESTION_LIMIT): string[] {
  return [...subjectCounts(rows).entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([subject]) => subject);
}

export function yearStats(rows: GoalRow[], year: number): YearStats {
  const inPeriod = rows.filter((r) => inYear(r.book.dateRead, year));

  let pages = 0;
  let unknownPages = 0;
  const authorCounts = new Map<string, number>();
  for (const r of inPeriod) {
    if (r.book.pageCount === null) unknownPages += 1;
    else pages += r.book.pageCount;
    const a = r.book.author;
    if (a) authorCounts.set(a, (authorCounts.get(a) ?? 0) + 1);
  }

  return {
    books: inPeriod.length,
    pages,
    unknown_pages: unknownPages,
    authors: authorCounts.size,
    new_authors: countNewAuthors(rows, year),
    // Not year-scoped on purpose: an undated book has no year to be scoped to.
    undated: rows.filter((r) => r.book.dateRead === null).length,
    top_genres: [...subjectCounts(inPeriod).entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_N)
      .map(([subject, count]) => ({ subject, count })),
    top_authors: [...authorCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_N)
      .map(([author, count]) => ({ author, count })),
  };
}

/** The one db-touching export: every read-shelf book of one user, with its subjects. */
export async function loadReadRows(db: Db, userId: string): Promise<GoalRow[]> {
  const rows = await db
    .select({ book: schema.books, enrichment: schema.enrichment })
    .from(schema.books)
    .leftJoin(schema.enrichment, eq(schema.enrichment.bookId, schema.books.id))
    .where(and(eq(schema.books.userId, userId), eq(schema.books.exclusiveShelf, 'read')))
    .orderBy(asc(schema.books.id));

  return rows.map((r) => ({
    book: { author: r.book.author, dateRead: r.book.dateRead, pageCount: r.book.pageCount },
    subjects: (r.enrichment?.subjects ?? null) as string[] | null,
  }));
}
```

`loadReadRows` takes a `Db` rather than calling `getDb()` itself: the routes already hold one, and passing it keeps this module's only db-touching function trivially injectable in tests.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/server/__tests__/goals.test.ts`
Expected: PASS, all cases.

If `does not match a substring that is not a whole word` fails, do **not** write a second matching rule — read `subjectHits` in `lib/server/recFilters.ts:160` and adjust the test's expectation to the real behavior, then report the discrepancy, because the spec's genre semantics are defined as "whatever `subjectHits` does".

- [ ] **Step 5: Typecheck and report**

Run: `npm run type-check`
Expected: clean. Report the exported signatures so the next task builds against real names.

---

## Task 3: `GET /api/goals` — goals, stats, and suggestions

**Dispatch:** Codex, `--write`, fresh dispatch (Wave 2, first). Focused gate: `npx vitest run app/api/goals/route.test.ts`. Task 4 edits the same file, so it must not start until this one is accepted.

**Files:**
- Create: `app/api/goals/route.ts`
- Test: `app/api/goals/route.test.ts`

**Interfaces:**
- Consumes: everything Task 2 produced; `withApi`/`ApiError` from `lib/server/http.ts`; `getDb`, `schema` from `lib/server/db.ts`.
- Produces: `GET` returning `{ year, stats, goals, subjects }`. Task 8's client and Task 9's card consume this shape verbatim.

In local mode (no `SUPABASE_URL`, which `setupTestEnv()` guarantees) `withApi` resolves the caller to `LOCAL_USER_ID === 'local'`. Tenancy tests therefore seed rows under a different `user_id` and assert they are invisible.

- [ ] **Step 1: Write the failing test**

Create `app/api/goals/route.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeTestDb, loadSeed } from '@/lib/server/__tests__/helpers/pglite';
import { setupTestEnv } from '@/lib/server/__tests__/helpers/testEnv';
import { _setDbForTests, type Db } from '@/lib/server/db';
import { currentYear } from '@/lib/server/goals';
import { GET } from './route';

setupTestEnv();
afterEach(() => vi.restoreAllMocks());

function req(qs = ''): Request {
  return new Request(`http://test/api/goals${qs}`);
}

async function withDb(fn: (db: Db) => Promise<void>): Promise<void> {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const { db, close } = await makeTestDb();
  try {
    _setDbForTests(db);
    await fn(db);
  } finally {
    _setDbForTests(null);
    await close();
  }
}

const book = (over: Record<string, unknown>) => ({
  user_id: 'local',
  title: 'A Book',
  author: 'Le Guin',
  exclusive_shelf: 'read',
  goodreads_rating: 0,
  source: 'test',
  page_count: 300,
  ...over,
});

describe('GET /api/goals', () => {
  it('defaults to the current year and reports zeroes for an empty library', async () => {
    await withDb(async () => {
      const res = await GET(req());
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.year).toBe(currentYear());
      expect(body.goals).toEqual([]);
      expect(body.subjects).toEqual([]);
      expect(body.stats.books).toBe(0);
      expect(body.stats.undated).toBe(0);
    });
  });

  it('computes progress and stats for the requested year', async () => {
    await withDb(async (db) => {
      await loadSeed(db, {
        books: [
          book({ id: 1, date_read: '2026-01-05' }),
          book({ id: 2, date_read: '2026-02-05', author: 'Chiang', page_count: null }),
          book({ id: 3, date_read: '2025-02-05' }),
          book({ id: 4, date_read: null }),
        ],
        enrichment: [
          { id: 1, book_id: 1, resolution_confidence: 1, subjects: ['History'] },
          { id: 2, book_id: 2, resolution_confidence: 1, subjects: ['Fiction'] },
        ],
        reading_goals: [
          { id: 1, user_id: 'local', year: 2026, kind: 'books', target: 10 },
          { id: 2, user_id: 'local', year: 2026, kind: 'genre', subject: 'History', target: 5 },
        ],
      });

      const body = await (await GET(req('?year=2026'))).json();
      expect(body.year).toBe(2026);
      expect(body.stats).toMatchObject({
        books: 2,
        pages: 300,
        unknown_pages: 1,
        authors: 2,
        undated: 1,
      });
      expect(body.goals.map((g: { kind: string; progress: number }) => [g.kind, g.progress])).toEqual(
        [
          ['books', 2],
          ['genre', 1],
        ]
      );
      expect(body.subjects).toContain('History');
    });
  });

  it('returns stats even when the user has no goals', async () => {
    await withDb(async (db) => {
      await loadSeed(db, { books: [book({ id: 1, date_read: '2026-01-05' })] });
      const body = await (await GET(req('?year=2026'))).json();
      expect(body.goals).toEqual([]);
      expect(body.stats.books).toBe(1);
    });
  });

  it('never counts another user rows or lists their goals', async () => {
    await withDb(async (db) => {
      await loadSeed(db, {
        books: [book({ id: 1, user_id: 'someone-else', date_read: '2026-01-05' })],
        reading_goals: [{ id: 1, user_id: 'someone-else', year: 2026, kind: 'books', target: 10 }],
      });
      const body = await (await GET(req('?year=2026'))).json();
      expect(body.goals).toEqual([]);
      expect(body.stats.books).toBe(0);
    });
  });

  it('rejects a non-numeric year with 422', async () => {
    await withDb(async () => {
      expect((await GET(req('?year=banana'))).status).toBe(422);
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/api/goals/route.test.ts`
Expected: FAIL — cannot resolve `./route`.

- [ ] **Step 3: Implement the GET handler**

Create `app/api/goals/route.ts`:

```ts
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import {
  countForGoal,
  currentYear,
  goalOut,
  loadReadRows,
  topSubjects,
  yearStats,
  type GoalKind,
} from '@/lib/server/goals';

const Query = z.object({ year: z.coerce.number().int().min(1900).max(2200).optional() });

export const GET = withApi('/api/goals', async (req, ctx) => {
  const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) {
    throw new ApiError(422, `validation error: ${parsed.error.issues[0]?.message ?? 'invalid year'}`);
  }
  const year = parsed.data.year ?? currentYear();

  const db = getDb();
  const userId = ctx.user.userId;

  const goals = await db
    .select()
    .from(schema.readingGoals)
    .where(and(eq(schema.readingGoals.userId, userId), eq(schema.readingGoals.year, year)))
    .orderBy(
      asc(schema.readingGoals.kind),
      asc(schema.readingGoals.subject),
      asc(schema.readingGoals.id)
    );
  const rows = await loadReadRows(db, userId);
  ctx.timer.mark('db');

  return Response.json({
    year,
    stats: yearStats(rows, year),
    goals: goals.map((g) =>
      goalOut(
        g,
        countForGoal(rows, {
          year: g.year,
          kind: g.kind as GoalKind,
          subject: g.subject,
          target: g.target,
        })
      )
    ),
    subjects: topSubjects(rows),
  });
});
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run app/api/goals/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Report**

Note whether `loadSeed` needed a `subjects` JSON entry — `subjects` is already in the helper's `JSON_COLS`, so seeded arrays are stringified for you. If that turned out to be false, report it, because Task 4's tests rely on it too.

---

## Task 4: `POST /api/goals` — create with validation

**Dispatch:** Codex, `--write`, **fresh dispatch — not a resume of Task 3** (Wave 2, second). Focused gate: `npx vitest run app/api/goals/route.test.ts`. The brief must paste the current body of `app/api/goals/route.ts` as Task 3 left it: a fresh agent knows nothing of that thread, and a resumed one cannot be granted write access it did not start with.

**Files:**
- Modify: `app/api/goals/route.ts` (add `POST`)
- Modify: `app/api/goals/route.test.ts` (add a `describe` block)

**Interfaces:**
- Consumes: Task 3's module imports; `pyList` and `pyTitle` from `lib/server/serialize.ts`.
- Produces: `POST` returning a single `GoalOut` (not wrapped), status 200.

The validation split follows the project's established convention (see the ratings note in CLAUDE.md): Zod stays permissive about the *values*, and a manual guard owns the stable 422 message.

- [ ] **Step 1: Write the failing tests**

Append to `app/api/goals/route.test.ts` (add `POST` to the import from `./route`):

```ts
function post(body: unknown): Request {
  return new Request('http://test/api/goals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/goals', () => {
  it('creates a goal, defaulting the year, and returns computed progress', async () => {
    await withDb(async (db) => {
      await loadSeed(db, { books: [book({ id: 1, date_read: `${currentYear()}-01-05` })] });
      const res = await POST(post({ kind: 'books', target: 12 }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        year: currentYear(),
        kind: 'books',
        subject: null,
        target: 12,
        progress: 1,
        done: false,
      });
    });
  });

  it('normalizes a genre subject to title case', async () => {
    await withDb(async () => {
      const body = await (await POST(post({ year: 2026, kind: 'genre', subject: ' history ', target: 5 }))).json();
      expect(body.subject).toBe('History');
    });
  });

  it('rejects an unknown kind with 422 naming the valid kinds', async () => {
    await withDb(async () => {
      const res = await POST(post({ kind: 'sandwiches', target: 5 }));
      expect(res.status).toBe(422);
      expect((await res.json()).detail).toContain("'books'");
    });
  });

  it('rejects a non-positive target with 422', async () => {
    await withDb(async () => {
      expect((await POST(post({ kind: 'books', target: 0 }))).status).toBe(422);
      expect((await POST(post({ kind: 'books', target: -3 }))).status).toBe(422);
    });
  });

  it('rejects a genre goal with no subject, and a non-genre goal with one', async () => {
    await withDb(async () => {
      expect((await POST(post({ kind: 'genre', target: 5 }))).status).toBe(422);
      expect((await POST(post({ kind: 'genre', subject: '   ', target: 5 }))).status).toBe(422);
      expect((await POST(post({ kind: 'books', subject: 'History', target: 5 }))).status).toBe(422);
    });
  });

  it('rejects a duplicate books goal with 409 (the NULL-subject case)', async () => {
    await withDb(async () => {
      expect((await POST(post({ year: 2026, kind: 'books', target: 10 }))).status).toBe(200);
      expect((await POST(post({ year: 2026, kind: 'books', target: 50 }))).status).toBe(409);
    });
  });

  it('rejects a duplicate genre goal with 409, case-insensitively', async () => {
    await withDb(async () => {
      expect((await POST(post({ year: 2026, kind: 'genre', subject: 'History', target: 10 }))).status).toBe(200);
      expect((await POST(post({ year: 2026, kind: 'genre', subject: 'history', target: 4 }))).status).toBe(409);
    });
  });

  it('allows the same kind in a different year', async () => {
    await withDb(async () => {
      expect((await POST(post({ year: 2026, kind: 'books', target: 10 }))).status).toBe(200);
      expect((await POST(post({ year: 2027, kind: 'books', target: 10 }))).status).toBe(200);
    });
  });
});
```

- [ ] **Step 2: Run to verify the new block fails**

Run: `npx vitest run app/api/goals/route.test.ts`
Expected: FAIL — `POST` is not exported.

- [ ] **Step 3: Implement POST**

Add to `app/api/goals/route.ts` (extend the existing imports):

```ts
import { GOAL_KINDS } from '@/lib/server/goals';
import { pyList, pyTitle } from '@/lib/server/serialize';

// Permissive on values by design: the manual guards below own the 422 messages,
// matching how the books routes handle ratings.
const CreateBody = z.object({
  year: z.number().int().optional(),
  kind: z.string(),
  subject: z.string().nullish(),
  target: z.number(),
});

export const POST = withApi('/api/goals', async (req, ctx) => {
  const raw = await req.json().catch(() => null);
  const parsed = CreateBody.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(422, `validation error: ${parsed.error.issues[0]?.message ?? 'invalid body'}`);
  }
  const { kind, target } = parsed.data;
  const year = parsed.data.year ?? currentYear();

  if (!(GOAL_KINDS as readonly string[]).includes(kind)) {
    throw new ApiError(422, `kind must be one of ${pyList([...GOAL_KINDS])}.`);
  }
  if (!Number.isInteger(target) || target <= 0) {
    throw new ApiError(422, 'target must be a positive whole number.');
  }
  if (year < 1900 || year > 2200) {
    throw new ApiError(422, 'year must be between 1900 and 2200.');
  }

  const trimmed = (parsed.data.subject ?? '').trim();
  if (kind === 'genre' && !trimmed) {
    throw new ApiError(422, 'A genre goal requires a subject.');
  }
  if (kind !== 'genre' && trimmed) {
    throw new ApiError(422, `A ${kind} goal cannot have a subject.`);
  }
  // Normalized so 'history' and 'History' are the same goal, and so the stored
  // spelling matches the suggestion list the UI offers.
  const subject = kind === 'genre' ? pyTitle(trimmed) : null;

  const db = getDb();
  const userId = ctx.user.userId;

  // Explicit duplicate check: Postgres treats NULLs as distinct in a unique
  // constraint, so uq_reading_goal does NOT stop two 'books' goals in one year.
  const existing = await db
    .select({ id: schema.readingGoals.id })
    .from(schema.readingGoals)
    .where(
      and(
        eq(schema.readingGoals.userId, userId),
        eq(schema.readingGoals.year, year),
        eq(schema.readingGoals.kind, kind),
        subject === null
          ? isNull(schema.readingGoals.subject)
          : eq(schema.readingGoals.subject, subject)
      )
    );
  if (existing.length > 0) {
    throw new ApiError(409, 'That goal already exists for this year.');
  }

  const inserted = await db
    .insert(schema.readingGoals)
    .values({ userId, year, kind, subject, target })
    .returning();
  const rows = await loadReadRows(db, userId);
  ctx.timer.mark('db');

  const goal = inserted[0];
  return Response.json(
    goalOut(goal, countForGoal(rows, { year, kind: kind as GoalKind, subject, target }))
  );
});
```

Add `isNull` to the `drizzle-orm` import at the top of the file.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run app/api/goals/route.test.ts`
Expected: PASS, both describe blocks.

- [ ] **Step 5: Report**

---

## Task 5: `PATCH` and `DELETE /api/goals/[id]`

**Dispatch:** Codex, `--write`, fresh dispatch (Wave 2, third). Focused gate: `npx vitest run 'app/api/goals/[id]/route.test.ts'` — quote the brackets. **Step 5's full server suite is the controller's wave gate; leave it out of the brief.**

**Files:**
- Create: `app/api/goals/[id]/route.ts`
- Test: `app/api/goals/[id]/route.test.ts`

**Interfaces:**
- Consumes: Task 2's exports; `parseIdParam` from `lib/server/serialize.ts`.
- Produces: `PATCH` returning a `GoalOut`; `DELETE` returning `{ ok: true }`. Task 8's client depends on both shapes.

`withApi` handlers receive route params through `ctx.params`, and the wrapper's second argument carries them — the tests must pass `{ params: { id: '1' } }` as the second argument, exactly as the other `[id]` route tests do.

- [ ] **Step 1: Write the failing test**

Create `app/api/goals/[id]/route.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeTestDb, loadSeed } from '@/lib/server/__tests__/helpers/pglite';
import { setupTestEnv } from '@/lib/server/__tests__/helpers/testEnv';
import { _setDbForTests, type Db } from '@/lib/server/db';
import { PATCH, DELETE } from './route';

setupTestEnv();
afterEach(() => vi.restoreAllMocks());

async function withDb(fn: (db: Db) => Promise<void>): Promise<void> {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const { db, close } = await makeTestDb();
  try {
    _setDbForTests(db);
    await fn(db);
  } finally {
    _setDbForTests(null);
    await close();
  }
}

const ctxFor = (id: string) => ({ params: { id } });

function patchReq(body: unknown): Request {
  return new Request('http://test/api/goals/1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const seedGoals = (db: Db) =>
  loadSeed(db, {
    reading_goals: [
      { id: 1, user_id: 'local', year: 2026, kind: 'books', target: 10 },
      { id: 2, user_id: 'someone-else', year: 2026, kind: 'books', target: 10 },
    ],
  });

describe('PATCH /api/goals/[id]', () => {
  it('updates the target and returns the recomputed goal', async () => {
    await withDb(async (db) => {
      await seedGoals(db);
      const res = await PATCH(patchReq({ target: 25 }), ctxFor('1'));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id: 1, target: 25, progress: 0, done: false });
    });
  });

  it('rejects a non-positive target with 422', async () => {
    await withDb(async (db) => {
      await seedGoals(db);
      expect((await PATCH(patchReq({ target: 0 }), ctxFor('1'))).status).toBe(422);
    });
  });

  it('returns 404 -- not 403 -- for another user goal', async () => {
    await withDb(async (db) => {
      await seedGoals(db);
      expect((await PATCH(patchReq({ target: 25 }), ctxFor('2'))).status).toBe(404);
    });
  });

  it('returns 404 for a goal that does not exist', async () => {
    await withDb(async (db) => {
      await seedGoals(db);
      expect((await PATCH(patchReq({ target: 25 }), ctxFor('999'))).status).toBe(404);
    });
  });
});

describe('DELETE /api/goals/[id]', () => {
  it('deletes the goal', async () => {
    await withDb(async (db) => {
      await seedGoals(db);
      const res = await DELETE(new Request('http://test/api/goals/1', { method: 'DELETE' }), ctxFor('1'));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect((await PATCH(patchReq({ target: 5 }), ctxFor('1'))).status).toBe(404);
    });
  });

  it('will not delete another user goal', async () => {
    await withDb(async (db) => {
      await seedGoals(db);
      const res = await DELETE(new Request('http://test/api/goals/2', { method: 'DELETE' }), ctxFor('2'));
      expect(res.status).toBe(404);
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/api/goals/\[id\]/route.test.ts`
Expected: FAIL — cannot resolve `./route`.

- [ ] **Step 3: Implement the handlers**

Create `app/api/goals/[id]/route.ts`:

```ts
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { countForGoal, goalOut, loadReadRows, type GoalKind } from '@/lib/server/goals';
import { parseIdParam } from '@/lib/server/serialize';

const PatchBody = z.object({ target: z.number() });

/** Scoped read: another user's goal is 404, never 403 -- 403 would confirm it exists. */
async function ownedGoal(userId: string, goalId: number) {
  const rows = await getDb()
    .select()
    .from(schema.readingGoals)
    .where(and(eq(schema.readingGoals.id, goalId), eq(schema.readingGoals.userId, userId)));
  const goal = rows[0];
  if (!goal) throw new ApiError(404, `Goal ${goalId} not found.`);
  return goal;
}

export const PATCH = withApi('/api/goals/[id]', async (req, ctx) => {
  const goalId = parseIdParam(ctx.params.id);
  const parsed = PatchBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError(422, 'validation error: target is required');
  }
  const { target } = parsed.data;
  if (!Number.isInteger(target) || target <= 0) {
    throw new ApiError(422, 'target must be a positive whole number.');
  }

  const goal = await ownedGoal(ctx.user.userId, goalId);
  const db = getDb();
  await db
    .update(schema.readingGoals)
    .set({ target })
    .where(eq(schema.readingGoals.id, goalId));
  const rows = await loadReadRows(db, ctx.user.userId);
  ctx.timer.mark('db');

  return Response.json(
    goalOut(
      { ...goal, target },
      countForGoal(rows, {
        year: goal.year,
        kind: goal.kind as GoalKind,
        subject: goal.subject,
        target,
      })
    )
  );
});

export const DELETE = withApi('/api/goals/[id]', async (_req, ctx) => {
  const goalId = parseIdParam(ctx.params.id);
  await ownedGoal(ctx.user.userId, goalId);
  await getDb().delete(schema.readingGoals).where(eq(schema.readingGoals.id, goalId));
  ctx.timer.mark('db');
  return Response.json({ ok: true });
});
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run app/api/goals/\[id\]/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole server suite and report**

Run: `npm run test:server`
Expected: PASS — nothing else should have moved yet.

---

## Task 6: Purge goals when an account is deleted

**Dispatch:** Codex, `--write`, fresh dispatch (Wave 3). Parallel-safe with Task 7 — disjoint files. Focused gate: `npx vitest run lib/server/__tests__/purge-routes.test.ts`. Step 5's grep sweep stays in the brief; its `npm run test:server` re-run does not.

**Files:**
- Modify: `lib/server/purge.ts` (`AccountPurgeResult`, `deleteAccountRows`)
- Modify: `lib/server/__tests__/purge-routes.test.ts` (the account-level `toEqual` around line 283)

**Interfaces:**
- Consumes: `schema.readingGoals`.
- Produces: `AccountPurgeResult.goals_removed: number`.

`deleteAccountRows` enumerates every user-scoped table by hand and nothing cascades. Goals go in **`deleteAccountRows`, not `deleteProfileRows`** — rebuilding a taste profile must not wipe someone's goals.

- [ ] **Step 1: Write the failing test**

In `lib/server/__tests__/purge-routes.test.ts`, find the account-deletion test whose assertion is the `toEqual` containing `books_removed`, `settings_removed`, `signals_removed`, … (around line 283). Add `goals_removed: 1` to that expected object, and seed a goal row in that test's `loadSeed` call:

```ts
reading_goals: [{ id: 1, user_id: 'local', year: 2026, kind: 'books', target: 10 }],
```

Also assert the row is gone, matching the file's existing `countFor` style if that helper covers it; otherwise a direct select is fine.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/server/__tests__/purge-routes.test.ts`
Expected: FAIL — received object is missing `goals_removed`.

- [ ] **Step 3: Implement**

In `lib/server/purge.ts`, add to the `AccountPurgeResult` interface:

```ts
  goals_removed: number;
```

and inside `deleteAccountRows`, alongside the other deletes:

```ts
  const goals = await tx
    .delete(schema.readingGoals)
    .where(eq(schema.readingGoals.userId, userId))
    .returning({ id: schema.readingGoals.id });
```

then add `goals_removed: goals.length,` to the returned object.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run lib/server/__tests__/purge-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Check for other assertions on that shape**

Run: `grep -rn "settings_removed" --include=*.ts lib app`
Expected: every hit either is the implementation or has been updated. Fix any other `toEqual` that now misses `goals_removed`, then re-run `npm run test:server`.

---

## Task 7: Stamp `date_read` when a book is marked read

**Dispatch:** Codex, `--write`, fresh dispatch (Wave 3). Parallel-safe with Task 6. Focused gate: `npx vitest run 'app/api/books/[id]/shelf/route.test.ts'` — quote the brackets. **Step 5's full suite is the controller's wave gate.**

**Files:**
- Modify: `app/api/books/[id]/shelf/route.ts`
- Create: `app/api/books/[id]/shelf/route.test.ts` — there is **no** existing test covering this route; the whole `app/api/books/` tree has no test file (verified 2026-08-24, `find app/api -name "*.test.ts"`). Do not spend dispatch budget re-searching for one.

**Interfaces:**
- Consumes: `todayIsoDate` from `lib/server/serialize.ts` (already imported in that route? check — the route currently imports `effectiveRating`, `parseIdParam`, `pyList` from it).
- Produces: no signature change. `bookSummary` already emits `date_read`.

Without this, every yearly goal and the whole year card are dead on arrival for books marked read in-app: nothing else in the write path records *when*.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeTestDb, loadSeed } from '@/lib/server/__tests__/helpers/pglite';
import { setupTestEnv } from '@/lib/server/__tests__/helpers/testEnv';
import { _setDbForTests, type Db } from '@/lib/server/db';
import { todayIsoDate } from '@/lib/server/serialize';
import { PATCH } from './route';

setupTestEnv();
afterEach(() => vi.restoreAllMocks());

async function withDb(fn: (db: Db) => Promise<void>): Promise<void> {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const { db, close } = await makeTestDb();
  try {
    _setDbForTests(db);
    await fn(db);
  } finally {
    _setDbForTests(null);
    await close();
  }
}

const shelfReq = (shelf: string) =>
  new Request('http://test/api/books/1/shelf', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shelf }),
  });

const seedBook = (db: Db, over: Record<string, unknown>) =>
  loadSeed(db, {
    books: [
      {
        id: 1,
        user_id: 'local',
        title: 'A Book',
        exclusive_shelf: 'to-read',
        goodreads_rating: 0,
        source: 'test',
        ...over,
      },
    ],
  });

describe('PATCH /api/books/[id]/shelf — date_read stamping', () => {
  it('stamps today when an undated book moves to read', async () => {
    await withDb(async (db) => {
      await seedBook(db, { date_read: null });
      const body = await (await PATCH(shelfReq('read'), { params: { id: '1' } })).json();
      expect(body.date_read).toBe(todayIsoDate());
    });
  });

  it('never overwrites an existing date_read', async () => {
    await withDb(async (db) => {
      await seedBook(db, { date_read: '2019-04-04' });
      const body = await (await PATCH(shelfReq('read'), { params: { id: '1' } })).json();
      expect(body.date_read).toBe('2019-04-04');
    });
  });

  it('does not stamp a move to a shelf other than read', async () => {
    await withDb(async (db) => {
      await seedBook(db, { date_read: null });
      const body = await (await PATCH(shelfReq('to-read'), { params: { id: '1' } })).json();
      expect(body.date_read).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/api/books/\[id\]/shelf/route.test.ts`
Expected: FAIL — the first test gets `null`.

- [ ] **Step 3: Implement**

In `app/api/books/[id]/shelf/route.ts`, add `todayIsoDate` to the existing `@/lib/server/serialize` import, then replace the update-and-return block (currently at lines 32-33):

```ts
  // Marking a book read is the only signal ShelfSprite has for WHEN it was read;
  // without this, every yearly goal and the year card stay empty. Never overwrite
  // an existing date -- Goodreads import dates must survive.
  const dateRead =
    shelf === 'read' && book.dateRead === null ? todayIsoDate() : book.dateRead;

  await db
    .update(schema.books)
    .set({ exclusiveShelf: shelf, dateRead })
    .where(eq(schema.books.id, bookId));
  ctx.timer.mark('db');

  return Response.json(bookSummary({ ...book, exclusiveShelf: shelf, dateRead }));
```

The stamped value **must** be spread into the `bookSummary` argument — the existing code builds the response from the pre-update row, so returning `book` unchanged would report a stale `null` for the write just performed.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run app/api/books/\[id\]/shelf/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full server suite**

Run: `npm run test:server`
Expected: PASS. If an existing shelf or library test asserted `date_read: null` after marking read, that assertion encoded the bug — update it and say so in the report.

---

## Task 8: Typed client in `lib/api.ts`

**Dispatch:** Codex, `--write`, fresh dispatch (Wave 3) — or run it directly in the controller turn that closes Wave 3, if that session is still cheap. Focused gate: `npm run type-check`. Tasks 9 and 10 both import these names, so Step 4's reported export list goes into the ledger verbatim.

**Files:**
- Modify: `lib/api.ts`

**Interfaces:**
- Consumes: the wire shapes from Tasks 3-5.
- Produces: `Goal`, `GoalKind`, `YearStats`, `GoalsResponse`, `GOALS_KEY`, and `api.listGoals/createGoal/updateGoal/deleteGoal`. Tasks 9 and 10 import all of these.

- [ ] **Step 1: Add the types**

In the types section of `lib/api.ts`, near `Stats`:

```ts
export type GoalKind = 'books' | 'genre' | 'new_authors' | 'pages';

export interface Goal {
  id: number;
  year: number;
  kind: GoalKind;
  subject: string | null;
  target: number;
  progress: number;
  /** Books that could not contribute -- currently only pages goals with no page_count. */
  unknown: number;
  done: boolean;
}

export interface YearStats {
  books: number;
  pages: number;
  unknown_pages: number;
  authors: number;
  new_authors: number;
  /** Read-shelf books with no date_read, any year -- the backlog the card cannot see. */
  undated: number;
  top_genres: { subject: string; count: number }[];
  top_authors: { author: string; count: number }[];
}

export interface GoalsResponse {
  year: number;
  stats: YearStats;
  goals: Goal[];
  /** The user's own subject vocabulary, for goal-creation suggestions. */
  subjects: string[];
}
```

- [ ] **Step 2: Add the SWR key and the methods**

```ts
export const GOALS_KEY = 'reading-goals';
```

and inside the `api` object:

```ts
  listGoals: (year?: number) =>
    get<GoalsResponse>(year === undefined ? '/goals' : `/goals?year=${year}`),

  createGoal: (req: { year?: number; kind: GoalKind; subject?: string; target: number }) =>
    post<Goal>('/goals', req),

  updateGoal: (goalId: number, target: number) => patch<Goal>(`/goals/${goalId}`, { target }),

  deleteGoal: (goalId: number) => del<{ ok: true }>(`/goals/${goalId}`),
```

- [ ] **Step 3: Typecheck**

Run: `npm run type-check`
Expected: clean.

- [ ] **Step 4: Report the exact exported names** so the UI tasks build against them.

---

## Task 9: The "Your 2026" card

**Dispatch:** Codex, `--write`, fresh dispatch (Wave 4). Parallel-safe with Task 10. Focused gates: `npx jest components/__tests__/YearCard.test.tsx`, then `npm test` (5 s — cheap enough to name in full) and `npm run type-check`. **Step 6's render check is the controller's browser verification, not the dispatch's** — an executor with no network and no browser cannot perform it, and its absence from a report is not a pass.

**Files:**
- Create: `components/YearCard.tsx`
- Test: `components/__tests__/YearCard.test.tsx`
- Modify: `app/(main)/page.tsx`

**Interfaces:**
- Consumes: `api.listGoals`, `GOALS_KEY`, `Goal`, `GoalsResponse` from `lib/api.ts`; `Card` from `components/ui`.
- Produces: default-exported `YearCard` taking no props.

Design rules from spec §9.1, all load-bearing: the all-time `StatsStrip` above stays untouched; genre bars scale to the **top genre's count**, not the year's book total; bar *width* is clamped but numbers are not; the `undated` line is quiet `text-faint` copy, not a warning; a year with no dated reads collapses to one line instead of a wall of zeros.

- [ ] **Step 1: Write the failing test**

Create `components/__tests__/YearCard.test.tsx`:

```tsx
/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import YearCard from '@/components/YearCard';
import type { GoalsResponse } from '@/lib/api';

let mockData: GoalsResponse | undefined;
jest.mock('swr', () => ({
  __esModule: true,
  default: () => ({ data: mockData, isLoading: false, error: undefined }),
  mutate: jest.fn(),
}));

const base: GoalsResponse = {
  year: 2026,
  stats: {
    books: 42,
    pages: 11204,
    unknown_pages: 0,
    authors: 28,
    new_authors: 9,
    undated: 0,
    top_genres: [
      { subject: 'Fiction', count: 18 },
      { subject: 'History', count: 9 },
    ],
    top_authors: [{ author: 'Le Guin', count: 3 }],
  },
  goals: [],
  subjects: [],
};

const withData = (over: Partial<GoalsResponse>) => {
  mockData = { ...base, ...over } as GoalsResponse;
};

describe('YearCard', () => {
  it('shows the year numbers and top genres', () => {
    withData({});
    render(<YearCard />);
    expect(screen.getByText('Your 2026')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('Fiction')).toBeInTheDocument();
    expect(screen.getByText('Le Guin')).toBeInTheDocument();
  });

  it('renders goal progress and a done state', () => {
    withData({
      goals: [
        { id: 1, year: 2026, kind: 'books', subject: null, target: 100, progress: 42, unknown: 0, done: false },
        { id: 2, year: 2026, kind: 'new_authors', subject: null, target: 2, progress: 9, unknown: 0, done: true },
      ],
    });
    render(<YearCard />);
    expect(screen.getByText('42 / 100')).toBeInTheDocument();
    expect(screen.getByText('9 / 2')).toBeInTheDocument();
  });

  it('names the unknown-pages caveat on a pages goal', () => {
    withData({
      goals: [
        { id: 3, year: 2026, kind: 'pages', subject: null, target: 20000, progress: 11204, unknown: 3, done: false },
      ],
    });
    render(<YearCard />);
    expect(screen.getByText(/3 books have no page count/i)).toBeInTheDocument();
  });

  it('names the undated backlog only when there is one', () => {
    withData({ stats: { ...base.stats, undated: 12 } });
    const { unmount } = render(<YearCard />);
    expect(screen.getByText(/12 read books have no date/i)).toBeInTheDocument();
    unmount();

    withData({});
    render(<YearCard />);
    expect(screen.queryByText(/have no date/i)).not.toBeInTheDocument();
  });

  it('collapses to one line for a year with no dated reads', () => {
    withData({ stats: { ...base.stats, books: 0, pages: 0, authors: 0, new_authors: 0, top_genres: [], top_authors: [] } });
    render(<YearCard />);
    expect(screen.getByText(/nothing dated in 2026 yet/i)).toBeInTheDocument();
  });

  it('invites a first goal when there are none', () => {
    withData({});
    render(<YearCard />);
    expect(screen.getByText(/no goals for 2026/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest components/__tests__/YearCard.test.tsx`
Expected: FAIL — cannot resolve `@/components/YearCard`.

- [ ] **Step 3: Implement the card**

Create `components/YearCard.tsx`:

```tsx
'use client';

import Link from 'next/link';
import useSWR from 'swr';
import { api, GOALS_KEY, type Goal, type GoalsResponse } from '@/lib/api';
import { Card } from '@/components/ui';

const KIND_LABEL: Record<Goal['kind'], string> = {
  books: 'Books read',
  genre: 'Genre',
  new_authors: 'New authors',
  pages: 'Pages read',
};

function goalLabel(g: Goal): string {
  return g.kind === 'genre' ? (g.subject ?? KIND_LABEL.genre) : KIND_LABEL[g.kind];
}

function Bar({ pct }: { pct: number }) {
  return (
    <div className="flex-1 overflow-hidden rounded-full bg-elevated h-2">
      <div
        className="h-2 rounded-full bg-accent transition-all"
        style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
      />
    </div>
  );
}

function Figure({ value, label }: { value: string; label: string }) {
  return (
    <div className="px-4 text-center">
      <p className="font-mono text-xl font-semibold text-text">{value}</p>
      <p className="mt-0.5 font-mono text-xs uppercase tracking-widest text-faint">{label}</p>
    </div>
  );
}

export default function YearCard() {
  const { data, isLoading, error } = useSWR<GoalsResponse>(GOALS_KEY, () => api.listGoals());

  if (isLoading) {
    return (
      <Card>
        <div className="h-24 rounded bg-elevated motion-safe:animate-pulse" />
      </Card>
    );
  }
  if (error || !data) return null; // never block the page on this card

  const { year, stats, goals } = data;
  const topGenreCount = stats.top_genres[0]?.count ?? 0;

  return (
    <Card>
      <p className="mb-4 font-mono text-xs font-medium uppercase tracking-widest text-muted">
        Your {year}
      </p>

      {stats.books === 0 ? (
        <p className="text-sm text-muted">Nothing dated in {year} yet.</p>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-y-4 sm:divide-x sm:divide-border">
            <Figure value={String(stats.books)} label="Books" />
            <Figure value={stats.pages.toLocaleString()} label="Pages" />
            <Figure
              value={`${stats.authors}${stats.new_authors > 0 ? ` (${stats.new_authors} new)` : ''}`}
              label="Authors"
            />
          </div>

          {stats.top_genres.length > 0 && (
            <div className="mt-6 space-y-2">
              <p className="font-mono text-xs uppercase tracking-widest text-faint">Top genres</p>
              {stats.top_genres.map((g) => (
                <div key={g.subject} className="flex items-center gap-3">
                  <span className="w-28 shrink-0 truncate text-sm text-muted">{g.subject}</span>
                  <Bar pct={topGenreCount > 0 ? (g.count / topGenreCount) * 100 : 0} />
                  <span className="w-8 text-right font-mono text-sm text-faint">{g.count}</span>
                </div>
              ))}
            </div>
          )}

          {stats.top_authors.length > 0 && (
            <p className="mt-4 text-sm text-muted">
              <span className="font-mono text-xs uppercase tracking-widest text-faint">
                Top authors{' '}
              </span>
              {stats.top_authors.map((a) => (
                <span key={a.author} className="ml-2">
                  {a.author} ({a.count})
                </span>
              ))}
            </p>
          )}
        </>
      )}

      {stats.undated > 0 && (
        <p className="mt-4 text-xs text-faint">
          {stats.undated} read {stats.undated === 1 ? 'book has' : 'books have'} no date and
          {stats.undated === 1 ? " isn't" : " aren't"} counted.
        </p>
      )}

      <div className="mt-6 border-t border-border pt-4">
        {goals.length === 0 ? (
          <p className="text-sm text-muted">
            No goals for {year}.{' '}
            <Link href="/settings" className="transition-colors hover:text-text">
              Set one in settings &rarr;
            </Link>
          </p>
        ) : (
          <div className="space-y-2">
            {goals.map((g) => (
              <div key={g.id}>
                <div className="flex items-center gap-3">
                  <span className="w-28 shrink-0 truncate text-sm text-muted">{goalLabel(g)}</span>
                  <Bar pct={g.target > 0 ? (g.progress / g.target) * 100 : 0} />
                  <span className="w-20 text-right font-mono text-sm text-faint">
                    {g.progress} / {g.target}
                  </span>
                </div>
                {g.unknown > 0 && (
                  <p className="ml-31 mt-1 text-xs text-faint">
                    {g.unknown} books have no page count.
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
```

If `ml-31` is not a valid spacing token in this Tailwind config, use `ml-[7.75rem]` or simply drop the indent — do not invent a config change.

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest components/__tests__/YearCard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Mount it on the home page**

In `app/(main)/page.tsx`, import it and add it to the utility tier, **after** the existing `StatsStrip` block and before `RatingsBreakdown`:

```tsx
import YearCard from '@/components/YearCard';
```

```tsx
        <YearCard />
```

- [ ] **Step 6: Verify the page still builds and renders**

Run: `npm test && npm run type-check`
Expected: PASS.

---

## Task 10: Settings management section

**Dispatch:** Claude subagent on **Sonnet 5**, not Codex (Wave 4). Parallel-safe with Task 9. This component has **no test file anywhere in this plan**, so its only real gate is the browser and the work is visual-convention matching — copy the `<select>` and `<Input>` class lists rather than inventing them. Gates: `npm test && npm run type-check && npm run lint`. The controller browser-verifies create, edit-target, and delete before accepting; Task 11 Step 2 exercises the same three for the same reason.

**Files:**
- Create: `components/ReadingGoalsSettings.tsx`
- Modify: `app/(main)/settings/page.tsx`

**Interfaces:**
- Consumes: `api.listGoals/createGoal/updateGoal/deleteGoal`, `GOALS_KEY`, `Goal`, `GoalsResponse`; `Card`, `Field`, `Input`, `Button`, `useToast` from `components/ui`.
- Produces: default-exported `ReadingGoalsSettings` taking no props.

`components/ui` has no `Select`; a raw styled `<select>` is the established pattern (`components/ImportModal.tsx:157`, `components/admin/UsageTab.tsx:50`) — copy the class list from one of those rather than inventing styling.

- [ ] **Step 1: Build the component**

Create `components/ReadingGoalsSettings.tsx`. The `<select>` and `<Input>` class lists are copied
from `components/admin/UsageTab.tsx:50` and the surrounding settings page — do not invent styling.

```tsx
'use client';

import { useState } from 'react';
import useSWR, { mutate } from 'swr';
import {
  api,
  GOALS_KEY,
  type Goal,
  type GoalKind,
  type GoalsResponse,
} from '@/lib/api';
import { Card, Button, Input, useToast } from '@/components/ui';

const KIND_OPTIONS: { value: GoalKind; label: string }[] = [
  { value: 'books', label: 'Books read' },
  { value: 'genre', label: 'Books in a genre' },
  { value: 'new_authors', label: 'New-to-you authors' },
  { value: 'pages', label: 'Pages read' },
];

const SELECT_CLASS =
  'rounded border border-border bg-elevated px-2 py-1 text-sm text-text';

function goalLabel(g: Goal): string {
  if (g.kind === 'genre') return g.subject ?? 'Genre';
  return KIND_OPTIONS.find((k) => k.value === g.kind)?.label ?? g.kind;
}

export default function ReadingGoalsSettings() {
  const toast = useToast();
  const { data } = useSWR<GoalsResponse>(GOALS_KEY, () => api.listGoals());

  const [kind, setKind] = useState<GoalKind>('books');
  const [subject, setSubject] = useState('');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);

  const year = data?.year;

  // The API owns the user-facing message (409 -> "That goal already exists for
  // this year."), so pass it straight through rather than inventing our own.
  function fail(e: unknown, fallback: string) {
    toast.error(e instanceof Error ? e.message : fallback);
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const n = Number(target);
    if (!Number.isInteger(n) || n <= 0) {
      toast.error('Target must be a positive whole number.');
      return;
    }
    setBusy(true);
    try {
      await api.createGoal({
        kind,
        target: n,
        ...(kind === 'genre' ? { subject: subject.trim() } : {}),
      });
      await mutate(GOALS_KEY);
      setSubject('');
      setTarget('');
      toast.success('Goal added.');
    } catch (err) {
      fail(err, 'Could not add that goal.');
    } finally {
      setBusy(false);
    }
  }

  async function handleTarget(goal: Goal, raw: string) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0 || n === goal.target) return;
    try {
      await api.updateGoal(goal.id, n);
      await mutate(GOALS_KEY);
    } catch (err) {
      fail(err, 'Could not update that goal.');
    }
  }

  async function handleDelete(goal: Goal) {
    try {
      await api.deleteGoal(goal.id);
      await mutate(GOALS_KEY);
      toast.success('Goal removed.');
    } catch (err) {
      fail(err, 'Could not remove that goal.');
    }
  }

  return (
    <Card>
      <h2 className="mb-4 font-display text-lg font-semibold text-text">Reading goals</h2>
      <p className="mb-4 text-sm text-muted">
        Goals track books you have marked read with a date in {year ?? 'this year'}.
      </p>

      {data && data.goals.length > 0 && (
        <ul className="mb-6 space-y-2">
          {data.goals.map((g) => (
            <li key={g.id} className="flex items-center gap-3">
              <span className="flex-1 truncate text-sm text-text">{goalLabel(g)}</span>
              <span className="font-mono text-xs text-faint">{g.progress} /</span>
              <Input
                type="number"
                min={1}
                defaultValue={g.target}
                aria-label={`Target for ${goalLabel(g)}`}
                className="w-20"
                onBlur={(e) => handleTarget(g, e.target.value)}
              />
              <Button variant="ghost" onClick={() => handleDelete(g)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={handleAdd} className="flex flex-wrap items-end gap-3">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as GoalKind)}
          aria-label="Goal type"
          className={SELECT_CLASS}
        >
          {KIND_OPTIONS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>

        {kind === 'genre' && (
          <>
            <Input
              list="goal-subject-suggestions"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="History"
              aria-label="Genre"
              className="w-44"
            />
            <datalist id="goal-subject-suggestions">
              {(data?.subjects ?? []).map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </>
        )}

        <Input
          type="number"
          min={1}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder="10"
          aria-label="Target"
          className="w-24"
        />

        <Button type="submit" loading={busy} disabled={busy}>
          Add goal
        </Button>
      </form>
    </Card>
  );
}
```

Check `Input`'s and `Button`'s real prop signatures in `components/ui/` before assuming
`className`, `variant="ghost"`, or `loading` exist — if one does not, match what that component
actually accepts rather than editing the design system.

Deletes are immediate with a toast. Do **not** wrap them in the `DangerAction` confirm treatment;
that is reserved for account-level destruction.

- [ ] **Step 2: Mount it in settings**

In `app/(main)/settings/page.tsx`, add `<ReadingGoalsSettings />` as a new section in the existing card stack — after the display-name card, before the import/export cards.

- [ ] **Step 3: Verify**

Run: `npm test && npm run type-check && npm run lint`
Expected: PASS.

- [ ] **Step 4: Report** which classes you copied for the `<select>` and from where.

---

## Task 11: Full gate and manual verification

**Dispatch:** Controller (Opus 5) only, and not delegable in any part. `npm run build` needs network for Google Fonts and Step 2 needs a browser. Do not accept a report of this task from any subagent.

**Files:** none — this task changes nothing.

- [ ] **Step 1: Run every gate, in order**

```bash
npm run test:server
npm test
npm run type-check
npm run lint
npm run format:check
npm run build
```

Expected: all PASS. `npm run build` is not optional — it is the only gate that catches Next segment-config and prerender failures, and this change adds three new route segments.

- [ ] **Step 2: Run the app and exercise the real flow**

Start the dev server and, in the browser:

1. Create one goal of each kind (`books`, `genre` with a suggested subject, `new_authors`, `pages`) in settings.
2. Confirm all four appear on the home card with plausible progress.
3. Mark a `to-read` book as `read` in the library; return home and confirm the books count, the author count, and the relevant goal bars all moved, and that the book's date now shows today in its edit modal.
4. Confirm the undated line appears if and only if undated read books exist.
5. Edit a goal's target in settings and confirm the home card's bar and `n/target` both move. **Task 10 ships with no automated test, so this is the only verification its `PATCH` path gets.**
6. Delete a goal and confirm it leaves both surfaces.
7. Look at a year with no dated reads (switch the year in the URL query if the UI has no picker) and confirm it collapses to one line rather than a wall of zeros.

Tests passing is not the bar; the flow working in the app is.

- [ ] **Step 3: Report**

Summarize: gates run and their results, what you exercised in the browser, anything that behaved differently from this plan, and the fact that nothing was committed.

---

## Notes for the reviewer

- **The riskiest task is 2**, not the routes. Every number the user sees comes out of `countForGoal` and `yearStats`; the routes are plumbing. Review the rules against spec §5 and §5.1 line by line.
- **Three hand-maintained lists** are easy to miss and fail loudly only later: the pglite `create table`, the `Seed`/`order`/`SEQ_TABLES` triple, and `deleteAccountRows`.
- **Task 10 is the only task with no automated test.** That is a deliberate accepted gap, not an
  oversight: a settings form whose real failure modes are visual and interactive gets little from an
  RTL test of its own markup. It is why Task 10 goes to a Claude subagent rather than Codex, and why
  Task 11 Step 2 now exercises edit-target explicitly. If the browser pass finds anything, add the
  test then, when you know what it should assert.
- **The `date_read` stamp (Task 7) is the one behavior change to an existing endpoint.** If anything about this feature gets cut, this is the piece that must not be, because everything else derives from it.
