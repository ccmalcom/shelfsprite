# ScreenSprite wave 4: schema, opt-in and Letterboxd import — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land every screen table and column in one migration, the screen opt-in flag, the
Letterboxd ZIP import, the title list/get/edit/delete routes, "Delete screen library", and the
purge and JSON-export changes, so a user can import a Letterboxd export and manage the resulting
titles over the API.

**Architecture:** One drizzle migration adds `titles`, `title_enrichment`,
`title_recommendations`, the `user_settings` screen flag, `enrich_jobs.kind` (with the one-active
index widened to `(user_id, kind)`), and the typed-evidence columns that waves 5–7 fill. Import is
two pure layers and one writer: `letterboxd.ts` turns ZIP bytes into `LetterboxdFilm[]` (bounded
unzip, allowlisted entries, CSV joins), and `importTitles.ts` upserts them under an explicit
Letterboxd-owned field allowlist in one transaction that also turns screen on. Routes follow the
existing `withApi` idioms and the book feedback route's rating/review rules. Nothing here calls a
catalog, Claude, or the enrichment job runner; wave 5 adds those.

**Tech Stack:** TypeScript, Next.js App Router route handlers, drizzle-orm + drizzle-kit,
PGlite (server tests), Vitest, `csv-parse/sync` (existing), `fflate` (new).

**Spec:** `docs/superpowers/specs/2026-09-22-screen-media-design.md` — §3 (all), §7.6, §9, §10 are
this wave's requirements. **Index / cross-wave contract:**
`docs/superpowers/plans/2026-09-22-screen-media-00-index.md` — its "Database", "Server modules"
(wave 4 rows), "HTTP routes" (wave 4 rows) and `TitleOut` are fixed; this plan implements them
exactly. If the repo disagrees with either document, stop and report.

**Issue:** #96. **Branch:** `feat/screen-media`.

**Precondition:** wave 2 has landed. Before Task 1, confirm:

```bash
grep -n "export async function setRebuildReason\|export type RebuildReason" lib/server/profileMeta.ts
grep -n "rebuildReason" lib/server/schema.ts lib/server/__tests__/helpers/pglite.ts
ls drizzle/*.sql
```

Expected: both `profileMeta.ts` exports exist, `rebuild_reason` is in the schema **and** the PGlite
mirror, and wave 2's migration is the newest `drizzle/*.sql`. If any is missing, stop: this wave
calls `setRebuildReason(tx, userId, reason)` in five places.

---

## Global Constraints

Every task's requirements implicitly include this section. The first block is the index's
global list, verbatim in substance.

- **Two test runners with disjoint ownership.** `npm run test:server` (Vitest) owns exactly
  `lib/server/**` and `app/api/**`; `npm test` (Jest) owns everything else. Before naming a single
  test file as a gate, confirm the runner sees it: `npx vitest list <path>`. A gate that matches
  zero tests exits 0.
- **Full gate at the end of the wave**, from the repository root: `npm run test:server`,
  `npm test`, `npm run type-check`, `npm run lint`, `npm run format:check`, `npm run build`.
- **Real-flow verification before the wave is called done** (Task 9). Tests alone never close it.
  Isolated local run only: a scratch Postgres in Docker plus a local-mode dev server
  (`ALLOW_LOCAL_AUTH=true`) with **no `.env` file in scope**, following the procedure in the
  project memory note `marketing-screenshot-pipeline`. Never point it at production. Record what
  you actually observe, not what this plan predicts.
- **Secrets.** Never open, print, or name the contents of `.env*` files; check presence only
  (`test -e`).
- **Ratings.** `numeric(2,1)` with drizzle `mode: 'number'` on every rating column. `0` on an API
  mutation means "clear". The manual `isValidRating` guard owns the 422 message; the Zod schema
  stays a permissive `z.number()`.
- **Wire format.** API JSON is snake_case.
- **Tenancy.** Every query on a user-owned table filters by `user_id`. Every route test includes a
  second user whose ids are rejected with 404.
- **Schema changes.** Edit `lib/server/schema.ts`, run `npm run db:generate`, read the generated
  SQL, and mirror every change in `lib/server/__tests__/helpers/pglite.ts` (hand-written SQL) and
  `loadSeed`'s key/JSON/timestamp/sequence lists. `books` is never dropped or recreated. Applying
  the migration to production is Chase's step (Task 9 hands him the command).
- **Copy.** User-facing messages say **ScreenSprite**; code, routes, tables and keys say `screen`.
- **Git.** Commit steps run only when Chase has authorized commits for this execution session;
  otherwise stage the listed paths and leave them. Plain messages, no `Co-Authored-By` trailer; end
  each with the session's `Claude-Session:` line. Subject form: `feat(screen): <subject> (#96)`.
- **Next.js here is not the Next.js you know.** Before writing a route file, read
  `node_modules/next/dist/docs/` for route handlers.

Wave-specific:

- **Letterboxd facts (spec §2.1 finding 1) are requirements, not hints.** `watched.csv`,
  `ratings.csv`, `watchlist.csv` and the profile's favorites join on `Letterboxd URI`.
  `diary.csv` and `reviews.csv` URIs point at the **entry**, not the film: those rows join to their
  film by **exact** `(Name, Year)` and never by URI. Only the `Favorite Films` column of
  `profile.csv` is read; the parser is configured so the other (PII) columns never become values.
  `likes/`, `lists/`, `comments.csv`, `deleted/`, `orphaned/` are never read.
- **Fixtures are synthetic.** Never copy rows from Chase's real export into a fixture, test, or
  this repository.
- **Book behavior is unchanged.** Existing purge route responses keep their exact key sets
  (they are pinned as Python-parity counts); the book-only JSON export stays byte-identical.
- **Screen counts are reported only by `DELETE /api/screen/library`.** Book purge routes delete
  the screen rows the spec §7.6 table says they delete, but do not add response keys.

---

## Review Focus

The five inputs a real user will hit that no happy-path test exercises, each pinned by a test in
the task that owns the code:

1. **Re-importing a newer export after editing titles in-app.** Expected: `app_*` untouched,
   `dropped`/`watching` never demoted to `watched`, a favorite never cleared, a rating absent from
   the new export never erased, rows missing from it never deleted. → Task 4, test
   `re-import honours the Letterboxd ownership allowlist`.
2. **A ZIP that is not laid out as Letterboxd sends it** — the user unzipped and re-zipped the
   folder, or uploaded some other ZIP, or only `deleted/diary.csv` matches a name. Expected: a
   clear 422 naming the problem, never a silent zero-film import, and `deleted/`/`orphaned/`
   entries never read. → Task 3, tests `rejects a re-zipped folder with a specific message` and
   `never reads deleted/ or orphaned/ entries`.
3. **Titles whose normalized form is empty or non-Latin** meeting a manually added title with the
   same year. Expected: `夜の図書館` matches its manual twin; `!!!` never matches `???`; two
   manual candidates mean insert, not a guess. → Task 4, test
   `title+year fallback matches only a single non-empty candidate`.
4. **Clearing a rating (0) on a title whose review is in-app only**, and clearing an app review
   that hides a Letterboxd one. Expected: the first is a 422 unless the title is `dropped`; the
   second reveals the Letterboxd review. → Task 6, tests
   `PATCH enforces review-requires-rating after applying the change` and
   `PATCH review "" clears app_review and reveals the Letterboxd review`.
5. **A user who never enabled screen** exporting a JSON backup or resetting the book library.
   Expected: the JSON backup is byte-identical to today's (no `screen` key); a book-library reset
   deletes screen recommendations but never titles. → Task 8 test
   `book-only export has no screen key`, Task 7 test `book library reset keeps titles`.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `package.json`, `package-lock.json` | Modify | add `fflate` |
| `lib/server/schema.ts` | Modify | new tables and columns (contract "Database") |
| `drizzle/00NN_<generated>.sql`, `drizzle/meta/*` | Create (generated) | the one screen migration |
| `lib/server/__tests__/helpers/pglite.ts` | Modify | mirror the migration; `loadSeed` lists |
| `lib/server/__tests__/screen-schema.test.ts` | Create | constraint and index behavior of the mirror |
| `lib/server/titles.ts` | Create | title row types, effective rating/review, evidence rule, `titleOut`, `normalizeTitleKey` |
| `lib/server/screenSettings.ts` | Create | opt-in flag read/require/flip |
| `lib/server/__tests__/titles.test.ts` | Create | pure helper tests |
| `lib/server/__tests__/screen-settings.test.ts` | Create | flag tests |
| `lib/server/letterboxd.ts` | Create | bounded unzip + CSV parsing + joins → `LetterboxdFilm[]` |
| `lib/server/import-upload.ts` | Modify | add `readZipUpload` |
| `lib/server/__tests__/fixtures/letterboxd.ts` | Create | synthetic export + ZIP builders |
| `lib/server/__tests__/letterboxd.test.ts` | Create | reader tests |
| `lib/server/importTitles.ts` | Create | ownership-allowlisted upsert + enable |
| `lib/server/__tests__/import-titles.test.ts` | Create | ownership tests |
| `lib/server/ratelimit.ts` | Modify | `screenImport` entry |
| `app/api/screen/import/route.ts` | Create | `POST /api/screen/import` |
| `app/api/settings/screen/route.ts` | Create | `GET`/`PUT /api/settings/screen` |
| `lib/server/__tests__/screen-import-routes.test.ts` | Create | import + settings route tests |
| `app/api/screen/titles/route.ts` | Create | `GET /api/screen/titles` (wave 5 adds `POST`) |
| `app/api/screen/titles/[id]/route.ts` | Create | `GET`/`PATCH`/`DELETE` |
| `lib/server/__tests__/screen-title-routes.test.ts` | Create | title route tests |
| `lib/server/screenPurge.ts` | Create | screen row deletion primitives |
| `lib/server/purge.ts` | Modify | call them from profile and account purges |
| `app/api/screen/library/route.ts` | Create | `DELETE /api/screen/library` |
| `lib/server/__tests__/screen-purge.test.ts` | Create | purge scope per spec §7.6 |
| `lib/server/export.ts` | Modify | versioned `screen` section in the JSON export |
| `lib/server/__tests__/screen-export.test.ts` | Create | export tests |
| `docs/architecture.md`, `docs/conventions.md` | Modify | module map and invariants |

---

## Handoff batching

A controller's cost is context size times turns. Stop and hand off at each batch boundary; keep the
`.superpowers/sdd/` ledger current after every task.

- **Batch A:** Task 1, Task 2, Task 3 → hand off
- **Batch B:** Task 4, Task 5, Task 6 → hand off
- **Batch C:** Task 7, Task 8, Task 9

---

### Task 1: Dependency, schema, migration and test-database mirror

**Files:**
- Modify: `package.json`, `package-lock.json`
- Modify: `lib/server/schema.ts`
- Create (generated): `drizzle/00NN_<name>.sql`, `drizzle/meta/00NN_snapshot.json`, `drizzle/meta/_journal.json`
- Modify: `lib/server/__tests__/helpers/pglite.ts`
- Modify: `lib/server/enrichmentJobs.ts` (hydrate the new `kind` column)
- Test: `lib/server/__tests__/screen-schema.test.ts`

**Interfaces:**
- Consumes: wave 2's `profileMeta.rebuildReason` (already in schema and mirror).
- Produces (contract "Database", exact drizzle names): `schema.titles`, `schema.titleEnrichment`,
  `schema.titleRecommendations`; `userSettings.screenEnabled`, `userSettings.screenToggledAt`;
  `enrichJobs.kind` + index `uq_enrich_jobs_active_user_kind`; `tasteTraits.exhibitTitleIds`,
  `tasteTraits.contrastTitleIds`; `tasteSignal.targetTitleId`. `Seed` gains `titles`,
  `title_enrichment`, `title_recommendations`.

- [ ] **Step 1: Add fflate (controller step — needs network; a sandboxed executor cannot do it)**

```bash
npm install fflate@^0.8.3
node -e "const f=require('fflate'); console.log(typeof f.unzipSync, typeof f.Unzip, typeof f.UnzipInflate, typeof f.zipSync, typeof f.strToU8)"
grep -n "interface UnzipFileInfo\|interface UnzipFile \|originalSize\|terminate: \|declare class Unzip \|declare function unzipSync" node_modules/fflate/lib/index.d.ts
```

Expected: `function function function function function`, and the typings show
`UnzipFileInfo { name; size; originalSize; compression }`, an `UnzipFile` with `ondata`, `start`,
`terminate`, and `unzipSync(data, opts?: UnzipOptions)` whose options carry `filter`. Task 3's code
is written against exactly these names; if one differs, adapt Task 3 to the installed typings and
note the difference in the ledger.

- [ ] **Step 2: Write the failing schema test**

Create `lib/server/__tests__/screen-schema.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { schema, type Db } from '../db';
import { makeTestDb } from './helpers/pglite';

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await makeTestDb());
});
afterEach(async () => {
  await close();
});

function errorText(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    parts.push(current.message);
    current = current.cause;
  }
  return parts.join(' | ');
}

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return errorText(error);
  }
  return 'accepted';
}

const base = {
  userId: 'local',
  mediaType: 'movie',
  title: 'The Lantern Keeper',
  status: 'watched',
} as const;

describe('titles', () => {
  test('ratings are numbers on the half grid and 0 is rejected', async () => {
    await db.insert(schema.titles).values({ ...base, letterboxdRating: 4.5, appRating: 0.5 });
    const [row] = await db.select().from(schema.titles);
    expect(row.letterboxdRating).toBe(4.5);
    expect(typeof row.letterboxdRating).toBe('number');
    expect(row.appRating).toBe(0.5);
    expect(await failure(db.insert(schema.titles).values({ ...base, letterboxdRating: 0 }))).toContain(
      'ck_titles_letterboxd_rating_half_step'
    );
    expect(await failure(db.insert(schema.titles).values({ ...base, appRating: 0 }))).toContain(
      'ck_titles_app_rating_half_step'
    );
    expect(await failure(db.insert(schema.titles).values({ ...base, appRating: 4.3 }))).toContain(
      'ck_titles_app_rating_half_step'
    );
    expect(await failure(db.insert(schema.titles).values({ ...base, appRating: 5.5 }))).toContain(
      'ck_titles_app_rating_half_step'
    );
  });

  test('media type and status are closed vocabularies', async () => {
    expect(await failure(db.insert(schema.titles).values({ ...base, mediaType: 'book' }))).toContain(
      'ck_titles_media_type'
    );
    expect(await failure(db.insert(schema.titles).values({ ...base, status: 'read' }))).toContain(
      'ck_titles_status'
    );
    for (const status of ['watched', 'watching', 'dropped', 'want']) {
      await db.insert(schema.titles).values({ ...base, status });
    }
    await db.insert(schema.titles).values({ ...base, mediaType: 'tv' });
  });

  test('identity columns are unique per user only when present', async () => {
    await db.insert(schema.titles).values([base, base]);
    await db.insert(schema.titles).values({ ...base, wikidataQid: 'Q1', tvmazeId: 7, letterboxdUri: 'https://boxd.it/a' });
    await db.insert(schema.titles).values({
      ...base,
      userId: 'other',
      wikidataQid: 'Q1',
      tvmazeId: 7,
      letterboxdUri: 'https://boxd.it/a',
    });
    expect(await failure(db.insert(schema.titles).values({ ...base, wikidataQid: 'Q1' }))).toContain(
      'uq_titles_user_wikidata_qid'
    );
    expect(await failure(db.insert(schema.titles).values({ ...base, tvmazeId: 7 }))).toContain(
      'uq_titles_user_tvmaze_id'
    );
    expect(
      await failure(db.insert(schema.titles).values({ ...base, letterboxdUri: 'https://boxd.it/a' }))
    ).toContain('uq_titles_user_letterboxd_uri');
  });

  test('booleans default false and created_at is stamped', async () => {
    const [row] = await db.insert(schema.titles).values(base).returning();
    expect(row.isFavorite).toBe(false);
    expect(row.excludeFromProfile).toBe(false);
    expect(row.createdAt).toEqual(expect.any(String));
    expect(row.updatedAt).toBeNull();
  });
});

describe('title_enrichment', () => {
  test('requires an existing title, one row per title, identity_source defaults to auto', async () => {
    expect(
      await failure(db.insert(schema.titleEnrichment).values({ titleId: 999, resolutionConfidence: 0 }))
    ).toContain('title_enrichment_title_id_fkey');
    const [title] = await db.insert(schema.titles).values(base).returning();
    const [enr] = await db
      .insert(schema.titleEnrichment)
      .values({ titleId: title.id, resolutionConfidence: 0.95, genres: ['drama film'] })
      .returning();
    expect(enr.identitySource).toBe('auto');
    expect(enr.genres).toEqual(['drama film']);
    expect(
      await failure(db.insert(schema.titleEnrichment).values({ titleId: title.id, resolutionConfidence: 0 }))
    ).toContain('ix_title_enrichment_title_id');
  });
});

describe('title_recommendations', () => {
  test('stores a served row with json evidence', async () => {
    const [row] = await db
      .insert(schema.titleRecommendations)
      .values({
        userId: 'local',
        runId: 'run-1',
        rank: 1,
        mediaType: 'movie',
        mediaFilter: 'both',
        title: 'Glass Orchard',
        score: 0.8,
        status: 'served',
        groundedTitleIds: [1, 2],
      })
      .returning();
    expect(row.groundedTitleIds).toEqual([1, 2]);
  });
});

describe('enrich_jobs.kind', () => {
  const job = (jobId: string, kind?: string, status = 'running') => ({
    jobId,
    userId: 'local',
    status,
    progress: 0,
    total: 0,
    ...(kind ? { kind } : {}),
  });

  test('defaults to books and allows one active job per (user, kind)', async () => {
    await db.insert(schema.enrichJobs).values(job('b1'));
    const [row] = await db.select().from(schema.enrichJobs).where(eq(schema.enrichJobs.jobId, 'b1'));
    expect(row.kind).toBe('books');
    await db.insert(schema.enrichJobs).values(job('s1', 'screen'));
    const second = await failure(db.insert(schema.enrichJobs).values(job('b2')));
    // enrichmentJobs.isActiveUserViolation matches this substring; the new name must keep it.
    expect(second).toContain('uq_enrich_jobs_active_user_kind');
    expect(second).toContain('uq_enrich_jobs_active_user');
    await db.insert(schema.enrichJobs).values(job('b3', 'books', 'done'));
    await db.insert(schema.enrichJobs).values({ ...job('b4'), userId: 'other' });
  });
});

describe('additive columns on existing tables', () => {
  test('default to off / null', async () => {
    const [settings] = await db.insert(schema.userSettings).values({ userId: 'local' }).returning();
    expect(settings.screenEnabled).toBe(false);
    expect(settings.screenToggledAt).toBeNull();
    const [trait] = await db
      .insert(schema.tasteTraits)
      .values({ userId: 'local', claim: 'c', polarity: 'reward', inferenceConfidence: 1, status: 'proposed' })
      .returning();
    expect(trait.exhibitTitleIds).toBeNull();
    expect(trait.contrastTitleIds).toBeNull();
    const [signal] = await db
      .insert(schema.tasteSignal)
      .values({ userId: 'local', direction: 'more', targetKind: 'book' })
      .returning();
    expect(signal.targetTitleId).toBeNull();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest list lib/server/__tests__/screen-schema.test.ts` (expect the tests listed), then
`npx vitest run lib/server/__tests__/screen-schema.test.ts`
Expected: FAIL — `schema.titles` is undefined / type errors on the new properties.

- [ ] **Step 4: Edit `lib/server/schema.ts`**

In `tasteTraits`, after `revealLine`:

```ts
    // Typed title evidence (screen variant, wave 6). Null on every book-only trait.
    exhibitTitleIds: json('exhibit_title_ids'),
    contrastTitleIds: json('contrast_title_ids'),
```

In `userSettings`, after `displayName`:

```ts
    // ScreenSprite opt-in (spec §3.1). screen_toggled_at is compared inside every profile,
    // archetype and reveal-line write transaction (wave 6) to discard runs that straddle a toggle.
    screenEnabled: boolean('screen_enabled').default(false).notNull(),
    screenToggledAt: timestamp('screen_toggled_at', { mode: 'string' }),
```

In `tasteSignal`, after `targetBookId`:

```ts
    targetTitleId: integer('target_title_id'),
```

In `enrichJobs`, after `status`:

```ts
    // 'books' | 'screen'. The default keeps every existing insert (typed by the hand-written
    // NewJobValues, which does not mention kind) a book job. Wave 5 threads it through.
    kind: varchar().default('books').notNull(),
```

and replace the `uq_enrich_jobs_active_user` index with:

```ts
    // One active job per user PER KIND (spec §4.6). The name must keep the substring
    // 'uq_enrich_jobs_active_user': isActiveUserViolation in enrichmentJobs.ts matches on it.
    uniqueIndex('uq_enrich_jobs_active_user_kind')
      .on(table.userId, table.kind)
      .where(sql`${table.status} in ('pending', 'running')`),
```

Append at the end of the file:

```ts
/**
 * ScreenSprite tables (spec §3.2, §3.3, §6.6). Hand-added and owned by ShelfSprite alone, like
 * invite_requests: there is no introspected shape to drift from. Tenant-scoped by user_id;
 * title_enrichment is scoped through titles, as enrichment is through books.
 *
 * Rating columns are numeric(2,1) with mode: 'number' -- LOAD-BEARING, exactly as on books.
 * Unlike books.goodreads_rating there is NO 0 sentinel in storage: null means unrated, and the
 * check constraints reject 0.
 */
export const titles = pgTable(
  'titles',
  {
    id: serial().primaryKey().notNull(),
    userId: varchar('user_id').default('local').notNull(),
    mediaType: varchar('media_type').notNull(), // 'movie' | 'tv'
    title: varchar().notNull(),
    year: integer(),
    status: varchar().notNull(), // 'watched' | 'watching' | 'dropped' | 'want'
    letterboxdRating: numeric('letterboxd_rating', { precision: 2, scale: 1, mode: 'number' }),
    appRating: numeric('app_rating', { precision: 2, scale: 1, mode: 'number' }),
    letterboxdReview: text('letterboxd_review'),
    appReview: text('app_review'),
    lastWatchedOn: date('last_watched_on'),
    letterboxdUri: varchar('letterboxd_uri'),
    wikidataQid: varchar('wikidata_qid'),
    tvmazeId: integer('tvmaze_id'),
    isFavorite: boolean('is_favorite').default(false).notNull(),
    excludeFromProfile: boolean('exclude_from_profile').default(false).notNull(),
    feedbackUpdatedAt: timestamp('feedback_updated_at', { mode: 'string' }),
    createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'string' }),
  },
  (table) => [
    index('ix_titles_user_id').using('btree', table.userId.asc().nullsLast().op('text_ops')),
    uniqueIndex('uq_titles_user_letterboxd_uri')
      .on(table.userId, table.letterboxdUri)
      .where(sql`${table.letterboxdUri} is not null`),
    uniqueIndex('uq_titles_user_wikidata_qid')
      .on(table.userId, table.wikidataQid)
      .where(sql`${table.wikidataQid} is not null`),
    uniqueIndex('uq_titles_user_tvmaze_id')
      .on(table.userId, table.tvmazeId)
      .where(sql`${table.tvmazeId} is not null`),
    check('ck_titles_media_type', sql`${table.mediaType} in ('movie', 'tv')`),
    check(
      'ck_titles_status',
      sql`${table.status} in ('watched', 'watching', 'dropped', 'want')`
    ),
    check(
      'ck_titles_letterboxd_rating_half_step',
      sql`${table.letterboxdRating} is null or (${table.letterboxdRating} >= 0.5 and ${table.letterboxdRating} <= 5.0 and (${table.letterboxdRating} * 2) % 1 = 0)`
    ),
    check(
      'ck_titles_app_rating_half_step',
      sql`${table.appRating} is null or (${table.appRating} >= 0.5 and ${table.appRating} <= 5.0 and (${table.appRating} * 2) % 1 = 0)`
    ),
  ]
);

export const titleEnrichment = pgTable(
  'title_enrichment',
  {
    id: serial().primaryKey().notNull(),
    titleId: integer('title_id').notNull(),
    wikidataQid: varchar('wikidata_qid'),
    tvmazeId: integer('tvmaze_id'),
    wikipediaPage: varchar('wikipedia_page'),
    genres: json(), // string[]
    directors: json(), // string[]
    creators: json(), // string[]
    writers: json(), // string[]
    countries: json(), // string[]
    originalLanguage: varchar('original_language'),
    basedOn: json('based_on'), // Array<{ qid, title, author }>
    mainSubjects: json('main_subjects'), // string[]
    series: json(), // Array<{ qid, label }>
    productionCompanies: json('production_companies'), // Array<{ qid, label }>
    sitelinks: integer(),
    description: text(),
    descriptionSource: varchar('description_source'), // 'wikipedia' | 'tvmaze'
    descriptionUrl: varchar('description_url'),
    imageUrl: varchar('image_url'),
    resolutionConfidence: doublePrecision('resolution_confidence').notNull(),
    confidenceLabel: varchar('confidence_label'), // HIGH | MEDIUM | LOW | CORRECTED
    matchMethod: varchar('match_method'),
    identitySource: varchar('identity_source').default('auto').notNull(), // auto | manual | corrected
    duplicateOfTitleId: integer('duplicate_of_title_id'),
    rawResponse: json('raw_response'),
    resolvedAt: timestamp('resolved_at', { mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('ix_title_enrichment_title_id').using(
      'btree',
      table.titleId.asc().nullsLast().op('int4_ops')
    ),
    foreignKey({
      columns: [table.titleId],
      foreignColumns: [titles.id],
      name: 'title_enrichment_title_id_fkey',
    }),
  ]
);

export const titleRecommendations = pgTable(
  'title_recommendations',
  {
    id: serial().primaryKey().notNull(),
    userId: varchar('user_id').default('local').notNull(),
    runId: varchar('run_id').notNull(),
    rank: integer().notNull(),
    mediaType: varchar('media_type').notNull(),
    mediaFilter: varchar('media_filter').notNull(), // 'both' | 'movie' | 'tv'
    title: varchar().notNull(),
    year: integer(),
    wikidataQid: varchar('wikidata_qid'),
    tvmazeId: integer('tvmaze_id'),
    imageUrl: varchar('image_url'),
    genres: json(),
    description: text(),
    retrievalPool: varchar('retrieval_pool'),
    seedReason: varchar('seed_reason'),
    score: doublePrecision().notNull(),
    rationale: text(),
    groundedTraitIds: json('grounded_trait_ids'),
    groundedBookIds: json('grounded_book_ids'),
    groundedTitleIds: json('grounded_title_ids'),
    status: varchar().notNull(), // served | accepted | rejected | already_watched
    userNote: text('user_note'),
    rejectReasons: json('reject_reasons'),
    createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    index('ix_title_recommendations_user_id').using(
      'btree',
      table.userId.asc().nullsLast().op('text_ops')
    ),
    index('ix_title_recommendations_run_id').using(
      'btree',
      table.runId.asc().nullsLast().op('text_ops')
    ),
  ]
);
```

- [ ] **Step 5: Mirror it in `lib/server/__tests__/helpers/pglite.ts`**

In the `create table taste_traits` statement, after `reveal_line text` add a comma and:

```sql
      exhibit_title_ids json,
      contrast_title_ids json
```

Replace the `create table user_settings` statement with:

```sql
    create table user_settings (
      id serial primary key,
      user_id text not null default 'local' unique,
      anthropic_api_key_encrypted text,
      created_at timestamp not null default current_timestamp,
      updated_at timestamp,
      display_name text,
      screen_enabled boolean not null default false,
      screen_toggled_at timestamp
    );
```

In `create table taste_signal`, after `target_book_id integer,` add `target_title_id integer,`.

In `create table enrich_jobs`, after `status text not null,` add
`kind text not null default 'books',`, and replace the index that follows the table with:

```sql
    create unique index uq_enrich_jobs_active_user_kind
    on enrich_jobs (user_id, kind)
    where status in ('pending', 'running');
```

After the two `reading_goals` unique indexes (the end of the `pg.exec` string), append:

```sql
    create table titles (
      id serial primary key,
      user_id text not null default 'local',
      media_type text not null,
      title text not null,
      year integer,
      status text not null,
      letterboxd_rating numeric(2,1),
      app_rating numeric(2,1),
      letterboxd_review text,
      app_review text,
      last_watched_on date,
      letterboxd_uri text,
      wikidata_qid text,
      tvmaze_id integer,
      is_favorite boolean not null default false,
      exclude_from_profile boolean not null default false,
      feedback_updated_at timestamp,
      created_at timestamp not null default current_timestamp,
      updated_at timestamp,
      constraint ck_titles_media_type check (media_type in ('movie', 'tv')),
      constraint ck_titles_status check (status in ('watched', 'watching', 'dropped', 'want')),
      constraint ck_titles_letterboxd_rating_half_step check (
        letterboxd_rating is null or (letterboxd_rating >= 0.5 and letterboxd_rating <= 5.0 and (letterboxd_rating * 2) % 1 = 0)
      ),
      constraint ck_titles_app_rating_half_step check (
        app_rating is null or (app_rating >= 0.5 and app_rating <= 5.0 and (app_rating * 2) % 1 = 0)
      )
    );
    create index ix_titles_user_id on titles (user_id);
    create unique index uq_titles_user_letterboxd_uri on titles (user_id, letterboxd_uri)
      where letterboxd_uri is not null;
    create unique index uq_titles_user_wikidata_qid on titles (user_id, wikidata_qid)
      where wikidata_qid is not null;
    create unique index uq_titles_user_tvmaze_id on titles (user_id, tvmaze_id)
      where tvmaze_id is not null;
    create table title_enrichment (
      id serial primary key,
      title_id integer not null,
      wikidata_qid text,
      tvmaze_id integer,
      wikipedia_page text,
      genres json,
      directors json,
      creators json,
      writers json,
      countries json,
      original_language text,
      based_on json,
      main_subjects json,
      series json,
      production_companies json,
      sitelinks integer,
      description text,
      description_source text,
      description_url text,
      image_url text,
      resolution_confidence double precision not null,
      confidence_label text,
      match_method text,
      identity_source text not null default 'auto',
      duplicate_of_title_id integer,
      raw_response json,
      resolved_at timestamp not null default current_timestamp,
      constraint title_enrichment_title_id_fkey foreign key (title_id) references titles(id)
    );
    create unique index ix_title_enrichment_title_id on title_enrichment (title_id);
    create table title_recommendations (
      id serial primary key,
      user_id text not null default 'local',
      run_id text not null,
      rank integer not null,
      media_type text not null,
      media_filter text not null,
      title text not null,
      year integer,
      wikidata_qid text,
      tvmaze_id integer,
      image_url text,
      genres json,
      description text,
      retrieval_pool text,
      seed_reason text,
      score double precision not null,
      rationale text,
      grounded_trait_ids json,
      grounded_book_ids json,
      grounded_title_ids json,
      status text not null,
      user_note text,
      reject_reasons json,
      created_at timestamp not null default current_timestamp
    );
    create index ix_title_recommendations_user_id on title_recommendations (user_id);
    create index ix_title_recommendations_run_id on title_recommendations (run_id);
```

Then extend `loadSeed`'s support. In `interface Seed`, add:

```ts
  titles?: Record<string, unknown>[];
  title_enrichment?: Record<string, unknown>[];
  title_recommendations?: Record<string, unknown>[];
```

In `TS_COLS` add `'screen_toggled_at'`. In `JSON_COLS` add:

```ts
    'exhibit_title_ids',
    'contrast_title_ids',
    'grounded_title_ids',
    'genres',
    'directors',
    'creators',
    'writers',
    'countries',
    'based_on',
    'main_subjects',
    'production_companies',
```

`series` must **not** go in the global set: `enrichment.series` is a text column holding a string,
and stringifying it would corrupt every existing book seed. Add a per-table set right after
`JSON_COLS`:

```ts
  // Column names that are JSON only on one table. enrichment.series is TEXT; title_enrichment.series
  // is JSON -- a global entry would JSON-quote every book seed's series string.
  const TABLE_JSON_COLS: Record<string, Set<string>> = {
    title_enrichment: new Set(['series']),
  };
```

and change the value mapping line to
`if (JSON_COLS.has(c) || TABLE_JSON_COLS[table]?.has(c)) return JSON.stringify(v);`.

In `order`, insert `'titles'` right after `'books'`, `'title_enrichment'` right after
`'enrichment'`, and `'title_recommendations'` right after `'recommendations'`. In `SEQ_TABLES` add
`'titles'`, `'title_enrichment'`, `'title_recommendations'`.

- [ ] **Step 6: Run the schema test and the existing suites that touch changed tables**

Run: `npx vitest run lib/server/__tests__/screen-schema.test.ts lib/server/__tests__/enrichment-jobs.test.ts lib/server/__tests__/enrich-job-insert.test.ts lib/server/__tests__/purge-routes.test.ts lib/server/__tests__/pglite-seed.test.ts`
Expected: PASS. `enrichment-jobs.test.ts` asserts the violation message includes
`uq_enrich_jobs_active_user`; the new name contains it, so it stays green. If it goes red, the
index name is wrong — fix the name, never the assertion.

- [ ] **Step 7: Generate the migration and inspect it**

```bash
npm run db:generate
git status --short drizzle/
```

Expected: exactly one new `drizzle/00NN_<name>.sql`, one new snapshot, and a modified
`_journal.json`. Then read the whole SQL file and check it against this list:

```bash
f=$(ls -t drizzle/*.sql | head -1); echo "$f"
grep -nE 'DROP TABLE|DROP COLUMN|ALTER TABLE "books"|RENAME' "$f"      # expect: no output
grep -nE 'CREATE TABLE "titles"|CREATE TABLE "title_enrichment"|CREATE TABLE "title_recommendations"' "$f"
grep -nE 'ADD COLUMN "(screen_enabled|screen_toggled_at|kind|exhibit_title_ids|contrast_title_ids|target_title_id)"' "$f"
grep -nE 'DROP INDEX "uq_enrich_jobs_active_user"|CREATE UNIQUE INDEX "uq_enrich_jobs_active_user_kind"' "$f"
grep -nE 'ck_titles_(media_type|status|letterboxd_rating_half_step|app_rating_half_step)|title_enrichment_title_id_fkey' "$f"
```

Required, and a STOP if violated:
- No `DROP TABLE`, no `DROP COLUMN`, nothing that alters `books`.
- `ADD COLUMN "kind" varchar DEFAULT 'books' NOT NULL` appears **before**
  `CREATE UNIQUE INDEX "uq_enrich_jobs_active_user_kind"` (the index needs the column). If drizzle
  ordered them the other way, move the `ALTER TABLE ... ADD COLUMN "kind"` statement above the
  index by hand and record that edit in the ledger.
- `screen_enabled` is `boolean DEFAULT false NOT NULL`; every other added column is nullable.
- All four check constraints, all three partial unique indexes (with their `WHERE ... IS NOT NULL`),
  and the FK are present.

Record what the file actually contains in the ledger, not this list.

- [ ] **Step 8: Hydrate `kind` in `enrichmentJobs.ts`**

The new NOT NULL column widens `EnrichJobRow` (`typeof enrichJobs.$inferSelect`), but
`lib/server/enrichmentJobs.ts` builds job rows by hand from raw SQL rows: `interface RawJobRow`
and `hydrateJob()` do not mention `kind`, so type-check fails with "Property 'kind' is missing".
`claimJob` uses `returning *`, so the raw row already carries the column. Add, in `RawJobRow`
after `status: string;`:

```ts
  kind: string;
```

and in `hydrateJob`'s returned object after `status: row.status,`:

```ts
    kind: row.kind,
```

- [ ] **Step 9: Type-check**

Run: `npm run type-check`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json lib/server/schema.ts lib/server/enrichmentJobs.ts drizzle/ lib/server/__tests__/helpers/pglite.ts lib/server/__tests__/screen-schema.test.ts
git commit -m "feat(screen): add screen tables, opt-in flag and per-kind enrich jobs (#96)"
```

---

### Task 2: Title domain helpers and the opt-in flag

**Files:**
- Create: `lib/server/titles.ts`, `lib/server/screenSettings.ts`
- Test: `lib/server/__tests__/titles.test.ts`, `lib/server/__tests__/screen-settings.test.ts`

**Interfaces:**
- Consumes: `schema.titles`, `schema.titleEnrichment`, `schema.userSettings` (Task 1);
  `setRebuildReason(tx, userId, reason)` from `lib/server/profileMeta.ts` (wave 2); `tsToIso`,
  `utcnowTs` from `serialize.ts`; `ApiError` from `errors.ts`.
- Produces (contract, exact):
  - `titles.ts`: `type TitleRow`, `type TitleEnrichmentRow`, `type MediaType`,
    `type TitleStatus`, `MEDIA_TYPES`, `TITLE_STATUSES`, `interface TitleOut` (index verbatim),
    `effectiveTitleRating(row): number | null`, `effectiveTitleReview(row): string | null`,
    `isTitleProfileEvidence(row): boolean`, `titleOut(row, enr): TitleOut`,
    `normalizeTitleKey(title: string, year: number | null): string` (returns `''` when the
    normalized title is empty — callers treat `''` as "no key").
  - `screenSettings.ts`: `SCREEN_DISABLED_MESSAGE`, `isScreenEnabled(db, userId)`,
    `requireScreenEnabled(db, userId)`, `readScreenToggledAt(db, userId)`, plus two additive
    exports later waves may use: `setScreenEnabled(tx: DbTx, userId, enabled): Promise<boolean>`
    (true when the flag actually changed) and `countTitles(db, userId): Promise<number>`.

- [ ] **Step 1: Write the failing tests**

Create `lib/server/__tests__/titles.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import {
  effectiveTitleRating,
  effectiveTitleReview,
  isTitleProfileEvidence,
  normalizeTitleKey,
  titleOut,
  type TitleEnrichmentRow,
  type TitleRow,
} from '../titles';

function row(overrides: Partial<TitleRow> = {}): TitleRow {
  return {
    id: 1,
    userId: 'local',
    mediaType: 'movie',
    title: 'The Lantern Keeper',
    year: 2019,
    status: 'watched',
    letterboxdRating: null,
    appRating: null,
    letterboxdReview: null,
    appReview: null,
    lastWatchedOn: null,
    letterboxdUri: null,
    wikidataQid: null,
    tvmazeId: null,
    isFavorite: false,
    excludeFromProfile: false,
    feedbackUpdatedAt: null,
    createdAt: '2026-09-22 10:00:00',
    updatedAt: null,
    ...overrides,
  };
}

describe('effective values', () => {
  test('app rating wins, else letterboxd, else null', () => {
    expect(effectiveTitleRating(row({ appRating: 3, letterboxdRating: 4.5 }))).toBe(3);
    expect(effectiveTitleRating(row({ letterboxdRating: 4.5 }))).toBe(4.5);
    expect(effectiveTitleRating(row())).toBeNull();
  });
  test('app review wins, else letterboxd review', () => {
    expect(effectiveTitleReview(row({ appReview: 'mine', letterboxdReview: 'lb' }))).toBe('mine');
    expect(effectiveTitleReview(row({ letterboxdReview: 'lb' }))).toBe('lb');
    expect(effectiveTitleReview(row())).toBeNull();
  });
});

describe('isTitleProfileEvidence (spec §3.2)', () => {
  test.each([
    ['dropped unrated', { status: 'dropped' }, true],
    ['want rated', { status: 'want', letterboxdRating: 5 }, false],
    ['watched unrated', { status: 'watched' }, false],
    ['watched rated', { status: 'watched', letterboxdRating: 4 }, true],
    ['watching rated in app', { status: 'watching', appRating: 2 }, true],
    ['excluded rated', { status: 'watched', appRating: 5, excludeFromProfile: true }, false],
    ['excluded dropped', { status: 'dropped', excludeFromProfile: true }, false],
  ])('%s', (_name, overrides, expected) => {
    expect(isTitleProfileEvidence(row(overrides as Partial<TitleRow>))).toBe(expected);
  });
});

describe('normalizeTitleKey', () => {
  test('folds case, punctuation and width, keeps the year', () => {
    expect(normalizeTitleKey('Spider-Man: No Way Home', 2021)).toBe('spider man no way home\u00002021');
    expect(normalizeTitleKey('ＡＢＣ', 1999)).toBe('abc\u00001999');
    expect(normalizeTitleKey('Salt & Static', null)).toBe('salt static\u0000');
  });
  test('keeps non-Latin letters and combining marks', () => {
    expect(normalizeTitleKey('夜の図書館', 2016)).toBe('夜の図書館\u00002016');
    expect(normalizeTitleKey('Amélie', 2001)).toBe('amélie\u00002001');
    expect(normalizeTitleKey('नमस्ते', 2020)).toBe('नमस्ते\u00002020');
  });
  test('an empty normalized title yields no key', () => {
    expect(normalizeTitleKey('!!!', 2020)).toBe('');
    expect(normalizeTitleKey('   ', null)).toBe('');
  });
});

describe('titleOut', () => {
  test('serializes effective values and a null enrichment', () => {
    expect(
      titleOut(row({ letterboxdRating: 4.5, letterboxdReview: 'lb', letterboxdUri: 'https://boxd.it/a' }), null)
    ).toEqual({
      id: 1,
      media_type: 'movie',
      title: 'The Lantern Keeper',
      year: 2019,
      status: 'watched',
      rating: 4.5,
      app_rating: null,
      letterboxd_rating: 4.5,
      review: 'lb',
      app_review: null,
      letterboxd_review: 'lb',
      last_watched_on: null,
      is_favorite: false,
      exclude_from_profile: false,
      wikidata_qid: null,
      tvmaze_id: null,
      created_at: '2026-09-22T10:00:00',
      enrichment: null,
    });
  });

  test('serializes enrichment with list defaults', () => {
    const enr = {
      id: 5,
      titleId: 1,
      confidenceLabel: 'HIGH',
      resolutionConfidence: 0.95,
      matchMethod: 'exact',
      identitySource: 'auto',
      imageUrl: 'https://upload.wikimedia.org/x.jpg',
      description: 'A keeper of lanterns.',
      descriptionSource: 'wikipedia',
      descriptionUrl: 'https://en.wikipedia.org/wiki/X',
      wikipediaPage: 'X',
      genres: ['drama film'],
      directors: null,
      creators: 'not a list',
      duplicateOfTitleId: null,
    } as unknown as TitleEnrichmentRow;
    expect(titleOut(row(), enr).enrichment).toEqual({
      confidence_label: 'HIGH',
      resolution_confidence: 0.95,
      match_method: 'exact',
      identity_source: 'auto',
      image_url: 'https://upload.wikimedia.org/x.jpg',
      description: 'A keeper of lanterns.',
      description_source: 'wikipedia',
      description_url: 'https://en.wikipedia.org/wiki/X',
      wikipedia_page: 'X',
      genres: ['drama film'],
      directors: [],
      creators: [],
      duplicate_of_title_id: null,
    });
  });
});
```

Create `lib/server/__tests__/screen-settings.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ApiError } from '../errors';
import { schema, type Db } from '../db';
import {
  countTitles,
  isScreenEnabled,
  readScreenToggledAt,
  requireScreenEnabled,
  SCREEN_DISABLED_MESSAGE,
  setScreenEnabled,
} from '../screenSettings';
import { makeTestDb } from './helpers/pglite';

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await makeTestDb());
});
afterEach(async () => {
  await close();
});

async function reason(userId: string): Promise<string | null> {
  const rows = await db
    .select({ r: schema.profileMeta.rebuildReason })
    .from(schema.profileMeta)
    .where(eq(schema.profileMeta.userId, userId));
  return rows[0]?.r ?? null;
}

describe('screen opt-in flag', () => {
  test('is off with no settings row, and requireScreenEnabled answers 403', async () => {
    expect(await isScreenEnabled(db, 'local')).toBe(false);
    expect(await readScreenToggledAt(db, 'local')).toBeNull();
    const err = await requireScreenEnabled(db, 'local').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 403, detail: SCREEN_DISABLED_MESSAGE });
  });

  test('enabling creates the row, stamps toggled_at, and sets the rebuild reason', async () => {
    expect(await db.transaction((tx) => setScreenEnabled(tx, 'local', true))).toBe(true);
    expect(await isScreenEnabled(db, 'local')).toBe(true);
    expect(await readScreenToggledAt(db, 'local')).toEqual(expect.any(String));
    expect(await reason('local')).toBe('screen_enabled');
    await expect(requireScreenEnabled(db, 'local')).resolves.toBeUndefined();
  });

  test('setting the same value again is a no-op that does not restamp', async () => {
    await db.transaction((tx) => setScreenEnabled(tx, 'local', true));
    const first = await readScreenToggledAt(db, 'local');
    expect(await db.transaction((tx) => setScreenEnabled(tx, 'local', true))).toBe(false);
    expect(await readScreenToggledAt(db, 'local')).toBe(first);
  });

  test('disabling an enabled account updates the existing row and keeps a reason set', async () => {
    await db.insert(schema.userSettings).values({ userId: 'local', displayName: 'Sam' });
    await db.transaction((tx) => setScreenEnabled(tx, 'local', true));
    expect(await db.transaction((tx) => setScreenEnabled(tx, 'local', false))).toBe(true);
    expect(await isScreenEnabled(db, 'local')).toBe(false);
    const [settings] = await db
      .select()
      .from(schema.userSettings)
      .where(eq(schema.userSettings.userId, 'local'));
    expect(settings.displayName).toBe('Sam');
    // First reason wins until a full rebuild clears it (wave 2 contract).
    expect(await reason('local')).toBe('screen_enabled');
  });

  test('is per user', async () => {
    await db.transaction((tx) => setScreenEnabled(tx, 'other', true));
    expect(await isScreenEnabled(db, 'local')).toBe(false);
    expect(await reason('local')).toBeNull();
  });

  test('countTitles counts only the caller', async () => {
    await db.insert(schema.titles).values([
      { userId: 'local', mediaType: 'movie', title: 'A', status: 'want' },
      { userId: 'local', mediaType: 'tv', title: 'B', status: 'watching' },
      { userId: 'other', mediaType: 'movie', title: 'C', status: 'want' },
    ]);
    expect(await countTitles(db, 'local')).toBe(2);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run lib/server/__tests__/titles.test.ts lib/server/__tests__/screen-settings.test.ts`
Expected: FAIL — cannot resolve `../titles` / `../screenSettings`.

- [ ] **Step 3: Write `lib/server/titles.ts`**

```ts
/**
 * Screen title domain rules (spec §3.2). The screen counterpart of books.ts + the rating parts
 * of serialize.ts, kept separate because the storage rules differ: titles store null for
 * unrated, never a 0 sentinel.
 */
import { schema } from './db';
import { tsToIso } from './serialize';

export type TitleRow = typeof schema.titles.$inferSelect;
export type TitleEnrichmentRow = typeof schema.titleEnrichment.$inferSelect;

export const MEDIA_TYPES = ['movie', 'tv'] as const;
export const TITLE_STATUSES = ['watched', 'watching', 'dropped', 'want'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];
export type TitleStatus = (typeof TITLE_STATUSES)[number];

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

/** app_rating ?? letterboxd_rating. A stored 0 is impossible (check constraint). */
export function effectiveTitleRating(
  row: Pick<TitleRow, 'appRating' | 'letterboxdRating'>
): number | null {
  return row.appRating ?? row.letterboxdRating ?? null;
}

/** app_review ?? letterboxd_review: clearing the app review reveals the Letterboxd one. */
export function effectiveTitleReview(
  row: Pick<TitleRow, 'appReview' | 'letterboxdReview'>
): string | null {
  return row.appReview ?? row.letterboxdReview ?? null;
}

/**
 * Spec §3.2 profile eligibility: dropped behaves like DNF (evidence even unrated); want is never
 * evidence; watched/watching count only when rated; an excluded title is never evidence.
 */
export function isTitleProfileEvidence(
  row: Pick<TitleRow, 'status' | 'excludeFromProfile' | 'appRating' | 'letterboxdRating'>
): boolean {
  if (row.excludeFromProfile) return false;
  if (row.status === 'dropped') return true;
  if (row.status === 'want') return false;
  return effectiveTitleRating(row) !== null;
}

/**
 * Unicode-safe title + year key for import matching and dedup. NFKC folds width and
 * compatibility forms; letters (any script), combining marks and digits survive; everything else
 * becomes a single space. Deliberately NOT dedup.normalizeTitle, which strips every non-[a-z0-9]
 * character and so maps every non-Latin title to '' (spec §1, §4.3). Returns '' when nothing
 * survives, and '' must never be used as a match key.
 */
export function normalizeTitleKey(title: string, year: number | null): string {
  const norm = title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();
  if (!norm) return '';
  return `${norm}\u0000${year ?? ''}`;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function titleOut(row: TitleRow, enr: TitleEnrichmentRow | null): TitleOut {
  return {
    id: row.id,
    media_type: row.mediaType as MediaType,
    title: row.title,
    year: row.year,
    status: row.status as TitleStatus,
    rating: effectiveTitleRating(row),
    app_rating: row.appRating,
    letterboxd_rating: row.letterboxdRating,
    review: effectiveTitleReview(row),
    app_review: row.appReview,
    letterboxd_review: row.letterboxdReview,
    last_watched_on: row.lastWatchedOn,
    is_favorite: row.isFavorite,
    exclude_from_profile: row.excludeFromProfile,
    wikidata_qid: row.wikidataQid,
    tvmaze_id: row.tvmazeId,
    created_at: tsToIso(row.createdAt) ?? row.createdAt,
    enrichment: enr
      ? {
          confidence_label: enr.confidenceLabel,
          resolution_confidence: enr.resolutionConfidence,
          match_method: enr.matchMethod,
          identity_source: enr.identitySource as 'auto' | 'manual' | 'corrected',
          image_url: enr.imageUrl,
          description: enr.description,
          description_source: enr.descriptionSource as 'wikipedia' | 'tvmaze' | null,
          description_url: enr.descriptionUrl,
          wikipedia_page: enr.wikipediaPage,
          genres: stringList(enr.genres),
          directors: stringList(enr.directors),
          creators: stringList(enr.creators),
          duplicate_of_title_id: enr.duplicateOfTitleId,
        }
      : null,
  };
}
```

`titles.ts` is a `.ts` server module, so the `\u0000` escape and the Unicode regex are fine (the
ASCII-only rule is for `.tsx`).

- [ ] **Step 4: Write `lib/server/screenSettings.ts`**

```ts
/**
 * ScreenSprite opt-in (spec §3.1). The flag lives on user_settings; a missing row means off.
 * Every screen route except import and "Delete screen library" calls requireScreenEnabled.
 */
import { eq, sql } from 'drizzle-orm';
import { schema, type Db, type DbTx } from './db';
import { ApiError } from './errors';
import { setRebuildReason } from './profileMeta';
import { utcnowTs } from './serialize';

type Conn = Db | DbTx;

export const SCREEN_DISABLED_MESSAGE = 'ScreenSprite is not enabled for this account.';

async function settingsRow(db: Conn, userId: string) {
  const rows = await db
    .select({
      id: schema.userSettings.id,
      screenEnabled: schema.userSettings.screenEnabled,
      screenToggledAt: schema.userSettings.screenToggledAt,
    })
    .from(schema.userSettings)
    .where(eq(schema.userSettings.userId, userId));
  return rows[0] ?? null;
}

export async function isScreenEnabled(db: Conn, userId: string): Promise<boolean> {
  return (await settingsRow(db, userId))?.screenEnabled ?? false;
}

export async function requireScreenEnabled(db: Conn, userId: string): Promise<void> {
  if (!(await isScreenEnabled(db, userId))) throw new ApiError(403, SCREEN_DISABLED_MESSAGE);
}

export async function readScreenToggledAt(db: Conn, userId: string): Promise<string | null> {
  return (await settingsRow(db, userId))?.screenToggledAt ?? null;
}

/**
 * Flip the flag inside the caller's transaction. Only a real change stamps screen_toggled_at and
 * records a rebuild reason (spec §5.5: enabling or disabling screen forces a full rebuild).
 * Returns whether the flag changed. Wave 6's opt-out calls this for the disable half.
 */
export async function setScreenEnabled(
  tx: DbTx,
  userId: string,
  enabled: boolean
): Promise<boolean> {
  const row = await settingsRow(tx, userId);
  if ((row?.screenEnabled ?? false) === enabled) return false;
  const now = utcnowTs();
  if (row) {
    await tx
      .update(schema.userSettings)
      .set({ screenEnabled: enabled, screenToggledAt: now, updatedAt: now })
      .where(eq(schema.userSettings.id, row.id));
  } else {
    await tx.insert(schema.userSettings).values({ userId, screenEnabled: enabled, screenToggledAt: now });
  }
  await setRebuildReason(tx, userId, enabled ? 'screen_enabled' : 'screen_disabled');
  return true;
}

export async function countTitles(db: Conn, userId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.titles)
    .where(eq(schema.titles.userId, userId));
  return Number(rows[0]?.n ?? 0);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run lib/server/__tests__/titles.test.ts lib/server/__tests__/screen-settings.test.ts`
Expected: PASS.

- [ ] **Step 6: Mutation-check the non-Latin rule**

Temporarily change the regex in `normalizeTitleKey` to `/[^a-z0-9]+/g`, rerun `titles.test.ts`,
confirm `keeps non-Latin letters and combining marks` and `an empty normalized title yields no key`
behave as expected (the first goes red), then revert and rerun green.

- [ ] **Step 7: Commit**

```bash
git add lib/server/titles.ts lib/server/screenSettings.ts lib/server/__tests__/titles.test.ts lib/server/__tests__/screen-settings.test.ts
git commit -m "feat(screen): add title domain helpers and the ScreenSprite opt-in flag (#96)"
```

---

### Task 3: Letterboxd ZIP reader

**Files:**
- Create: `lib/server/letterboxd.ts`
- Modify: `lib/server/import-upload.ts` (add `readZipUpload`)
- Create: `lib/server/__tests__/fixtures/letterboxd.ts`
- Test: `lib/server/__tests__/letterboxd.test.ts`

**Interfaces:**
- Consumes: `fflate` (`unzipSync` with `filter`, streaming `Unzip` + `UnzipInflate`);
  `parse` from `csv-parse/sync`; `isValidRating` from `rating.ts`; `ApiError`;
  `MAX_IMPORT_BYTES`, `MissingImportFileError` from `import-upload.ts`.
- Produces (contract, exact): `readLetterboxdZip(bytes: Uint8Array, limits?: ZipLimits):
  LetterboxdExport` with `interface LetterboxdExport { films: LetterboxdFilm[] }` and
  `interface LetterboxdFilm { uri: string; name: string; year: number | null; status: 'watched' |
  'want'; rating: number | null; review: string | null; lastWatchedOn: string | null; favorite:
  boolean }`. The optional `limits` parameter is additive and exists for tests. Also
  `readZipUpload(request): Promise<{ bytes: Uint8Array; filename: string }>`.

**Export facts this code relies on** (measured on a real export in the spike; headers only):

| Entry | Header |
|---|---|
| `watched.csv` | `Date,Name,Year,Letterboxd URI` |
| `ratings.csv` | `Date,Name,Year,Letterboxd URI,Rating` |
| `watchlist.csv` | `Date,Name,Year,Letterboxd URI` |
| `diary.csv` | `Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date` |
| `reviews.csv` | `Date,Name,Year,Letterboxd URI,Rating,Rewatch,Review,Tags,Watched Date` |
| `profile.csv` | `Date Joined,Username,Given Name,Family Name,Email Address,Location,Website,Bio,Pronoun,Favorite Films` |

`Favorite Films` is one cell holding up to four `https://boxd.it/<id>` film URIs separated by
`", "`. Ratings are decimals on the half grid (`4.5`). Dates are `YYYY-MM-DD`. The ZIP also holds
`comments.csv`, `likes/*.csv`, `lists/*.csv`, `deleted/*.csv` and `orphaned/*.csv`, whose
`deleted/diary.csv` and `orphaned/reviews.csv` share basenames with real entries — which is why
only exact root names are read.

- [ ] **Step 1: Write the synthetic fixture**

Create `lib/server/__tests__/fixtures/letterboxd.ts`. Every film, person and URI here is fictional.

```ts
import { strToU8, zipSync } from 'fflate';

/**
 * A synthetic Letterboxd export shaped from the spike's measurements (spec §2.1 finding 1).
 * Nothing here comes from a real account. Diary and review URIs are ENTRY links (boxd.it/e*,
 * boxd.it/r*) that match no film URI, exactly as in real exports.
 */
export const SYNTHETIC_LETTERBOXD: Record<string, string> = {
  'profile.csv':
    'Date Joined,Username,Given Name,Family Name,Email Address,Location,Website,Bio,Pronoun,Favorite Films\n' +
    '2020-01-01,synthetic_user,Sam,Example,sam@example.invalid,Nowhere,,A bio,they/them,' +
    '"https://boxd.it/aaa2, https://boxd.it/aaa4"\n',
  'watched.csv':
    'Date,Name,Year,Letterboxd URI\n' +
    '2024-01-05,The Lantern Keeper,2019,https://boxd.it/aaa1\n' +
    '2024-02-10,Salt & Static,2021,https://boxd.it/aaa2\n' +
    '2024-03-15,"Quiet Harbor, Loud Sea",2008,https://boxd.it/aaa3\n' +
    '2024-04-20,夜の図書館,2016,https://boxd.it/aaa4\n' +
    '2024-05-25,Paper Moons,,https://boxd.it/aaa5\n',
  'ratings.csv':
    'Date,Name,Year,Letterboxd URI,Rating\n' +
    '2024-01-06,The Lantern Keeper,2019,https://boxd.it/aaa1,4.5\n' +
    '2024-02-11,Salt & Static,2021,https://boxd.it/aaa2,2\n' +
    '2024-04-21,夜の図書館,2016,https://boxd.it/aaa4,5\n',
  'watchlist.csv':
    'Date,Name,Year,Letterboxd URI\n' +
    '2024-06-01,Glass Orchard,2023,https://boxd.it/bbb1\n' +
    '2024-06-02,The Lantern Keeper,2019,https://boxd.it/aaa1\n',
  'diary.csv':
    'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\n' +
    '2024-01-06,The Lantern Keeper,2019,https://boxd.it/e1,4.5,,,2024-01-04\n' +
    '2024-07-01,The Lantern Keeper,2019,https://boxd.it/e2,4.5,Yes,,2024-06-30\n' +
    '2024-02-11,Salt & Static,2021,https://boxd.it/e3,2,,,2024-02-09\n' +
    '2024-08-01,Unknown Film,1999,https://boxd.it/e4,3,,,2024-07-31\n',
  'reviews.csv':
    'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Review,Tags,Watched Date\n' +
    '2024-01-06,The Lantern Keeper,2019,https://boxd.it/r1,4.5,,"First take, with ""quotes""\nand a second line.",,2024-01-04\n' +
    '2024-07-01,The Lantern Keeper,2019,https://boxd.it/r2,4.5,Yes,Second take wins.,,2024-06-30\n' +
    '2024-05-26,Paper Moons,,https://boxd.it/r3,,,Loved it but never rated.,,2024-05-25\n',
  'comments.csv': 'Date,Content,Comment\n',
  'likes/films.csv': 'Date,Name,Year,Letterboxd URI\n2024-03-16,"Quiet Harbor, Loud Sea",2008,https://boxd.it/aaa3\n',
  'lists/favorite-bad-movies.csv': 'Date,Name,URL,Description\n',
  'deleted/diary.csv':
    'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\n' +
    '2025-12-31,The Lantern Keeper,2019,https://boxd.it/e9,1,,,2025-12-31\n',
  'orphaned/reviews.csv':
    'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Review,Tags,Watched Date\n' +
    '2025-12-31,The Lantern Keeper,2019,https://boxd.it/r9,1,,Orphaned text must never import.,,2025-12-31\n',
};

export function letterboxdZip(
  files: Record<string, string> = SYNTHETIC_LETTERBOXD,
  level: 0 | 6 = 6
): Uint8Array {
  return zipSync(
    Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])),
    { level }
  );
}

/** Rewrites every local and central-directory header field at `offset` (little-endian). */
function patchHeaders(zip: Uint8Array, local: number, central: number, width: 2 | 4, value: number) {
  const out = zip.slice();
  const view = new DataView(out.buffer);
  for (let i = 0; i + 4 <= out.length; i += 1) {
    const sig = view.getUint32(i, true);
    const at = sig === 0x04034b50 ? i + local : sig === 0x02014b50 ? i + central : -1;
    if (at < 0) continue;
    if (width === 4) view.setUint32(at, value, true);
    else view.setUint16(at, value, true);
  }
  return out;
}

/** Declares a false uncompressed size in both headers (a "lying" ZIP). */
export function withDeclaredSize(zip: Uint8Array, size: number): Uint8Array {
  return patchHeaders(zip, 22, 24, 4, size);
}

/** Declares an unsupported compression method, so any attempt to inflate fails. */
export function withCompressionMethod(zip: Uint8Array, method: number): Uint8Array {
  return patchHeaders(zip, 8, 10, 2, method);
}
```

The header patchers scan for signatures; use them only on single-entry ZIPs of short ASCII text,
where a signature byte pattern inside the data is not a realistic collision.

- [ ] **Step 2: Write the failing tests**

Create `lib/server/__tests__/letterboxd.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { ApiError } from '../errors';
import { readLetterboxdZip, type LetterboxdFilm } from '../letterboxd';
import {
  letterboxdZip,
  SYNTHETIC_LETTERBOXD,
  withCompressionMethod,
  withDeclaredSize,
} from './fixtures/letterboxd';

function rejection(fn: () => unknown): { status: number; detail: string } {
  try {
    fn();
  } catch (error) {
    if (error instanceof ApiError) return { status: error.status, detail: error.detail };
    throw error;
  }
  throw new Error('expected an ApiError');
}

const byUri = (films: LetterboxdFilm[]) => new Map(films.map((f) => [f.uri, f]));

describe('readLetterboxdZip — joins', () => {
  test('builds one film per film URI with ratings, statuses, diary dates, reviews and favorites', () => {
    const { films } = readLetterboxdZip(letterboxdZip());
    expect(films.map((f) => f.uri)).toEqual([
      'https://boxd.it/aaa1',
      'https://boxd.it/aaa2',
      'https://boxd.it/aaa3',
      'https://boxd.it/aaa4',
      'https://boxd.it/aaa5',
      'https://boxd.it/bbb1',
    ]);
    const m = byUri(films);
    expect(m.get('https://boxd.it/aaa1')).toEqual({
      uri: 'https://boxd.it/aaa1',
      name: 'The Lantern Keeper',
      year: 2019,
      status: 'watched', // on the watchlist too, but watched wins
      rating: 4.5,
      review: 'Second take wins.', // most recent review by Date
      lastWatchedOn: '2024-06-30', // latest diary Watched Date
      favorite: false,
    });
    expect(m.get('https://boxd.it/aaa2')).toMatchObject({ rating: 2, favorite: true, lastWatchedOn: '2024-02-09' });
    expect(m.get('https://boxd.it/aaa3')).toMatchObject({
      name: 'Quiet Harbor, Loud Sea',
      rating: null,
      favorite: false, // liked, and likes are never read (spec decision 15)
    });
    expect(m.get('https://boxd.it/aaa4')).toMatchObject({ name: '夜の図書館', rating: 5, favorite: true });
    expect(m.get('https://boxd.it/aaa5')).toMatchObject({
      year: null,
      rating: null,
      review: 'Loved it but never rated.', // kept here; importTitles decides whether to store it
    });
    expect(m.get('https://boxd.it/bbb1')).toMatchObject({ status: 'want', rating: null });
  });

  test('diary and review rows join by exact (Name, Year), never by their entry URI', () => {
    const { films } = readLetterboxdZip(letterboxdZip());
    for (const f of films) expect(f.uri).not.toMatch(/boxd\.it\/[er]\d/);
    // "Unknown Film" (1999) is only in the diary: it has no film URI, so it is not imported.
    expect(films.some((f) => f.name === 'Unknown Film')).toBe(false);
  });

  test('a quoted multi-line review with commas and doubled quotes survives', () => {
    const files = { ...SYNTHETIC_LETTERBOXD };
    files['reviews.csv'] =
      'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Review,Tags,Watched Date\n' +
      '2024-01-06,The Lantern Keeper,2019,https://boxd.it/r1,4.5,,"First take, with ""quotes""\nand a second line.",,2024-01-04\n';
    const film = byUri(readLetterboxdZip(letterboxdZip(files)).films).get('https://boxd.it/aaa1');
    expect(film?.review).toBe('First take, with "quotes"\nand a second line.');
  });

  test('an ambiguous (Name, Year) pair joins diary and review rows to neither film', () => {
    const files = { ...SYNTHETIC_LETTERBOXD };
    files['watched.csv'] =
      'Date,Name,Year,Letterboxd URI\n' +
      '2024-01-05,Twin,2020,https://boxd.it/t1\n' +
      '2024-01-05,Twin,2020,https://boxd.it/t2\n';
    files['ratings.csv'] = 'Date,Name,Year,Letterboxd URI,Rating\n';
    files['watchlist.csv'] = 'Date,Name,Year,Letterboxd URI\n';
    files['diary.csv'] =
      'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\n2024-02-01,Twin,2020,https://boxd.it/e1,3,,,2024-02-01\n';
    files['reviews.csv'] =
      'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Review,Tags,Watched Date\n2024-02-01,Twin,2020,https://boxd.it/r1,3,,Which one?,,2024-02-01\n';
    const { films } = readLetterboxdZip(letterboxdZip(files));
    expect(films.map((f) => [f.uri, f.lastWatchedOn, f.review])).toEqual([
      ['https://boxd.it/t1', null, null],
      ['https://boxd.it/t2', null, null],
    ]);
  });

  test('never reads deleted/ or orphaned/ entries', () => {
    const film = byUri(readLetterboxdZip(letterboxdZip()).films).get('https://boxd.it/aaa1');
    expect(film?.lastWatchedOn).toBe('2024-06-30'); // deleted/diary.csv says 2025-12-31
    expect(film?.review).not.toContain('Orphaned');
  });

  test('profile PII never reaches the result', () => {
    const text = JSON.stringify(readLetterboxdZip(letterboxdZip()));
    for (const pii of ['synthetic_user', 'sam@example.invalid', 'Nowhere', 'A bio']) {
      expect(text).not.toContain(pii);
    }
  });

  test('a profile.csv without Favorite Films, or no profile.csv, means no favorites', () => {
    const noColumn = { ...SYNTHETIC_LETTERBOXD, 'profile.csv': 'Date Joined,Username\n2020-01-01,x\n' };
    expect(readLetterboxdZip(letterboxdZip(noColumn)).films.some((f) => f.favorite)).toBe(false);
    const { ['profile.csv']: _omit, ...noProfile } = SYNTHETIC_LETTERBOXD;
    expect(readLetterboxdZip(letterboxdZip(noProfile)).films.some((f) => f.favorite)).toBe(false);
  });

  test('ratings off the half grid are treated as absent', () => {
    const files = {
      ...SYNTHETIC_LETTERBOXD,
      'ratings.csv': 'Date,Name,Year,Letterboxd URI,Rating\n2024-01-06,The Lantern Keeper,2019,https://boxd.it/aaa1,4.3\n',
    };
    expect(byUri(readLetterboxdZip(letterboxdZip(files)).films).get('https://boxd.it/aaa1')?.rating).toBeNull();
  });
});

describe('readLetterboxdZip — shape errors', () => {
  test('rejects a re-zipped folder with a specific message', () => {
    const nested = Object.fromEntries(
      Object.entries(SYNTHETIC_LETTERBOXD).map(([name, text]) => [`letterboxd-export/${name}`, text])
    );
    expect(rejection(() => readLetterboxdZip(letterboxdZip(nested)))).toEqual({
      status: 422,
      detail:
        'Upload the ZIP exactly as Letterboxd sent it: its CSV files must be at the top level, not inside a folder.',
    });
  });

  test('rejects a ZIP with no Letterboxd entries, even when deleted/ has look-alikes', () => {
    const onlyDeleted = { 'deleted/diary.csv': SYNTHETIC_LETTERBOXD['deleted/diary.csv'] };
    expect(rejection(() => readLetterboxdZip(letterboxdZip(onlyDeleted)))).toEqual({
      status: 422,
      detail:
        'This does not look like a Letterboxd export: watched.csv, ratings.csv or watchlist.csv must be at the top level of the ZIP.',
    });
  });

  test('rejects bytes that are not a ZIP', () => {
    expect(rejection(() => readLetterboxdZip(new TextEncoder().encode('not a zip')))).toEqual({
      status: 422,
      detail: 'The upload is not a readable ZIP file.',
    });
  });

  test('rejects a CSV missing a required column', () => {
    const files = { ...SYNTHETIC_LETTERBOXD, 'ratings.csv': 'Date,Name,Year,Letterboxd URI\n' };
    expect(rejection(() => readLetterboxdZip(letterboxdZip(files)))).toEqual({
      status: 422,
      detail: "ratings.csv is missing its 'Rating' column; is this a Letterboxd export?",
    });
  });

  test('rejects an entry that is not UTF-8', () => {
    const header = 'Date,Name,Year,Letterboxd URI\n';
    const stored = letterboxdZip({ 'watched.csv': `${header}x` }, 0);
    // Stored (level 0) entry: 30-byte local header + name, then the raw bytes. Replace the final
    // data byte 'x' with 0xff, which is invalid UTF-8 on its own.
    const at = 30 + 'watched.csv'.length + header.length;
    expect(stored[at]).toBe(0x78);
    const invalid = stored.slice();
    invalid[at] = 0xff;
    const error = rejection(() => readLetterboxdZip(invalid));
    expect(error.status).toBe(422);
    // fflate may reject the CRC mismatch before decoding; either message is a correct refusal.
    expect([
      'watched.csv is not UTF-8 text.',
      'The upload is not a readable ZIP file.',
    ]).toContain(error.detail);
  });
});

describe('readLetterboxdZip — bounds (spec §3.4 ZIP-bomb guard)', () => {
  const small = { maxEntryBytes: 64, maxTotalBytes: 100 };

  test('checks declared sizes before inflating anything', () => {
    // The entry is too big AND uses an unsupported compression method. If inflation ran first
    // the error would be the unreadable-ZIP 422; the size check must answer 413 first.
    const zip = withCompressionMethod(
      letterboxdZip({ 'watched.csv': 'Date,Name,Year,Letterboxd URI\n' + 'x'.repeat(200) }, 0),
      99
    );
    expect(rejection(() => readLetterboxdZip(zip, small))).toEqual({
      status: 413,
      detail: 'The Letterboxd export is too large to import.',
    });
  });

  test('enforces the total across allowlisted entries', () => {
    const files = {
      'watched.csv': 'Date,Name,Year,Letterboxd URI\n' + 'a'.repeat(20),
      'ratings.csv': 'Date,Name,Year,Letterboxd URI,Rating\n' + 'b'.repeat(20),
      'watchlist.csv': 'Date,Name,Year,Letterboxd URI\n' + 'c'.repeat(20),
    };
    expect(rejection(() => readLetterboxdZip(letterboxdZip(files), small)).status).toBe(413);
  });

  test('ignored entries do not count toward the total', () => {
    const files = {
      'watched.csv': 'Date,Name,Year,Letterboxd URI\n',
      'lists/huge.csv': 'z'.repeat(5_000),
    };
    expect(readLetterboxdZip(letterboxdZip(files), small).films).toEqual([]);
  });

  test('stops inflating when the real size exceeds a lying declared size', () => {
    const honest = letterboxdZip({ 'watched.csv': 'Date,Name,Year,Letterboxd URI\n' + 'y'.repeat(2_000) });
    const lying = withDeclaredSize(honest, 10);
    expect(rejection(() => readLetterboxdZip(lying))).toEqual({
      status: 422,
      detail: 'The upload is not a readable ZIP file.',
    });
  });

  test('stops inflating at the per-entry cap even when the declaration claims to fit', () => {
    const honest = letterboxdZip({ 'watched.csv': 'Date,Name,Year,Letterboxd URI\n' + 'y'.repeat(2_000) });
    const lying = withDeclaredSize(honest, 50); // declared 50 <= cap 64, real ~2 KB
    expect(rejection(() => readLetterboxdZip(lying, small)).status).toBeGreaterThanOrEqual(413);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest list lib/server/__tests__/letterboxd.test.ts` then
`npx vitest run lib/server/__tests__/letterboxd.test.ts`
Expected: FAIL — cannot resolve `../letterboxd`.

- [ ] **Step 4: Write `lib/server/letterboxd.ts`**

```ts
/**
 * Letterboxd export reader (spec §3.4). Pure: ZIP bytes in, LetterboxdFilm[] out.
 *
 * Two passes over the ZIP, deliberately:
 *   1. The central directory's DECLARED uncompressed sizes are checked against the per-entry and
 *      total caps before a single byte inflates (unzipSync with a filter that always says no).
 *   2. Only the allowlisted root entries are inflated, streaming, with every chunk counted. A
 *      declared size can lie, so the real size is enforced again here and must equal the
 *      declaration.
 *
 * Only exact root names are read: deleted/diary.csv and orphaned/reviews.csv share basenames
 * with real entries. Of profile.csv only `Favorite Films` is read; the parser maps every other
 * column to `false`, so the PII never becomes a JavaScript value.
 */
import { parse } from 'csv-parse/sync';
import { Unzip, UnzipInflate, unzipSync } from 'fflate';
import { ApiError } from './errors';
import { isValidRating } from './rating';

export const LETTERBOXD_ENTRIES = [
  'watched.csv',
  'ratings.csv',
  'watchlist.csv',
  'diary.csv',
  'reviews.csv',
  'profile.csv',
] as const;
type EntryName = (typeof LETTERBOXD_ENTRIES)[number];

export interface ZipLimits {
  maxEntryBytes: number;
  maxTotalBytes: number;
}

// A 5,000-film watched.csv is about 300 KB; these leave two orders of magnitude of headroom
// while keeping a serverless function's memory bounded.
export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntryBytes: 8 * 1024 * 1024,
  maxTotalBytes: 24 * 1024 * 1024,
};

export interface LetterboxdFilm {
  uri: string;
  name: string;
  year: number | null;
  status: 'watched' | 'want';
  rating: number | null;
  review: string | null;
  lastWatchedOn: string | null;
  favorite: boolean;
}

export interface LetterboxdExport {
  films: LetterboxdFilm[];
}

const NOT_AN_EXPORT =
  'This does not look like a Letterboxd export: watched.csv, ratings.csv or watchlist.csv must be at the top level of the ZIP.';
const REZIPPED =
  'Upload the ZIP exactly as Letterboxd sent it: its CSV files must be at the top level, not inside a folder.';
const TOO_BIG = 'The Letterboxd export is too large to import.';
const UNREADABLE = 'The upload is not a readable ZIP file.';

const REQUIRED_COLUMNS: Record<EntryName, string[]> = {
  'watched.csv': ['Name', 'Year', 'Letterboxd URI'],
  'ratings.csv': ['Name', 'Year', 'Letterboxd URI', 'Rating'],
  'watchlist.csv': ['Name', 'Year', 'Letterboxd URI'],
  'diary.csv': ['Name', 'Year', 'Watched Date'],
  'reviews.csv': ['Date', 'Name', 'Year', 'Review'],
  'profile.csv': [],
};

function isEntry(name: string): name is EntryName {
  return (LETTERBOXD_ENTRIES as readonly string[]).includes(name);
}

/** Pass 1: declared sizes from the central directory. Nothing is inflated. */
function declaredSizes(bytes: Uint8Array, limits: ZipLimits): Map<EntryName, number> {
  const declared = new Map<EntryName, number>();
  let total = 0;
  let nested = false;
  try {
    unzipSync(bytes, {
      filter(file) {
        if (isEntry(file.name)) {
          if (declared.has(file.name)) throw new ApiError(422, UNREADABLE);
          if (file.originalSize > limits.maxEntryBytes) throw new ApiError(413, TOO_BIG);
          total += file.originalSize;
          if (total > limits.maxTotalBytes) throw new ApiError(413, TOO_BIG);
          declared.set(file.name, file.originalSize);
        } else if (
          /^[^/]+\/(watched|ratings|watchlist)\.csv$/.test(file.name) &&
          !/^(deleted|orphaned|likes|lists)\//.test(file.name)
        ) {
          nested = true;
        }
        return false; // never inflate in this pass
      },
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(422, UNREADABLE);
  }
  if (!declared.has('watched.csv') && !declared.has('ratings.csv') && !declared.has('watchlist.csv')) {
    throw new ApiError(422, nested ? REZIPPED : NOT_AN_EXPORT);
  }
  return declared;
}

/** Pass 2: inflate only the declared allowlisted entries, counting every chunk. */
function inflateEntries(
  bytes: Uint8Array,
  declared: Map<EntryName, number>,
  limits: ZipLimits
): Map<EntryName, Uint8Array> {
  const parts = new Map<EntryName, Uint8Array[]>();
  const sizes = new Map<EntryName, number>();
  // An object, not a `let`: TypeScript would narrow a closure-assigned `let` to null below.
  const state: { failure: ApiError | null; total: number } = { failure: null, total: 0 };

  const unzip = new Unzip((file) => {
    if (!isEntry(file.name)) return; // never started, so never inflated
    const name = file.name;
    const expected = declared.get(name);
    if (expected === undefined || parts.has(name)) {
      // Present locally but absent from (or duplicated against) the central directory.
      state.failure ??= new ApiError(422, UNREADABLE);
      return;
    }
    const chunks: Uint8Array[] = [];
    parts.set(name, chunks);
    sizes.set(name, 0);
    file.ondata = (err, data, _final) => {
      if (state.failure) return;
      if (err) {
        state.failure = new ApiError(422, UNREADABLE);
        return;
      }
      const size = (sizes.get(name) ?? 0) + data.length;
      state.total += data.length;
      if (size > expected) {
        state.failure = new ApiError(422, UNREADABLE); // the declaration lied
      } else if (size > limits.maxEntryBytes || state.total > limits.maxTotalBytes) {
        state.failure = new ApiError(413, TOO_BIG);
      }
      if (state.failure) {
        file.terminate();
        return;
      }
      sizes.set(name, size);
      chunks.push(data);
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  try {
    unzip.push(bytes, true);
  } catch {
    state.failure ??= new ApiError(422, UNREADABLE);
  }
  if (state.failure) throw state.failure;

  const out = new Map<EntryName, Uint8Array>();
  for (const [name, expected] of declared) {
    const chunks = parts.get(name);
    if (!chunks || sizes.get(name) !== expected) throw new ApiError(422, UNREADABLE);
    const joined = new Uint8Array(expected);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    out.set(name, joined);
  }
  return out;
}

function decode(name: EntryName, bytes: Uint8Array): string {
  const body = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new ApiError(422, `${name} is not UTF-8 text.`);
  }
}

function headerOf(name: EntryName, text: string): string[] {
  try {
    const rows = parse(text, { to_line: 1, relax_column_count: true }) as string[][];
    return rows[0] ?? [];
  } catch {
    throw new ApiError(422, `${name} could not be read as CSV.`);
  }
}

function records(name: EntryName, text: string): Record<string, string>[] {
  const header = headerOf(name, text);
  for (const column of REQUIRED_COLUMNS[name]) {
    if (!header.includes(column)) {
      throw new ApiError(422, `${name} is missing its '${column}' column; is this a Letterboxd export?`);
    }
  }
  try {
    return parse(text, {
      // profile.csv: every column except Favorite Films maps to false, which csv-parse skips.
      columns:
        name === 'profile.csv'
          ? (cols: string[]) => cols.map((c) => (c === 'Favorite Films' ? c : false))
          : true,
      skip_empty_lines: true,
      relax_column_count: true,
    }) as Record<string, string>[];
  } catch {
    throw new ApiError(422, `${name} could not be read as CSV.`);
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const FILM_URI = /^https:\/\/(boxd\.it|letterboxd\.com)\//;

function yearOf(value: string | undefined): number | null {
  const t = (value ?? '').trim();
  return /^\d{4}$/.test(t) ? Number(t) : null;
}
function ratingOf(value: string | undefined): number | null {
  const t = (value ?? '').trim();
  if (!t) return null;
  const n = Number(t);
  return isValidRating(n) ? n : null;
}
function dateOf(value: string | undefined): string | null {
  const t = (value ?? '').trim();
  return DATE.test(t) ? t : null;
}
function uriOf(value: string | undefined): string | null {
  const t = (value ?? '').trim();
  return FILM_URI.test(t) ? t : null;
}
function nameYearKey(name: string, year: number | null): string {
  return `${name}\u0000${year ?? ''}`;
}

/** Joins the parsed entries into one film per film URI. Exported for tests only via readLetterboxdZip. */
function buildFilms(entries: Map<EntryName, Record<string, string>[]>): LetterboxdFilm[] {
  const films = new Map<string, LetterboxdFilm>();
  const upsert = (row: Record<string, string>, status: 'watched' | 'want', rating: number | null) => {
    const uri = uriOf(row['Letterboxd URI']);
    const name = (row.Name ?? '').trim();
    if (!uri || !name) return;
    const film = films.get(uri) ?? {
      uri,
      name,
      year: yearOf(row.Year),
      status,
      rating: null,
      review: null,
      lastWatchedOn: null,
      favorite: false,
    };
    if (status === 'watched') film.status = 'watched';
    if (rating !== null) film.rating = rating;
    films.set(uri, film);
  };
  for (const row of entries.get('watched.csv') ?? []) upsert(row, 'watched', null);
  for (const row of entries.get('ratings.csv') ?? []) upsert(row, 'watched', ratingOf(row.Rating));
  for (const row of entries.get('watchlist.csv') ?? []) upsert(row, 'want', null);

  // Diary and review URIs are ENTRY links (spec §2.1 finding 1): join by exact (Name, Year).
  // A pair shared by two films is ambiguous and joins to neither.
  const byNameYear = new Map<string, string | null>();
  for (const film of films.values()) {
    const key = nameYearKey(film.name, film.year);
    byNameYear.set(key, byNameYear.has(key) ? null : film.uri);
  }
  const filmFor = (row: Record<string, string>): LetterboxdFilm | null => {
    const uri = byNameYear.get(nameYearKey((row.Name ?? '').trim(), yearOf(row.Year)));
    return uri ? (films.get(uri) ?? null) : null;
  };

  for (const row of entries.get('diary.csv') ?? []) {
    const film = filmFor(row);
    const watched = dateOf(row['Watched Date']);
    if (film && watched && (film.lastWatchedOn === null || watched > film.lastWatchedOn)) {
      film.lastWatchedOn = watched;
    }
  }

  // Most recent review wins: by Date, then Watched Date; a later row wins a full tie.
  const best = new Map<string, { date: string; watched: string }>();
  for (const row of entries.get('reviews.csv') ?? []) {
    const film = filmFor(row);
    const review = (row.Review ?? '').trim();
    if (!film || !review) continue;
    const date = dateOf(row.Date) ?? '';
    const watched = dateOf(row['Watched Date']) ?? '';
    const prior = best.get(film.uri);
    if (!prior || date > prior.date || (date === prior.date && watched >= prior.watched)) {
      best.set(film.uri, { date, watched });
      film.review = review;
    }
  }

  const profile = entries.get('profile.csv')?.[0];
  for (const part of (profile?.['Favorite Films'] ?? '').split(',')) {
    const uri = uriOf(part);
    const film = uri ? films.get(uri) : undefined;
    if (film) film.favorite = true;
  }

  return [...films.values()];
}

export function readLetterboxdZip(
  bytes: Uint8Array,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS
): LetterboxdExport {
  const declared = declaredSizes(bytes, limits);
  const raw = inflateEntries(bytes, declared, limits);
  const parsed = new Map<EntryName, Record<string, string>[]>();
  for (const [name, entryBytes] of raw) parsed.set(name, records(name, decode(name, entryBytes)));
  return { films: buildFilms(parsed) };
}
```

- [ ] **Step 5: Add `readZipUpload` to `lib/server/import-upload.ts`**

Append:

```ts
const ZIP_TOO_LARGE = 'Uploaded ZIP exceeds the 10 MiB limit.';

/** The Letterboxd export upload: same 10 MiB in-memory bound and missing-file shape as CSV. */
export async function readZipUpload(
  request: Request
): Promise<{ bytes: Uint8Array; filename: string }> {
  const contentLength = request.headers.get('content-length');
  if (/^\d+$/.test(contentLength ?? '') && Number(contentLength) > MAX_IMPORT_BYTES) {
    throw new ApiError(413, ZIP_TOO_LARGE);
  }
  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) throw new MissingImportFileError();
  if (!file.name.toLowerCase().endsWith('.zip')) {
    throw new ApiError(422, 'Uploaded file must be a .zip');
  }
  if (file.size > MAX_IMPORT_BYTES) throw new ApiError(413, ZIP_TOO_LARGE);
  return { bytes: new Uint8Array(await file.arrayBuffer()), filename: file.name };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run lib/server/__tests__/letterboxd.test.ts`
Expected: PASS. If the `stops inflating ...` tests fail because fflate's streaming reader trusts
the local header's size in a way this code does not expect, read `node_modules/fflate/esm/index.mjs`
(`Unzip.prototype.push`) before changing the code, and keep both passes: the declared check and
the counted inflate are the two halves of the spec's guard.

- [ ] **Step 7: Mutation-check the ZIP bounds (spec §10 load-bearing)**

1. In `declaredSizes`, change `return false` to `return true` (inflate during the size pass).
   Run the bounds tests; `checks declared sizes before inflating anything` must go red (the error
   becomes the unsupported-method 422). Revert.
2. In `inflateEntries`, delete the `size > expected` branch. Run; the lying-size test must go red.
   Revert and rerun green.

Record both red runs in the ledger.

- [ ] **Step 8: Commit**

```bash
git add lib/server/letterboxd.ts lib/server/import-upload.ts lib/server/__tests__/fixtures/letterboxd.ts lib/server/__tests__/letterboxd.test.ts
git commit -m "feat(screen): read Letterboxd export ZIPs with bounded, allowlisted unzip (#96)"
```

---

### Task 4: Ownership-allowlisted title import

**Files:**
- Create: `lib/server/importTitles.ts`
- Test: `lib/server/__tests__/import-titles.test.ts`

**Interfaces:**
- Consumes: `LetterboxdFilm` (Task 3); `TitleRow`, `effectiveTitleRating`, `normalizeTitleKey`
  (Task 2); `setScreenEnabled` (Task 2); `schema.titles`; `utcnowTs`.
- Produces (contract, exact): `importLetterboxdFilms(db: Db, userId: string, films:
  LetterboxdFilm[]): Promise<{ inserted: number; updated: number; unchanged: number }>` — one
  transaction that also enables screen. Also exported for tests: `letterboxdChanges(existing:
  TitleRow, film: LetterboxdFilm)` and `LETTERBOXD_OWNED_FIELDS`.

**Rules (spec §3.4), each pinned by a test below:**
- Match: `letterboxd_uri` first; else `normalizeTitleKey(name, year)` against existing titles
  **that have no `letterboxd_uri`**, only when exactly one matches and the key is non-empty;
  otherwise insert. (A title already carrying a different Letterboxd URI is a different Letterboxd
  film; letting a key match claim it would collapse two films.)
- Letterboxd owns `letterboxd_rating`, `letterboxd_review`, `letterboxd_uri`, `last_watched_on`
  (later of stored and imported); `status` may only be promoted `want → watched`; `is_favorite` may
  be set true, never cleared. A value absent from the export never overwrites a stored one. Rows
  missing from a re-import are never deleted. `app_*`, `title`, `year`, `media_type` and identity
  columns are never written.
- A Letterboxd review is stored only when the title has an effective rating after the import (or
  is `dropped`), mirroring the book import's `seedReview` rule and the review-requires-rating
  invariant.
- `feedback_updated_at` is stamped on insert when the film is rated or a favorite, and on update
  when a profile-relevant field changed (rating, review, status, favorite, last watched). Setting
  only `letterboxd_uri` does not stamp it.

- [ ] **Step 1: Write the failing tests**

Create `lib/server/__tests__/import-titles.test.ts`:

```ts
import { and, asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { schema, type Db } from '../db';
import { importLetterboxdFilms, letterboxdChanges } from '../importTitles';
import type { LetterboxdFilm } from '../letterboxd';
import { readLetterboxdZip } from '../letterboxd';
import { isScreenEnabled, readScreenToggledAt } from '../screenSettings';
import type { TitleRow } from '../titles';
import { letterboxdZip } from './fixtures/letterboxd';
import { makeTestDb } from './helpers/pglite';

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await makeTestDb());
});
afterEach(async () => {
  await close();
});

function film(overrides: Partial<LetterboxdFilm> = {}): LetterboxdFilm {
  return {
    uri: 'https://boxd.it/aaa1',
    name: 'The Lantern Keeper',
    year: 2019,
    status: 'watched',
    rating: null,
    review: null,
    lastWatchedOn: null,
    favorite: false,
    ...overrides,
  };
}

async function titlesOf(userId = 'local'): Promise<TitleRow[]> {
  return db.select().from(schema.titles).where(eq(schema.titles.userId, userId)).orderBy(asc(schema.titles.id));
}

describe('importLetterboxdFilms — first import', () => {
  test('inserts every film as a movie, enables screen, and drops an unrated review', async () => {
    const { films } = readLetterboxdZip(letterboxdZip());
    expect(await importLetterboxdFilms(db, 'local', films)).toEqual({ inserted: 6, updated: 0, unchanged: 0 });
    const rows = await titlesOf();
    expect(rows.map((r) => [r.title, r.mediaType, r.status, r.letterboxdRating, r.isFavorite])).toEqual([
      ['The Lantern Keeper', 'movie', 'watched', 4.5, false],
      ['Salt & Static', 'movie', 'watched', 2, true],
      ['Quiet Harbor, Loud Sea', 'movie', 'watched', null, false],
      ['夜の図書館', 'movie', 'watched', 5, true],
      ['Paper Moons', 'movie', 'watched', null, false],
      ['Glass Orchard', 'movie', 'want', null, false],
    ]);
    const paper = rows.find((r) => r.title === 'Paper Moons');
    expect(paper?.letterboxdReview).toBeNull(); // review requires a rating
    expect(rows.find((r) => r.title === 'The Lantern Keeper')?.letterboxdReview).toBe('Second take wins.');
    expect(rows.every((r) => r.appRating === null && r.appReview === null)).toBe(true);
    expect(await isScreenEnabled(db, 'local')).toBe(true);
    const [meta] = await db.select().from(schema.profileMeta).where(eq(schema.profileMeta.userId, 'local'));
    expect(meta.rebuildReason).toBe('screen_enabled');
  });

  test('stamps feedback_updated_at only for rated or favorite inserts', async () => {
    await importLetterboxdFilms(db, 'local', [
      film({ uri: 'https://boxd.it/1', rating: 4 }),
      film({ uri: 'https://boxd.it/2', name: 'B', favorite: true }),
      film({ uri: 'https://boxd.it/3', name: 'C' }),
    ]);
    expect((await titlesOf()).map((r) => r.feedbackUpdatedAt !== null)).toEqual([true, true, false]);
  });
});

describe('importLetterboxdFilms — re-import', () => {
  test('an identical re-import changes nothing and does not restamp the toggle', async () => {
    const { films } = readLetterboxdZip(letterboxdZip());
    await importLetterboxdFilms(db, 'local', films);
    const toggled = await readScreenToggledAt(db, 'local');
    const before = await titlesOf();
    expect(await importLetterboxdFilms(db, 'local', films)).toEqual({ inserted: 0, updated: 0, unchanged: 6 });
    expect(await titlesOf()).toEqual(before);
    expect(await readScreenToggledAt(db, 'local')).toBe(toggled);
  });

  test('re-import honours the Letterboxd ownership allowlist', async () => {
    await db.insert(schema.titles).values({
      userId: 'local',
      mediaType: 'tv', // enrichment converted it; import must not flip it back
      title: 'The Lantern Keeper (edited)',
      year: 2018,
      status: 'dropped',
      letterboxdRating: 3,
      appRating: 2.5,
      appReview: 'my own words',
      letterboxdReview: 'old lb review',
      isFavorite: true,
      lastWatchedOn: '2025-01-01',
      letterboxdUri: 'https://boxd.it/aaa1',
      wikidataQid: 'Q42',
    });
    const counts = await importLetterboxdFilms(db, 'local', [
      film({ rating: 4.5, review: 'new lb review', favorite: false, lastWatchedOn: '2024-06-30' }),
    ]);
    expect(counts).toEqual({ inserted: 0, updated: 1, unchanged: 0 });
    const [row] = await titlesOf();
    expect(row).toMatchObject({
      mediaType: 'tv',
      title: 'The Lantern Keeper (edited)',
      year: 2018,
      status: 'dropped', // never demoted
      letterboxdRating: 4.5, // Letterboxd-owned
      letterboxdReview: 'new lb review', // Letterboxd-owned
      appRating: 2.5, // never touched
      appReview: 'my own words', // never touched
      isFavorite: true, // never cleared
      lastWatchedOn: '2025-01-01', // later of stored and imported
      wikidataQid: 'Q42',
    });
  });

  test('status is promoted want -> watched only, never demoted', async () => {
    await importLetterboxdFilms(db, 'local', [
      film({ uri: 'https://boxd.it/w', name: 'W', status: 'want' }),
      film({ uri: 'https://boxd.it/x', name: 'X', status: 'watched' }),
    ]);
    await importLetterboxdFilms(db, 'local', [
      film({ uri: 'https://boxd.it/w', name: 'W', status: 'watched' }),
      film({ uri: 'https://boxd.it/x', name: 'X', status: 'want' }),
    ]);
    expect((await titlesOf()).map((r) => [r.title, r.status])).toEqual([
      ['W', 'watched'],
      ['X', 'watched'],
    ]);
  });

  test('values absent from the export never overwrite stored ones', async () => {
    await importLetterboxdFilms(db, 'local', [film({ rating: 4, review: 'kept', lastWatchedOn: '2024-01-01' })]);
    await importLetterboxdFilms(db, 'local', [film()]);
    expect((await titlesOf())[0]).toMatchObject({ letterboxdRating: 4, letterboxdReview: 'kept', lastWatchedOn: '2024-01-01' });
  });

  test('rows missing from a re-import are never deleted', async () => {
    await importLetterboxdFilms(db, 'local', [film(), film({ uri: 'https://boxd.it/gone', name: 'Gone' })]);
    await importLetterboxdFilms(db, 'local', [film()]);
    expect((await titlesOf()).map((r) => r.title)).toEqual(['The Lantern Keeper', 'Gone']);
  });

  test('a later rating change bumps feedback_updated_at; a URI-only link does not', async () => {
    await db.insert(schema.titles).values({ userId: 'local', mediaType: 'movie', title: 'The Lantern Keeper', year: 2019, status: 'watched' });
    expect(await importLetterboxdFilms(db, 'local', [film()])).toEqual({ inserted: 0, updated: 1, unchanged: 0 });
    let [row] = await titlesOf();
    expect(row.letterboxdUri).toBe('https://boxd.it/aaa1');
    expect(row.feedbackUpdatedAt).toBeNull();
    await importLetterboxdFilms(db, 'local', [film({ rating: 3.5 })]);
    [row] = await titlesOf();
    expect(row.feedbackUpdatedAt).not.toBeNull();
  });
});

describe('importLetterboxdFilms — matching', () => {
  test('title+year fallback matches only a single non-empty candidate', async () => {
    await db.insert(schema.titles).values([
      { userId: 'local', mediaType: 'movie', title: '夜の図書館', year: 2016, status: 'want' },
      { userId: 'local', mediaType: 'movie', title: 'Twin', year: 2020, status: 'want' },
      { userId: 'local', mediaType: 'movie', title: 'twin!', year: 2020, status: 'want' },
      { userId: 'local', mediaType: 'movie', title: '!!!', year: 2021, status: 'want' },
      { userId: 'local', mediaType: 'movie', title: 'Linked', year: 2022, status: 'want', letterboxdUri: 'https://boxd.it/other' },
    ]);
    const counts = await importLetterboxdFilms(db, 'local', [
      film({ uri: 'https://boxd.it/cjk', name: '夜の図書館', year: 2016 }), // one candidate: match
      film({ uri: 'https://boxd.it/twin', name: 'Twin', year: 2020 }), // two candidates: insert
      film({ uri: 'https://boxd.it/qqq', name: '???', year: 2021 }), // empty key: insert
      film({ uri: 'https://boxd.it/linked', name: 'Linked', year: 2022 }), // candidate has a URI: insert
      film({ uri: 'https://boxd.it/yr', name: '夜の図書館', year: 2017 }), // different year: insert
    ]);
    expect(counts).toEqual({ inserted: 4, updated: 1, unchanged: 0 });
    const cjk = (await titlesOf()).filter((r) => r.title === '夜の図書館');
    expect(cjk.map((r) => [r.year, r.letterboxdUri, r.status])).toEqual([
      [2016, 'https://boxd.it/cjk', 'watched'],
      [2017, 'https://boxd.it/yr', 'watched'],
    ]);
  });

  test('two export films never both claim one manual title', async () => {
    await db.insert(schema.titles).values({ userId: 'local', mediaType: 'movie', title: 'Salt Static', year: 2021, status: 'want' });
    const counts = await importLetterboxdFilms(db, 'local', [
      film({ uri: 'https://boxd.it/s1', name: 'Salt & Static', year: 2021 }),
      film({ uri: 'https://boxd.it/s2', name: 'Salt, Static', year: 2021 }),
    ]);
    expect(counts).toEqual({ inserted: 1, updated: 1, unchanged: 0 });
  });

  test('never matches or modifies another user\'s titles', async () => {
    await db.insert(schema.titles).values({
      userId: 'other',
      mediaType: 'movie',
      title: 'The Lantern Keeper',
      year: 2019,
      status: 'want',
      letterboxdUri: 'https://boxd.it/aaa1',
    });
    const before = await titlesOf('other');
    expect(await importLetterboxdFilms(db, 'local', [film({ rating: 5 })])).toEqual({ inserted: 1, updated: 0, unchanged: 0 });
    expect(await titlesOf('other')).toEqual(before);
    expect(await isScreenEnabled(db, 'other')).toBe(false);
  });

  test('inserts in chunks without losing rows', async () => {
    const many = Array.from({ length: 450 }, (_, i) => film({ uri: `https://boxd.it/n${i}`, name: `Film ${i}` }));
    expect(await importLetterboxdFilms(db, 'local', many)).toEqual({ inserted: 450, updated: 0, unchanged: 0 });
    const n = await db.select().from(schema.titles).where(and(eq(schema.titles.userId, 'local')));
    expect(n).toHaveLength(450);
  });
});

describe('letterboxdChanges', () => {
  test('stores a Letterboxd review on an unrated dropped title', () => {
    const existing = { status: 'dropped', appRating: null, letterboxdRating: null, letterboxdReview: null, letterboxdUri: 'u', isFavorite: false, lastWatchedOn: null } as unknown as TitleRow;
    expect(letterboxdChanges(existing, film({ uri: 'u', review: 'gave up' }))).toEqual({ letterboxdReview: 'gave up' });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/server/__tests__/import-titles.test.ts`
Expected: FAIL — cannot resolve `../importTitles`.

- [ ] **Step 3: Write `lib/server/importTitles.ts`**

```ts
/**
 * Letterboxd import writer (spec §3.4). Import-once semantics, like the Goodreads import:
 * Letterboxd owns only LETTERBOXD_OWNED_FIELDS; app_* columns, title, year, media_type (which
 * enrichment may have changed to 'tv') and identity are never written by a re-import. Missing
 * rows are never deleted. The whole import and the screen opt-in land in one transaction
 * (spec §3.1).
 */
import { and, eq } from 'drizzle-orm';
import { schema, type Db, type DbTx } from './db';
import type { LetterboxdFilm } from './letterboxd';
import { setScreenEnabled } from './screenSettings';
import { utcnowTs } from './serialize';
import { effectiveTitleRating, normalizeTitleKey, type TitleRow } from './titles';

export const LETTERBOXD_OWNED_FIELDS = [
  'letterboxdRating',
  'letterboxdReview',
  'letterboxdUri',
  'lastWatchedOn',
  'status',
  'isFavorite',
] as const;

type OwnedField = (typeof LETTERBOXD_OWNED_FIELDS)[number];
export type TitleUpdate = Partial<Pick<TitleRow, OwnedField>>;

/** Fields whose change is profile-relevant and therefore stamps feedback_updated_at. */
const PROFILE_FIELDS: readonly OwnedField[] = [
  'letterboxdRating',
  'letterboxdReview',
  'status',
  'isFavorite',
  'lastWatchedOn',
];

export interface TitleImportCounts {
  inserted: number;
  updated: number;
  unchanged: number;
}

const INSERT_CHUNK = 200;

/** The allowlisted changes a re-import may make to one existing title. Empty = unchanged. */
export function letterboxdChanges(existing: TitleRow, film: LetterboxdFilm): TitleUpdate {
  const next: TitleUpdate = {};
  if (existing.letterboxdUri === null) next.letterboxdUri = film.uri;
  if (film.rating !== null && film.rating !== existing.letterboxdRating) {
    next.letterboxdRating = film.rating;
  }
  if (existing.status === 'want' && film.status === 'watched') next.status = 'watched';
  if (film.favorite && !existing.isFavorite) next.isFavorite = true;
  if (
    film.lastWatchedOn !== null &&
    (existing.lastWatchedOn === null || film.lastWatchedOn > existing.lastWatchedOn)
  ) {
    next.lastWatchedOn = film.lastWatchedOn;
  }
  const ratedAfter =
    effectiveTitleRating({
      appRating: existing.appRating,
      letterboxdRating: next.letterboxdRating ?? existing.letterboxdRating,
    }) !== null;
  const dropped = (next.status ?? existing.status) === 'dropped';
  if (film.review !== null && film.review !== existing.letterboxdReview && (ratedAfter || dropped)) {
    next.letterboxdReview = film.review;
  }
  return next;
}

async function applyFilms(
  tx: DbTx,
  userId: string,
  films: LetterboxdFilm[]
): Promise<TitleImportCounts> {
  const existing = await tx.select().from(schema.titles).where(eq(schema.titles.userId, userId));
  const byUri = new Map<string, TitleRow>();
  const byKey = new Map<string, TitleRow[]>();
  for (const row of existing) {
    if (row.letterboxdUri !== null) {
      byUri.set(row.letterboxdUri, row);
      continue;
    }
    const key = normalizeTitleKey(row.title, row.year);
    if (key) byKey.set(key, [...(byKey.get(key) ?? []), row]);
  }

  const now = utcnowTs();
  const claimed = new Set<number>();
  const inserts: (typeof schema.titles.$inferInsert)[] = [];
  let updated = 0;
  let unchanged = 0;

  for (const film of films) {
    let match = byUri.get(film.uri);
    if (!match) {
      const key = normalizeTitleKey(film.name, film.year);
      const candidates = key ? (byKey.get(key) ?? []) : [];
      if (candidates.length === 1 && !claimed.has(candidates[0].id)) match = candidates[0];
    }

    if (match) {
      claimed.add(match.id);
      const changes = letterboxdChanges(match, film);
      if (Object.keys(changes).length === 0) {
        unchanged += 1;
        continue;
      }
      const touchesProfile = PROFILE_FIELDS.some((field) => field in changes);
      await tx
        .update(schema.titles)
        .set({ ...changes, updatedAt: now, ...(touchesProfile ? { feedbackUpdatedAt: now } : {}) })
        .where(and(eq(schema.titles.userId, userId), eq(schema.titles.id, match.id)));
      updated += 1;
      continue;
    }

    inserts.push({
      userId,
      mediaType: 'movie', // enrichment converts Letterboxd-logged series to 'tv' (spec decision 18)
      title: film.name,
      year: film.year,
      status: film.status,
      letterboxdRating: film.rating,
      letterboxdReview: film.rating !== null ? film.review : null,
      lastWatchedOn: film.lastWatchedOn,
      letterboxdUri: film.uri,
      isFavorite: film.favorite,
      feedbackUpdatedAt: film.rating !== null || film.favorite ? now : null,
    });
  }

  for (let i = 0; i < inserts.length; i += INSERT_CHUNK) {
    await tx.insert(schema.titles).values(inserts.slice(i, i + INSERT_CHUNK));
  }
  return { inserted: inserts.length, updated, unchanged };
}

export async function importLetterboxdFilms(
  db: Db,
  userId: string,
  films: LetterboxdFilm[]
): Promise<TitleImportCounts> {
  return db.transaction(async (tx) => {
    const counts = await applyFilms(tx, userId, films);
    await setScreenEnabled(tx, userId, true);
    return counts;
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run lib/server/__tests__/import-titles.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation-check the ownership rules (spec §10 load-bearing)**

One at a time, run the file after each break, confirm the named test goes red, revert:
1. Replace `if (existing.status === 'want' && film.status === 'watched') next.status = 'watched';`
   with `if (film.status !== existing.status) next.status = film.status;` → `status is promoted
   want -> watched only` and `re-import honours ...` go red.
2. Add `appRating: film.rating,` to the `.set({...})` object → `re-import honours ...` goes red.
3. Before the insert loop, add
   `await tx.delete(schema.titles).where(eq(schema.titles.userId, userId));` guarded by
   `if (films.length)` → `rows missing from a re-import are never deleted` goes red.

Record each red run in the ledger.

- [ ] **Step 6: Commit**

```bash
git add lib/server/importTitles.ts lib/server/__tests__/import-titles.test.ts
git commit -m "feat(screen): import Letterboxd films under an ownership allowlist (#96)"
```

---

### Task 5: Import and settings routes

**Files:**
- Modify: `lib/server/ratelimit.ts`
- Create: `app/api/screen/import/route.ts`, `app/api/settings/screen/route.ts`
- Test: `lib/server/__tests__/screen-import-routes.test.ts`

**Interfaces:**
- Consumes: `readZipUpload`, `missingImportFileResponse` (Task 3 / existing),
  `readLetterboxdZip` (Task 3), `importLetterboxdFilms` (Task 4), `isScreenEnabled`,
  `readScreenToggledAt`, `setScreenEnabled`, `countTitles` (Task 2).
- Produces (contract "HTTP routes", wave 4 rows):
  - `POST /api/screen/import` (multipart field `file`) → `{ inserted, updated, unchanged }`.
    Wave 5 adds `job`.
  - `GET /api/settings/screen` → `{ enabled, toggled_at, title_count }`.
  - `PUT /api/settings/screen` `{ enabled: boolean }` → same shape. Disabling is a plain flag flip
    in this wave; wave 6 replaces the disable branch with the §5.7 opt-out.
  - `RATE_LIMITS.screenImport = { limit: 5, windowSeconds: 60 }`.

- [ ] **Step 1: Write the failing tests**

Create `lib/server/__tests__/screen-import-routes.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { POST as importRoute } from '../../../app/api/screen/import/route';
import { GET as getScreen, PUT as putScreen } from '../../../app/api/settings/screen/route';
import { _setDbForTests, schema, type Db } from '../db';
import { letterboxdZip } from './fixtures/letterboxd';
import { makeTestDb } from './helpers/pglite';

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await makeTestDb());
  _setDbForTests(db);
});
afterEach(async () => {
  _setDbForTests(null);
  await close();
});

function upload(filename: string, contents: BlobPart): Request {
  const form = new FormData();
  form.set('file', new File([contents], filename, { type: 'application/zip' }));
  return new Request('http://test/api/screen/import', { method: 'POST', body: form });
}

function put(body: unknown): Request {
  return new Request('http://test/api/settings/screen', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/screen/import', () => {
  test('imports the synthetic export, enables screen, and reports counts', async () => {
    const res = await importRoute(upload('letterboxd-export.ZIP', letterboxdZip()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ inserted: 6, updated: 0, unchanged: 0 });
    const state = await (await getScreen(new Request('http://test/api/settings/screen'))).json();
    expect(state).toEqual({ enabled: true, toggled_at: expect.any(String), title_count: 6 });
    const again = await importRoute(upload('letterboxd-export.zip', letterboxdZip()));
    expect(await again.json()).toEqual({ inserted: 0, updated: 0, unchanged: 6 });
  });

  test('rejects a missing file, a non-zip name, an oversize body, and a non-Letterboxd zip', async () => {
    const missing = await importRoute(
      new Request('http://test/api/screen/import', { method: 'POST', body: new FormData() })
    );
    expect({ status: missing.status, body: await missing.json() }).toEqual({
      status: 422,
      body: { detail: [{ type: 'missing', loc: ['body', 'file'], msg: 'Field required', input: null }] },
    });
    const wrongName = await importRoute(upload('export.csv', 'x'));
    expect({ status: wrongName.status, body: await wrongName.json() }).toEqual({
      status: 422,
      body: { detail: 'Uploaded file must be a .zip' },
    });
    const oversize = await importRoute(
      new Request('http://test/api/screen/import', {
        method: 'POST',
        headers: { 'content-length': String(10 * 1024 * 1024 + 1) },
        body: new FormData(),
      })
    );
    expect({ status: oversize.status, body: await oversize.json() }).toEqual({
      status: 413,
      body: { detail: 'Uploaded ZIP exceeds the 10 MiB limit.' },
    });
    const other = await importRoute(upload('photos.zip', letterboxdZip({ 'a.jpg': 'x' })));
    expect(other.status).toBe(422);
    expect(await db.select().from(schema.titles)).toEqual([]);
    const state = await (await getScreen(new Request('http://test/api/settings/screen'))).json();
    expect(state.enabled).toBe(false); // a failed import never enables screen
  });

  test('is rate limited per user', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push((await importRoute(upload('e.zip', letterboxdZip()))).status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });

  test("never touches another user's titles", async () => {
    await db.insert(schema.titles).values({
      userId: 'other',
      mediaType: 'movie',
      title: 'The Lantern Keeper',
      year: 2019,
      status: 'want',
      letterboxdUri: 'https://boxd.it/aaa1',
    });
    await importRoute(upload('e.zip', letterboxdZip()));
    const other = await db.select().from(schema.titles).where(eq(schema.titles.userId, 'other'));
    expect(other.map((r) => [r.status, r.letterboxdRating])).toEqual([['want', null]]);
  });
});

describe('GET/PUT /api/settings/screen', () => {
  test('defaults to off and toggles with a stamped time', async () => {
    const initial = await getScreen(new Request('http://test/api/settings/screen'));
    expect(await initial.json()).toEqual({ enabled: false, toggled_at: null, title_count: 0 });
    const on = await putScreen(put({ enabled: true }));
    expect(on.status).toBe(200);
    const onBody = await on.json();
    expect(onBody).toEqual({ enabled: true, toggled_at: expect.stringMatching(/T/), title_count: 0 });
    const off = await (await putScreen(put({ enabled: false }))).json();
    expect(off.enabled).toBe(false);
    const [meta] = await db.select().from(schema.profileMeta).where(eq(schema.profileMeta.userId, 'local'));
    expect(meta.rebuildReason).not.toBeNull();
  });

  test('rejects a body without a boolean enabled', async () => {
    for (const body of [{}, { enabled: 'yes' }, { enabled: true, extra: 1 }]) {
      const res = await putScreen(put(body));
      expect({ status: res.status, body: await res.json() }).toEqual({
        status: 422,
        body: { detail: 'enabled must be true or false.' },
      });
    }
  });

  test("reports only the caller's state", async () => {
    await db.insert(schema.userSettings).values({ userId: 'other', screenEnabled: true });
    await db.insert(schema.titles).values({ userId: 'other', mediaType: 'movie', title: 'X', status: 'want' });
    const res = await getScreen(new Request('http://test/api/settings/screen'));
    expect(await res.json()).toEqual({ enabled: false, toggled_at: null, title_count: 0 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/server/__tests__/screen-import-routes.test.ts`
Expected: FAIL — the route modules do not exist.

- [ ] **Step 3: Add the rate limit**

In `lib/server/ratelimit.ts`, inside `RATE_LIMITS` after `discover`:

```ts
  screenImport: { limit: 5, windowSeconds: 60 },
```

- [ ] **Step 4: Write `app/api/screen/import/route.ts`**

```ts
import { getDb } from '@/lib/server/db';
import { withApi } from '@/lib/server/http';
import { missingImportFileResponse, readZipUpload } from '@/lib/server/import-upload';
import { importLetterboxdFilms } from '@/lib/server/importTitles';
import { readLetterboxdZip } from '@/lib/server/letterboxd';
import { checkRateLimit, RATE_LIMITS, rateLimitExceededResponse } from '@/lib/server/ratelimit';

export const runtime = 'nodejs';

/**
 * Letterboxd export import (spec §3.4). The first successful import turns ScreenSprite on in the
 * same transaction (spec §3.1). Wave 5 starts a screen enrichment job here and adds `job`.
 */
export const POST = withApi('/api/screen/import', async (req, ctx) => {
  try {
    const db = getDb();
    const rateLimit = await checkRateLimit(db, {
      key: `screenImport:${ctx.user.userId}`,
      ...RATE_LIMITS.screenImport,
    });
    if (!rateLimit.allowed) {
      return rateLimitExceededResponse(
        RATE_LIMITS.screenImport.limit,
        RATE_LIMITS.screenImport.windowSeconds
      );
    }
    const { bytes } = await readZipUpload(req);
    const { films } = readLetterboxdZip(bytes);
    const counts = await importLetterboxdFilms(db, ctx.user.userId, films);
    ctx.timer.mark('db');
    return Response.json(counts);
  } catch (error) {
    const missing = missingImportFileResponse(error);
    if (missing) return missing;
    throw error;
  }
});
```

- [ ] **Step 5: Write `app/api/settings/screen/route.ts`**

```ts
import { z } from 'zod';
import { getDb, type Db } from '@/lib/server/db';
import { ApiError, withApi } from '@/lib/server/http';
import {
  countTitles,
  isScreenEnabled,
  readScreenToggledAt,
  setScreenEnabled,
} from '@/lib/server/screenSettings';
import { tsToIso } from '@/lib/server/serialize';

const Body = z.object({ enabled: z.boolean() }).strict();

async function screenState(db: Db, userId: string) {
  // Sequential on purpose: db.ts runs one pooled connection.
  const enabled = await isScreenEnabled(db, userId);
  const toggledAt = await readScreenToggledAt(db, userId);
  const titleCount = await countTitles(db, userId);
  return { enabled, toggled_at: tsToIso(toggledAt), title_count: titleCount };
}

export const GET = withApi('/api/settings/screen', async (_req, ctx) => {
  const db = getDb();
  const state = await screenState(db, ctx.user.userId);
  ctx.timer.mark('db');
  return Response.json(state);
});

export const PUT = withApi('/api/settings/screen', async (req, ctx) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw new ApiError(422, 'enabled must be true or false.');
  const db = getDb();
  // Wave 4: disabling is a plain flag flip (stamps screen_toggled_at, sets the rebuild reason).
  // Wave 6 replaces the disable branch with the spec §5.7 opt-out (trait deletion, archetype clear).
  await db.transaction((tx) => setScreenEnabled(tx, ctx.user.userId, parsed.data.enabled));
  const state = await screenState(db, ctx.user.userId);
  ctx.timer.mark('db');
  return Response.json(state);
});
```

- [ ] **Step 6: Run to verify it passes**

Run: `npx vitest run lib/server/__tests__/screen-import-routes.test.ts lib/server/__tests__/ratelimit.test.ts lib/server/__tests__/ratelimit-routes.test.ts`
Expected: PASS. If a ratelimit test enumerates `RATE_LIMITS` keys exactly, add `screenImport`
to its expectation (an intended addition, not a weakened assertion).

- [ ] **Step 7: Commit**

```bash
git add lib/server/ratelimit.ts app/api/screen/import/route.ts app/api/settings/screen/route.ts lib/server/__tests__/screen-import-routes.test.ts
git commit -m "feat(screen): add Letterboxd import and ScreenSprite settings routes (#96)"
```

---

### Task 6: Title list, detail, edit and delete routes

**Files:**
- Create: `app/api/screen/titles/route.ts`, `app/api/screen/titles/[id]/route.ts`
- Test: `lib/server/__tests__/screen-title-routes.test.ts`

**Interfaces:**
- Consumes: `titleOut`, `effectiveTitleRating`, `effectiveTitleReview`,
  `isTitleProfileEvidence`, `MEDIA_TYPES`, `TITLE_STATUSES` (Task 2); `requireScreenEnabled`
  (Task 2); `setRebuildReason` (wave 2); `isValidRating`; `parseIdParam`, `utcnowTs`.
- Produces (contract): `GET /api/screen/titles?type=&status=` → `TitleOut[]` ordered by id;
  `GET/PATCH/DELETE /api/screen/titles/[id]`. PATCH body
  `{ rating?, review?, status?, is_favorite?, exclude_from_profile? }`; `review: ""` clears
  `app_review`. DELETE → `{ id, title, removed: true }`. Wave 5 adds `POST` to
  `app/api/screen/titles/route.ts`.

Rules mirrored from `app/api/books/[id]/feedback/route.ts`: rating `0` clears `app_rating`; the
`isValidRating` guard owns the 422; the review-requires-rating guard runs **after** applying the
change, with `dropped` exempt (spec §3.2); every change stamps `feedback_updated_at`. Delete sets
`rebuild_reason = 'title_deleted'` only when the title was profile evidence or is cited by a trait
— deleting a watchlist entry must not force a full Claude rebuild.

- [ ] **Step 1: Write the failing tests**

Create `lib/server/__tests__/screen-title-routes.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { GET as listTitles } from '../../../app/api/screen/titles/route';
import {
  DELETE as deleteTitle,
  GET as getTitle,
  PATCH as patchTitle,
} from '../../../app/api/screen/titles/[id]/route';
import { _setDbForTests, schema, type Db } from '../db';
import { makeTestDb } from './helpers/pglite';

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await makeTestDb());
  _setDbForTests(db);
});
afterEach(async () => {
  _setDbForTests(null);
  await close();
});

async function enable(userId = 'local') {
  await db.insert(schema.userSettings).values({ userId, screenEnabled: true });
}

async function title(values: Partial<typeof schema.titles.$inferInsert> = {}) {
  const [row] = await db
    .insert(schema.titles)
    .values({ userId: 'local', mediaType: 'movie', title: 'The Lantern Keeper', year: 2019, status: 'watched', ...values })
    .returning();
  return row;
}

const params = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });
const patch = (id: number, body: unknown) =>
  patchTitle(
    new Request(`http://test/api/screen/titles/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    params(id)
  );
const del = (id: number) =>
  deleteTitle(new Request(`http://test/api/screen/titles/${id}`, { method: 'DELETE' }), params(id));

async function reason(): Promise<string | null> {
  const rows = await db.select().from(schema.profileMeta).where(eq(schema.profileMeta.userId, 'local'));
  return rows[0]?.rebuildReason ?? null;
}

describe('GET /api/screen/titles', () => {
  test('is 403 while screen is disabled', async () => {
    const res = await listTitles(new Request('http://test/api/screen/titles'));
    expect({ status: res.status, body: await res.json() }).toEqual({
      status: 403,
      body: { detail: 'ScreenSprite is not enabled for this account.' },
    });
  });

  test("lists only the caller's titles, filtered, in id order, with enrichment", async () => {
    await enable();
    const a = await title({ title: 'A', status: 'want' });
    const b = await title({ title: 'B', mediaType: 'tv', status: 'watching', letterboxdRating: 4 });
    await title({ userId: 'other', title: 'Secret' });
    await db.insert(schema.titleEnrichment).values({ titleId: b.id, resolutionConfidence: 0.95, confidenceLabel: 'HIGH', genres: ['drama'] });
    const all = await (await listTitles(new Request('http://test/api/screen/titles'))).json();
    expect(all.map((t: { title: string }) => t.title)).toEqual(['A', 'B']);
    expect(all[0].enrichment).toBeNull();
    expect(all[1].enrichment).toMatchObject({ confidence_label: 'HIGH', genres: ['drama'] });
    const tv = await (await listTitles(new Request('http://test/api/screen/titles?type=tv'))).json();
    expect(tv.map((t: { id: number }) => t.id)).toEqual([b.id]);
    const want = await (await listTitles(new Request('http://test/api/screen/titles?status=want'))).json();
    expect(want.map((t: { id: number }) => t.id)).toEqual([a.id]);
    const bad = await listTitles(new Request('http://test/api/screen/titles?type=book'));
    expect(bad.status).toBe(422);
  });
});

describe('GET /api/screen/titles/[id]', () => {
  test("returns the caller's title and 404s another user's", async () => {
    await enable();
    const mine = await title();
    const theirs = await title({ userId: 'other' });
    const ok = await getTitle(new Request('http://test'), params(mine.id));
    expect((await ok.json()).title).toBe('The Lantern Keeper');
    const other = await getTitle(new Request('http://test'), params(theirs.id));
    expect({ status: other.status, body: await other.json() }).toEqual({
      status: 404,
      body: { detail: `Title ${theirs.id} not found.` },
    });
    expect((await getTitle(new Request('http://test'), params('abc'))).status).toBe(422);
  });
});

describe('PATCH /api/screen/titles/[id]', () => {
  test('rating 4.5 sets app_rating; 0 clears it back to the Letterboxd rating', async () => {
    await enable();
    const t = await title({ letterboxdRating: 3 });
    const set = await (await patch(t.id, { rating: 4.5 })).json();
    expect([set.rating, set.app_rating, set.letterboxd_rating]).toEqual([4.5, 4.5, 3]);
    const cleared = await (await patch(t.id, { rating: 0 })).json();
    expect([cleared.rating, cleared.app_rating]).toEqual([3, null]);
    const [row] = await db.select().from(schema.titles).where(eq(schema.titles.id, t.id));
    expect(row.feedbackUpdatedAt).not.toBeNull();
    expect(row.updatedAt).not.toBeNull();
  });

  test('rejects off-grid ratings and empty bodies with the stable messages', async () => {
    await enable();
    const t = await title();
    const bad = await patch(t.id, { rating: 4.3 });
    expect({ status: bad.status, body: await bad.json() }).toEqual({
      status: 422,
      body: { detail: 'rating must be 0.5 to 5 in half-star steps (or 0 to clear).' },
    });
    const empty = await patch(t.id, {});
    expect({ status: empty.status, body: await empty.json() }).toEqual({
      status: 422,
      body: { detail: 'Nothing to update: pass a rating, review, status, favorite, and/or exclude flag.' },
    });
    const status = await patch(t.id, { status: 'read' });
    expect(status.status).toBe(422);
  });

  test('PATCH enforces review-requires-rating after applying the change', async () => {
    await enable();
    const unrated = await title();
    const res = await patch(unrated.id, { review: 'great' });
    expect({ status: res.status, body: await res.json() }).toEqual({
      status: 422,
      body: { detail: 'A review requires a rating. Rate the title 0.5 to 5 (same update is fine) before saving a review.' },
    });
    expect((await patch(unrated.id, { review: 'great', rating: 4 })).status).toBe(200);
    // Clearing the only rating while an app review exists is rejected...
    expect((await patch(unrated.id, { rating: 0 })).status).toBe(422);
    // ...unless the title is dropped (DNF semantics, spec §3.2).
    const dropped = await title({ title: 'Dropped', status: 'dropped' });
    expect((await patch(dropped.id, { review: 'gave up' })).status).toBe(200);
    // Leaving dropped with an unrated review is rejected.
    expect((await patch(dropped.id, { status: 'watched' })).status).toBe(422);
  });

  test('PATCH review "" clears app_review and reveals the Letterboxd review', async () => {
    await enable();
    const t = await title({ letterboxdRating: 4, letterboxdReview: 'lb words', appReview: 'app words' });
    const body = await (await patch(t.id, { review: '' })).json();
    expect([body.review, body.app_review, body.letterboxd_review]).toEqual(['lb words', null, 'lb words']);
  });

  test('sets status, favorite and exclusion', async () => {
    await enable();
    const t = await title({ status: 'want' });
    const body = await (await patch(t.id, { status: 'watching', is_favorite: true, exclude_from_profile: true })).json();
    expect([body.status, body.is_favorite, body.exclude_from_profile]).toEqual(['watching', true, true]);
  });

  test("404s another user's title and leaves it unchanged; 403 while disabled", async () => {
    await enable();
    const theirs = await title({ userId: 'other' });
    const res = await patch(theirs.id, { rating: 5 });
    expect(res.status).toBe(404);
    const [row] = await db.select().from(schema.titles).where(eq(schema.titles.id, theirs.id));
    expect(row.appRating).toBeNull();
    await db.update(schema.userSettings).set({ screenEnabled: false });
    expect((await patch((await title()).id, { rating: 5 })).status).toBe(403);
  });
});

describe('DELETE /api/screen/titles/[id]', () => {
  test('removes an evidence title and its enrichment, sets the rebuild reason', async () => {
    await enable();
    const t = await title({ letterboxdRating: 4 });
    await db.insert(schema.titleEnrichment).values({ titleId: t.id, resolutionConfidence: 0.95 });
    const other = await title({ title: 'Twin' });
    await db.insert(schema.titleEnrichment).values({ titleId: other.id, resolutionConfidence: 0.3, duplicateOfTitleId: t.id });
    const res = await del(t.id);
    expect(await res.json()).toEqual({ id: t.id, title: 'The Lantern Keeper', removed: true });
    expect(await db.select().from(schema.titles).where(eq(schema.titles.id, t.id))).toEqual([]);
    expect(await db.select().from(schema.titleEnrichment).where(eq(schema.titleEnrichment.titleId, t.id))).toEqual([]);
    const [twin] = await db.select().from(schema.titleEnrichment).where(eq(schema.titleEnrichment.titleId, other.id));
    expect(twin.duplicateOfTitleId).toBeNull();
    expect(await reason()).toBe('title_deleted');
  });

  test('deleting a watchlist title does not force a rebuild unless a trait cites it', async () => {
    await enable();
    const want = await title({ status: 'want' });
    await del(want.id);
    expect(await reason()).toBeNull();
    const cited = await title({ status: 'want', title: 'Cited' });
    await db.insert(schema.tasteTraits).values({
      userId: 'local',
      claim: 'c',
      polarity: 'reward',
      inferenceConfidence: 1,
      status: 'proposed',
      exhibitTitleIds: [cited.id],
    });
    await del(cited.id);
    expect(await reason()).toBe('title_deleted');
  });

  test("404s another user's title", async () => {
    await enable();
    const theirs = await title({ userId: 'other' });
    expect((await del(theirs.id)).status).toBe(404);
    expect(await db.select().from(schema.titles).where(eq(schema.titles.id, theirs.id))).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/server/__tests__/screen-title-routes.test.ts`
Expected: FAIL — route modules missing.

- [ ] **Step 3: Write `app/api/screen/titles/route.ts`**

```ts
import { and, asc, eq, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, schema } from '@/lib/server/db';
import { ApiError, withApi } from '@/lib/server/http';
import { requireScreenEnabled } from '@/lib/server/screenSettings';
import { MEDIA_TYPES, TITLE_STATUSES, titleOut } from '@/lib/server/titles';

const Query = z.object({
  type: z.enum(MEDIA_TYPES).optional(),
  status: z.enum(TITLE_STATUSES).optional(),
});

export const GET = withApi('/api/screen/titles', async (req, ctx) => {
  const url = new URL(req.url);
  const parsed = Query.safeParse({
    type: url.searchParams.get('type') ?? undefined,
    status: url.searchParams.get('status') ?? undefined,
  });
  if (!parsed.success) {
    throw new ApiError(
      422,
      "type must be 'movie' or 'tv'; status must be watched, watching, dropped or want."
    );
  }
  const db = getDb();
  await requireScreenEnabled(db, ctx.user.userId);
  const conds: SQL[] = [eq(schema.titles.userId, ctx.user.userId)];
  if (parsed.data.type) conds.push(eq(schema.titles.mediaType, parsed.data.type));
  if (parsed.data.status) conds.push(eq(schema.titles.status, parsed.data.status));
  const rows = await db
    .select({ title: schema.titles, enrichment: schema.titleEnrichment })
    .from(schema.titles)
    .leftJoin(schema.titleEnrichment, eq(schema.titleEnrichment.titleId, schema.titles.id))
    .where(and(...conds))
    .orderBy(asc(schema.titles.id));
  ctx.timer.mark('db');
  return Response.json(rows.map((r) => titleOut(r.title, r.enrichment)));
});
```

- [ ] **Step 4: Write `app/api/screen/titles/[id]/route.ts`**

```ts
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, schema, type Db, type DbTx } from '@/lib/server/db';
import { ApiError, withApi } from '@/lib/server/http';
import { setRebuildReason } from '@/lib/server/profileMeta';
import { isValidRating } from '@/lib/server/rating';
import { requireScreenEnabled } from '@/lib/server/screenSettings';
import { parseIdParam, utcnowTs } from '@/lib/server/serialize';
import {
  effectiveTitleRating,
  effectiveTitleReview,
  isTitleProfileEvidence,
  TITLE_STATUSES,
  titleOut,
  type TitleRow,
} from '@/lib/server/titles';

// Permissive z.number() on purpose: the manual isValidRating guard owns the 422 (CLAUDE.md).
const Body = z.object({
  rating: z.number().nullish(),
  review: z.string().nullish(),
  status: z.enum(TITLE_STATUSES).nullish(),
  is_favorite: z.boolean().nullish(),
  exclude_from_profile: z.boolean().nullish(),
});

async function loadOwned(db: Db, userId: string, id: number) {
  const rows = await db
    .select({ title: schema.titles, enrichment: schema.titleEnrichment })
    .from(schema.titles)
    .leftJoin(schema.titleEnrichment, eq(schema.titleEnrichment.titleId, schema.titles.id))
    .where(and(eq(schema.titles.id, id), eq(schema.titles.userId, userId)));
  const row = rows[0];
  if (!row) throw new ApiError(404, `Title ${id} not found.`);
  return row;
}

export const GET = withApi('/api/screen/titles/[id]', async (_req, ctx) => {
  const id = parseIdParam(ctx.params.id);
  const db = getDb();
  await requireScreenEnabled(db, ctx.user.userId);
  const row = await loadOwned(db, ctx.user.userId, id);
  ctx.timer.mark('db');
  return Response.json(titleOut(row.title, row.enrichment));
});

export const PATCH = withApi('/api/screen/titles/[id]', async (req, ctx) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError(422, `validation error: ${parsed.error.issues[0]?.message ?? 'invalid body'}`);
  }
  const b = parsed.data;
  const id = parseIdParam(ctx.params.id);

  // 0 is the clear sentinel, not a rating.
  if (b.rating != null && b.rating !== 0 && !isValidRating(b.rating)) {
    throw new ApiError(422, 'rating must be 0.5 to 5 in half-star steps (or 0 to clear).');
  }
  if (
    b.rating == null &&
    b.review == null &&
    b.status == null &&
    b.is_favorite == null &&
    b.exclude_from_profile == null
  ) {
    throw new ApiError(
      422,
      'Nothing to update: pass a rating, review, status, favorite, and/or exclude flag.'
    );
  }

  const db = getDb();
  await requireScreenEnabled(db, ctx.user.userId);
  const row = await loadOwned(db, ctx.user.userId, id);

  const next: TitleRow = { ...row.title };
  if (b.rating != null) next.appRating = b.rating === 0 ? null : b.rating;
  if (b.review != null) next.appReview = b.review.trim() || null;
  if (b.status != null) next.status = b.status;
  if (b.is_favorite != null) next.isFavorite = b.is_favorite;
  if (b.exclude_from_profile != null) next.excludeFromProfile = b.exclude_from_profile;

  // After applying, like the book route: a review needs an effective rating unless dropped.
  if (
    effectiveTitleReview(next) !== null &&
    effectiveTitleRating(next) === null &&
    next.status !== 'dropped'
  ) {
    throw new ApiError(
      422,
      'A review requires a rating. Rate the title 0.5 to 5 (same update is fine) before saving a review.'
    );
  }

  const now = utcnowTs();
  next.feedbackUpdatedAt = now;
  next.updatedAt = now;
  await db
    .update(schema.titles)
    .set({
      appRating: next.appRating,
      appReview: next.appReview,
      status: next.status,
      isFavorite: next.isFavorite,
      excludeFromProfile: next.excludeFromProfile,
      feedbackUpdatedAt: now,
      updatedAt: now,
    })
    .where(and(eq(schema.titles.id, id), eq(schema.titles.userId, ctx.user.userId)));
  ctx.timer.mark('db');
  return Response.json(titleOut(next, row.enrichment));
});

async function citedByTrait(tx: DbTx, userId: string, titleId: number): Promise<boolean> {
  const needle = JSON.stringify(titleId);
  const result = await tx.execute(sql`
    select 1 from taste_traits
    where user_id = ${userId}
      and (coalesce(exhibit_title_ids::jsonb, '[]'::jsonb) @> ${needle}::jsonb
        or coalesce(contrast_title_ids::jsonb, '[]'::jsonb) @> ${needle}::jsonb)
    limit 1
  `);
  const rows = Array.isArray(result) ? result : (result as { rows: unknown[] }).rows;
  return rows.length > 0;
}

export const DELETE = withApi('/api/screen/titles/[id]', async (_req, ctx) => {
  const id = parseIdParam(ctx.params.id);
  const userId = ctx.user.userId;
  const db = getDb();
  await requireScreenEnabled(db, userId);
  const row = await loadOwned(db, userId, id);
  await db.transaction(async (tx) => {
    // duplicate_of_title_id is a plain integer (merging is out of v1); clear dangling pointers.
    await tx
      .update(schema.titleEnrichment)
      .set({ duplicateOfTitleId: null })
      .where(
        and(
          eq(schema.titleEnrichment.duplicateOfTitleId, id),
          inArray(
            schema.titleEnrichment.titleId,
            tx.select({ id: schema.titles.id }).from(schema.titles).where(eq(schema.titles.userId, userId))
          )
        )
      );
    // LOAD-BEARING order: title_enrichment.title_id is an FK with no cascade.
    await tx.delete(schema.titleEnrichment).where(eq(schema.titleEnrichment.titleId, id));
    await tx
      .delete(schema.titles)
      .where(and(eq(schema.titles.id, id), eq(schema.titles.userId, userId)));
    // Spec §5.5: deleting a title forces a full rebuild -- but only when the profile could have
    // used it. A watchlist entry nobody cites changes nothing.
    if (isTitleProfileEvidence(row.title) || (await citedByTrait(tx, userId, id))) {
      await setRebuildReason(tx, userId, 'title_deleted');
    }
  });
  ctx.timer.mark('db');
  return Response.json({ id, title: row.title.title, removed: true });
});
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run lib/server/__tests__/screen-title-routes.test.ts`
Expected: PASS.

- [ ] **Step 6: Mutation-check tenancy (spec §10 load-bearing)**

Remove `eq(schema.titles.userId, userId)` from `loadOwned`'s `where`. Run the file: every
"another user's" test must go red. Revert and rerun green. Record in the ledger.

- [ ] **Step 7: Commit**

```bash
git add app/api/screen/titles lib/server/__tests__/screen-title-routes.test.ts
git commit -m "feat(screen): add title list, detail, edit and delete routes (#96)"
```

---

### Task 7: Purge scope and "Delete screen library"

**Files:**
- Create: `lib/server/screenPurge.ts`, `app/api/screen/library/route.ts`
- Modify: `lib/server/purge.ts`
- Test: `lib/server/__tests__/screen-purge.test.ts`

**Interfaces:**
- Consumes: `schema.titles`, `schema.titleEnrichment`, `schema.titleRecommendations`,
  `schema.tasteSignal.targetTitleId`; `deleteProfileRows` (existing); `setRebuildReason`.
- Produces (contract): `deleteScreenLibraryRows(tx, userId): Promise<ScreenLibraryPurgeResult>`
  (`{ titles_removed, title_recommendations_removed, title_signals_removed }`);
  `deleteTitleRecommendationRows(tx, userId): Promise<number>`. `DELETE /api/screen/library` →
  `{ titles_removed, title_recommendations_removed, title_signals_removed, traits_removed,
  recommendations_removed, profile_reset: true }`.

Spec §7.6 table, implemented exactly:

| Action | Deletes (screen part) | Keeps |
|---|---|---|
| Clear library (books) — `DELETE /api/library` | title recommendations (via `deleteProfileRows`) | titles |
| Delete screen library — `DELETE /api/screen/library` | titles, title enrichment, title recommendations, title signals, the shared profile | books, book signals |
| Reset profile — `DELETE /api/profile` | title recommendations (via `deleteProfileRows`) | both libraries |
| Delete account | all of the above plus `user_settings` (the flag) | — |

Book purge **response shapes do not change** (they are pinned as Python-parity counts in
`purge-routes.test.ts`); title signals removed by account deletion are added into the existing
`signals_removed` count, since they are taste signals.

- [ ] **Step 1: Write the failing tests**

Create `lib/server/__tests__/screen-purge.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { DELETE as deleteAccount } from '../../../app/api/account/route';
import { DELETE as deleteLibrary } from '../../../app/api/library/route';
import { DELETE as deleteProfile } from '../../../app/api/profile/route';
import { DELETE as deleteScreenLibrary } from '../../../app/api/screen/library/route';
import { _setDbForTests, schema, type Db } from '../db';
import { deleteScreenLibraryRows } from '../screenPurge';
import { makeTestDb } from './helpers/pglite';

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await makeTestDb());
  _setDbForTests(db);
});
afterEach(async () => {
  _setDbForTests(null);
  await close();
});

async function seed(userId: string) {
  await db.insert(schema.userSettings).values({ userId, screenEnabled: true });
  const [book] = await db
    .insert(schema.books)
    .values({ userId, title: 'Dune', goodreadsRating: 5, source: 'test' })
    .returning();
  const titles = await db
    .insert(schema.titles)
    .values([
      { userId, mediaType: 'movie', title: 'A', status: 'watched', letterboxdRating: 4 },
      { userId, mediaType: 'tv', title: 'B', status: 'want' },
    ])
    .returning();
  await db.insert(schema.titleEnrichment).values(titles.map((t) => ({ titleId: t.id, resolutionConfidence: 0.95 })));
  await db.insert(schema.titleRecommendations).values({
    userId, runId: 'r', rank: 1, mediaType: 'movie', mediaFilter: 'both', title: 'C', score: 1, status: 'served',
  });
  await db.insert(schema.recommendations).values({ userId, runId: 'b', rank: 1, title: 'Book rec', score: 1, status: 'served' });
  await db.insert(schema.tasteTraits).values({ userId, claim: 'c', polarity: 'reward', inferenceConfidence: 1, status: 'proposed' });
  await db.insert(schema.profileMeta).values({ userId, lastProfileKind: 'full', lastProfiledAt: '2026-09-01 00:00:00' });
  await db.insert(schema.tasteSignal).values([
    { userId, direction: 'more', targetKind: 'book', targetBookId: book.id },
    { userId, direction: 'more', targetKind: 'title', targetTitleId: titles[0].id },
  ]);
}

async function counts(userId: string) {
  const n = async (table: any, col: any) => (await db.select().from(table).where(eq(col, userId))).length;
  const titleIds = (await db.select().from(schema.titles).where(eq(schema.titles.userId, userId))).map((t) => t.id);
  const enrichment = (await db.select().from(schema.titleEnrichment)).filter((e) => titleIds.includes(e.titleId)).length;
  const signals = await db.select().from(schema.tasteSignal).where(eq(schema.tasteSignal.userId, userId));
  return {
    books: await n(schema.books, schema.books.userId),
    titles: titleIds.length,
    titleEnrichment: enrichment,
    titleRecs: await n(schema.titleRecommendations, schema.titleRecommendations.userId),
    bookRecs: await n(schema.recommendations, schema.recommendations.userId),
    traits: await n(schema.tasteTraits, schema.tasteTraits.userId),
    bookSignals: signals.filter((s) => s.targetTitleId === null).length,
    titleSignals: signals.filter((s) => s.targetTitleId !== null).length,
    settings: await n(schema.userSettings, schema.userSettings.userId),
  };
}

const full = { books: 1, titles: 2, titleEnrichment: 2, titleRecs: 1, bookRecs: 1, traits: 1, bookSignals: 1, titleSignals: 1, settings: 1 };

describe('spec §7.6 purge scope', () => {
  test('DELETE /api/screen/library deletes the screen library and the shared profile, keeps books', async () => {
    await seed('local');
    await seed('other');
    const res = await deleteScreenLibrary(new Request('http://test/api/screen/library', { method: 'DELETE' }));
    expect(await res.json()).toEqual({
      titles_removed: 2,
      title_recommendations_removed: 1,
      title_signals_removed: 1,
      traits_removed: 1,
      recommendations_removed: 1,
      profile_reset: true,
    });
    expect(await counts('local')).toEqual({ ...full, titles: 0, titleEnrichment: 0, titleRecs: 0, bookRecs: 0, traits: 0, titleSignals: 0 });
    expect(await counts('other')).toEqual(full);
    const [meta] = await db.select().from(schema.profileMeta).where(eq(schema.profileMeta.userId, 'local'));
    expect(meta.rebuildReason).toBe('screen_library_deleted');
    expect(meta.lastProfiledAt).toBeNull();
  });

  test('DELETE /api/screen/library works while screen is disabled', async () => {
    await seed('local');
    await db.update(schema.userSettings).set({ screenEnabled: false });
    expect((await deleteScreenLibrary(new Request('http://test/api/screen/library', { method: 'DELETE' }))).status).toBe(200);
    expect((await counts('local')).titles).toBe(0);
  });

  test('book library reset keeps titles', async () => {
    await seed('local');
    const res = await deleteLibrary(new Request('http://test/api/library', { method: 'DELETE' }));
    expect(await res.json()).toEqual({ books_removed: 1, traits_removed: 1, recommendations_removed: 1, profile_reset: true });
    expect(await counts('local')).toEqual({ ...full, books: 0, titleRecs: 0, bookRecs: 0, traits: 0 });
  });

  test('profile reset deletes both recommendation tables and keeps both libraries', async () => {
    await seed('local');
    const res = await deleteProfile(new Request('http://test/api/profile', { method: 'DELETE' }));
    expect(await res.json()).toEqual({ traits_removed: 1, recommendations_removed: 1, profile_reset: true });
    expect(await counts('local')).toEqual({ ...full, titleRecs: 0, bookRecs: 0, traits: 0 });
  });

  test('account deletion removes every screen row and counts title signals as signals', async () => {
    await seed('local');
    await seed('other');
    const body = await (await deleteAccount(new Request('http://test/api/account', { method: 'DELETE' }))).json();
    expect(body.signals_removed).toBe(2);
    expect(Object.keys(body)).not.toContain('titles_removed'); // shape pinned by purge-routes.test.ts
    expect(await counts('local')).toEqual({
      books: 0, titles: 0, titleEnrichment: 0, titleRecs: 0, bookRecs: 0, traits: 0, bookSignals: 0, titleSignals: 0, settings: 0,
    });
    expect(await counts('other')).toEqual(full);
  });

  test('deleteScreenLibraryRows deletes enrichment before titles (FK)', async () => {
    await seed('local');
    await expect(db.transaction((tx) => deleteScreenLibraryRows(tx, 'local'))).resolves.toEqual({
      titles_removed: 2,
      title_recommendations_removed: 1,
      title_signals_removed: 1,
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/server/__tests__/screen-purge.test.ts`
Expected: FAIL — `../screenPurge` and the library route are missing.

- [ ] **Step 3: Write `lib/server/screenPurge.ts`**

```ts
import { and, eq, inArray, isNotNull, or } from 'drizzle-orm';
import { schema, type DbTx } from './db';

export interface ScreenLibraryPurgeResult {
  titles_removed: number;
  title_recommendations_removed: number;
  title_signals_removed: number;
}

export async function deleteTitleRecommendationRows(tx: DbTx, userId: string): Promise<number> {
  const rows = await tx
    .delete(schema.titleRecommendations)
    .where(eq(schema.titleRecommendations.userId, userId))
    .returning({ id: schema.titleRecommendations.id });
  return rows.length;
}

/** Spec §7.6 "Delete screen library", minus the shared profile (the route adds that). */
export async function deleteScreenLibraryRows(
  tx: DbTx,
  userId: string
): Promise<ScreenLibraryPurgeResult> {
  const owned = await tx
    .select({ id: schema.titles.id })
    .from(schema.titles)
    .where(eq(schema.titles.userId, userId));
  const ids = owned.map(({ id }) => id);

  // LOAD-BEARING: bulk deletes do not cascade; title_enrichment.title_id is an FK.
  if (ids.length > 0) {
    await tx.delete(schema.titleEnrichment).where(inArray(schema.titleEnrichment.titleId, ids));
  }
  const titles = await tx
    .delete(schema.titles)
    .where(eq(schema.titles.userId, userId))
    .returning({ id: schema.titles.id });
  const titleRecommendations = await deleteTitleRecommendationRows(tx, userId);
  const signals = await tx
    .delete(schema.tasteSignal)
    .where(
      and(
        eq(schema.tasteSignal.userId, userId),
        or(isNotNull(schema.tasteSignal.targetTitleId), eq(schema.tasteSignal.targetKind, 'title'))
      )
    )
    .returning({ id: schema.tasteSignal.id });

  return {
    titles_removed: titles.length,
    title_recommendations_removed: titleRecommendations,
    title_signals_removed: signals.length,
  };
}
```

- [ ] **Step 4: Wire it into `lib/server/purge.ts`**

Add the import `import { deleteScreenLibraryRows, deleteTitleRecommendationRows } from './screenPurge';`.

In `deleteProfileRows`, after the `recommendations` delete:

```ts
  // Spec §7.6: every profile reset clears BOTH recommendation tables. Not reported: the response
  // keys are pinned Python-parity counts; DELETE /api/screen/library reports screen counts.
  await deleteTitleRecommendationRows(tx, userId);
```

In `deleteAccountRows`, right after `const books_removed = await deleteLibraryRows(tx, userId);`:

```ts
  // Wire every user-owned table into account deletion (docs/conventions.md). Runs before the
  // user_settings delete; title signals are counted into signals_removed below.
  const screen = await deleteScreenLibraryRows(tx, userId);
```

and change the returned `signals_removed` to `signals_removed: signals.length + screen.title_signals_removed,`.

- [ ] **Step 5: Write `app/api/screen/library/route.ts`**

```ts
import { getDb } from '@/lib/server/db';
import { withApi } from '@/lib/server/http';
import { setRebuildReason } from '@/lib/server/profileMeta';
import { deleteProfileRows } from '@/lib/server/purge';
import { deleteScreenLibraryRows } from '@/lib/server/screenPurge';

/**
 * Spec §7.6 "Delete screen library": titles, their enrichment, screen recommendations, title
 * signals, and the shared profile; books survive. Not gated on the opt-in flag, so a user who
 * turned ScreenSprite off can still remove their viewing history. The flag itself is unchanged.
 */
export const DELETE = withApi('/api/screen/library', async (_req, ctx) => {
  const db = getDb();
  const userId = ctx.user.userId;
  const result = await db.transaction(async (tx) => {
    const screen = await deleteScreenLibraryRows(tx, userId);
    const profile = await deleteProfileRows(tx, userId);
    // deleteProfileRows removed profile_meta; this recreates it carrying the reason, so any
    // profile built next is a full one.
    await setRebuildReason(tx, userId, 'screen_library_deleted');
    return {
      titles_removed: screen.titles_removed,
      title_recommendations_removed: screen.title_recommendations_removed,
      title_signals_removed: screen.title_signals_removed,
      traits_removed: profile.traits_removed,
      recommendations_removed: profile.recommendations_removed,
      profile_reset: true as const,
    };
  });
  ctx.timer.mark('db');
  return Response.json(result);
});
```

- [ ] **Step 6: Run the new and the existing purge tests**

Run: `npx vitest run lib/server/__tests__/screen-purge.test.ts lib/server/__tests__/purge-routes.test.ts`
Expected: PASS, with `purge-routes.test.ts` **unmodified**. If an existing exact-count assertion
fails, the change leaked into a book response shape — fix the code, not the test.

- [ ] **Step 7: Mutation-check the FK order**

Swap the two statements in `deleteScreenLibraryRows` (delete titles before enrichment). Run
`screen-purge.test.ts`; it must fail on `title_enrichment_title_id_fkey`. Revert.

- [ ] **Step 8: Commit**

```bash
git add lib/server/screenPurge.ts lib/server/purge.ts app/api/screen/library/route.ts lib/server/__tests__/screen-purge.test.ts
git commit -m "feat(screen): purge screen rows per spec scope and add Delete screen library (#96)"
```

---

### Task 8: JSON export gains a versioned screen section

**Files:**
- Modify: `lib/server/export.ts`
- Test: `lib/server/__tests__/screen-export.test.ts`

**Interfaces:**
- Consumes: `isScreenEnabled` (Task 2); `effectiveTitleRating`, `TitleRow`,
  `TitleEnrichmentRow` (Task 2); `schema.titleRecommendations`.
- Produces: `exportJsonText(books, signals, now?, screen?: ScreenExportData | null)` — the
  fourth parameter is additive; `interface ScreenExportData { titles: Array<{ title: TitleRow;
  enrichment: TitleEnrichmentRow | null }>; recommendations: TitleRecRow[] }`.

Shape (spec §3.6): when the user has screen enabled, any title, or any title signal, the JSON
gains a final key `"screen": { "version": 1, "titles": [...], "title_recommendations": [...],
"taste_signals": [...] }`; each title embeds its enrichment. Title-targeted signals move out of
the top-level `taste_signals` into the screen section. Otherwise the output is byte-identical to
today's. `raw_response` is not exported (it is a trimmed catalog payload, not user data). The CSV
export is unchanged.

- [ ] **Step 1: Write the failing tests**

Create `lib/server/__tests__/screen-export.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { GET as exportRoute } from '../../../app/api/export/route';
import { _setDbForTests, schema, type Db } from '../db';
import { exportJsonText } from '../export';
import { makeTestDb } from './helpers/pglite';

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await makeTestDb());
  _setDbForTests(db);
});
afterEach(async () => {
  _setDbForTests(null);
  await close();
});

const jsonExport = async () =>
  (await exportRoute(new Request('http://test/api/export?format=json'))).text();

describe('JSON export — screen section', () => {
  test('book-only export has no screen key', async () => {
    await db.insert(schema.books).values({ userId: 'local', title: 'Dune', goodreadsRating: 5, source: 'goodreads' });
    const text = await jsonExport();
    expect(text).not.toContain('"screen"');
    const books = await db.select().from(schema.books);
    // Same bytes as the pre-screen three-argument call.
    expect(exportJsonText(books, [], new Date('2026-08-10T12:34:56.123Z'))).toBe(
      exportJsonText(books, [], new Date('2026-08-10T12:34:56.123Z'), null)
    );
  });

  test('an enabled user with no titles gets an empty versioned section', async () => {
    await db.insert(schema.userSettings).values({ userId: 'local', screenEnabled: true });
    const parsed = JSON.parse(await jsonExport());
    expect(Object.keys(parsed)).toEqual(['version', 'exported_at', 'books', 'taste_signals', 'screen']);
    expect(parsed.screen).toEqual({ version: 1, titles: [], title_recommendations: [], taste_signals: [] });
  });

  test('exports titles with enrichment, title recommendations and title signals', async () => {
    await db.insert(schema.userSettings).values({ userId: 'local', screenEnabled: true });
    const [t] = await db
      .insert(schema.titles)
      .values({
        userId: 'local', mediaType: 'movie', title: '夜の図書館', year: 2016, status: 'watched',
        letterboxdRating: 4, appRating: 4.5, letterboxdReview: 'lb', letterboxdUri: 'https://boxd.it/aaa4',
        isFavorite: true, createdAt: '2026-09-01 10:00:00',
      })
      .returning();
    await db.insert(schema.titleEnrichment).values({
      titleId: t.id, wikidataQid: 'Q1', genres: ['drama film'], series: [{ qid: 'Q2', label: 'S' }],
      resolutionConfidence: 0.95, confidenceLabel: 'HIGH', matchMethod: 'exact', rawResponse: { big: true },
      resolvedAt: '2026-09-02 10:00:00',
    });
    await db.insert(schema.titleRecommendations).values({
      userId: 'local', runId: 'r1', rank: 1, mediaType: 'tv', mediaFilter: 'both', title: 'Glass Orchard',
      score: 0.8, status: 'rejected', rejectReasons: ['not_my_genre'], groundedTitleIds: [t.id], createdAt: '2026-09-03 10:00:00',
    });
    await db.insert(schema.tasteSignal).values([
      { userId: 'local', direction: 'more', targetKind: 'book', targetBookId: 7, createdAt: '2026-09-04 10:00:00' },
      { userId: 'local', direction: 'less', targetKind: 'title', targetTitleId: t.id, createdAt: '2026-09-05 10:00:00' },
    ]);
    await db.insert(schema.titles).values({ userId: 'other', mediaType: 'movie', title: 'Secret', status: 'want' });

    const text = await jsonExport();
    expect(text).not.toContain('Secret');
    expect(text).not.toContain('"big"'); // raw_response is not exported
    expect(text).toContain('\\u591c'); // ensure_ascii escaping still applies
    const parsed = JSON.parse(text);
    expect(parsed.taste_signals.map((s: { target_kind: string }) => s.target_kind)).toEqual(['book']);
    expect(parsed.screen.taste_signals).toEqual([
      { direction: 'less', target_kind: 'title', target_title_id: t.id, snapshot: null, created_at: '2026-09-05T10:00:00' },
    ]);
    const [title] = parsed.screen.titles;
    expect(Object.keys(title)).toEqual([
      'id', 'media_type', 'title', 'year', 'status', 'letterboxd_rating', 'app_rating', 'effective_rating',
      'letterboxd_review', 'app_review', 'last_watched_on', 'letterboxd_uri', 'wikidata_qid', 'tvmaze_id',
      'is_favorite', 'exclude_from_profile', 'created_at', 'enrichment',
    ]);
    expect(title).toMatchObject({ title: '夜の図書館', effective_rating: 4.5, is_favorite: true, created_at: '2026-09-01T10:00:00' });
    expect(title.enrichment).toMatchObject({
      wikidata_qid: 'Q1', genres: ['drama film'], series: [{ qid: 'Q2', label: 'S' }],
      confidence_label: 'HIGH', resolved_at: '2026-09-02T10:00:00',
    });
    expect(parsed.screen.title_recommendations).toEqual([
      expect.objectContaining({ run_id: 'r1', title: 'Glass Orchard', status: 'rejected', reject_reasons: ['not_my_genre'], grounded_title_ids: [t.id] }),
    ]);
  });

  test('CSV export stays book-only', async () => {
    await db.insert(schema.userSettings).values({ userId: 'local', screenEnabled: true });
    await db.insert(schema.titles).values({ userId: 'local', mediaType: 'movie', title: 'Film', status: 'want' });
    const csv = await (await exportRoute(new Request('http://test/api/export?format=csv'))).text();
    expect(csv).not.toContain('Film');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/server/__tests__/screen-export.test.ts`
Expected: FAIL — no `screen` section is produced.

- [ ] **Step 3: Modify `lib/server/export.ts`**

Replace the imports and `exportJsonText`/`buildExport` with:

```ts
import { asc, eq } from 'drizzle-orm';
import { stringifyCanonical, type CanonicalCsvRecord } from './import-csv';
import { schema, type Db } from './db';
import { isScreenEnabled } from './screenSettings';
import { effectiveRating, pyJsonDumpsIndented, tsToIso } from './serialize';
import { effectiveTitleRating, type TitleEnrichmentRow, type TitleRow } from './titles';

type Book = typeof schema.books.$inferSelect;
type Signal = typeof schema.tasteSignal.$inferSelect;
type TitleRecRow = typeof schema.titleRecommendations.$inferSelect;

export interface ScreenExportData {
  titles: Array<{ title: TitleRow; enrichment: TitleEnrichmentRow | null }>;
  recommendations: TitleRecRow[];
}
```

(keep `csvText` and `pythonUtcIso` unchanged), then:

```ts
function isTitleSignal(signal: Signal): boolean {
  return signal.targetTitleId != null || signal.targetKind === 'title';
}

function enrichmentOut(e: TitleEnrichmentRow) {
  return {
    wikidata_qid: e.wikidataQid,
    tvmaze_id: e.tvmazeId,
    wikipedia_page: e.wikipediaPage,
    genres: e.genres,
    directors: e.directors,
    creators: e.creators,
    writers: e.writers,
    countries: e.countries,
    original_language: e.originalLanguage,
    based_on: e.basedOn,
    main_subjects: e.mainSubjects,
    series: e.series,
    production_companies: e.productionCompanies,
    sitelinks: e.sitelinks,
    description: e.description,
    description_source: e.descriptionSource,
    description_url: e.descriptionUrl,
    image_url: e.imageUrl,
    resolution_confidence: e.resolutionConfidence,
    confidence_label: e.confidenceLabel,
    match_method: e.matchMethod,
    identity_source: e.identitySource,
    duplicate_of_title_id: e.duplicateOfTitleId,
    resolved_at: tsToIso(e.resolvedAt),
  };
}

function screenSection(screen: ScreenExportData, titleSignals: Signal[]) {
  return {
    version: 1,
    titles: screen.titles.map(({ title: t, enrichment }) => ({
      id: t.id,
      media_type: t.mediaType,
      title: t.title,
      year: t.year,
      status: t.status,
      letterboxd_rating: t.letterboxdRating,
      app_rating: t.appRating,
      effective_rating: effectiveTitleRating(t),
      letterboxd_review: t.letterboxdReview,
      app_review: t.appReview,
      last_watched_on: t.lastWatchedOn,
      letterboxd_uri: t.letterboxdUri,
      wikidata_qid: t.wikidataQid,
      tvmaze_id: t.tvmazeId,
      is_favorite: t.isFavorite,
      exclude_from_profile: t.excludeFromProfile,
      created_at: tsToIso(t.createdAt),
      enrichment: enrichment ? enrichmentOut(enrichment) : null,
    })),
    title_recommendations: screen.recommendations.map((r) => ({
      run_id: r.runId,
      rank: r.rank,
      media_type: r.mediaType,
      media_filter: r.mediaFilter,
      title: r.title,
      year: r.year,
      wikidata_qid: r.wikidataQid,
      tvmaze_id: r.tvmazeId,
      image_url: r.imageUrl,
      genres: r.genres,
      description: r.description,
      retrieval_pool: r.retrievalPool,
      seed_reason: r.seedReason,
      score: r.score,
      rationale: r.rationale,
      grounded_trait_ids: r.groundedTraitIds,
      grounded_book_ids: r.groundedBookIds,
      grounded_title_ids: r.groundedTitleIds,
      status: r.status,
      user_note: r.userNote,
      reject_reasons: r.rejectReasons,
      created_at: tsToIso(r.createdAt),
    })),
    taste_signals: titleSignals.map((signal) => ({
      direction: signal.direction,
      target_kind: signal.targetKind,
      target_title_id: signal.targetTitleId,
      snapshot: signal.snapshot,
      created_at: tsToIso(signal.createdAt),
    })),
  };
}

/**
 * The book part is byte-identical to the pre-screen export (pinned by
 * import-export-routes.test.ts). The screen section is appended LAST and only when `screen` is
 * non-null, so a user who never used ScreenSprite gets exactly today's bytes.
 */
export function exportJsonText(
  books: Book[],
  signals: Signal[],
  now = new Date(),
  screen: ScreenExportData | null = null
): string {
  const doc: Record<string, unknown> = {
    version: 1,
    exported_at: pythonUtcIso(now),
    books: books.map((book) => ({
      title: book.title,
      author: book.author,
      additional_authors: book.additionalAuthors,
      isbn13: book.isbn13,
      shelf: book.exclusiveShelf,
      goodreads_rating: book.goodreadsRating,
      app_rating: book.appRating,
      app_review: book.appReview,
      effective_rating: effectiveRating(book.appRating, book.goodreadsRating),
      is_favorite: book.isFavorite,
      exclude_from_profile: book.excludeFromProfile,
      date_read: book.dateRead,
      date_added: book.dateAdded,
      page_count: book.pageCount,
      year_published: book.yearPublished,
      source: book.source,
    })),
    taste_signals: signals
      .filter((signal) => !isTitleSignal(signal))
      .map((signal) => ({
        direction: signal.direction,
        target_kind: signal.targetKind,
        target_book_id: signal.targetBookId,
        snapshot: signal.snapshot,
        created_at: tsToIso(signal.createdAt),
      })),
  };
  if (screen) doc.screen = screenSection(screen, signals.filter(isTitleSignal));
  return pyJsonDumpsIndented(doc);
}

async function screenExportData(
  db: Db,
  userId: string,
  signals: Signal[]
): Promise<ScreenExportData | null> {
  const titles = await db
    .select({ title: schema.titles, enrichment: schema.titleEnrichment })
    .from(schema.titles)
    .leftJoin(schema.titleEnrichment, eq(schema.titleEnrichment.titleId, schema.titles.id))
    .where(eq(schema.titles.userId, userId))
    .orderBy(asc(schema.titles.id));
  const include =
    titles.length > 0 || signals.some(isTitleSignal) || (await isScreenEnabled(db, userId));
  if (!include) return null;
  const recommendations = await db
    .select()
    .from(schema.titleRecommendations)
    .where(eq(schema.titleRecommendations.userId, userId))
    .orderBy(asc(schema.titleRecommendations.id));
  return { titles, recommendations };
}

export async function buildExport(db: Db, userId: string, format: 'csv' | 'json'): Promise<string> {
  const books = await db
    .select()
    .from(schema.books)
    .where(eq(schema.books.userId, userId))
    .orderBy(asc(schema.books.id));
  if (format === 'csv') return csvText(books);
  const signals = await db
    .select()
    .from(schema.tasteSignal)
    .where(eq(schema.tasteSignal.userId, userId))
    .orderBy(asc(schema.tasteSignal.id));
  const screen = await screenExportData(db, userId, signals);
  return exportJsonText(books, signals, new Date(), screen);
}
```

- [ ] **Step 4: Run the new and the existing export tests**

Run: `npx vitest run lib/server/__tests__/screen-export.test.ts lib/server/__tests__/import-export-routes.test.ts`
Expected: PASS, with `import-export-routes.test.ts` **unmodified** (its golden-bytes and
empty-export regex are the book-only identity check).

- [ ] **Step 5: Commit**

```bash
git add lib/server/export.ts lib/server/__tests__/screen-export.test.ts
git commit -m "feat(screen): export titles, title recommendations and title signals in JSON backups (#96)"
```

---

### Task 9: Docs, full gate, real-flow verification, and the migration handoff

**Files:**
- Modify: `docs/architecture.md`, `docs/conventions.md`

**Interfaces:** none new.

- [ ] **Step 1: Update `docs/architecture.md`**

Add a subsection after "### Import, library, and export":

```markdown
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

Routes: `POST /api/screen/import`, `GET|PUT /api/settings/screen`, `GET /api/screen/titles`,
`GET|PATCH|DELETE /api/screen/titles/{id}`, `DELETE /api/screen/library`.
```

In `docs/conventions.md` under "## Data invariants", add:

```markdown
- **`titles` is never dropped or recreated by a migration**, for the same reason as `books`. Its
  rating columns reject `0`: unlike `books.goodreads_rating`, screen storage has no unrated
  sentinel, only null. A Letterboxd re-import writes only `LETTERBOXD_OWNED_FIELDS`
  (`lib/server/importTitles.ts`).
- **Screen purge scope follows the spec §7.6 table.** Profile reset and book-library reset also
  clear `title_recommendations`; account deletion clears every screen table. Book purge responses
  do not report screen counts; `DELETE /api/screen/library` does.
```

- [ ] **Step 2: Run the full gate**

```bash
npm run test:server
npm test
npm run type-check
npm run lint
npm run format:check
npm run build
```

Expected: all pass. Record the Vitest pass count by extracting it, not by tailing output:
`npm run test:server 2>&1 | grep -E "Tests +[0-9]+ passed"`.

- [ ] **Step 3: Real-flow verification against an isolated local database**

Follow the `marketing-screenshot-pipeline` memory note for the isolated run (scratch Postgres in
Docker, local-mode dev server, no `.env` in scope). The concrete shape, adapted to this wave:

```bash
# 1. A copy of the working tree with no .env in scope
# Beside the repository, not in /tmp: the memory note records that Turbopack rejects a
# node_modules symlink pointing outside the inferred workspace root when the copy is in /tmp.
# If it still rejects the link here, run `npm ci` in the copy instead (no sudo) and say so.
VERIFY="$HOME/Documents/Code/shelfsprite-w4-verify"
# Tracked + untracked-but-not-ignored files only: secrets files, .next and node_modules are
# gitignored, so the command never names them (the PreToolUse secrets guard denies any
# command whose text names one; do not rephrase around it).
mkdir -p "$VERIFY"
git ls-files -z --cached --others --exclude-standard | rsync -a --from0 --files-from=- ./ "$VERIFY"/
ln -sfn "$PWD/node_modules" "$VERIFY/node_modules"
ls -a "$VERIFY"   # names only; confirm no dot-env entry. If there is one: STOP, delete the copy.

# 2. Scratch Postgres (55432 is the memory note's shelfsprite-scratch container)
docker ps --format '{{.Names}} {{.Ports}}' | grep 55434 && echo "STOP: port 55434 busy"
docker run -d --name ss-w4-pg -e POSTGRES_PASSWORD=postgres -p 55434:5432 postgres:17
export VERIFY_DB=postgres://postgres:postgres@localhost:55434/postgres
```

Create the schema the way the memory note's procedure does. If that procedure applies the
migrations from empty, run `cd "$VERIFY" && DATABASE_URL=$VERIFY_DB npm run db:migrate` and
confirm this wave's migration is in the applied list. Then start the server:

```bash
cd "$VERIFY" && DATABASE_URL=$VERIFY_DB ALLOW_LOCAL_AUTH=true npx next dev -p 3100
```

Build a synthetic, real-shaped export (fictional films; includes the ignored `likes/`, `lists/`,
`deleted/`, `orphaned/` entries):

```bash
python3 - <<'PY'
import zipfile
files = {
  "profile.csv": "Date Joined,Username,Given Name,Family Name,Email Address,Location,Website,Bio,Pronoun,Favorite Films\n2020-01-01,synthetic_user,Sam,Example,sam@example.invalid,Nowhere,,A bio,they/them,\"https://boxd.it/aaa2, https://boxd.it/aaa4\"\n",
  "watched.csv": "Date,Name,Year,Letterboxd URI\n2024-01-05,The Lantern Keeper,2019,https://boxd.it/aaa1\n2024-02-10,Salt & Static,2021,https://boxd.it/aaa2\n2024-03-15,\"Quiet Harbor, Loud Sea\",2008,https://boxd.it/aaa3\n2024-04-20,夜の図書館,2016,https://boxd.it/aaa4\n2024-05-25,Paper Moons,,https://boxd.it/aaa5\n",
  "ratings.csv": "Date,Name,Year,Letterboxd URI,Rating\n2024-01-06,The Lantern Keeper,2019,https://boxd.it/aaa1,4.5\n2024-02-11,Salt & Static,2021,https://boxd.it/aaa2,2\n2024-04-21,夜の図書館,2016,https://boxd.it/aaa4,5\n",
  "watchlist.csv": "Date,Name,Year,Letterboxd URI\n2024-06-01,Glass Orchard,2023,https://boxd.it/bbb1\n",
  "diary.csv": "Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\n2024-07-01,The Lantern Keeper,2019,https://boxd.it/e2,4.5,Yes,,2024-06-30\n",
  "reviews.csv": "Date,Name,Year,Letterboxd URI,Rating,Rewatch,Review,Tags,Watched Date\n2024-07-01,The Lantern Keeper,2019,https://boxd.it/r2,4.5,Yes,Second take wins.,,2024-06-30\n",
  "comments.csv": "Date,Content,Comment\n",
  "likes/films.csv": "Date,Name,Year,Letterboxd URI\n2024-03-16,\"Quiet Harbor, Loud Sea\",2008,https://boxd.it/aaa3\n",
  "lists/favorite-bad-movies.csv": "Date,Name,URL,Description\n",
  "deleted/diary.csv": "Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\n2025-12-31,The Lantern Keeper,2019,https://boxd.it/e9,1,,,2025-12-31\n",
  "orphaned/reviews.csv": "Date,Name,Year,Letterboxd URI,Rating,Rewatch,Review,Tags,Watched Date\n",
}
with zipfile.ZipFile("/tmp/shelfsprite-w4-letterboxd.zip", "w", zipfile.ZIP_DEFLATED) as z:
    for name, text in files.items():
        z.writestr(name, text.encode("utf-8"))
PY
```

Note this ZIP is written by Python's `zipfile`, not by `fflate`: it exercises the reader against a
second, independent ZIP writer. Then exercise the flow and record every response:

```bash
B=http://localhost:3100/api
curl -s $B/settings/screen                                   # enabled:false
curl -s $B/screen/titles                                     # 403 ScreenSprite is not enabled
curl -s -F file=@/tmp/shelfsprite-w4-letterboxd.zip $B/screen/import   # inserted:6
curl -s $B/settings/screen                                   # enabled:true, title_count:6
curl -s "$B/screen/titles?status=want"                       # Glass Orchard only
ID=$(curl -s $B/screen/titles | python3 -c "import sys,json;print([t['id'] for t in json.load(sys.stdin) if t['title']=='The Lantern Keeper'][0])")
curl -s -X PATCH -H 'content-type: application/json' -d '{"rating":3}' $B/screen/titles/$ID     # rating 3, letterboxd 4.5
curl -s -X PATCH -H 'content-type: application/json' -d '{"rating":0}' $B/screen/titles/$ID     # rating back to 4.5
curl -s -X PATCH -H 'content-type: application/json' -d '{"rating":4.3}' $B/screen/titles/$ID   # 422
curl -s -F file=@/tmp/shelfsprite-w4-letterboxd.zip $B/screen/import   # inserted:0 unchanged:6
curl -s "$B/export?format=json" | python3 -c "import sys,json;d=json.load(sys.stdin);print(len(d['screen']['titles']))"   # 6
curl -s -X DELETE $B/screen/titles/$ID                       # removed:true
curl -s -X PUT -H 'content-type: application/json' -d '{"enabled":false}' $B/settings/screen    # enabled:false
curl -s -X DELETE $B/screen/library                          # titles_removed:5
```

Then confirm the real database shape (not `schema.ts` comments):

```bash
docker exec ss-w4-pg psql -U postgres -c "select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_name in ('titles','title_enrichment','title_recommendations') or (table_name='user_settings' and column_name like 'screen%') or (table_name='enrich_jobs' and column_name='kind') or column_name in ('exhibit_title_ids','contrast_title_ids','target_title_id') order by table_name, ordinal_position;"
docker exec ss-w4-pg psql -U postgres -c "select indexname, indexdef from pg_indexes where indexname like 'uq_enrich_jobs%' or indexname like 'uq_titles%';"
docker exec ss-w4-pg psql -U postgres -c "select conname from pg_constraint where conname like 'ck_titles%';"
```

Clean up: `docker rm -f ss-w4-pg`, stop the dev server, `rm -rf "$VERIFY" /tmp/shelfsprite-w4-letterboxd.zip`.

Record what you observed in the ledger. Any divergence from the comments above is a finding to
report, not something to reconcile silently.

- [ ] **Step 4: Commit the docs**

```bash
git add docs/architecture.md docs/conventions.md
git commit -m "docs(screen): document ScreenSprite import, settings and purge modules (#96)"
```

- [ ] **Step 5: Hand Chase the production migration step**

Do **not** run this. Report it to Chase verbatim, with the migration filename filled in:

> Wave 4 adds migration `drizzle/00NN_<name>.sql` (new tables `titles`, `title_enrichment`,
> `title_recommendations`; additive columns on `user_settings`, `enrich_jobs`, `taste_traits`,
> `taste_signal`; the active-job index becomes per-kind). It must be applied before this branch's
> code serves traffic, in a release window:
>
> ```bash
> npm run db:migrate    # with DATABASE_URL pointing at production
> ```
>
> Then verify with `information_schema.columns` (the same three queries as Task 9 Step 3). The
> migration drops and recreates only the partial index `uq_enrich_jobs_active_user`; drizzle runs
> it in a transaction, so no second active book job can slip in between.
