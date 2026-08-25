# Reading goals — design

**Date:** 2026-08-24
**Status:** approved in chat, ready for implementation planning
**Branch:** `user-reading-goals` (already checked out, no commits ahead of `main`)

ShelfSprite knows what you have read and how you rated it, but it has no notion of what you are
_trying_ to read. User feedback asked for reading goals: "100 books this year, 10 nonfiction, 2 new
authors."

This spec adds a `reading_goals` table, a small typed goal vocabulary, a `GET/POST/PATCH/DELETE
/api/goals` surface whose progress is derived on read, a **"Your 2026" card** on the home page
carrying both year statistics and goal progress, and a management section on the settings page. It
also closes a gap that would otherwise make yearly goals unusable: marking a book read in
ShelfSprite never records _when_.

**Amended 2026-08-24, after the initial approval**, to add year statistics (books, pages, authors,
top genres, top authors) to the same card. The addition is close to free on the server: computing
goal progress already requires loading the year's read set joined to enrichment and counting
subjects, so the statistics come from a query that runs either way. The reason it is in this spec
rather than a later one is that the two share a module, a query, and a card; building them apart
would mean building the same loader twice.

During brainstorming the requester clarified that "nonfiction" was **shorthand for genre**, not a
request for a fiction/nonfiction classifier. There is no such classifier in this codebase and this
spec does not add one.

---

## 1. Preconditions (verified 2026-08-24 against source, not assumed)

| Precondition | Status | How it was verified |
|---|---|---|
| Marking a book `read` does not set `date_read` | ⚠️ confirmed gap | `app/api/books/[id]/shelf/route.ts:32` updates `exclusiveShelf` only |
| `date_read` is otherwise writable | ✅ | `app/api/books/[id]/feedback/route.ts:64` (`b.date_read`) and CSV import (`lib/server/import-csv.ts`) |
| `books.dateRead` is a nullable `date` column | ✅ | `lib/server/schema.ts:102` |
| `books.pageCount` is nullable | ✅ | `lib/server/schema.ts:104` — the `unknown` bucket in §5 exists because of this |
| `VALID_SHELVES` contains `'read'` | ✅ | `lib/server/books.ts:8` |
| `todayIsoDate()` already exists | ✅ | `lib/server/serialize.ts:110` — no new date helper needed |
| "Genre" already means a title-cased OpenLibrary subject | ✅ | `app/api/profile/highlights/route.ts:52-74` builds `top_genres` from `enrichment.subjects` via `pyTitle` |
| `subjectHits` is exported and does whole-word matching | ✅ | `lib/server/recFilters.ts:160` |
| `enrichment.subjects` is a nullable `json` array | ✅ | `lib/server/schema.ts` `enrichment` block; consumers cast `as string[] \| null` |
| `withApi` supplies auth, `ctx.user.userId`, error shape | ✅ | `lib/server/http.ts:34` |
| Zod is the route validation pattern | ✅ | `app/api/books/route.ts:2,16` |
| `ApiError` maps to a FastAPI-shaped `{detail}` | ✅ | `lib/server/errors.ts`, re-exported from `http.ts:12` |
| `deleteAccountRows` enumerates user tables by hand | ⚠️ must extend | `lib/server/purge.ts:56-88` — seven explicit deletes; nothing cascades |
| The pglite test helper hand-writes every `create table` | ⚠️ must extend | `lib/server/__tests__/helpers/pglite.ts` — 17 statements, last is `invite_requests` |
| Vitest owns `lib/server/**` and `app/api/**`, `*.test.ts` only | ✅ | `vitest.config.ts` `include` |
| Jest ignores exactly those two paths | ✅ | `jest.config.js:11` |
| Home page renders a `StatsStrip` inside a `Card` | ✅ | `app/(main)/page.tsx:21-45,183-196` |
| Settings is a vertical stack of `<Card>` sections | ✅ | `app/(main)/settings/page.tsx:259,290,340,409,467,478,507` |
| `components/ui` has no `Select`; raw `<select>` is the norm | ✅ | `components/ui/index.ts`; `components/ImportModal.tsx:157`, `components/admin/UsageTab.tsx:50` |
| SWR keys are exported constants from `lib/api.ts` | ✅ | `PROFILE_STATUS_KEY`, `ARCHETYPE_KEY`, imported by `app/(main)/page.tsx:12-13` |
| New tables are hand-authored then generated | ✅ | `invite_requests` precedent: `drizzle/0004_robust_tony_stark.sql` |
| Migrations are manual, never part of `npm run build` | ✅ | `docs/hosting.md:174-192` (`npm run db:migrate`) |

---

## 2. Scope

**In scope**

1. `reading_goals` table + generated migration.
2. Four goal kinds: `books`, `genre`, `new_authors`, `pages`. Calendar-year periods.
3. `GET/POST/PATCH/DELETE /api/goals`, progress derived on read.
4. Year statistics on the same GET: books, pages, distinct authors, new authors, top genres, top
   authors, and the undated-reads count (§5.1).
5. `date_read` stamping when a book moves to the `read` shelf.
6. Home-page "Your 2026" card (statistics + goals); settings-page management section.
7. Purge and pglite-helper updates.

**Explicitly out of scope** (decided in brainstorming, not oversights)

- **Recommender coupling.** Goals do not bias retrieval and are not injected into any Claude
  prompt. "More nonfiction this year" already has a home in the directive / custom instructions
  (`components/CustomInstructions.tsx:75`). Wiring goals into `recSignal`/`recFilters`/`recPrompts`
  is a clean follow-up once the goal data exists; doing it now risks a goal fighting the taste
  profile it is meant to serve.
- **A fiction/nonfiction classifier.** See the header note.
- **Non-calendar-year periods** (monthly, rolling, custom ranges).
- **End-of-year snapshots / "year in review" history.** Nothing to snapshot until December.
- **Per-goal book lists**, pace-vs-target projections, streaks, a `/goals` or `/year` page.
- **A materialized `progress` column.** See §3.
- **A library filter for undated read books.** The card names the backlog (§5.1); it does not link
  to a filtered view. That filter is a reasonable follow-up and would need new query support on
  the library page.
- **A bulk date backfill.** Considered and rejected: stamping a chosen date across undated read
  books writes fabricated dates permanently into the library, and every count downstream would
  then rest on invented data.
- **Year-over-year comparison.** No 2025 baseline exists for most books for the same
  `date_read` reason.

---

## 3. Architecture: progress is derived, never stored

A goal row stores only its _definition_. `GET /api/goals` runs one `books` ⟕ `enrichment` query
scoped to the caller and counts in memory.

The rejected alternative was a `progress` column maintained on write. It would have to be updated
from the shelf route, the feedback route, book import, book deletion, and late-arriving enrichment
(which can change a genre count long after the book was read). Every missed path is silent,
permanent drift. Deriving costs one query per home-page load on a library of a few thousand rows —
the same shape `/api/stats` already runs on every home-page load today.

This also matches the rule CLAUDE.md states for enrichment jobs: progress is derived by recounting
persisted rows, never by accumulating a counter.

---

## 4. Data model

New table in `lib/server/schema.ts`:

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
    check(
      'ck_reading_goals_kind',
      sql`${table.kind} in ('books', 'genre', 'new_authors', 'pages')`
    ),
    check(
      'ck_reading_goals_subject',
      sql`(${table.kind} = 'genre') = (${table.subject} is not null)`
    ),
  ]
);
```

Notes that must survive into the implementation:

- **`user_id` is the tenancy boundary**, matching every other user-owned table. It is not the
  `invite_requests` exception. `default('local')` matches the existing convention for local mode.
- **`unique(user_id, year, kind, subject)` is the duplicate guard.** Postgres treats NULLs as
  distinct in a unique constraint, so this does **not** prevent two `books` goals for the same
  year — `subject` is NULL for all non-genre kinds. The route therefore performs an explicit
  pre-insert existence check for non-genre kinds and returns 409; the constraint is the backstop
  for genre goals and for concurrent inserts. Do not assume the constraint alone is sufficient.
  (Postgres 15+ `UNIQUE NULLS NOT DISTINCT` would close this at the database level, but it depends
  on both the server vintage and drizzle's support for the modifier; the explicit check works
  regardless and is the one to implement.)
- **`kind` is a plain varchar with a CHECK, not a Postgres enum**, matching `invites.status`,
  `feedback.status`, and `books.exclusive_shelf`.
- **`subject` stores the term as the user picked it** from the suggestion list (title-cased, the
  same shape `top_genres` emits). Matching is case-insensitive at count time, so casing is
  cosmetic — but store it consistently so the UI label reads well.
- **No foreign key to `books`.** Goals are independent of any particular book; deleting a book
  simply changes a count.

### 4.1 The `schema.ts` header says not to hand-edit. Read this before touching it.

`lib/server/schema.ts` opens with a comment saying it is `drizzle-kit pull` output and that column
shapes must never be hand-edited, offering re-pulling and diffing as the alternative. Taken
literally that blocks this task, and an implementer who follows it will run `drizzle-kit pull` and
overwrite the file against whatever state the dev database happens to be in.

Do not do that. The header guards the shape of tables introspected from a database another system
owned, so the checked-in file cannot silently drift from real column types. Adding a brand new
table that ShelfSprite itself owns is a different operation: there is nothing to drift from,
because the table does not exist anywhere yet. This is the same reasoning recorded for
`invite_requests` in the 2026-08-23 splash-page spec.

So: hand-add `readingGoals` to `schema.ts`, leave every existing table untouched, never run
`drizzle-kit pull` as part of this change. Then `npx drizzle-kit generate`, read the emitted SQL,
and apply with `npm run db:migrate` per `docs/hosting.md:174`.

### 4.2 Two hand-maintained lists must be extended

Both are enumerated by hand and neither cascades. Missing either is a real bug, not a lint nit.

1. **`lib/server/purge.ts`** — add a `readingGoals` delete to `deleteAccountRows` and a
   `goals_removed` count to `AccountPurgeResult`. Without it, a revoked account leaves goal rows
   behind. It belongs in `deleteAccountRows`, **not** `deleteProfileRows`: rebuilding a taste
   profile must not wipe someone's goals.
2. **`lib/server/__tests__/helpers/pglite.ts`** — add a `create table reading_goals` statement, or
   every route test touching goals fails on a missing relation.

---

## 5. Counting rules

A book counts toward year _Y_ when **`exclusive_shelf = 'read'` AND `date_read` falls within
calendar year _Y_**. Call that set the year's read set. Both conditions are required: `date_read`
alone would count a book that was re-shelved to `to-read`, and shelf alone has no clock.

| kind | count |
|---|---|
| `books` | size of the read set |
| `genre` | read-set books where any entry of `enrichment.subjects` matches `subject` |
| `new_authors` | distinct authors in the read set with no read book dated earlier than the year |
| `pages` | sum of `page_count` over the read set |

Details that are load-bearing:

- **`genre` matching reuses `subjectHits` from `lib/server/recFilters.ts:160`**, lowercasing both
  operands first, exactly as `applyDirectiveFilters` does. Whole-word semantics mean the goal
  "History" also counts a book subjected "Art history" — that is the intended behavior and matches
  what the profile page already calls a genre. Do not introduce a second matching rule.
- A read-set book with **no enrichment row, or a NULL/empty `subjects` array**, never counts toward
  a genre goal. It is not an error and is not reported; the enrichment backlog is surfaced
  elsewhere.
- **`new_authors` uses `books.author` only** — the primary author, exact string, NULL author
  skipped. `additional_authors` is not consulted. "Earlier" is judged against every `read`-shelf
  book of that user with a non-NULL `date_read` strictly before Jan 1 of the goal year, whatever
  its rating. An author first read in a prior year does not become new again.
- **`pages` excludes books with a NULL `page_count`** and returns that quantity separately as
  `unknown`, so the card can say "3 books have no page count" instead of showing a bar that is
  quietly short.
- Every other kind returns `unknown: 0`.
- Progress is **not** clamped to the target. 112/100 is a true and pleasant thing to see; the
  UI clamps the _bar width_, not the number.

### 5.1 Year statistics

Computed from the same read set, in the same pass, and returned whether or not the user has any
goals — a reader who never sets a goal still gets a year card:

| field | definition |
|---|---|
| `books` | size of the year's read set |
| `pages` / `unknown_pages` | sum of `page_count`, and the count of read-set books lacking one |
| `authors` | distinct non-NULL `books.author` in the read set |
| `new_authors` | as the `new_authors` goal kind: no read book by that author dated before the year |
| `top_genres` | top 5 `{subject, count}`, subject counts over the read set |
| `top_authors` | top 5 `{author, count}`, books-in-year per author |
| `undated` | read-shelf books of this user with a NULL `date_read`, **any year** |

- `top_genres` counts each subject **once per book** and considers only each book's first 8
  subjects, matching how `top_genres` is already built in
  `app/api/profile/highlights/route.ts:56-68`. Subjects are normalized with `pyTitle` so the
  spelling matches the goal-creation suggestion list.
- Ties are broken by first-seen order via a stable sort, again matching the highlights route.
- **`undated` is deliberately not year-scoped** — an undated book has no year to be scoped to.
  It is the size of the backlog that this card cannot see, and it is what §9.1's limit line
  reports.
- All of these are plain counts over rows already in memory. No additional query.

---

## 6. Server module: `lib/server/goals.ts`

The counting rules live in pure functions that take rows, not a `Db`, so Vitest can exercise every
rule without a database:

```ts
export const GOAL_KINDS = ['books', 'genre', 'new_authors', 'pages'] as const;
export type GoalKind = (typeof GOAL_KINDS)[number];

/** Every read-shelf book of one user, with its enrichment row, ordered by id. */
export interface GoalRow { book: BookRow; enrichment: EnrichmentRow | null }

export function countForGoal(rows: GoalRow[], goal: GoalDef): { progress: number; unknown: number };
export function goalOut(goal: GoalRecord, count: { progress: number; unknown: number }): GoalOut;
export function topSubjects(rows: GoalRow[], limit: number): string[];
export function yearStats(rows: GoalRow[], year: number): YearStats;

/** The one db-touching export: every read-shelf book of one user + its enrichment row. */
export function loadReadRows(db: Db, userId: string): Promise<GoalRow[]>;
```

`subjectCounts(rows)` is an internal helper returning a `Map<string, number>`; both `topSubjects`
(names only, over every read book, for goal-creation suggestions) and `yearStats.top_genres`
(names with counts, over the year's read set) are thin wrappers around it. One normalization rule,
one place.

`countForGoal` receives the caller's full read-shelf row set — not just the year's — because
`new_authors` needs prior-year history to decide what "new" means.

`topSubjects` reuses the `pyTitle` normalization from the highlights route so the suggestions the
user picks from are spelled the same way `top_genres` spells them.

Wire shape (snake_case, matching `bookOut`):

```json
{
  "id": 7, "year": 2026, "kind": "genre", "subject": "History",
  "target": 10, "progress": 4, "unknown": 0, "done": false
}
```

---

## 7. API

All four routes are `withApi`-wrapped, so auth, `ctx.user.userId`, logging, and the `{detail}`
error shape come for free. Every query filters on `ctx.user.userId`.

### `GET /api/goals?year=<int>`

`year` is optional and defaults to the current calendar year (`todayIsoDate().slice(0, 4)`, so the
server clock decides — there is no per-user timezone in this app and inventing one is out of
scope). Zod-coerced; a non-numeric year is a 422.

Runs two queries: the user's goals for that year, and the user's `read`-shelf books left-joined to
`enrichment`. Returns:

```json
{
  "year": 2026,
  "stats": {
    "books": 42, "pages": 11204, "unknown_pages": 3,
    "authors": 28, "new_authors": 9, "undated": 12,
    "top_genres": [{ "subject": "Fiction", "count": 18 }],
    "top_authors": [{ "author": "Ursula K. Le Guin", "count": 3 }]
  },
  "goals": [ ... ],
  "subjects": ["Fiction", "History", "..."]
}
```

`stats` is always present, never null, and is fully populated even when `goals` is empty — the year
card is not a goals feature that happens to show numbers.

`subjects` is the ~30 most common subjects across the user's own read books, computed from the
query already run — no second round trip, no new endpoint. A free-text genre field is a trap: type
"sci-fi", get a counter frozen at 0, with nothing on screen explaining why. Suggestions drawn from
the user's real library make an unmatchable term the exception rather than the default.

Goals are returned ordered by `kind` then `subject` then `id`, so the card's row order is stable
across reloads.

### `POST /api/goals`

Zod body: `{ year?: int, kind: enum, subject?: string, target: int }`. `year` defaults as above.

- unknown `kind` → 422 naming the valid kinds via `pyList(GOAL_KINDS)`, matching the
  `VALID_SHELVES` 422 style in `app/api/books/[id]/shelf/route.ts:12`
- `target <= 0` → 422
- `kind='genre'` with a blank/missing `subject` → 422
- non-genre kind with a `subject` → 422 (reject rather than silently dropping it)
- duplicate → 409, via the explicit pre-check in §4 plus a caught unique violation
- year outside a sane range (say 1900–2200) → 422

Returns the created goal with progress already computed, so the card can render without refetching.

### `PATCH /api/goals/[id]`

Body `{ target: int }`. Target only — changing a genre term is a delete-and-recreate, which keeps
the unique constraint honest and avoids partial-edit machinery for a four-field row.

### `DELETE /api/goals/[id]`

Deletes and returns the standard no-content shape used elsewhere in the codebase.

### Tenancy

`PATCH` and `DELETE` scope by `and(eq(id), eq(userId))` and return **404, not 403**, when the row
belongs to someone else. 403 would confirm the id exists. This mirrors the book routes.

---

## 8. The `date_read` gap

`PATCH /api/books/[id]/shelf` sets `dateRead: todayIsoDate()` when — and only when — the book is
moving to `read` and `book.dateRead` is currently NULL.

- It never overwrites an existing date, so Goodreads import dates survive untouched.
- Moving a book to any other shelf leaves `date_read` alone. Un-shelving and re-shelving a book
  keeps its original date; the read set is defined by shelf **and** date, so a book moved off
  `read` stops counting anyway.
- The route's existing rating/review guard runs first and is unchanged.

Known and accepted: books already marked `read` in-app before this ships have no date and will not
count until edited in the book modal. A backfill prompt was considered and deferred — it is a
follow-up, not a blocker.

`bookSummary` already emits `date_read` (`lib/server/books.ts:46`), so the response shape does not
change — but the route currently returns `bookSummary({ ...book, exclusiveShelf: shelf })` from the
pre-update row. The stamped date must be spread into that object too, or the response reports a
stale NULL date for the write it just performed.

---

## 9. UI

### 9.1 Home — `components/YearCard.tsx`

Renders under `StatsStrip` in `app/(main)/page.tsx`, inside a `Card`, following the existing
`StatsStripSkeleton` pattern while loading and the same SWR + `lib/api.ts` client pattern as
`stats`. New exported key `GOALS_KEY` in `lib/api.ts`. The all-time strip above it is **unchanged**;
this card is explicitly year-scoped and titled so ("Your 2026"), which is what keeps the two from
reading as duplicate stats blocks.

Three stacked regions inside one card:

1. **Numbers** — books, pages, and authors (with new-author count), in the same
   `font-mono` figure-over-label treatment `StatsStrip` uses, so the two cards feel like one system.
2. **Top genres** (bars, up to 5) and **top authors** (inline list). Genre bars are scaled to the
   top genre's count, not to the year's book total — a reader whose top genre is 18 of 42 books
   should see a full bar, not a 43% one.
3. **Goals** — per goal: label, progress bar, `62 / 100`, and a done state when
   `progress >= target`. Bar width is clamped to 100%; the number is not. A `pages` goal with
   `unknown > 0` prints a quiet line under the bar — "3 books have no page count" — rather than
   letting the bar under-report in silence.

When `stats.undated > 0` the card prints one quiet limit line — "12 read books have no date and
aren't counted." — so an under-reporting number explains itself instead of looking broken. It is
plain `text-faint` copy, not a warning, and it disappears on its own as dates get filled in. It
does not link anywhere (§2).

A year with no dated reads at all (`stats.books === 0`) collapses to a single line rather than
rendering a row of zeros and three empty bars: "Nothing dated in 2026 yet." — plus the limit line
above if there is a backlog, which is precisely the case where a wall of zeros would be most
misleading.

All bars — genre and goal alike — use the existing `bg-accent` on `bg-elevated` treatment from
`RatingsBreakdown` (`app/(main)/page.tsx:96-101`), and inherit the `--user-accent` taste-accent
variables the page already sets, so the card belongs to the same visual system as the hero.

The goals region's empty state is **one quiet line** — "No goals for 2026. Set one in settings →" —
not a promotional empty state. A user who does not want goals should barely notice that part of the
card exists; the statistics above it stand on their own.

An error fetching goals renders the same inline `text-danger` line the stats block uses. It never
blocks the page.

### 9.2 Settings — reading goals section

A new `<Card>` in the existing stack in `app/(main)/settings/page.tsx`:

- the current year's goals, each with a target input (`PATCH` on save) and a delete button
- an add form: kind `<select>` → target `<Input>` → a genre `<Input>` that appears only when kind
  is `genre`, backed by a `<datalist>` of the `subjects` array from `GET /api/goals`

Uses `Card`, `Field`, `Input`, `Button`, `useToast` from `components/ui` — all already imported on
that page. `components/ui` has no `Select`; a raw styled `<select>` matches
`components/ImportModal.tsx:157` and `components/admin/UsageTab.tsx:50`.

Deletes are immediate with a toast, consistent with the page's other list actions; this is not a
destructive-enough action to earn the `DangerAction` confirm treatment used for account removal.

---

## 10. Testing

Two runners with disjoint ownership. Both are required for a complete pass, along with
`type-check`, `lint`, `format:check`, and `build`.

**Vitest** — `lib/server/__tests__/goals.test.ts` (pure rules) and `app/api/goals/route.test.ts`
(routes, on pglite):

- year boundary: `2026-01-01` and `2026-12-31` count; `2025-12-31` and `2027-01-01` do not
- a book with `date_read` in range but shelf `to-read` does not count
- a book on the `read` shelf with NULL `date_read` does not count
- genre: `subjectHits` whole-word match; case-insensitive; "History" counts an "Art history" book;
  a book with no enrichment row and one with an empty `subjects` array both do not count
- `new_authors`: an author first read in a prior year does not count; two books by the same new
  author in-year count once; NULL author skipped
- `pages`: NULL `page_count` lands in `unknown`, not in the sum
- progress exceeding target reports the true number and `done: true`
- tenancy: another user's books never counted; another user's goal id → 404 on PATCH and DELETE
- validation: bad kind, `target <= 0`, genre without subject, non-genre with subject, bad year
- duplicate create → 409, for both a genre goal and a `books` goal (the NULL-subject case §4 warns
  about)
- `GET` with no `year` uses the current year
- `yearStats`: books/pages/authors over the year only; `unknown_pages` counts NULL page counts;
  `new_authors` agrees with the goal kind of the same name on identical input; `top_genres` counts
  a subject once per book, caps at each book's first 8 subjects, and is capped at 5 entries;
  `top_authors` capped at 5; `undated` counts read-shelf NULL-date books from **every** year and is
  unaffected by the requested year
- `stats` is fully populated when the user has zero goals
- shelf route: stamps today on a `read` transition; does **not** overwrite an existing
  `date_read`; does not stamp on a move to `to-read`

**Jest** — `components/__tests__/YearCard.test.tsx`: renders the numbers, genre bars, goal bars and
counts, the done state, the `unknown` pages line, the `undated` limit line (and its absence when
`undated` is 0), the no-dated-reads collapse, and the no-goals line. (Vitest's `include` is
`*.test.ts` only, so a `.tsx` component test is Jest's by construction.)

**Manual verification before this is called done:** run the app, create each of the four goal
kinds, mark a book read and watch the year numbers, the goal count, and the stamped `date_read` all
change, delete a goal, and confirm the card reads sensibly for a year with no dated reads. Tests
passing is not the bar.

---

## 11. Implementation order

1. `schema.ts` table + `drizzle-kit generate`, read the SQL, apply with `npm run db:migrate`
2. `lib/server/__tests__/helpers/pglite.ts` — `create table reading_goals`
3. `lib/server/goals.ts` + its unit tests (goal counting and `yearStats` — this is where the
   thinking is)
4. `app/api/goals/**` routes + route tests
5. `lib/server/purge.ts` — `goals_removed`, and its purge test
6. `app/api/books/[id]/shelf/route.ts` — `date_read` stamping + tests
7. `lib/api.ts` — client methods, `Goal` type, `GOALS_KEY`
8. `components/YearCard.tsx` + Jest test; mount on the home page
9. Settings management section
10. Full gate + browser walkthrough
