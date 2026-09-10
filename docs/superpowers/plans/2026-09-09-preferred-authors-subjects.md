# Favorite Authors and Subjects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a reader explicitly name favorite authors and subjects on `/profile`, and make those favorites change what the recommender retrieves and how it reranks.

**Architecture:** Two new optional keys (`prefer_authors`, `prefer_subjects`) join the existing `user_directive.constraints` JSON blob — no table, no migration. `cleanDirectiveConstraints` owns their normalization; a new `lib/server/preferences.ts` owns reading them back. The recommender consumes them in exactly three places: `metadataPool` (preferred entries generate their own catalog queries, and are queried even in cold start), `applyAuthorCaps` (a preferred author is exempt from the library-author trim but not from `MAX_PER_AUTHOR`), and the two `/recommend` prompts. A deterministic `GET /api/directive/suggestions` proposes values drawn from the reader's own loved books. The UI grows inside `CustomInstructions.tsx`, which stays the single writer of the directive record.

**Tech Stack:** TypeScript, Next.js App Router route handlers, drizzle-orm + Postgres (PGlite in tests), SWR, React 18 (`^18`, installed 18.3.1), Vitest (`lib/server/**`, `app/api/**`), Jest + Testing Library (everything else).

**Spec:** `docs/superpowers/specs/2026-09-09-preferred-authors-subjects-design.md`

---

## Global Constraints

- **`MAX_PREFER_ENTRIES = 10`** per family, enforced server-side in `lib/server/directive.ts` and mirrored (duplicated, never imported) in `lib/api.ts`.
- **Retrieval reservation:** preferred entries are truncated to `TOP_SUBJECTS - 2` (6) and `TOP_AUTHORS - 2` (4) before merging, so at least two inferred slots survive in each list. Merged lists stay capped at `TOP_SUBJECTS = 8` / `TOP_AUTHORS = 6`, so **the worst-case call ceiling per run is unchanged**. A given run *can* gain calls up to that ceiling — see the correction below; the spec's "zero added catalog calls" is too strong.
- **`prefer_subjects` is lowercased. `prefer_authors` preserves case** and collapses internal whitespace; every comparison lowercases at the point of use. This deliberately diverges from the adjacent `exclude_authors`, which lowercases, and **must be commented in the source**.
- **A preference never removes a candidate.** `applyDirectiveConstraints` and `applyDiscoveryConstraints` are not modified.
- **`MAX_PER_AUTHOR = 2` still applies to preferred authors.** Only the 40% library-author trim (`MAX_LIBRARY_AUTHOR_SHARE`) and the cold-start author skip are exempted.
- **`/similar` and `/discover` stay out of directive scope.** Both new function parameters take empty defaults so those two callers compile and behave identically without edits.
- **No client component may import from `lib/server/**`.** `preferenceSuggest.ts` imports `db.ts`, which would drag drizzle and `schema.ts` into the browser bundle. Types are duplicated in `lib/api.ts`, exactly as `Directive` / `DirectiveConstraints` already are.
- **Both test runners plus the build are the gate:** `npm run test:server`, `npm test`, `npm run type-check`, `npm run lint`, `npm run format:check`, `npm run build`.
- **Commits stay local.** Do not push and do not open a PR. This is not an issue-driven fix hand-off; Chase commits and integrates.

### Correction to the spec (verified, load-bearing)

The spec's §1 precondition table says *"No byte-exact prompt fixture pins `userSteeringBlock` — no test in `lib/server/__tests__/` imports `recPrompts`."* **That is wrong.** `lib/server/__tests__/recommend-run.test.ts:123-124` asserts:

```ts
expect(client.calls[0].params).toEqual((prompts as any).recommend_seed.kwargs);
expect(client.calls[1].params).toEqual((prompts as any).recommend_rerank.kwargs);
```

against `lib/server/__tests__/fixtures/claude/prompts.json`. That fixture pins both `/recommend` prompts byte-for-byte, and `recommend_rerank.kwargs` contains the full `userSteeringBlock` output.

The seeded fixture user (`lib/server/__tests__/fixtures/seed.json`, `user_directive` id 1) has `constraints: {"exclude_authors": ["john ringo"]}` and **no `prefer_*` keys**, so the fixture stays green *provided every new prompt string is emitted conditionally* — including the closing weighting clause. §4.5's phrasing ("the closing weighting instruction gains a clause") would break the fixture if applied unconditionally. **Task 5 emits that clause only when at least one favorites list is non-empty.** Do not "simplify" it back to unconditional.

### Correction to the spec: "zero added catalog calls" is too strong (§4.1)

Spec §4.1 claims preferred entries "take slots from inferred ones rather than adding their own, so run duration is unchanged." That holds only when the inferred lists are already at their caps. Two cases where a run genuinely gains calls:

- **Cold start.** `recAssemble.ts:87` issues *zero* author calls today. A reader with favorites now gets up to `TOP_AUTHORS - 2` = 4 `googleBooksAuthor` calls where they previously got none.
- **Under-full inferred lists.** A reader whose loved books yield only three distinct subjects has three subject slots used today; adding six favorites fills eight.

What *is* guaranteed, and what the reservation actually buys, is that **the per-run ceiling does not move**: the merged lists are still capped at `TOP_SUBJECTS` / `TOP_AUTHORS`, so no run issues more metadata calls than a reader with a full taste profile already issues today. That ceiling is what the 300s function budget was sized against. State it that way; do not repeat the spec's stronger claim in code comments.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `lib/server/preferences.ts` | Read `prefer_*` back out of a constraints blob; derive `surname()`-keyed preferred-author set. Pure, no db. |
| `lib/server/preferenceSuggest.ts` | One loved-books query → top subject/author suggestions, minus anything already listed. |
| `app/api/directive/suggestions/route.ts` | `GET /api/directive/suggestions`, tenant-scoped, deterministic, unrate-limited. |
| `components/FavoritesFields.tsx` | Controlled presentation of the two favorites lists. No fetching, no server state. |
| `lib/server/__tests__/rec-metadata-pool.test.ts` | `metadataPool` merge/reservation/cold-start/provenance tests (mocks `./catalog`). |
| `lib/server/__tests__/rec-prompts-favorites.test.ts` | `userSteeringBlock` / `buildSeedPrompt` favorites blocks. |
| `lib/server/__tests__/preference-suggest.test.ts` | `suggestPreferences` counting, exclusion, truncation, tie order. |
| `app/api/directive/route.test.ts` | `PUT /directive` round-trips the new keys; favorites-only record does not 422. |
| `app/api/directive/suggestions/route.test.ts` | Tenant scoping and the empty-library shape. |
| `components/__tests__/FavoritesFields.test.tsx` | Add / Enter / remove / suggestion click / cap message / conflict message. |
| `components/__tests__/CustomInstructions.test.tsx` | One `PUT` carries prose + favorites; Clear shows for a constraints-only record. |

**Modified**

| File | Change |
|---|---|
| `lib/server/directive.ts` | `MAX_PREFER_ENTRIES`; normalize + dedup + conflict-drop + cap both new keys. |
| `lib/server/directive.test.ts` | Cases for the above. |
| `lib/server/recAssemble.ts` | `PoolPreferences`, `metadataPool`'s 5th parameter, `assemble`'s 5th parameter. |
| `lib/server/recFilters.ts` | `applyAuthorCaps`'s 3rd parameter. |
| `lib/server/__tests__/rec-filters.test.ts` | Preferred-author exemption + the `applyDirectiveConstraints` regression pin. |
| `lib/server/__tests__/rec-assemble.test.ts` | `assemble` threads the preferred set through. |
| `lib/server/recPrompts.ts` | Favorites blocks in `userSteeringBlock` and `buildSeedPrompt`. |
| `lib/server/recommendRun.ts` | Read preferences once; pass to `metadataPool` and `assemble`. |
| `lib/api.ts` | `DirectiveConstraints` gains both keys; `MAX_PREFER_ENTRIES`, `PreferenceSuggestions`, `DIRECTIVE_SUGGESTIONS_KEY`, `getPreferenceSuggestions`. |
| `components/CustomInstructions.tsx` | Mount `FavoritesFields`, fetch suggestions, fix the Clear guard. |

---

## Task 1: Storage — normalize `prefer_authors` and `prefer_subjects`

**Files:**
- Modify: `lib/server/directive.ts`
- Test: `lib/server/directive.test.ts` (colocated; Vitest's `include` is `lib/server/**/*.test.ts`, so this file is already picked up)
- Test: `app/api/directive/route.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `MAX_PREFER_ENTRIES: number` (value `10`) exported from `lib/server/directive.ts`; `cleanDirectiveConstraints(raw: unknown): Record<string, unknown>` now emits optional `prefer_subjects: string[]` and `prefer_authors: string[]`.

**Normalization order (fixed, do not reorder):** normalize each entry → case-insensitive dedup keeping the first occurrence's casing → drop entries that collide with the already-cleaned matching `exclude_*` list → truncate to `MAX_PREFER_ENTRIES`. Conflict-drop runs *before* the cap so a reader keeps a full list rather than losing slots to entries that would have been thrown away anyway (same convention as `preferenceSuggest`'s filter-before-truncate in Task 7).

- [ ] **Step 1: Write the failing tests**

Append to `lib/server/directive.test.ts`:

```ts
describe('cleanDirectiveConstraints — favorites', () => {
  it('lowercases prefer_subjects and preserves prefer_authors casing', () => {
    expect(
      cleanDirectiveConstraints({
        prefer_subjects: ['Space Opera', ' Translated Fiction '],
        prefer_authors: ['Ursula K. Le Guin', '  Gene   Wolfe  '],
      })
    ).toEqual({
      prefer_subjects: ['space opera', 'translated fiction'],
      // Case preserved, internal whitespace collapsed to single spaces.
      prefer_authors: ['Ursula K. Le Guin', 'Gene Wolfe'],
    });
  });

  it('dedups case-insensitively, keeping the first occurrence casing', () => {
    expect(
      cleanDirectiveConstraints({ prefer_authors: ['Gene Wolfe', 'gene wolfe', 'GENE WOLFE'] })
    ).toEqual({ prefer_authors: ['Gene Wolfe'] });
  });

  it('caps each family at MAX_PREFER_ENTRIES', () => {
    const many = Array.from({ length: MAX_PREFER_ENTRIES + 4 }, (_, i) => `author ${i}`);
    const out = cleanDirectiveConstraints({ prefer_authors: many, prefer_subjects: many });
    expect((out.prefer_authors as string[]).length).toBe(MAX_PREFER_ENTRIES);
    expect((out.prefer_subjects as string[]).length).toBe(MAX_PREFER_ENTRIES);
    expect((out.prefer_authors as string[])[0]).toBe('author 0');
  });

  it('omits empty lists entirely', () => {
    expect(cleanDirectiveConstraints({ prefer_authors: ['  ', ''], prefer_subjects: [] })).toEqual(
      {}
    );
  });

  it('drops a preference that collides with the matching exclude list', () => {
    expect(
      cleanDirectiveConstraints({
        exclude_authors: ['Brandon Sanderson'],
        prefer_authors: ['brandon sanderson', 'Gene Wolfe'],
        exclude_subjects: ['GRIMDARK'],
        prefer_subjects: ['grimdark', 'space opera'],
      })
    ).toEqual({
      exclude_authors: ['brandon sanderson'],
      exclude_subjects: ['grimdark'],
      prefer_authors: ['Gene Wolfe'],
      prefer_subjects: ['space opera'],
    });
  });

  it('ignores non-array values', () => {
    expect(cleanDirectiveConstraints({ prefer_authors: 'Gene Wolfe', prefer_subjects: 7 })).toEqual(
      {}
    );
  });
});
```

Update the import at the top of the file:

```ts
import { cleanDirectiveConstraints, MAX_PREFER_ENTRIES } from './directive';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/server/directive.test.ts`
Expected: FAIL — `MAX_PREFER_ENTRIES` is not exported from `./directive`.

- [ ] **Step 3: Implement the normalization**

In `lib/server/directive.ts`, add above `cleanDirectiveConstraints`:

```ts
/** Cap per favorites family. Bounds the stored JSON blob and the retrieval budget.
 *  Mirrored — deliberately duplicated, never imported — as MAX_PREFER_ENTRIES in
 *  lib/api.ts, because a client component must not import from lib/server/**. */
export const MAX_PREFER_ENTRIES = 10;

/**
 * Normalize one favorites list.
 *
 * DELIBERATE DIVERGENCE from the adjacent exclude_authors, which lowercases:
 * `lowercase` is true for prefer_subjects and FALSE for prefer_authors. Lowercasing
 * is harmless for an invisible filter but wrong for a field the reader types and
 * then reads back on their own profile page, so prefer_authors preserves case and
 * every comparison lowercases at the point of use instead.
 */
function normalizePreferList(raw: unknown, lowercase: boolean): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of Array.isArray(raw) ? raw : []) {
    const collapsed = String(x).trim().replace(/\s+/g, ' ');
    if (!collapsed) continue;
    const value = lowercase ? collapsed.toLowerCase() : collapsed;
    const fold = value.toLowerCase();
    if (seen.has(fold)) continue;
    seen.add(fold);
    out.push(value);
  }
  return out;
}

/**
 * A hard filter outranks a soft boost: an entry present in both families is dropped
 * from the preference. Keeping both would boost a candidate into the pool and then
 * delete it from the pool. Conflicts are dropped BEFORE the cap so the reader does
 * not lose slots to entries that were never going to survive.
 */
function dropExcluded(values: string[], excluded: unknown): string[] {
  const blocked = new Set(
    (Array.isArray(excluded) ? excluded : []).map((e) => String(e).trim().toLowerCase())
  );
  return values.filter((v) => !blocked.has(v.toLowerCase())).slice(0, MAX_PREFER_ENTRIES);
}
```

Then, inside `cleanDirectiveConstraints`, immediately before `return out;` (so `out.exclude_subjects` / `out.exclude_authors` are already normalized):

```ts
  // Compared against the CLEANED excludes above, so the conflict check runs on the
  // normalized set rather than on whatever the caller sent.
  const preferSubjects = dropExcluded(
    normalizePreferList(r.prefer_subjects, true),
    out.exclude_subjects
  );
  if (preferSubjects.length) out.prefer_subjects = preferSubjects;

  const preferAuthors = dropExcluded(
    normalizePreferList(r.prefer_authors, false),
    out.exclude_authors
  );
  if (preferAuthors.length) out.prefer_authors = preferAuthors;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/server/directive.test.ts`
Expected: PASS, all cases including the three pre-existing ones.

- [ ] **Step 5: Write the route round-trip test**

Create `app/api/directive/route.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeTestDb } from '@/lib/server/__tests__/helpers/pglite';
import { setupTestEnv } from '@/lib/server/__tests__/helpers/testEnv';
import { _setDbForTests, type Db } from '@/lib/server/db';
import { GET, PUT } from './route';

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

const put = (body: unknown) =>
  new Request('http://test/api/directive', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('PUT /api/directive', () => {
  it('round-trips prefer_authors and prefer_subjects', async () => {
    await withDb(async () => {
      const res = await PUT(
        put({
          nl_text: 'More literary sci-fi.',
          constraints: {
            prefer_authors: ['Ursula K. Le Guin'],
            prefer_subjects: ['Space Opera'],
          },
        })
      );
      expect(res.status).toBe(200);
      expect((await res.json()).constraints).toEqual({
        prefer_authors: ['Ursula K. Le Guin'],
        prefer_subjects: ['space opera'],
      });

      const read = await GET(new Request('http://test/api/directive'));
      expect((await read.json()).constraints).toEqual({
        prefer_authors: ['Ursula K. Le Guin'],
        prefer_subjects: ['space opera'],
      });
    });
  });

  it('accepts a favorites-only record with no prose', async () => {
    await withDb(async () => {
      const res = await PUT(put({ nl_text: null, constraints: { prefer_authors: ['Gene Wolfe'] } }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.nl_text).toBeNull();
      expect(body.constraints).toEqual({ prefer_authors: ['Gene Wolfe'] });
    });
  });
});
```

- [ ] **Step 6: Run the route test**

Run: `npx vitest run app/api/directive/route.test.ts`
Expected: PASS. No route source change is needed — `PUT` already rejects only when text **and** cleaned constraints are both empty (`app/api/directive/route.ts:33`).

- [ ] **Step 7: Commit**

```bash
git add lib/server/directive.ts lib/server/directive.test.ts app/api/directive/route.test.ts
git commit -m "feat(directive): store prefer_authors and prefer_subjects constraints (#82)"
```

---

## Task 2: Read preferences back out of the constraints blob

**Files:**
- Create: `lib/server/preferences.ts`
- Modify: `lib/server/recAssemble.ts` (add the `PoolPreferences` interface only — the `metadataPool` change is Task 3)
- Test: `lib/server/__tests__/preferences.test.ts` (create)

**Interfaces:**
- Consumes: `surname` from `lib/server/dedup.ts`.
- Produces:
  - `interface PoolPreferences { prefer_subjects: string[]; prefer_authors: string[] }` exported from `lib/server/recAssemble.ts`.
  - `readPreferences(constraints: Record<string, unknown> | null | undefined): PoolPreferences`
  - `preferredAuthorSurnames(authors: string[]): Set<string>`

- [ ] **Step 1: Write the failing test**

Create `lib/server/__tests__/preferences.test.ts`:

```ts
import { describe, test, expect } from 'vitest';
import { readPreferences, preferredAuthorSurnames } from '../preferences';

describe('readPreferences', () => {
  test('returns empty lists for a blob with no favorites', () => {
    expect(readPreferences({ exclude_authors: ['john ringo'] })).toEqual({
      prefer_subjects: [],
      prefer_authors: [],
    });
    expect(readPreferences(null)).toEqual({ prefer_subjects: [], prefer_authors: [] });
  });

  test('reads both families and drops blanks', () => {
    expect(
      readPreferences({
        prefer_authors: ['Gene Wolfe', '  ', ' Ursula K. Le Guin '],
        prefer_subjects: ['space opera'],
      })
    ).toEqual({
      prefer_authors: ['Gene Wolfe', 'Ursula K. Le Guin'],
      prefer_subjects: ['space opera'],
    });
  });

  test('ignores a non-array value', () => {
    expect(readPreferences({ prefer_authors: 'Gene Wolfe' })).toEqual({
      prefer_subjects: [],
      prefer_authors: [],
    });
  });
});

describe('preferredAuthorSurnames', () => {
  test('keys on surname(), lowercased, matching libraryAuthors', () => {
    expect(preferredAuthorSurnames(['Ursula K. Le Guin', 'Gene Wolfe'])).toEqual(
      new Set(['guin', 'wolfe'])
    );
  });

  test('skips names that reduce to nothing', () => {
    expect(preferredAuthorSurnames(['...', ''])).toEqual(new Set());
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/server/__tests__/preferences.test.ts`
Expected: FAIL — cannot resolve `../preferences`.

- [ ] **Step 3: Add `PoolPreferences` to `recAssemble.ts`**

In `lib/server/recAssemble.ts`, immediately after the `PoolEntry` type:

```ts
/**
 * The reader's explicit favorites, handed to metadataPool as an EXPLICIT argument
 * rather than pre-merged into the signal: cold start must treat preferred and
 * inferred authors differently, and a merged list cannot express that.
 */
export interface PoolPreferences {
  prefer_subjects: string[];
  prefer_authors: string[];
}
```

- [ ] **Step 4: Write the implementation**

Create `lib/server/preferences.ts`:

```ts
/**
 * Reading side of the reader's explicit favorites. `cleanDirectiveConstraints` in
 * directive.ts is the only writer; this is the only reader, so the recommender never
 * re-derives the stored shape.
 */
import { surname } from './dedup';
import type { PoolPreferences } from './recAssemble';

/** Type-only import above, so there is no runtime cycle with recAssemble. */
function stringList(v: unknown): string[] {
  return (Array.isArray(v) ? v : []).map((x) => String(x).trim()).filter((s) => s !== '');
}

export function readPreferences(
  constraints: Record<string, unknown> | null | undefined
): PoolPreferences {
  return {
    prefer_subjects: stringList(constraints?.prefer_subjects),
    prefer_authors: stringList(constraints?.prefer_authors),
  };
}

/**
 * surname()-normalized, the same keying applyAuthorCaps uses for libraryAuthors, so
 * the two sets compose without a second normalization pass. surname() already
 * lowercases (via normalizeTitle), which is where the case-preserving stored form
 * gets folded for comparison.
 *
 * SURNAME COLLISIONS ARE ACCEPTED, NOT FIXED: "Ursula K. Le Guin" reduces to `guin`,
 * so favoriting her exempts anyone sharing that surname. Same fidelity libraryAuthors
 * has always had; the failure mode is a mildly worse candidate, not a wrong one.
 */
export function preferredAuthorSurnames(authors: string[]): Set<string> {
  const out = new Set<string>();
  for (const a of authors) {
    const key = surname(a);
    if (key) out.add(key);
  }
  return out;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run lib/server/__tests__/preferences.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/server/preferences.ts lib/server/recAssemble.ts lib/server/__tests__/preferences.test.ts
git commit -m "feat(rec): read stored favorites out of the directive constraints blob (#82)"
```

---

## Task 3: Retrieval — favorites generate their own catalog queries

**Files:**
- Modify: `lib/server/recAssemble.ts:72-95` (`metadataPool`)
- Test: `lib/server/__tests__/rec-metadata-pool.test.ts` (create)

**Interfaces:**
- Consumes: `PoolPreferences` from Task 2; `TOP_SUBJECTS` / `TOP_AUTHORS` from `lib/server/recSignal.ts`.
- Produces:
  ```ts
  export async function metadataPool(
    db: Db,
    signal: Pick<RecSignal, 'top_subjects' | 'top_authors'>,
    perQuery: number,
    coldStart: boolean,
    preferences?: PoolPreferences
  ): Promise<PoolEntry[]>
  ```
  Reason tags: `preferred_subject:<s>` and `preferred_author:<a>` for preferred entries; the existing `subject:<s>` / `author:<a>` for inferred ones.

**Why the default argument matters:** `recSimilarRun.ts:69` calls `metadataPool(db, signal, PER_QUERY, false)`. With the default it compiles untouched and issues exactly the same catalog calls in exactly the same order — which the recorded HTTP fixtures in `similar-run.test.ts` replay.

**Why the reason tag is safe to change:** `seed_reason` is persisted and typed but no `.tsx` component parses it (`lib/api.ts:93,115,141` and `schema.ts:167` are the only non-test references). It already travels into the rerank prompt via `AssembledCandidate`, so the reranker learns a candidate's provenance at no added prompt cost.

**Note on the runtime import:** `recAssemble.ts` currently imports from `recSignal.ts` type-only. Adding a *value* import of `TOP_SUBJECTS` / `TOP_AUTHORS` is safe: `recSignal.ts:14` imports `AssembleSignal` back with `import type`, so there is no runtime edge in the other direction.

- [ ] **Step 1: Write the failing test**

Create `lib/server/__tests__/rec-metadata-pool.test.ts`:

```ts
import { describe, test, expect, vi, beforeEach } from 'vitest';

// Every catalog call is recorded in order, so a test can assert the exact request
// sequence — the property the merge-and-truncate budget is really about.
const calls: string[] = [];

vi.mock('../catalog', () => ({
  openlibrarySubject: async (_db: unknown, s: string) => {
    calls.push(`ol_subject:${s}`);
    return [];
  },
  googleBooksSubject: async (_db: unknown, s: string) => {
    calls.push(`gb_subject:${s}`);
    return [{ title: `S ${s}`, author: 'A B', subjects: [], raw: {} }];
  },
  googleBooksAuthor: async (_db: unknown, a: string) => {
    calls.push(`gb_author:${a}`);
    return [{ title: `A ${a}`, author: a, subjects: [], raw: {} }];
  },
  googleBooksQuery: async () => [],
  openlibraryQuery: async () => [],
  openlibraryWorkDescription: async () => null,
}));

const { metadataPool } = await import('../recAssemble');

const db = {} as never;
const sig = (subjects: string[], authors: string[]) => ({
  top_subjects: subjects,
  top_authors: authors,
});

beforeEach(() => {
  calls.length = 0;
});

describe('metadataPool without preferences', () => {
  test('reproduces today’s call sequence and reason tags exactly', async () => {
    const out = await metadataPool(db, sig(['a', 'b'], ['X Y']), 8, false);
    expect(calls).toEqual([
      'ol_subject:a',
      'gb_subject:a',
      'ol_subject:b',
      'gb_subject:b',
      'gb_author:X Y',
    ]);
    expect(out.map(([, reason]) => reason)).toEqual(['subject:a', 'subject:b', 'author:X Y']);
  });

  test('cold start still skips inferred authors', async () => {
    await metadataPool(db, sig(['a'], ['X Y']), 8, true);
    expect(calls).toEqual(['ol_subject:a', 'gb_subject:a']);
  });

  test('duplicate and case-variant inferred subjects are still queried separately', async () => {
    // /similar feeds metadataPool raw enrichment.subjects (recSignal.ts:363), which
    // today are neither deduplicated nor case-folded. Collapsing them would change
    // that route's recorded catalog call sequence.
    await metadataPool(db, sig(['Space Opera', 'space opera', 'Space Opera'], []), 8, false);
    expect(calls).toEqual([
      'ol_subject:Space Opera',
      'gb_subject:Space Opera',
      'ol_subject:space opera',
      'gb_subject:space opera',
      'ol_subject:Space Opera',
      'gb_subject:Space Opera',
    ]);
  });
});

describe('metadataPool with preferences', () => {
  test('queries preferred subjects first and tags their provenance', async () => {
    const out = await metadataPool(db, sig(['inferred'], []), 8, false, {
      prefer_subjects: ['space opera'],
      prefer_authors: [],
    });
    expect(calls).toEqual([
      'ol_subject:space opera',
      'gb_subject:space opera',
      'ol_subject:inferred',
      'gb_subject:inferred',
    ]);
    expect(out.map(([, r]) => r)).toEqual([
      'preferred_subject:space opera',
      'subject:inferred',
    ]);
  });

  test('queries preferred authors in COLD START, while inferred authors stay skipped', async () => {
    const out = await metadataPool(db, sig([], ['Inferred Author']), 8, true, {
      prefer_subjects: [],
      prefer_authors: ['Gene Wolfe'],
    });
    expect(calls).toEqual(['gb_author:Gene Wolfe']);
    expect(out.map(([, r]) => r)).toEqual(['preferred_author:Gene Wolfe']);
  });

  test('reserves two inferred slots in each list', async () => {
    // 10 favorites, but only TOP_SUBJECTS - 2 = 6 may generate subject queries and
    // only TOP_AUTHORS - 2 = 4 may generate author queries.
    const many = (p: string) => Array.from({ length: 10 }, (_, i) => `${p}${i}`);
    await metadataPool(db, sig(['inf0', 'inf1', 'inf2'], ['ia0', 'ia1', 'ia2']), 8, false, {
      prefer_subjects: many('ps'),
      prefer_authors: many('pa'),
    });
    const subjects = calls.filter((c) => c.startsWith('gb_subject:')).map((c) => c.slice(11));
    const authors = calls.filter((c) => c.startsWith('gb_author:')).map((c) => c.slice(10));
    expect(subjects).toEqual(['ps0', 'ps1', 'ps2', 'ps3', 'ps4', 'ps5', 'inf0', 'inf1']);
    expect(authors).toEqual(['pa0', 'pa1', 'pa2', 'pa3', 'ia0', 'ia1']);
  });

  test('a favorite that duplicates an inferred entry is queried once, as preferred', async () => {
    await metadataPool(db, sig(['Space Opera'], []), 8, false, {
      prefer_subjects: ['space opera'],
      prefer_authors: [],
    });
    expect(calls).toEqual(['ol_subject:space opera', 'gb_subject:space opera']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/server/__tests__/rec-metadata-pool.test.ts`
Expected: FAIL — the preference tests fail because `metadataPool` ignores its 5th argument (the two no-preference tests should already pass).

- [ ] **Step 3: Implement the merge**

In `lib/server/recAssemble.ts`, change the `recSignal` import from type-only to a mixed import:

```ts
import { TOP_AUTHORS, TOP_SUBJECTS } from './recSignal';
import type { RecSignal } from './recSignal';
```

Add above `metadataPool`:

```ts
/** Inferred slots that survive the merge in each list, so a full favorites list can
 *  never silence the taste profile entirely. */
const INFERRED_RESERVE = 2;

/**
 * Merge-and-truncate, NOT an additive budget: preferred entries take slots from
 * inferred ones wherever the inferred list is already full, and the merged list is
 * still capped at the same TOP_* limit, so the per-run catalog-call CEILING does not
 * move. (A specific run can still gain calls — cold start issues no author calls
 * today, and an under-full inferred list has spare slots. See the plan's "zero added
 * catalog calls is too strong" note.)
 *
 * Returns [value, isPreferred] pairs, preferred first.
 *
 * DEDUP IS ONE-DIRECTIONAL ON PURPOSE: an inferred entry is skipped only when it
 * collides with a PREFERRED one. Inferred entries are never deduplicated against
 * each other, because today's metadataPool does not deduplicate them either —
 * /similar feeds it raw `enrichment.subjects` (recSignal.ts:363, only sliced to
 * TOP_SUBJECTS), which can hold duplicates and case variants. Folding those together
 * would silently change /similar's recorded catalog call sequence. With an empty
 * `preferred` this function is therefore a pass-through.
 *
 * THIS TRUNCATION IS RETRIEVAL-ONLY. It governs which favorites spend a catalog
 * call; recPrompts renders the FULL stored list (up to MAX_PREFER_ENTRIES), so a
 * favorite past this cut still boosts any candidate that reaches the reranker by
 * another route.
 */
function mergePreferred(
  preferred: string[],
  inferred: string[],
  limit: number
): Array<[string, boolean]> {
  const out: Array<[string, boolean]> = [];
  const claimed = new Set<string>();
  for (const value of preferred.slice(0, Math.max(0, limit - INFERRED_RESERVE))) {
    const fold = value.toLowerCase();
    if (claimed.has(fold)) continue;
    claimed.add(fold);
    out.push([value, true]);
  }
  for (const value of inferred) {
    if (out.length >= limit) break;
    // Note: `value` is NOT added to `claimed` — see the one-directional note above.
    if (claimed.has(value.toLowerCase())) continue;
    out.push([value, false]);
  }
  return out.slice(0, limit);
}
```

Replace the body of `metadataPool`:

```ts
export async function metadataPool(
  db: Db,
  signal: Pick<RecSignal, 'top_subjects' | 'top_authors'>,
  perQuery: number,
  coldStart: boolean,
  preferences: PoolPreferences = { prefer_subjects: [], prefer_authors: [] }
): Promise<PoolEntry[]> {
  const pool: PoolEntry[] = [];
  for (const [subject, preferred] of mergePreferred(
    preferences.prefer_subjects,
    signal.top_subjects,
    TOP_SUBJECTS
  )) {
    const reason = `${preferred ? 'preferred_subject' : 'subject'}:${subject}`;
    for (const c of await openlibrarySubject(db, subject, perQuery)) pool.push([c, reason]);
    for (const c of await googleBooksSubject(db, subject, perQuery)) pool.push([c, reason]);
  }
  // Preferred authors are queried FIRST and ALWAYS, cold start included: the cold-start
  // skip exists because inferred authors are unreliable in a thin library, and an
  // explicit favorite is not an inference. Inferred authors keep today's behavior.
  for (const [author, preferred] of mergePreferred(
    preferences.prefer_authors,
    coldStart ? [] : signal.top_authors,
    TOP_AUTHORS
  )) {
    const reason = `${preferred ? 'preferred_author' : 'author'}:${author}`;
    for (const c of await googleBooksAuthor(db, author, perQuery)) pool.push([c, reason]);
  }
  return pool;
}
```

Also update the doc comment above `metadataPool` so it mentions that explicit favorites bypass the cold-start skip.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run lib/server/__tests__/rec-metadata-pool.test.ts`
Expected: PASS — every case in the file. (Counts drift as cases are added; do not treat a number here as the gate.)

- [ ] **Step 5: Run the retrieval-adjacent suites to prove nothing regressed**

Run: `npx vitest run lib/server/__tests__/rec-assemble.test.ts lib/server/__tests__/similar-run.test.ts lib/server/__tests__/recommend-run.test.ts`
Expected: PASS. `similar-run` and `recommend-run` replay recorded catalog HTTP; any change to the call sequence shows up here.

- [ ] **Step 6: Commit**

```bash
git add lib/server/recAssemble.ts lib/server/__tests__/rec-metadata-pool.test.ts
git commit -m "feat(rec): retrieve catalog candidates for favorite subjects and authors (#82)"
```

---

## Task 4: Author caps — exempt favorites from the library trim, not from `MAX_PER_AUTHOR`

**Files:**
- Modify: `lib/server/recFilters.ts:117-141` (`applyAuthorCaps`)
- Modify: `lib/server/recAssemble.ts:131-188` (`assemble`)
- Test: `lib/server/__tests__/rec-filters.test.ts`
- Test: `lib/server/__tests__/rec-assemble.test.ts`

**Interfaces:**
- Consumes: `preferredAuthorSurnames` output from Task 2 (a `Set<string>` of `surname()` keys).
- Produces:
  ```ts
  export function applyAuthorCaps<T extends { author?: string | null }>(
    candidates: T[],
    libraryAuthors: Set<string>,
    preferredAuthors?: Set<string>
  ): T[]

  export function assemble(
    metadataEntries: PoolEntry[],
    seedEntries: PoolEntry[],
    signal: AssembleSignal,
    cap: number,
    preferredAuthorSurnames?: Set<string>
  ): AssembledCandidate[]
  ```

**Why `AssembleSignal` is NOT extended:** adding a field would force `buildBookSignal` to supply it and drag `/similar` into directive scope. An optional parameter keeps the blast radius at one caller — `recommendRun`. `recSimilarRun.ts:73` and `recDiscoverRun.ts:98` keep the empty default.

**Task 4 also pins §4.4:** `applyDirectiveConstraints` is *not* modified. A constraints object containing only `prefer_*` keys is non-empty, so it passes the `Object.keys(constraints).length === 0` early return at `recFilters.ts:181` and walks every candidate, which then all fall through to `return true`. That is correct but *accidentally* correct — a future unrecognized-key guard would silently empty the pool. The test below pins it.

- [ ] **Step 1: Write the failing tests**

Append to `lib/server/__tests__/rec-filters.test.ts`. The file already imports `applyAuthorCaps` and `applyDirectiveConstraints`; add `MAX_PER_AUTHOR` to that same import list, which is not there yet:

```ts
import {
  dedupKey,
  EMPTY_DEDUP_KEY,
  allowedLanguages,
  languageOk,
  seriesInfo,
  seriesOk,
  fuzzyDuplicate,
  isLearnerEdition,
  applyAuthorCaps,
  MAX_PER_AUTHOR,
  subjectHits,
  applyDirectiveConstraints,
} from '../recFilters';
```


```ts
describe('applyAuthorCaps with preferred authors', () => {
  const c = (author: string) => ({ author });

  test('the empty-set default is behavior-identical to the two-argument call', () => {
    const pool = [c('A One'), c('B Two'), c('A One')];
    const lib = new Set(['one']);
    expect(applyAuthorCaps(pool, lib)).toEqual(applyAuthorCaps(pool, lib, new Set()));
  });

  // FIXTURE DESIGN, do not "simplify": the preferred author must be one the CURRENT
  // code actually drops, and enough non-preferred library authors must remain after
  // the exemption that `lib.length > maxLib` still holds — otherwise applyAuthorCaps
  // returns `kept` untouched and the test proves nothing about either branch.
  //
  // 14 candidates → maxLib = trunc(14 * 0.4) = 5.
  // kept order: L1..L7 (library, not preferred), P (library, PREFERRED), N1..N6 (new).
  //   no preference: lib = [L1..L7, P] (8) > 5 → [N1..N6, L1..L5]; P is dropped.
  //   preferring P:  lib = [L1..L7]   (7) > 5 → [P, N1..N6, L1..L5]; P survives, first.
  const libAuthors = ['L1 One', 'L2 Two', 'L3 Three', 'L4 Four', 'L5 Five', 'L6 Six', 'L7 Seven'];
  const capPool14 = [
    ...libAuthors.map(c),
    c('Gene Wolfe'),
    ...['N1 A', 'N2 B', 'N3 C', 'N4 D', 'N5 E', 'N6 F'].map(c),
  ];
  // surname() lowercases via normalizeTitle and keeps the last token, so these are
  // spelled out rather than importing surname() into this file just for the fixture.
  const capLib = new Set(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'wolfe']);

  test('a preferred library author survives a trim that drops them today', () => {
    const trimmed = applyAuthorCaps(capPool14, capLib).map((x) => x.author);
    expect(trimmed).not.toContain('Gene Wolfe');

    const kept = applyAuthorCaps(capPool14, capLib, new Set(['wolfe'])).map((x) => x.author);
    expect(kept).toContain('Gene Wolfe');
  });

  test('a preferred author is not reordered down, and the reorder branch still runs', () => {
    const kept = applyAuthorCaps(capPool14, capLib, new Set(['wolfe'])).map((x) => x.author);
    // Preferred sorts into the non-library partition, which is emitted first — and it
    // was NOT first in the input, so this could only come from the partition change.
    expect(kept[0]).toBe('Gene Wolfe');
    // The trim genuinely fired: L6/L7 lost their slots to maxLib = 5.
    expect(kept).not.toContain('L6 Six');
    expect(kept).not.toContain('L7 Seven');
  });

  test('MAX_PER_AUTHOR still caps a preferred author at 2', () => {
    const pool = [c('Gene Wolfe'), c('Gene Wolfe'), c('Gene Wolfe'), c('Gene Wolfe')];
    const kept = applyAuthorCaps(pool, new Set(['wolfe']), new Set(['wolfe']));
    expect(kept).toHaveLength(MAX_PER_AUTHOR);
  });
});

describe('applyDirectiveConstraints and favorites', () => {
  // A preference must NEVER remove a candidate. This object is non-empty, so it
  // walks every candidate instead of taking the early return — correct today only
  // because no branch reads the new keys. Pinned so a future unrecognized-key guard
  // cannot silently empty the pool.
  test('a constraints object containing only prefer_* keys returns every candidate', () => {
    const pool = [
      { author: 'Gene Wolfe', year: 1980, subjects: ['space opera'] },
      { author: 'Someone Else', year: 2020, subjects: ['grimdark'] },
      { author: null, year: null, subjects: null },
    ];
    expect(
      applyDirectiveConstraints(pool, {
        prefer_authors: ['Gene Wolfe'],
        prefer_subjects: ['space opera'],
      })
    ).toEqual(pool);
  });
});
```

Append to `lib/server/__tests__/rec-assemble.test.ts`:

```ts
describe('assemble threads preferred authors into the caps', () => {
  test('the empty-set default matches the four-argument call', () => {
    const signal = emptySignal();
    signal.library_authors.add('wolfe');
    const pool = [
      entry(cand({ title: 'One', author: 'Gene Wolfe' })),
      entry(cand({ title: 'Two', author: 'New Person' })),
    ];
    expect(assemble(pool, [], signal, 60)).toEqual(assemble(pool, [], signal, 60, new Set()));
  });

  test('a preferred library author is exempt from the library trim', () => {
    // Same fixture shape as rec-filters.test.ts, and for the same reason: the
    // preferred author must be one the CURRENT code drops, and enough non-preferred
    // library authors must survive the exemption to keep lib.length > maxLib.
    // 14 candidates → maxLib = trunc(14 * 0.4) = 5.
    const signal = emptySignal();
    for (const s of ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'wolfe']) {
      signal.library_authors.add(s);
    }
    const pool = [
      entry(cand({ title: 'L1', author: 'L1 One' })),
      entry(cand({ title: 'L2', author: 'L2 Two' })),
      entry(cand({ title: 'L3', author: 'L3 Three' })),
      entry(cand({ title: 'L4', author: 'L4 Four' })),
      entry(cand({ title: 'L5', author: 'L5 Five' })),
      entry(cand({ title: 'L6', author: 'L6 Six' })),
      entry(cand({ title: 'L7', author: 'L7 Seven' })),
      entry(cand({ title: 'P', author: 'Gene Wolfe' })),
      entry(cand({ title: 'N1', author: 'N1 A' })),
      entry(cand({ title: 'N2', author: 'N2 B' })),
      entry(cand({ title: 'N3', author: 'N3 C' })),
      entry(cand({ title: 'N4', author: 'N4 D' })),
      entry(cand({ title: 'N5', author: 'N5 E' })),
      entry(cand({ title: 'N6', author: 'N6 F' })),
    ];
    const without = assemble(pool, [], signal, 60).map((c) => c.title);
    const withPref = assemble(pool, [], signal, 60, new Set(['wolfe'])).map((c) => c.title);
    expect(without).not.toContain('P');
    expect(withPref[0]).toBe('P');
    // The trim still fired, so the exemption did not simply disable it.
    expect(withPref).not.toContain('L6');
    expect(withPref).not.toContain('L7');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/server/__tests__/rec-filters.test.ts lib/server/__tests__/rec-assemble.test.ts`
Expected: FAIL — the preferred-author cases fail (the extra argument is ignored). The `applyDirectiveConstraints` pin should already pass; that is fine, it is a regression guard.

- [ ] **Step 3: Implement the exemption**

In `lib/server/recFilters.ts`, replace the signature and the partition of `applyAuthorCaps`:

```ts
export function applyAuthorCaps<T extends { author?: string | null }>(
  candidates: T[],
  libraryAuthors: Set<string>,
  preferredAuthors: Set<string> = new Set()
): T[] {
  const perAuthor = new Map<string, number>();
  const kept: T[] = [];
  for (const c of candidates) {
    const a = surname(c.author ?? null);
    if (a) {
      const n = perAuthor.get(a) ?? 0;
      // MAX_PER_AUTHOR is a QUALITY guard, not a weak-inference crutch, so preferred
      // authors are deliberately NOT exempt from it: a favorite does not make ten
      // books by one person a good deck.
      if (n >= MAX_PER_AUTHOR) continue;
      perAuthor.set(a, n + 1);
    }
    kept.push(c);
  }

  const total = kept.length;
  if (!total) return kept;
  // The 40% library-author trim assumes "already on your shelf" means "not
  // discovery". An explicit favorite is precisely the statement that the assumption
  // is wrong, so a preferred author sorts into `non`: the trim never drops them and
  // the reorder never pushes them down.
  const isPreferred = (c: T) => preferredAuthors.has(surname(c.author ?? null));
  const lib = kept.filter((c) => libraryAuthors.has(surname(c.author ?? null)) && !isPreferred(c));
  const non = kept.filter((c) => !libraryAuthors.has(surname(c.author ?? null)) || isPreferred(c));
  // `total` stays kept.length, so maxLib is computed against the same denominator as
  // before and the budget for genuinely-library authors does not silently grow.
  // Python's int() truncates toward zero, unlike Math.round.
  const maxLib = Math.max(1, Math.trunc(total * MAX_LIBRARY_AUTHOR_SHARE));
  if (lib.length > maxLib) return [...non, ...lib.slice(0, maxLib)];
  return kept;
}
```

In `lib/server/recAssemble.ts`, change `assemble`'s signature and its single `applyAuthorCaps` call:

```ts
export function assemble(
  metadataEntries: PoolEntry[],
  seedEntries: PoolEntry[],
  signal: AssembleSignal,
  cap: number,
  // NOT a field on AssembleSignal: adding one would force buildBookSignal to supply
  // it and drag /similar into directive scope. recommendRun is the only caller that
  // passes it; /similar and /discover keep the empty default.
  preferredAuthorSurnames: Set<string> = new Set()
): AssembledCandidate[] {
```

and:

```ts
  return capPool(
    applyAuthorCaps(candidates, signal.library_authors, preferredAuthorSurnames),
    cap
  );
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/server/__tests__/rec-filters.test.ts lib/server/__tests__/rec-assemble.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/server/recFilters.ts lib/server/recAssemble.ts lib/server/__tests__/rec-filters.test.ts lib/server/__tests__/rec-assemble.test.ts
git commit -m "feat(rec): exempt favorite authors from the library-author trim (#82)"
```

---

## Task 5: Prompts — tell Claude about the favorites

**Files:**
- Modify: `lib/server/recPrompts.ts:167-239` (`buildSeedPrompt`, `userSteeringBlock`)
- Test: `lib/server/__tests__/rec-prompts-favorites.test.ts` (create)

**Interfaces:**
- Consumes: `readPreferences` from Task 2; `signal.directive_constraints` (already on `RecSignal`, `recSignal.ts:72`).
- Produces: no signature changes. Both builders already receive the full `RecSignal`.

**Placement:** the two blocks go into `userSteeringBlock` immediately after `LESS LIKE` and before `FREQUENT REJECT REASONS` / `CUSTOM INSTRUCTIONS` — favorites are more specific than prose guidance but less specific than the reader's own sentences.

**The conditional weighting clause (see "Correction to the spec" above):** `recommend-run.test.ts` pins the rerank prompt byte-for-byte. Emit the favorites clause only when at least one list is non-empty, so a reader with no favorites gets today's exact string.

- [ ] **Step 1: Write the failing test**

Create `lib/server/__tests__/rec-prompts-favorites.test.ts`:

```ts
import { describe, test, expect } from 'vitest';
import { buildSeedPrompt, userSteeringBlock } from '../recPrompts';
import type { RecSignal } from '../recSignal';

const signal = (constraints: Record<string, unknown>): RecSignal =>
  ({
    library_keys: new Set(),
    library_isbns: new Set(),
    library_languages: new Set(),
    library_authors: new Set(),
    library_titles: [],
    library_series: new Map(),
    loved: [],
    rated_count: 0,
    top_subjects: [],
    top_authors: [],
    traits: [],
    more_like: [],
    less_like: [],
    reject_reason_counts: new Map(),
    rejected_with_notes: [],
    directive_text: null,
    directive_constraints: constraints,
  }) as unknown as RecSignal;

const favorites = {
  prefer_authors: ['Ursula K. Le Guin', 'Gene Wolfe'],
  prefer_subjects: ['space opera', 'translated fiction'],
};

describe('userSteeringBlock', () => {
  test('is byte-identical to today when there are no favorites', () => {
    expect(userSteeringBlock(signal({}))).toBe(
      userSteeringBlock(signal({ exclude_authors: ['john ringo'] }))
    );
    expect(userSteeringBlock(signal({}))).not.toContain('FAVORITE');
  });

  test('renders both blocks with pyJsonDumps and names them in the weighting clause', () => {
    const out = userSteeringBlock(signal(favorites));
    expect(out).toContain(
      'FAVORITE AUTHORS (the reader explicitly marked these as favorites; treat a ' +
        'candidate written by one of them as a strong positive signal):\n' +
        '["Ursula K. Le Guin", "Gene Wolfe"]'
    );
    expect(out).toContain(
      'FAVORITE SUBJECTS (the reader explicitly marked these as favorites; treat a ' +
        'candidate carrying one of them as a strong positive signal):\n' +
        '["space opera", "translated fiction"]'
    );
    expect(out).toContain('reward candidates by a favorite author');
  });

  test('emits only the populated family', () => {
    const out = userSteeringBlock(signal({ prefer_subjects: ['space opera'] }));
    expect(out).toContain('FAVORITE SUBJECTS');
    expect(out).not.toContain('FAVORITE AUTHORS');
  });

  test('places favorites after LESS LIKE and before CUSTOM INSTRUCTIONS', () => {
    const s = signal(favorites);
    s.less_like.push('A Bad Book by Someone');
    s.directive_text = 'No grimdark.';
    const out = userSteeringBlock(s);
    expect(out.indexOf('LESS LIKE')).toBeLessThan(out.indexOf('FAVORITE AUTHORS'));
    expect(out.indexOf('FAVORITE SUBJECTS')).toBeLessThan(out.indexOf('CUSTOM INSTRUCTIONS'));
  });
});

describe('buildSeedPrompt', () => {
  test('is unchanged when there are no favorites', () => {
    const task = buildSeedPrompt(signal({}), 8)[1].text;
    expect(task).not.toContain('marked as favorites');
  });

  test('adds a bias clause per populated family', () => {
    const task = buildSeedPrompt(signal(favorites), 8)[1].text;
    expect(task).toContain(
      ' Favor queries that would surface books by these authors the reader has ' +
        'marked as favorites: ["Ursula K. Le Guin", "Gene Wolfe"].'
    );
    expect(task).toContain(
      ' Favor queries covering these subjects the reader has marked as favorites: ' +
        '["space opera", "translated fiction"].'
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/server/__tests__/rec-prompts-favorites.test.ts`
Expected: FAIL — the favorites blocks are not emitted.

- [ ] **Step 3: Implement the prompt blocks**

In `lib/server/recPrompts.ts`, add the import:

```ts
import { readPreferences } from './preferences';
```

In `buildSeedPrompt`, after the `less_like` branch:

```ts
  // Emitted only when populated, so today's output is preserved byte-for-byte for a
  // reader with no favorites (recommend-run.test.ts pins this prompt).
  const preferences = readPreferences(signal.directive_constraints);
  if (preferences.prefer_authors.length) {
    steering +=
      ' Favor queries that would surface books by these authors the reader has ' +
      'marked as favorites: ' +
      pyJsonDumps(preferences.prefer_authors) +
      '.';
  }
  if (preferences.prefer_subjects.length) {
    steering +=
      ' Favor queries covering these subjects the reader has marked as favorites: ' +
      pyJsonDumps(preferences.prefer_subjects) +
      '.';
  }
```

In `userSteeringBlock`, immediately after the `less_like` branch and before the `reject_reason_counts` branch:

```ts
  // Favorites sit between the more/less-like books and the reader's own prose: more
  // specific than prose guidance, less specific than their own sentences.
  const preferences = readPreferences(signal.directive_constraints);
  const hasFavorites =
    preferences.prefer_authors.length > 0 || preferences.prefer_subjects.length > 0;
  if (preferences.prefer_authors.length) {
    lines.push(
      'FAVORITE AUTHORS (the reader explicitly marked these as favorites; treat a ' +
        'candidate written by one of them as a strong positive signal):\n' +
        pyJsonDumps(preferences.prefer_authors)
    );
  }
  if (preferences.prefer_subjects.length) {
    lines.push(
      'FAVORITE SUBJECTS (the reader explicitly marked these as favorites; treat a ' +
        'candidate carrying one of them as a strong positive signal):\n' +
        pyJsonDumps(preferences.prefer_subjects)
    );
  }
```

Replace the closing `lines.push(...)` with:

```ts
  lines.push(
    'Favor candidates resembling the more-like books; penalize candidates ' +
      'resembling the less-like books; penalize candidates matching frequent reject ' +
      "reasons; weight trait influence by each trait's `user_weight`: traits with a " +
      'lower weight should influence the score less (0.0 = ignore, 1.0 = normal).' +
      // CONDITIONAL ON PURPOSE. recommend-run.test.ts asserts this whole block
      // byte-for-byte against fixtures/claude/prompts.json for a reader with no
      // favorites; an unconditional clause breaks that fixture.
      (hasFavorites
        ? ' Separately, reward candidates by a favorite author or carrying a favorite ' +
          'subject: treat those as strong positive evidence, second only to the ' +
          "reader's own custom instructions."
        : '')
  );
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run lib/server/__tests__/rec-prompts-favorites.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove the pinned prompt fixture is still byte-identical**

Run: `npx vitest run lib/server/__tests__/recommend-run.test.ts lib/server/__tests__/similar-run.test.ts lib/server/__tests__/discover-run.test.ts`
Expected: PASS. If `recommend_rerank` now differs, a new string is being emitted unconditionally — fix the condition, do **not** re-record the fixture.

- [ ] **Step 6: Commit**

```bash
git add lib/server/recPrompts.ts lib/server/__tests__/rec-prompts-favorites.test.ts
git commit -m "feat(rec): name the reader's favorites in the seed and rerank prompts (#82)"
```

---

## Task 6: Wire favorites into the `/recommend` run

**Files:**
- Modify: `lib/server/recommendRun.ts:101-121`
- Test: `lib/server/__tests__/recommend-run.test.ts` (run only — no new case; the wiring is proven by Tasks 3–5 plus the browser check in Task 12)

**Interfaces:**
- Consumes: `readPreferences`, `preferredAuthorSurnames` (Task 2); the 5th parameters of `metadataPool` (Task 3) and `assemble` (Task 4).
- Produces: nothing new. `recommendRun` remains the **only** caller that supplies either argument.

- [ ] **Step 1: Add the import**

In `lib/server/recommendRun.ts`:

```ts
import { preferredAuthorSurnames, readPreferences } from './preferences';
```

- [ ] **Step 2: Read the preferences once, next to the existing constraints read**

After the `statedLanguages` block (`recommendRun.ts:103-108`):

```ts
  // Read once: the pool needs the raw lists (subjects are queried verbatim) and the
  // author caps need the surname()-keyed set.
  const preferences = readPreferences(directiveConstraints);
  const preferredSurnames = preferredAuthorSurnames(preferences.prefer_authors);
```

- [ ] **Step 3: Pass them to the two consumers**

```ts
  const metaPool = useMetadata
    ? await metadataPool(db, signal, PER_QUERY, coldStart, preferences)
    : [];
```

and:

```ts
  let candidates = assemble(metaPool, seedEntries, signal, MAX_CANDIDATES, preferredSurnames);
```

- [ ] **Step 4: Run the run-level suites**

Run: `npx vitest run lib/server/__tests__/recommend-run.test.ts lib/server/__tests__/recommend-route.test.ts`
Expected: PASS. The seeded fixture user has no `prefer_*` keys, so both the catalog call sequence and the two prompts stay byte-identical.

- [ ] **Step 5: Type-check**

Run: `npm run type-check`
Expected: clean. In particular, `recSimilarRun.ts` and `recDiscoverRun.ts` must compile untouched on the defaults.

- [ ] **Step 6: Commit**

```bash
git add lib/server/recommendRun.ts
git commit -m "feat(rec): feed stored favorites into retrieval and the author caps (#82)"
```

---

## Task 7: Suggest favorites from the reader's own loved books

**Files:**
- Create: `lib/server/preferenceSuggest.ts`
- Test: `lib/server/__tests__/preference-suggest.test.ts` (create)

**Interfaces:**
- Consumes: `schema`, `Db` from `./db`; `LOVED_MIN`, `mostCommon` from `./recSignal`; `effectiveRating` from `./serialize`.
- Produces:
  ```ts
  export interface Suggestion { value: string; count: number }
  export interface PreferenceSuggestions { subjects: Suggestion[]; authors: Suggestion[] }
  export async function suggestPreferences(
    db: Db,
    userId: string,
    constraints: Record<string, unknown>
  ): Promise<PreferenceSuggestions>
  ```

**Why not reuse `buildSignal`:** it is a five-query function carrying byte-parity commitments, and its counting loop is interleaved with library-key, series and loved-book accumulation. Extracting it would put parity-sensitive code at risk to save ~10 lines. One simpler query is cheaper and safer.

**Counting rules, all deliberate:** loved books only (`effectiveRating(app, goodreads) >= LOVED_MIN`) — the same rule as `recSignal.ts:136`, because suggestions must reflect what actually drives the recommender, not what merely fills the shelf. Authors counted on the verbatim `books.author` string (that value is handed to `googleBooksAuthor` as a query). Subjects counted on `enrichment.subjects` entries as stored. Ordering reuses `mostCommon` so ties break identically to `top_subjects` / `top_authors`. Filter *before* truncation, so accepting a suggestion reveals the next candidate rather than shortening the list.

- [ ] **Step 1: Write the failing test**

Create `lib/server/__tests__/preference-suggest.test.ts`:

```ts
import { describe, test, expect, vi } from 'vitest';
import { makeTestDb } from './helpers/pglite';
import { setupTestEnv } from './helpers/testEnv';
import { schema, type Db } from '../db';
import { suggestPreferences } from '../preferenceSuggest';

setupTestEnv();

async function withDb(fn: (db: Db) => Promise<void>): Promise<void> {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const { db, close } = await makeTestDb();
  try {
    await fn(db);
  } finally {
    await close();
  }
}

/** Insert one book + its enrichment row. goodreadsRating 0 means unrated. */
async function addBook(
  db: Db,
  over: { author: string; rating?: number; appRating?: number; subjects?: string[]; userId?: string }
): Promise<void> {
  const [row] = await db
    .insert(schema.books)
    .values({
      userId: over.userId ?? 'local',
      title: `Book by ${over.author} ${Math.random()}`,
      author: over.author,
      goodreadsRating: over.rating ?? 0,
      appRating: over.appRating ?? null,
      source: 'test',
    })
    .returning({ id: schema.books.id });
  await db.insert(schema.enrichment).values({
    bookId: row.id,
    subjects: over.subjects ?? [],
    resolutionConfidence: 1,
  });
}

describe('suggestPreferences', () => {
  test('counts loved books only, ignoring unrated and low-rated ones', async () => {
    await withDb(async (db) => {
      await addBook(db, { author: 'Loved Author', rating: 5, subjects: ['space opera'] });
      await addBook(db, { author: 'Loved Author', rating: 4, subjects: ['space opera'] });
      await addBook(db, { author: 'Meh Author', rating: 3, subjects: ['grimdark'] });
      await addBook(db, { author: 'Unrated Author', rating: 0, subjects: ['grimdark'] });

      const out = await suggestPreferences(db, 'local', {});
      expect(out.authors).toEqual([{ value: 'Loved Author', count: 2 }]);
      expect(out.subjects).toEqual([{ value: 'space opera', count: 2 }]);
    });
  });

  test('an app_rating override decides lovedness', async () => {
    await withDb(async (db) => {
      // Goodreads says 2, the reader re-rated it 5 in-app: it counts as loved.
      await addBook(db, { author: 'Rerated', rating: 2, appRating: 5, subjects: ['x'] });
      const out = await suggestPreferences(db, 'local', {});
      expect(out.authors).toEqual([{ value: 'Rerated', count: 1 }]);
    });
  });

  test('is tenant-scoped', async () => {
    await withDb(async (db) => {
      await addBook(db, { author: 'Mine', rating: 5, subjects: ['mine'] });
      await addBook(db, { author: 'Theirs', rating: 5, subjects: ['theirs'], userId: 'other' });
      const out = await suggestPreferences(db, 'local', {});
      expect(out.authors.map((a) => a.value)).toEqual(['Mine']);
      expect(out.subjects.map((s) => s.value)).toEqual(['mine']);
    });
  });

  test('excludes values already in any of the four lists, before truncation', async () => {
    await withDb(async (db) => {
      // 14 distinct authors so the top-12 truncation is live.
      for (let i = 0; i < 14; i++) {
        for (let n = 0; n <= 14 - i; n++) {
          await addBook(db, { author: `Author ${i}`, rating: 5, subjects: [`subject ${i}`] });
        }
      }
      const out = await suggestPreferences(db, 'local', {
        prefer_authors: ['Author 0'],
        exclude_authors: ['author 1'],
        prefer_subjects: ['subject 0'],
        exclude_subjects: ['subject 1'],
      });
      expect(out.authors).toHaveLength(12);
      expect(out.authors.map((a) => a.value)).not.toContain('Author 0');
      expect(out.authors.map((a) => a.value)).not.toContain('Author 1');
      // Filtering happened BEFORE the cut, so the list is still full and reaches
      // deeper into the tail than an unfiltered top-12 would.
      expect(out.authors.map((a) => a.value)).toContain('Author 13');
      expect(out.subjects.map((s) => s.value)).not.toContain('subject 0');
      expect(out.subjects.map((s) => s.value)).not.toContain('subject 1');
    });
  });

  test('breaks count ties by first appearance, like mostCommon', async () => {
    await withDb(async (db) => {
      await addBook(db, { author: 'First Seen', rating: 5, subjects: ['alpha'] });
      await addBook(db, { author: 'Second Seen', rating: 5, subjects: ['beta'] });
      const out = await suggestPreferences(db, 'local', {});
      expect(out.authors.map((a) => a.value)).toEqual(['First Seen', 'Second Seen']);
      expect(out.subjects.map((s) => s.value)).toEqual(['alpha', 'beta']);
    });
  });

  test('a reader with no loved books gets two empty arrays, not an error', async () => {
    await withDb(async (db) => {
      await addBook(db, { author: 'Meh', rating: 2, subjects: ['x'] });
      expect(await suggestPreferences(db, 'local', {})).toEqual({ subjects: [], authors: [] });
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/server/__tests__/preference-suggest.test.ts`
Expected: FAIL — cannot resolve `../preferenceSuggest`.

- [ ] **Step 3: Write the implementation**

Create `lib/server/preferenceSuggest.ts`:

```ts
/**
 * Deterministic "suggest from your library" for the favorites editor. No Claude
 * call, no catalog call, no cost.
 *
 * Counts over LOVED books only — the same effectiveRating >= LOVED_MIN rule
 * recSignal.ts uses — deliberately: suggestions must reflect what actually drives
 * the recommender, not what merely fills the shelf.
 *
 * This deliberately does NOT extract buildSignal's counting loop. buildSignal is a
 * five-query function carrying byte-parity commitments, and its loop is interleaved
 * with library-key, series and loved-book accumulation; a separate simpler query is
 * the cheaper and safer choice.
 */
import { asc, eq } from 'drizzle-orm';
import { schema, type Db } from './db';
import { LOVED_MIN, mostCommon } from './recSignal';
import { effectiveRating } from './serialize';

/** Proposals per family, before the reader's own lists are subtracted. */
const SUGGESTION_LIMIT = 12;

export interface Suggestion {
  value: string;
  count: number;
}

export interface PreferenceSuggestions {
  subjects: Suggestion[];
  authors: Suggestion[];
}

/** Lowercased fold of every value already spoken for in the given constraint keys. */
function claimed(constraints: Record<string, unknown>, keys: string[]): Set<string> {
  const out = new Set<string>();
  for (const key of keys) {
    for (const v of (Array.isArray(constraints[key]) ? constraints[key] : []) as unknown[]) {
      const s = String(v).trim().toLowerCase();
      if (s) out.add(s);
    }
  }
  return out;
}

/**
 * Filter BEFORE truncating, so a reader who accepts a suggestion sees it replaced by
 * the next candidate rather than sees a shorter list. mostCommon keeps the
 * recommender's own tie ordering, so a suggestion list never disagrees with
 * top_subjects / top_authors.
 */
function pick(counts: Map<string, number>, blocked: Set<string>): Suggestion[] {
  const open = new Map<string, number>();
  for (const [value, count] of counts) {
    if (blocked.has(value.trim().toLowerCase())) continue;
    open.set(value, count);
  }
  return mostCommon(open, SUGGESTION_LIMIT).map((value) => ({
    value,
    count: open.get(value) as number,
  }));
}

export async function suggestPreferences(
  db: Db,
  userId: string,
  constraints: Record<string, unknown>
): Promise<PreferenceSuggestions> {
  const rows = await db
    .select({ b: schema.books, enr: schema.enrichment })
    .from(schema.books)
    // Safe against fan-out: enrichment.book_id carries a UNIQUE index, so this is 1:1.
    .leftJoin(schema.enrichment, eq(schema.enrichment.bookId, schema.books.id))
    .where(eq(schema.books.userId, userId))
    // Explicit order so mostCommon's insertion-order tiebreak is deterministic.
    .orderBy(asc(schema.books.id));

  const subjectCounts = new Map<string, number>();
  const authorCounts = new Map<string, number>();
  for (const { b, enr } of rows) {
    const rating = effectiveRating(b.appRating, b.goodreadsRating);
    if (rating === null || rating < LOVED_MIN) continue;
    for (const s of ((enr?.subjects as string[] | null) ?? []) as string[]) {
      subjectCounts.set(s, (subjectCounts.get(s) ?? 0) + 1);
    }
    // The verbatim string, matching top_authors: this value is handed to
    // googleBooksAuthor as a query.
    if (b.author) authorCounts.set(b.author, (authorCounts.get(b.author) ?? 0) + 1);
  }

  return {
    subjects: pick(subjectCounts, claimed(constraints, ['prefer_subjects', 'exclude_subjects'])),
    authors: pick(authorCounts, claimed(constraints, ['prefer_authors', 'exclude_authors'])),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run lib/server/__tests__/preference-suggest.test.ts`
Expected: PASS — every case in the file. (Counts drift as cases are added; do not treat a number here as the gate.)

- [ ] **Step 5: Commit**

```bash
git add lib/server/preferenceSuggest.ts lib/server/__tests__/preference-suggest.test.ts
git commit -m "feat(directive): derive favorite suggestions from the reader's loved books (#82)"
```

---

## Task 8: `GET /api/directive/suggestions`

**Files:**
- Create: `app/api/directive/suggestions/route.ts`
- Test: `app/api/directive/suggestions/route.test.ts` (create)

**Interfaces:**
- Consumes: `suggestPreferences` (Task 7); `withApi` from `lib/server/http`.
- Produces: `GET /api/directive/suggestions` → `{ subjects: Suggestion[], authors: Suggestion[] }`.

**No rate limit entry.** `RATE_LIMITS.directiveDraft` exists because `POST /directive/draft` spends Claude tokens. This route is a single indexed read and costs nothing, so it deliberately gets no `RATE_LIMITS` key.

- [ ] **Step 1: Write the failing test**

Create `app/api/directive/suggestions/route.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeTestDb } from '@/lib/server/__tests__/helpers/pglite';
import { setupTestEnv } from '@/lib/server/__tests__/helpers/testEnv';
import { _setDbForTests, schema, type Db } from '@/lib/server/db';
import { GET } from './route';

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

const req = () => new Request('http://test/api/directive/suggestions');

async function addLoved(db: Db, userId: string, author: string, subject: string): Promise<void> {
  const [row] = await db
    .insert(schema.books)
    .values({
      userId,
      title: `${author} / ${subject}`,
      author,
      goodreadsRating: 5,
      source: 'test',
    })
    .returning({ id: schema.books.id });
  await db
    .insert(schema.enrichment)
    .values({ bookId: row.id, subjects: [subject], resolutionConfidence: 1 });
}

describe('GET /api/directive/suggestions', () => {
  it('returns empty arrays for a reader with no loved books', async () => {
    await withDb(async () => {
      const res = await GET(req());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ subjects: [], authors: [] });
    });
  });

  it('is tenant-scoped and subtracts the caller’s stored lists', async () => {
    await withDb(async (db) => {
      await addLoved(db, 'local', 'Mine', 'mine');
      await addLoved(db, 'local', 'Already Favorited', 'already');
      await addLoved(db, 'other', 'Theirs', 'theirs');
      await db.insert(schema.userDirective).values({
        userId: 'local',
        constraints: { prefer_authors: ['already favorited'], exclude_subjects: ['already'] },
      });

      const body = await (await GET(req())).json();
      expect(body.authors).toEqual([{ value: 'Mine', count: 1 }]);
      expect(body.subjects).toEqual([{ value: 'mine', count: 1 }]);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/api/directive/suggestions/route.test.ts`
Expected: FAIL — cannot resolve `./route`.

- [ ] **Step 3: Write the route**

Create `app/api/directive/suggestions/route.ts`:

```ts
import { eq } from 'drizzle-orm';
import { withApi } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { suggestPreferences } from '@/lib/server/preferenceSuggest';

/**
 * Deterministic favorites suggestions drawn from the caller's own loved books. No
 * Claude call and no catalog call, so unlike POST /directive/draft this route
 * deliberately has no RATE_LIMITS entry.
 *
 * Reads the caller's stored constraints so a value they already listed (as a
 * favorite OR as an exclusion) is never proposed back to them.
 */
export const GET = withApi('/api/directive/suggestions', async (_req, ctx) => {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.userDirective)
    .where(eq(schema.userDirective.userId, ctx.user.userId));
  const constraints = (rows[0]?.constraints ?? {}) as Record<string, unknown>;
  const suggestions = await suggestPreferences(db, ctx.user.userId, constraints);
  ctx.timer.mark('db');
  return Response.json(suggestions);
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run app/api/directive/suggestions/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/api/directive/suggestions/route.ts app/api/directive/suggestions/route.test.ts
git commit -m "feat(api): add GET /directive/suggestions (#82)"
```

---

## Task 9: `components/FavoritesFields.tsx`

**Files:**
- Modify: `lib/api.ts` (types + client helper + the mirrored cap)
- Create: `components/FavoritesFields.tsx`
- Test: `components/__tests__/FavoritesFields.test.tsx` (create)

**Interfaces:**
- Consumes: `MAX_PREFER_ENTRIES`, `PreferenceSuggestions` from `lib/api.ts`; `Badge`, `Button`, `Input` from `@/components/ui`.
- Produces:
  ```ts
  export default function FavoritesFields(props: {
    authors: string[];
    subjects: string[];
    excludeAuthors: string[];
    excludeSubjects: string[];
    suggestions: PreferenceSuggestions | undefined;
    onChange: (next: { authors: string[]; subjects: string[] }) => void;
  }): React.JSX.Element
  ```

**Two deliberate deviations from the spec, both stated:**

1. **The props include `excludeAuthors` / `excludeSubjects`,** which spec §6.1's signature omits. Spec §6.2 requires an inline conflict message naming the collision, and the component cannot produce that message without the exclude lists. It stays a controlled component holding no server state.
2. **`PreferenceSuggestions` is imported from `lib/api.ts`, never from `lib/server/preferenceSuggest.ts`.** That module imports `db.ts`, which would pull drizzle and `schema.ts` into the browser bundle. The two declarations are duplicated on purpose, exactly as `Directive` / `DirectiveConstraints` already are.

- [ ] **Step 1: Extend `lib/api.ts`**

Replace the `DirectiveConstraints` interface (`lib/api.ts:741`):

```ts
export interface DirectiveConstraints {
  languages?: string[];
  min_year?: number;
  max_year?: number;
  exclude_subjects?: string[];
  exclude_authors?: string[];
  prefer_subjects?: string[];
  prefer_authors?: string[];
}

/** Mirror of lib/server/directive.ts's cap. DUPLICATED ON PURPOSE: a client
 *  component that imports lib/server/** drags drizzle into the browser bundle. */
export const MAX_PREFER_ENTRIES = 10;

export interface PreferenceSuggestion {
  value: string;
  count: number;
}

/** Client-side twin of lib/server/preferenceSuggest.ts's PreferenceSuggestions. */
export interface PreferenceSuggestions {
  subjects: PreferenceSuggestion[];
  authors: PreferenceSuggestion[];
}
```

Next to `DIRECTIVE_KEY` (`lib/api.ts:763`):

```ts
/** Shared SWR key for the deterministic "from your library" favorites suggestions. */
export const DIRECTIVE_SUGGESTIONS_KEY = 'directive-suggestions';
```

Next to `getDirective` (`lib/api.ts:813`):

```ts
/** GET /directive/suggestions - favorite candidates drawn from the reader's loved books. */
export const getPreferenceSuggestions = (): Promise<PreferenceSuggestions> =>
  get<PreferenceSuggestions>('/directive/suggestions');
```

- [ ] **Step 2: Write the failing test**

Create `components/__tests__/FavoritesFields.test.tsx`:

```tsx
/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent } from '@testing-library/react';
import FavoritesFields from '@/components/FavoritesFields';
import { MAX_PREFER_ENTRIES } from '@/lib/api';

const suggestions = {
  authors: [{ value: 'Gene Wolfe', count: 4 }],
  subjects: [{ value: 'space opera', count: 7 }],
};

type Props = React.ComponentProps<typeof FavoritesFields>;

const fields = (onChange: Props['onChange'], over: Partial<Props> = {}) => (
  <FavoritesFields
    authors={[]}
    subjects={[]}
    excludeAuthors={[]}
    excludeSubjects={[]}
    suggestions={suggestions}
    onChange={onChange}
    {...over}
  />
);

function setup(over: Partial<Props> = {}) {
  const onChange = jest.fn();
  // rerender, not a second render(): a second render() leaves the first tree mounted
  // and every getByRole then matches two nodes.
  const { rerender } = render(fields(onChange, over));
  return { onChange, rerender: (next: Partial<Props>) => rerender(fields(onChange, next)) };
}

const authorInput = () => screen.getByLabelText('Favorite authors');
const subjectInput = () => screen.getByLabelText('Favorite genres & subjects');

it('adds an author via the Add button and fires onChange with the full next value', () => {
  const { onChange } = setup({ subjects: ['space opera'] });
  fireEvent.change(authorInput(), { target: { value: '  Ursula K.  Le Guin  ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add favorite author' }));
  // Whitespace collapsed, case preserved, and BOTH lists come back — not a delta.
  expect(onChange).toHaveBeenCalledWith({
    authors: ['Ursula K. Le Guin'],
    subjects: ['space opera'],
  });
});

it('adds a subject on Enter, lowercased to match what the server will store', () => {
  const { onChange } = setup();
  fireEvent.change(subjectInput(), { target: { value: 'Translated Fiction' } });
  fireEvent.keyDown(subjectInput(), { key: 'Enter' });
  // cleanDirectiveConstraints lowercases prefer_subjects, so the chip must not flip
  // case on the reader's next page load.
  expect(onChange).toHaveBeenCalledWith({ authors: [], subjects: ['translated fiction'] });
});

it('does NOT lowercase an author', () => {
  const { onChange } = setup();
  fireEvent.change(authorInput(), { target: { value: 'Ursula K. Le Guin' } });
  fireEvent.keyDown(authorInput(), { key: 'Enter' });
  expect(onChange).toHaveBeenCalledWith({ authors: ['Ursula K. Le Guin'], subjects: [] });
});

it('removes an entry', () => {
  const { onChange } = setup({ authors: ['Gene Wolfe', 'Ursula K. Le Guin'] });
  fireEvent.click(screen.getByRole('button', { name: 'Remove Gene Wolfe' }));
  expect(onChange).toHaveBeenCalledWith({ authors: ['Ursula K. Le Guin'], subjects: [] });
});

it('clicking a suggestion adds it, and it leaves the suggestion row', () => {
  const { onChange, rerender } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Add Gene Wolfe' }));
  expect(onChange).toHaveBeenCalledWith({ authors: ['Gene Wolfe'], subjects: [] });

  // The row is derived from the current lists, so an already-chosen value is gone
  // once the parent feeds the new value back down.
  rerender({ authors: ['Gene Wolfe'] });
  expect(screen.queryByRole('button', { name: 'Add Gene Wolfe' })).toBeNull();
});

it('blocks adding past MAX_PREFER_ENTRIES with an inline message', () => {
  const full = Array.from({ length: MAX_PREFER_ENTRIES }, (_, i) => `Author ${i}`);
  const { onChange } = setup({ authors: full });
  fireEvent.change(authorInput(), { target: { value: 'One Too Many' } });
  fireEvent.keyDown(authorInput(), { key: 'Enter' });
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.getByText(`You can save up to ${MAX_PREFER_ENTRIES}. Remove one first.`))
    .toBeTruthy();
});

it('refuses an entry that is already on the matching avoid list', () => {
  const { onChange } = setup({ excludeAuthors: ['brandon sanderson'] });
  fireEvent.change(authorInput(), { target: { value: 'Brandon Sanderson' } });
  fireEvent.keyDown(authorInput(), { key: 'Enter' });
  expect(onChange).not.toHaveBeenCalled();
  expect(
    screen.getByText('"Brandon Sanderson" is already on your avoid list. Remove it there first.')
  ).toBeTruthy();
});

it('renders nothing extra when suggestions have not loaded', () => {
  setup({ suggestions: undefined });
  expect(screen.queryByText('From your library')).toBeNull();
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx jest components/__tests__/FavoritesFields.test.tsx`
Expected: FAIL — cannot resolve `@/components/FavoritesFields`.

- [ ] **Step 4: Write the component**

Create `components/FavoritesFields.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { Badge, Button, Input } from '@/components/ui';
import { MAX_PREFER_ENTRIES, type PreferenceSuggestion, type PreferenceSuggestions } from '@/lib/api';

const fold = (s: string) => s.trim().toLowerCase();
const has = (list: string[], value: string) => list.some((x) => fold(x) === fold(value));

interface GroupProps {
  label: string;
  addLabel: string;
  placeholder: string;
  values: string[];
  excluded: string[];
  suggestions: PreferenceSuggestion[];
  /** True for subjects, false for authors — mirrors cleanDirectiveConstraints, which
   *  lowercases prefer_subjects and preserves prefer_authors' case. Without this the
   *  chip a reader adds silently changes case on their next page load. */
  lowercase: boolean;
  onChange: (next: string[]) => void;
}

function Group({
  label,
  addLabel,
  placeholder,
  values,
  excluded,
  suggestions,
  lowercase,
  onChange,
}: GroupProps) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputId = `favorites-${addLabel.replace(/\s+/g, '-')}`;

  function add(raw: string): void {
    // Apply the SAME normalization cleanDirectiveConstraints will: collapse internal
    // whitespace, and lowercase for subjects. Otherwise the chip a reader just added
    // reads "Space Opera" until they reload and it silently becomes "space opera" —
    // a case flip with no explanation, which reads as a bug. A "From your library"
    // suggestion keeps the catalog's own casing on its label (enrichment.subjects is
    // stored as the catalog returned it); adding it stores the lowercase form, and
    // the row's own filter folds case, so it still disappears from the row.
    const collapsed = raw.trim().replace(/\s+/g, ' ');
    const value = lowercase ? collapsed.toLowerCase() : collapsed;
    if (!value) return;
    if (has(values, value)) {
      setDraft('');
      setError(null);
      return;
    }
    if (values.length >= MAX_PREFER_ENTRIES) {
      setError(`You can save up to ${MAX_PREFER_ENTRIES}. Remove one first.`);
      return;
    }
    // §3.3 says the server drops a preference that collides with an exclusion. Say so
    // here instead, so the reader learns why rather than watching it vanish on save.
    if (has(excluded, value)) {
      setError(`"${value}" is already on your avoid list. Remove it there first.`);
      return;
    }
    setError(null);
    setDraft('');
    onChange([...values, value]);
  }

  // Derived from the current list, so accepting a suggestion removes it from the row.
  const open = suggestions.filter((s) => !has(values, s.value));

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-text" htmlFor={inputId}>
        {label}
      </label>
      {values.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {values.map((v) => (
            <Badge key={v} variant="accent">
              {v}
              <button
                type="button"
                aria-label={`Remove ${v}`}
                className="ml-1.5 text-muted hover:text-text"
                onClick={() => onChange(values.filter((x) => x !== v))}
              >
                &times;
              </button>
            </Badge>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <Input
          id={inputId}
          aria-label={label}
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add(draft);
            }
          }}
        />
        <Button type="button" variant="secondary" size="sm" aria-label={addLabel} onClick={() => add(draft)}>
          Add
        </Button>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      {open.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs text-muted">From your library</p>
          <div className="flex flex-wrap gap-2">
            {open.map((s) => (
              <button
                key={s.value}
                type="button"
                aria-label={`Add ${s.value}`}
                onClick={() => add(s.value)}
                className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <Badge>
                  {s.value} &middot; {s.count}
                </Badge>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The favorites editor. Controlled: it holds no server state and performs no
 * fetching, because CustomInstructions must stay the single owner of the directive
 * record (PUT /directive replaces nl_text and constraints wholesale, so two
 * independent writers would clobber each other).
 *
 * PreferenceSuggestions here is the lib/api.ts declaration, NOT the
 * lib/server/preferenceSuggest.ts one: that module imports db.ts, which would pull
 * drizzle and schema.ts into the browser bundle.
 */
export default function FavoritesFields({
  authors,
  subjects,
  excludeAuthors,
  excludeSubjects,
  suggestions,
  onChange,
}: {
  authors: string[];
  subjects: string[];
  excludeAuthors: string[];
  excludeSubjects: string[];
  suggestions: PreferenceSuggestions | undefined;
  onChange: (next: { authors: string[]; subjects: string[] }) => void;
}) {
  return (
    <div className="space-y-4">
      <Group
        label="Favorite authors"
        addLabel="Add favorite author"
        placeholder="Ursula K. Le Guin"
        values={authors}
        excluded={excludeAuthors}
        suggestions={suggestions?.authors ?? []}
        lowercase={false}
        onChange={(next) => onChange({ authors: next, subjects })}
      />
      <Group
        label="Favorite genres & subjects"
        addLabel="Add favorite subject"
        placeholder="space opera"
        values={subjects}
        excluded={excludeSubjects}
        suggestions={suggestions?.subjects ?? []}
        lowercase
        onChange={(next) => onChange({ authors, subjects: next })}
      />
    </div>
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx jest components/__tests__/FavoritesFields.test.tsx`
Expected: PASS — every case in the file. (Counts drift as cases are added; do not treat a number here as the gate.)

- [ ] **Step 6: Commit**

```bash
git add lib/api.ts components/FavoritesFields.tsx components/__tests__/FavoritesFields.test.tsx
git commit -m "feat(profile): add the favorites editing surface (#82)"
```

---

## Task 10: Mount favorites in `CustomInstructions` and fix the Clear guard

**Files:**
- Modify: `components/CustomInstructions.tsx`
- Test: `components/__tests__/CustomInstructions.test.tsx` (create)

**Interfaces:**
- Consumes: `FavoritesFields` (Task 9); `getPreferenceSuggestions`, `DIRECTIVE_SUGGESTIONS_KEY`, `PreferenceSuggestions` from `lib/api.ts`.
- Produces: no new exports.

**Why here and not a sibling component:** `PUT /directive` replaces `nl_text` and `constraints` wholesale (`app/api/directive/route.ts:29-73`). Two components writing that record independently is a clobbering bug — saving favorites would erase unsaved prose, and vice versa. `CustomInstructions` stays the single owner: one state owner, one Save button, one write path.

**Two defects this task must also fix, both surfaced by review and neither in the spec:**

1. **Removing your last favorite and pressing Save 422s.** `PUT /directive` rejects a record whose text and cleaned constraints are both empty (`app/api/directive/route.ts:33`). `setFavorites` writes `prefer_authors: []` / `prefer_subjects: []`, `cleanDirectiveConstraints` omits empty lists, and `save()` calls `putDirective` unconditionally (`CustomInstructions.tsx:39-52`) with no `catch` — so the reader gets a silent no-op. The state is reachable today by clearing the textarea, but favorites make it a normal thing to do. Fix: `save()` routes to `deleteDirective()` when the record would be empty.
2. **Accepted suggestions are never replenished.** `save()` and `clearAll()` mutate only `DIRECTIVE_KEY` (`CustomInstructions.tsx:46,58`). The suggestion row does shrink immediately — it is derived client-side from the current lists — but §5.1's promise that an accepted suggestion is *replaced by the next candidate* needs a refetch, and after Clear the previously-excluded values never come back. Fix: mutate `DIRECTIVE_SUGGESTIONS_KEY` in both paths.

**Deliberate deviation from spec §6.3's first bullet:** `constraintChips` does **not** gain the two new families. `FavoritesFields` is fed straight from `effectiveConstraints`, so favorites written by the Claude distill flow already appear there as removable chips — which is what that bullet was for. Adding them to `constraintChips` too would render every favorite twice on the same card. Chips remain the display for excludes, as §6.3 also says. Spec §6.3's **second** bullet (the Clear guard) is implemented in full.

- [ ] **Step 1: Write the failing test**

Create `components/__tests__/CustomInstructions.test.tsx`:

```tsx
/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CustomInstructions from '@/components/CustomInstructions';
import { DIRECTIVE_KEY, DIRECTIVE_SUGGESTIONS_KEY } from '@/lib/api';

const mockPut = jest.fn();
const mockDelete = jest.fn();
const mockMutate = jest.fn();
let mockDirective: Record<string, unknown> = { nl_text: null, constraints: {}, updated_at: null };
const mockSuggestions = {
  authors: [{ value: 'Gene Wolfe', count: 4 }],
  subjects: [{ value: 'space opera', count: 7 }],
};

jest.mock('swr', () => ({
  __esModule: true,
  default: (key: string) => ({
    data: key === 'directive-suggestions' ? mockSuggestions : mockDirective,
  }),
  useSWRConfig: () => ({ mutate: (...args: unknown[]) => mockMutate(...args) }),
}));

// requireActual keeps the real DIRECTIVE_KEY / DIRECTIVE_SUGGESTIONS_KEY /
// MAX_PREFER_ENTRIES constants, so the assertions below compare against the real
// values rather than restating them. The swr mock above cannot reference them (jest
// hoists jest.mock factories above the imports), hence the literal there.
jest.mock('@/lib/api', () => {
  const actual = jest.requireActual('@/lib/api');
  return {
    ...actual,
    getDirective: jest.fn(),
    getPreferenceSuggestions: jest.fn(),
    deleteDirective: (...args: unknown[]) => mockDelete(...args),
    putDirective: (...args: unknown[]) => mockPut(...args),
  };
});

// DirectiveChat opens a Claude-backed modal; not under test here.
jest.mock('@/components/DirectiveChat', () => ({
  __esModule: true,
  default: () => null,
}));

beforeEach(() => {
  mockPut.mockReset().mockResolvedValue({});
  mockDelete.mockReset().mockResolvedValue({});
  mockMutate.mockReset().mockResolvedValue(undefined);
  mockDirective = { nl_text: null, constraints: {}, updated_at: null };
});

it('sends prose and favorites in one PUT', async () => {
  mockDirective = { nl_text: 'No grimdark.', constraints: {}, updated_at: null };
  render(<CustomInstructions />);

  fireEvent.click(screen.getByRole('button', { name: 'Add Gene Wolfe' }));
  fireEvent.change(screen.getByLabelText('Favorite genres & subjects'), {
    target: { value: 'translated fiction' },
  });
  fireEvent.keyDown(screen.getByLabelText('Favorite genres & subjects'), { key: 'Enter' });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));
  expect(mockPut).toHaveBeenCalledWith({
    nl_text: 'No grimdark.',
    constraints: {
      prefer_authors: ['Gene Wolfe'],
      prefer_subjects: ['translated fiction'],
    },
  });
});

it('deletes the record instead of PUTting an empty one when the last favorite goes', async () => {
  // PUT /directive 422s on a record whose text and cleaned constraints are both
  // empty, and save() has no catch — so without this the reader silently loses the
  // action. Removing your last favorite is a normal thing to do.
  mockDirective = {
    nl_text: null,
    constraints: { prefer_authors: ['Gene Wolfe'] },
    updated_at: null,
  };
  render(<CustomInstructions />);
  fireEvent.click(screen.getByRole('button', { name: 'Remove Gene Wolfe' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(mockDelete).toHaveBeenCalledTimes(1));
  expect(mockPut).not.toHaveBeenCalled();
});

it('revalidates the suggestions key after saving, so the row is replenished', async () => {
  mockDirective = { nl_text: 'No grimdark.', constraints: {}, updated_at: null };
  render(<CustomInstructions />);
  fireEvent.click(screen.getByRole('button', { name: 'Add Gene Wolfe' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(mockMutate).toHaveBeenCalledWith(DIRECTIVE_SUGGESTIONS_KEY));
  expect(mockMutate).toHaveBeenCalledWith(DIRECTIVE_KEY);
});

it('shows the Clear button for a constraints-only record', () => {
  // Today the Clear button is gated on nl_text alone, so this reader cannot clear
  // their record at all — and favorites make the state reachable for the first time.
  mockDirective = {
    nl_text: null,
    constraints: { prefer_authors: ['Gene Wolfe'] },
    updated_at: null,
  };
  render(<CustomInstructions />);
  expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy();
});

it('hides the Clear button for a genuinely empty record', () => {
  render(<CustomInstructions />);
  expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest components/__tests__/CustomInstructions.test.tsx`
Expected: FAIL — no favorites controls are rendered, and Clear is absent for the constraints-only record.

- [ ] **Step 3: Wire the component**

In `components/CustomInstructions.tsx`, extend the imports:

```ts
import {
  getDirective,
  putDirective,
  deleteDirective,
  getPreferenceSuggestions,
  DIRECTIVE_KEY,
  DIRECTIVE_SUGGESTIONS_KEY,
  type Directive,
  type DirectiveConstraints,
  type PreferenceSuggestions,
} from '@/lib/api';
import FavoritesFields from '@/components/FavoritesFields';
```

Add the suggestions read next to the directive read:

```ts
  const { data } = useSWR<Directive>(DIRECTIVE_KEY, getDirective);
  const { data: suggestions } = useSWR<PreferenceSuggestions>(
    DIRECTIVE_SUGGESTIONS_KEY,
    getPreferenceSuggestions
  );
```

Below `const chips = constraintChips(effectiveConstraints);`:

```ts
  // Favorites edit the SAME constraints object the prose shares, so Save writes both
  // in one PUT. PUT /directive replaces the record wholesale; a second writer would
  // clobber whichever field it did not own.
  //
  // Empty lists are OMITTED rather than sent as [], matching how
  // cleanDirectiveConstraints stores them — so `isEmptyRecord` below can just count
  // keys instead of inspecting each one.
  function setFavorites(next: { authors: string[]; subjects: string[] }): void {
    const merged: DirectiveConstraints = { ...effectiveConstraints };
    if (next.authors.length) merged.prefer_authors = next.authors;
    else delete merged.prefer_authors;
    if (next.subjects.length) merged.prefer_subjects = next.subjects;
    else delete merged.prefer_subjects;
    setConstraints(merged);
  }
```

Replace `save()` so an emptied record deletes instead of PUTting, and so the suggestions key is revalidated:

```ts
  async function save() {
    setSaving(true);
    try {
      const text = effectiveText.trim();
      // PUT /directive 422s when text and cleaned constraints are both empty, and
      // there is no catch here — the reader would get a silent no-op. Removing your
      // last favorite is a normal action, so route it to the delete path instead.
      if (!text && Object.keys(effectiveConstraints).length === 0) {
        await deleteDirective();
      } else {
        await putDirective({ nl_text: text || null, constraints: effectiveConstraints });
      }
      // Suggestions are computed server-side minus the reader's current lists, so a
      // save changes them: an accepted suggestion must be replaced by the next
      // candidate rather than just leaving a shorter row.
      await Promise.all([mutate(DIRECTIVE_KEY), mutate(DIRECTIVE_SUGGESTIONS_KEY)]);
      setText(null);
      setConstraints(null);
    } finally {
      setSaving(false);
    }
  }
```

And in `clearAll()`, revalidate the suggestions key too — clearing the record un-excludes every value it held:

```ts
      await deleteDirective();
      await Promise.all([mutate(DIRECTIVE_KEY), mutate(DIRECTIVE_SUGGESTIONS_KEY)]);
```

Render `FavoritesFields` between the `Textarea` and the chips block:

```tsx
      <FavoritesFields
        authors={effectiveConstraints.prefer_authors ?? []}
        subjects={effectiveConstraints.prefer_subjects ?? []}
        excludeAuthors={effectiveConstraints.exclude_authors ?? []}
        excludeSubjects={effectiveConstraints.exclude_subjects ?? []}
        suggestions={suggestions}
        onChange={setFavorites}
      />
```

Replace the Clear guard (`CustomInstructions.tsx:96`):

```tsx
        {(data?.nl_text || Object.keys(data?.constraints ?? {}).length > 0) && (
          <Button variant="ghost" onClick={clearAll} disabled={saving}>
            Clear
          </Button>
        )}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest components/__tests__/CustomInstructions.test.tsx`
Expected: PASS — every case in the file. (Counts drift as cases are added; do not treat a number here as the gate.)

- [ ] **Step 5: Run the whole Jest suite**

Run: `npm test`
Expected: PASS. `app/__tests__/profileAdminLink.test.tsx:10` already mocks `@/components/CustomInstructions`, so the profile page test is unaffected.

- [ ] **Step 6: Commit**

```bash
git add components/CustomInstructions.tsx components/__tests__/CustomInstructions.test.tsx
git commit -m "feat(profile): edit favorites alongside custom instructions (#82)"
```

---

## Task 11: Full gate and browser verification

**Files:** none modified unless a gate fails.

**Interfaces:** none.

A passing suite is **not** sufficient. `docs/superpowers/plans/` and this project's memory both record that the `isolated-local-env` skill is **stale** — it documents the retired Python backend. Do not follow it. Run the real Next.js app against the configured dev database.

- [ ] **Step 1: Run every gate**

```bash
npm run test:server
npm test
npm run type-check
npm run lint
npm run format:check
npm run build
```

Expected: all six pass. `npm run build` is the only gate that catches Next segment-config and prerender failures, so it is not optional.

- [ ] **Step 2: Start the app**

Run: `npm run dev`
Expected: the dev server boots and reports its URL.

- [ ] **Step 3: Verify the editor in the browser**

Open `/profile` and, in the Custom instructions card:

1. Add a favorite author by typing and pressing Enter; add a favorite subject with the Add button.
2. Confirm the "From your library" rows render with counts, and that clicking one adds it and removes it from the row.
3. Press **Save**, reload the page, and confirm both lists come back **with the same casing they had before the reload** — this is the round trip through `cleanDirectiveConstraints` and `PUT /directive`, and a subject that flips case here means the component's `lowercase` mode is not wired.
4. Confirm the **Clear** button is present for this record even with the prose textarea empty.
5. With the prose empty, remove every favorite and press **Save**. The record must clear without an error and without a stuck Save button — this is the `deleteDirective()` path; a 422 here means `save()` is still PUTting an empty record. Keep the network tab open: the request should be `DELETE /api/directive`, not `PUT`.
6. Re-add a favorite from the suggestion row and confirm the row **refills from the tail** rather than just getting shorter — that is `DIRECTIVE_SUGGESTIONS_KEY` being revalidated. (Needs more than 12 distinct loved-book authors or subjects to be observable; if the library is too small to have a 13th candidate, say so rather than reporting it verified.)

- [ ] **Step 4: Verify the recommender actually uses them**

Run a recommendation for that reader (`/recommendations`, or `POST /api/recommend`) and confirm at least one served candidate carries a `seed_reason` beginning `preferred_author:` or `preferred_subject:`. If the run returns nothing, check that the reader has a built profile and no unprofiled rating changes — `runRecommend` blocks on both before retrieval.

- [ ] **Step 5: Report**

Say plainly which gates ran and passed, what was clicked in the browser, and what the served `seed_reason` values were. If any step was skipped or failed, say which and why — do not report completion on a partial pass.

---

## Out of scope (from spec §8, restated so no task drifts into it)

- `/similar` and `/discover` stay unaffected — both keep the empty defaults.
- `exclude_subjects` / `exclude_authors` stay model-authored and read-only.
- No new table, no migration.
- No genre taxonomy and no fiction/nonfiction classifier; "genre" continues to mean an Open Library / Google Books subject string.
- No change to `surname()` keying, `MAX_PER_AUTHOR`, or `MAX_LIBRARY_AUTHOR_SHARE`.
