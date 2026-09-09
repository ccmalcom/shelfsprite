# Favorite authors and subjects — design

**Date:** 2026-09-09
**Status:** approved in chat, ready for implementation planning
**Issue:** [#82](https://github.com/ccmalcom/shelfsprite/issues/82) — "Add 'fav artists' and 'fav genres' section as a manual setting in profile"
**Branch:** none yet; `main` is clean at `75e64e5`

ShelfSprite's standing directive already carries the negative half of this request:
`exclude_subjects` and `exclude_authors` live in `user_directive.constraints` and are enforced as a
hard filter. There is no positive counterpart. A reader can say "never show me Brandon Sanderson"
but cannot say "show me more Ursula K. Le Guin," and the recommender's notion of a favorite author
is inferred entirely from shelf counts.

This spec adds `prefer_authors` and `prefer_subjects` to the same constraints blob, a manual editing
surface for them on the profile page, a deterministic "suggest from your library" flow that proposes
values drawn from the reader's own loved books, and recommender support at the two stages where a
preference can actually change the outcome — catalog retrieval and rerank.

Two findings from the design pass reshaped the feature relative to the issue's triage comment, and
both are load-bearing:

1. **There is no manual constraint editor today.** `components/CustomInstructions.tsx:30` holds
   `constraints` as opaque React state, written only by the Claude distill flow and rendered
   read-only as chips. "A manual setting" therefore means building an editing surface that does not
   exist, for a field family that is currently model-authored.
2. **A preference cannot be a filter.** `applyDirectiveConstraints` only ever *removes* candidates,
   and retrieval builds its catalog queries from `top_subjects` / `top_authors`, which are derived
   purely from loved-book counts. Favoriting an author who is not already in the top six by count
   puts *zero* candidates by them into the pool, and no downstream logic can add them back. The
   feature lives in retrieval and rerank, not in the constraints filter — which reframes the
   `applyAuthorCaps` conflict the triage identified.

---

## 1. Preconditions (verified 2026-09-09 against source, not assumed)

| Precondition | Status | How it was verified |
|---|---|---|
| Constraints are a free-form JSON column, no migration needed | ✅ | `lib/server/schema.ts:455` — `constraints: json()` on `user_directive` |
| The stored blob reaches the recommender unfiltered | ✅ | `lib/server/recSignal.ts:258` assigns `storedConstraints ?? {}` with no re-clean, surfaced as `signal.directive_constraints` (`recSignal.ts:72`) and read at `recommendRun.ts:101` |
| Only `cleanDirectiveConstraints` gates what can be stored | ✅ | `app/api/directive/route.ts:32` is the sole writer; unknown keys are dropped by `lib/server/directive.ts` |
| Retrieval queries come from loved-book counts only | ✅ | `recSignal.ts:136` — `if (rating === null || rating < LOVED_MIN) continue;` guards both `subjectCounts` and `authorCounts` |
| `top_authors` are full name strings, `library_authors` are surnames | ✅ | `recSignal.ts` counts `b.author` verbatim into `authorCounts`, but adds `surname(b.author)` to `library_authors` |
| `applyAuthorCaps` keys its library check on `surname()` | ✅ | `lib/server/recFilters.ts:135-136` |
| Cold start skips author expansion entirely | ✅ | `lib/server/recAssemble.ts:87` — `if (!coldStart) { ... }` wraps the whole author loop |
| `/similar` and `/discover` are already outside directive scope | ✅ | `recSimilarRun.ts:7-8` and `recDiscoverRun.ts:8` both document it; neither calls `applyDirectiveConstraints` |
| `seed_reason` is persisted and typed but never parsed by any component | ✅ | `lib/api.ts:93,115,141` and `schema.ts:167` are the only non-test references; no `.tsx` reads it |
| `PUT /directive` replaces the record wholesale | ⚠️ confirmed hazard | `app/api/directive/route.ts:29-73` sets both `nlText` and `constraints` from the request body; see §5 |
| `PUT /directive` accepts constraints with no prose | ✅ | `app/api/directive/route.ts:34` rejects only when text **and** cleaned constraints are both empty |
| `clearAll` is unreachable for a constraints-only record | ⚠️ confirmed gap | `components/CustomInstructions.tsx:96` gates the Clear button on `data?.nl_text` alone |
| No byte-exact prompt fixture pins `userSteeringBlock` | ✅ | no test in `lib/server/__tests__/` imports `recPrompts`; the only fixture helpers are `fakeClaude.ts` / `testEnv.ts` |

---

## 2. The principle

Every interaction between a favorite and an existing heuristic is decided by one rule:

> **An explicit preference overrides heuristics that compensate for weak inference. It does not
> override heuristics that protect output quality.**

Applied to the three places a preferred author meets existing logic:

| Heuristic | Why it exists | Preferred author |
|---|---|---|
| `MAX_PER_AUTHOR = 2` (`recFilters.ts:117-131`) | stops a deck of same-author clones | **still applies** — a quality guard, and a favorite does not make ten books by one person a good deck |
| 40% library-author trim (`recFilters.ts:135-140`) | assumes "already on your shelf" means "not discovery" | **exempt** — the favorite is precisely the statement that this assumption is wrong |
| cold-start author skip (`recAssemble.ts:87`) | a thin library makes inferred authors unreliable | **exempt** — an explicit favorite is not an inference, so the reason to skip does not apply |

The same rule settles the filter question: `applyDirectiveConstraints` exists to enforce hard limits,
and a preference is not a limit. It is left unchanged (§4.4).

---

## 3. Storage

### 3.1 Shape

Two new optional keys in `user_directive.constraints`:

```jsonc
{
  "prefer_authors":  ["Ursula K. Le Guin", "Gene Wolfe"],  // case preserved
  "prefer_subjects": ["space opera", "translated fiction"] // lowercased
}
```

### 3.2 Normalization rules

`cleanDirectiveConstraints` (`lib/server/directive.ts`) gains both keys.

**`prefer_subjects`** follows the existing `exclude_subjects` convention exactly: trim, lowercase,
drop empties.

**`prefer_authors` deliberately diverges** from `exclude_authors`, which lowercases. Lowercasing is
harmless for an invisible filter but wrong for a field the reader types and then reads back on their
own profile page. `prefer_authors` is trimmed, has internal whitespace collapsed to single spaces,
and **preserves case**; comparisons lowercase at the point of use. This divergence is intentional and
must be commented in the source, because the adjacent key does the opposite.

Both lists:

- deduplicate **case-insensitively**, keeping the first occurrence's casing;
- are capped at **10 entries** each (`MAX_PREFER_ENTRIES`), bounding both the JSON blob and the
  retrieval budget in §4.1;
- are omitted from the output object entirely when empty, matching how every existing key behaves.

### 3.3 Conflict with excludes

An entry present in both `prefer_authors` and `exclude_authors` (compared lowercased) is **dropped
from `prefer_authors`**. A hard filter outranks a soft boost; keeping both would mean a candidate is
boosted into the pool and then deleted from it. The same rule applies to
`prefer_subjects` / `exclude_subjects`. Excludes are cleaned first so the comparison runs against the
normalized set. The UI in §5 prevents reaching this state, so this is a backstop for API callers and
for the distill flow.

### 3.4 Not doing

No new table. The blob already flows end-to-end (§1), a separate table would add a migration, a
route family, and a second home for user preferences, and nothing here needs to be indexed or
queried independently.

---

## 4. Recommender integration

### 4.1 Retrieval — `metadataPool`

`metadataPool` (`recAssemble.ts:72`) takes a new explicit preferences argument rather than
pre-merged lists, because cold start must treat preferred and inferred **authors** differently and a
merged list cannot express that.

```ts
export interface PoolPreferences {
  prefer_subjects: string[];
  prefer_authors: string[];
}

export async function metadataPool(
  db: Db,
  signal: Pick<RecSignal, 'top_subjects' | 'top_authors'>,
  perQuery: number,
  coldStart: boolean,
  preferences: PoolPreferences = { prefer_subjects: [], prefer_authors: [] }
): Promise<PoolEntry[]>
```

The default keeps `recSimilarRun.ts:69` compiling and behaving identically without edits.

**Subjects.** Preferred subjects are queried first, then inferred `top_subjects` fill the remainder.
The combined list is deduplicated case-insensitively and truncated to the existing
`TOP_SUBJECTS = 8`.

**Authors.** Preferred authors are queried first and **always**, including cold start. Inferred
`top_authors` are appended only when `!coldStart`, preserving today's behavior for the inferred half.
Combined, deduplicated, truncated to `TOP_AUTHORS = 6`.

**Retrieval budget — merge-and-truncate, zero added catalog calls.** `/recommend` already issues
roughly 22 sequential throttled catalog calls before seed queries, under a 300s function ceiling.
Preferred entries take slots from inferred ones rather than adding their own, so run duration is
unchanged. To stop a full favorites list from silencing the taste profile entirely, preferred entries
are themselves truncated to `TOP_SUBJECTS - 2` (6) and `TOP_AUTHORS - 2` (4) before merging, so at
least two inferred slots always survive in each list.

The rejected alternative — an additive budget with its own cap — costs up to 12 more sequential
throttled calls per run to buy pool breadth the reranker largely cannot use, given `MAX_CANDIDATES`
is 60 and `capPool` trims to it anyway.

**This truncation is retrieval-only.** The `TOP_* - 2` cut governs which favorites generate catalog
queries; §4.5 renders the **full stored list** (up to all 10) into the prompts. A favorite past the
retrieval cut still boosts any candidate that reaches the reranker by another route — it just does
not spend a catalog call of its own.

**Provenance.** Preferred entries are tagged `preferred_subject:<s>` and `preferred_author:<a>`
instead of `subject:` / `author:`. This puts the provenance on each candidate's `seed_reason`, which
already travels into the rerank prompt, so the reranker learns which candidates came from an explicit
favorite at no additional prompt cost. Safe to change: no component parses `seed_reason` (§1).

### 4.2 Author caps — `applyAuthorCaps`

```ts
export function applyAuthorCaps<T extends { author?: string | null }>(
  candidates: T[],
  libraryAuthors: Set<string>,
  preferredAuthors: Set<string> = new Set()
): T[]
```

`preferredAuthors` holds `surname()`-normalized names, the same keying as `libraryAuthors`, so the
two compose without a second normalization pass.

Only the library/non-library partition changes:

```ts
const isPreferred = (c: T) => preferredAuthors.has(surname(c.author ?? null));
const lib = kept.filter((c) => libraryAuthors.has(surname(c.author ?? null)) && !isPreferred(c));
const non = kept.filter((c) => !libraryAuthors.has(surname(c.author ?? null)) || isPreferred(c));
```

A preferred author now sorts into `non`, so the 40% trim never drops them and the reorder never
pushes them down. The per-author loop above it is untouched, so `MAX_PER_AUTHOR = 2` still applies to
everyone — the quality guard survives, per §2.

`total` stays `kept.length`, so `maxLib` is computed against the same denominator as today and the
budget for genuinely-library authors does not silently grow.

**Surname collisions are accepted, not fixed.** `surname()` reduces "Ursula K. Le Guin" to `guin`, so
a favorite exempts anyone sharing that surname. This is the same fidelity `libraryAuthors` has always
had, the failure mode is a mildly worse candidate rather than a wrong one, and changing the keying
would alter existing recommendation behavior for reasons unrelated to this feature.

### 4.3 Threading — `assemble`

```ts
export function assemble(
  metadataEntries: PoolEntry[],
  seedEntries: PoolEntry[],
  signal: AssembleSignal,
  cap: number,
  preferredAuthorSurnames: Set<string> = new Set()
): AssembledCandidate[]
```

passed straight through to `applyAuthorCaps` at `recAssemble.ts:187`.

`AssembleSignal` is **not** extended. Adding a field would force `buildBookSignal` to supply it and
drag `/similar` into directive scope. An optional parameter keeps the blast radius at one caller.

**`recommendRun` is the only caller that supplies it.** `recSimilarRun.ts:73` and
`recDiscoverRun.ts:98` keep the empty default: both already document that the standing directive does
not steer them, and favorites inherit that boundary rather than quietly widening it.

### 4.4 Filtering — unchanged, but needs a test

`applyDirectiveConstraints` is **not modified**. A preference must never remove a candidate.

This needs an explicit regression test rather than trust. A constraints object containing only
`prefer_*` keys is non-empty, so it passes the `Object.keys(constraints).length === 0` early return
at `recFilters.ts:181` and walks every candidate. No branch reads the new keys, so every candidate
falls through to `return true` — correct, but *accidentally* correct. A future refactor that adds an
unrecognized-key guard would silently empty the pool. The test pins the behavior.

`applyDiscoveryConstraints` is likewise untouched; discovery never receives these keys.

### 4.5 Prompts

**`userSteeringBlock`** (`recPrompts.ts:203`) gains two blocks, emitted only when non-empty, placed
after `LESS LIKE` and before `CUSTOM INSTRUCTIONS` — favorites are more specific than prose guidance
but less specific than the reader's own sentences, so they sit between them:

```
FAVORITE AUTHORS (the reader explicitly marked these as favorites; treat a candidate
written by one of them as a strong positive signal):
["Ursula K. Le Guin", "Gene Wolfe"]

FAVORITE SUBJECTS (the reader explicitly marked these as favorites; treat a candidate
carrying one of them as a strong positive signal):
["space opera", "translated fiction"]
```

Rendered with `pyJsonDumps`, matching every adjacent block. No signature change: the function already
receives the full `RecSignal`, which carries `directive_constraints`.

The closing weighting instruction at the end of the block gains a clause naming favorites, so the
reranker is told how to weigh them and not merely that they exist.

**`buildSeedPrompt`** (`recPrompts.ts:167`) gains a bias clause alongside the existing
`more_like` / `less_like` ones, so Claude's proposed catalog queries chase favorites too:

```
 Favor queries that would surface books by these authors the reader has
 marked as favorites: [...].
 Favor queries covering these subjects the reader has marked as favorites: [...].
```

Emitted only when the respective list is non-empty, preserving today's output byte-for-byte for
readers with no favorites.

---

## 5. Suggest from library

### 5.1 Module

New `lib/server/preferenceSuggest.ts`, exporting:

```ts
export interface Suggestion { value: string; count: number; }
export interface PreferenceSuggestions { subjects: Suggestion[]; authors: Suggestion[]; }

export async function suggestPreferences(
  db: Db,
  userId: string,
  constraints: Record<string, unknown>
): Promise<PreferenceSuggestions>
```

It runs one `books` ⟕ `enrichment` query scoped to `userId` (the same left join `buildSignal` uses —
`enrichment.book_id` is unique, so no fan-out), and counts subjects and authors over **loved books
only**, applying `effectiveRating(appRating, goodreadsRating) >= LOVED_MIN`. That is the same rule as
`recSignal.ts:136`, deliberately: suggestions must reflect what actually drives the recommender, not
what merely fills the shelf.

Authors are counted on the verbatim `books.author` string (matching `top_authors`, since the value is
handed to `googleBooksAuthor` as a query). Subjects are counted on `enrichment.subjects` entries as
stored.

Ordering reuses the exported `mostCommon` from `recSignal.ts:81` so ties break identically to the
recommender's own top-N selection. Returns the top **12** of each.

Anything already present in `prefer_authors`, `prefer_subjects`, `exclude_authors`, or
`exclude_subjects` (compared lowercased) is filtered out *before* truncation, so a reader who accepts
a suggestion sees it replaced by the next candidate rather than sees a shorter list.

### 5.2 Route

`GET /api/directive/suggestions`, via `withApi`, tenant-scoped by `ctx.user.userId` like every other
directive route. It reads the caller's stored constraints to perform the §5.1 exclusion.

Deterministic: no Claude call, no catalog call, no cost. It therefore needs no entry in
`RATE_LIMITS` — unlike `POST /directive/draft`, which is rate-limited because it spends tokens.

Returns `{ subjects: [...], authors: [...] }`. A reader with no loved books gets two empty arrays,
not an error.

### 5.3 Why not reuse `buildSignal`

`buildSignal` already computes these counts, but it is a five-query function carrying byte-parity
commitments to a Python port, and its counting loop is interleaved with library-key, series, and
loved-book accumulation. Extracting it would put parity-sensitive code at risk to save roughly ten
lines. A separate, simpler query is the cheaper and safer choice.

### 5.4 What this solves

The triage comment flagged that the catalog stores Open Library / Google Books *subjects*, not a
curated genre vocabulary, so a free-text "genre" field may not match any filter term. Suggestions
dissolve that: every proposed subject is a string already present in the reader's own
`enrichment.subjects`, so it is guaranteed to match what retrieval queries against. Free-text entry
remains available for readers who want it, with the accompanying risk that a typed subject matches
nothing — acceptable, because the same is already true of `exclude_subjects`.

---

## 6. UI

### 6.1 One writer for the directive record

`PUT /directive` replaces `nl_text` and `constraints` wholesale (§1). Two components writing that
record independently is a clobbering bug: saving favorites would erase unsaved prose, and vice versa.

Therefore **`CustomInstructions.tsx` remains the single owner of directive state** and grows a
favorites section, rather than a sibling component being added to the profile page. One state owner,
one Save button, one write path. The alternatives — read-modify-write from the SWR cache, or adding
PATCH semantics to the route — both add a race or an endpoint to avoid a problem that co-location
removes outright.

To keep the file focused, the presentation is extracted into a new
`components/FavoritesFields.tsx`, a controlled component:

```ts
export default function FavoritesFields({
  authors,
  subjects,
  suggestions,
  onChange,
}: {
  authors: string[];
  subjects: string[];
  suggestions: PreferenceSuggestions | undefined;
  onChange: (next: { authors: string[]; subjects: string[] }) => void;
}): JSX.Element
```

It holds no server state and performs no fetching. `CustomInstructions` owns the SWR reads (including
the new suggestions key) and the save.

**`PreferenceSuggestions` here is the `lib/api.ts` declaration (§6.4), not the `preferenceSuggest.ts`
one.** A client component must never import a type from `lib/server/**`: `preferenceSuggest.ts`
imports `db.ts`, which would pull drizzle and `schema.ts` into the browser bundle. The two
declarations are deliberately duplicated, exactly as the existing `Directive` / `DirectiveConstraints`
types already are.

### 6.2 Interaction

Two labelled groups, "Favorite authors" and "Favorite genres & subjects". Each renders current
entries as removable chips, a text input with an Add affordance (Enter also adds), and — when the
suggestions endpoint returned any — a "From your library" row of clickable chips showing value and
count. Clicking a suggestion adds it to the corresponding list; it disappears from the suggestion row
because the row is derived from the current lists.

Adding is blocked at the client's `MAX_PREFER_ENTRIES` cap with an inline message, so the reader is
not silently truncated server-side by §3.2. An entry already present in the matching `exclude_*` list
is refused with an inline message naming the conflict, implementing §3.3 before the request rather
than after.

Nothing saves until the existing Save button is pressed, matching how the prose field already
behaves.

### 6.3 Incidental fixes required

- **`constraintChips`** (`CustomInstructions.tsx:16`) gains the two new families so a reader whose
  favorites came from the distill flow can see them. Chips remain the display for excludes.
- **The Clear button's guard** (`CustomInstructions.tsx:96`) changes from `data?.nl_text` to
  `data?.nl_text || Object.keys(data?.constraints ?? {}).length > 0`. Today a reader with constraints
  but no prose cannot clear their record at all, and favorites make that state reachable through the
  normal UI for the first time.

### 6.4 Types

`DirectiveConstraints` (`lib/api.ts:721`) gains `prefer_authors?: string[]` and
`prefer_subjects?: string[]`. A `PreferenceSuggestions` type and a `getPreferenceSuggestions()`
client function are added alongside the existing directive helpers, with a `DIRECTIVE_SUGGESTIONS_KEY`
SWR key next to `DIRECTIVE_KEY`.

### 6.5 Assumption

The editor covers `prefer_*` only. `exclude_subjects` and `exclude_authors` stay model-authored and
read-only, exactly as today. This is mildly asymmetric — manual favorites sitting beside read-only
exclusions — but making excludes editable was not part of the request, and it would double the UI
surface for a field family that is working as intended.

---

## 7. Testing

Ownership is fixed by `vitest.config.ts`: Vitest owns `lib/server/**` and `app/api/**`, Jest owns
everything else. Both runners plus `npm run build` are required.

**Vitest**

- `cleanDirectiveConstraints`: both keys accepted; case preserved for authors and lowercased for
  subjects; case-insensitive dedup keeping first casing; whitespace collapse; 10-entry cap; empty
  lists omitted from the output; prefer/exclude conflict drops the prefer entry on both families.
- `metadataPool`: preferred subjects queried first and merged under `TOP_SUBJECTS`; preferred authors
  queried **when `coldStart` is true** while inferred authors are still skipped; the
  `TOP_* - 2` reservation leaves inferred slots; `preferred_*` reason tags emitted; the default
  argument reproduces today's call sequence exactly.
- `applyAuthorCaps`: a preferred library author survives a trim that would otherwise drop them and is
  not reordered down; `MAX_PER_AUTHOR` still caps a preferred author at 2; the empty-set default is
  behavior-identical to the current two-argument call.
- `applyDirectiveConstraints`: a constraints object containing **only** `prefer_*` keys returns every
  candidate (§4.4).
- `userSteeringBlock` and `buildSeedPrompt`: blocks render when populated; output is unchanged when
  both lists are empty.
- `preferenceSuggest`: counts loved books only and ignores unrated and low-rated ones; excludes
  values already in any of the four lists; respects the top-12 truncation *after* exclusion;
  `mostCommon` tie ordering.
- Routes: `PUT /directive` round-trips the new keys; a favorites-only record does not 422;
  `GET /api/directive/suggestions` is tenant-scoped and returns empty arrays for a reader with no
  loved books.

**Jest**

- `FavoritesFields`: add via input and via Enter; remove; clicking a suggestion adds it and removes
  it from the suggestion row; the cap message appears at `MAX_PREFER_ENTRIES`; the exclude-conflict
  message appears; `onChange` fires with the full next value rather than a delta.
- `CustomInstructions`: saving sends prose and favorites in one `PUT`; the Clear button appears for a
  constraints-only record.

**Browser verification** (required by the global rule; a passing suite is not sufficient): add a
favorite author and a favorite subject on `/profile`, save, reload and confirm persistence, accept a
library suggestion, then run a recommendation and confirm candidates by the favorited author appear
with a `preferred_author:` seed reason.

Note that `docs/superpowers/plans/` records the `isolated-local-env` skill as stale — it documents
the retired Python backend and must not be followed for local verification.

---

## 8. Out of scope

- `/similar` and `/discover` remain unaffected (§4.3).
- `exclude_*` stay model-authored (§6.5).
- No new table, no migration (§3.4).
- No genre taxonomy or fiction/nonfiction classifier; "genre" continues to mean an Open Library /
  Google Books subject string, as it already does everywhere else in the app.
- No change to `surname()` keying or to `MAX_PER_AUTHOR` / `MAX_LIBRARY_AUTHOR_SHARE` values.
