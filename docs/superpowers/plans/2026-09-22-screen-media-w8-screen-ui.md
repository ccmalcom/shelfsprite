# ScreenSprite Wave 8 — Screen UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reader who turns ScreenSprite on can switch between Books and Screen, import from Letterboxd and watch it match, browse and edit their film and TV library, fix a doubtful match, add titles by search, run screen recommendations and act on them, and see films and shows cited as evidence on the one shared taste profile.

**Architecture:** Everything in this wave is client code on top of the routes waves 4–7 built. `lib/api.ts` gains a `screenApi` object whose calls throw `ApiRequestError(status, detail)`, so screens can show the server's message instead of a raw status line. The active section comes from the pathname (`sectionFor`), never from state. `/screen/*` shares a server layout that sets the page title and wraps every page in a client `ScreenGate`, which sends a reader without ScreenSprite to `/settings#screen`. The profile page body becomes `components/profile/ProfileView.tsx`, so `/profile` and `/screen/profile` render the same unified view; title evidence reaches `TraitRow` and the reveal flow only when ScreenSprite is on. Book pages change only where the spec says they may: the Profile view, and Settings.

**Tech Stack:** Next.js 16 App Router (client pages, one server layout), React 19, SWR 2, Tailwind, lucide-react 1.41, `next/image` with `unoptimized`, Jest 30 + Testing Library (jsdom).

**Spec:** `docs/superpowers/specs/2026-09-22-screen-media-design.md` — §7 (all of it), §5.7, §6.2, §6.7, §8, §10. **Index and cross-wave contract:** `docs/superpowers/plans/2026-09-22-screen-media-00-index.md`. Read the index, then this plan, then spec §7.

**Issue:** #96. **Branch:** `feat/screen-media`.

---

## Global Constraints

Every task's requirements implicitly include this section. The first block is copied verbatim from the index; the second is specific to this wave.

- **Two test runners with disjoint ownership.** `npm run test:server` (Vitest) owns exactly `lib/server/**` and `app/api/**`; `npm test` (Jest) owns everything else. Before naming a single test file as a gate, confirm the runner sees it: `npx vitest list <path>` or `npx jest --listTests <path>`. A gate that matches zero tests exits 0.
- **Full gate at the end of every wave**, from the repository root: `npm run test:server`, `npm test`, `npm run type-check`, `npm run lint`, `npm run format:check`, `npm run build`. `npm run build` is the only gate that catches Next segment-config and prerender failures.
- **Real-flow verification before a wave is called done** (spec §10). Tests alone never close a wave. Use an isolated local run: a scratch Postgres in Docker plus a local-mode dev server (`ALLOW_LOCAL_AUTH=true`) with **no `.env` file in scope**, following the procedure recorded in the project memory note `marketing-screenshot-pipeline`. Never point a verification run at the production database. Record what you actually observe, not what a plan predicts.
- **Secrets.** Never open, print, or name the contents of `.env*` files; check presence only. Never ask Codex to inspect them.
- **Ratings.** `numeric(2,1)` with drizzle `mode: 'number'` on every rating column. `0` on an API mutation means "clear". The manual `isValidRating` guard owns the 422 message; do not move the grid rule into Zod.
- **Wire format.** API JSON is snake_case. Prompt payloads use `pyJsonDumps` over ordered `Map`s (`lib/server/serialize.ts`); never `JSON.stringify` a prompt payload.
- **Long-running routes** export the literal `export const maxDuration = 300;` — never an imported binding. Every new one is added to `app/api/enrich/enrich-max-duration.test.ts`.
- **Tenancy.** Every query on a user-owned table filters by `user_id`; every route test includes a second user whose ids are rejected (404, never 403 that leaks existence).
- **Schema changes.** None in this wave. If a task seems to need a column or a route change, stop and report.
- **`.tsx` string literals are ASCII-only**; put a non-ASCII value in an expression container (`{'\u2026'}`), never in a bare JSX attribute. `text-base` is a colour, not a size.
- **Copy.** User-facing copy says **ScreenSprite**; code, routes, tables and settings keys say `screen` (spec decision 13).
- **Git.** Work on `feat/screen-media`. Chase commits manually by default: a plan's "Commit" step runs only when Chase has authorized commits for that execution session; otherwise stage the listed paths and leave them. Plain commit messages, no `Co-Authored-By` trailer; end each with the `Claude-Session:` line from the session's attribution instructions. Subject: `feat(screen): … (#96)`.
- **Next.js here is not the Next.js you know.** Before writing route, page or `next/image` code, read the relevant guide in `node_modules/next/dist/docs/`.

Wave 8 specifics:

- **No book page gains a control unless ScreenSprite is on, and even then only Profile and Settings change** (spec §7 principle). The Books nav set, Home, Swipe, Discover, Library and To-read render exactly as today. The swipe page's reject picker is extracted into a component with no behavior change.
- **Images are hotlinked, never copied.** Every poster renders through `next/image` with `unoptimized` (spec §7.8, decisions 8 and 14). Do **not** add Wikimedia or TVmaze hosts to `images.remotePatterns` in `next.config.mjs`; `unoptimized` bypasses the loader that checks that list (`node_modules/next/dist/shared/lib/get-img-props.js`, `generateImgAttrs`). The marketing page never shows a poster (§7.10).
- **Cache invalidation (spec §7.7).** Every title rating, review, favorite, exclusion, correction, deletion and screen rejection revalidates `PROFILE_STATUS_KEY`. Disabling ScreenSprite and deleting the screen library invalidate traits, archetype, reveal, profile status and every screen key. Invalidating a key whose page is not mounted uses the three-argument `mutate(key, undefined, { revalidate: true })` (`docs/frontend.md`).
- **Show the server's words.** Screen routes answer errors as `{ "detail": "…" }`. Surface that detail (it is written for people), never `POST /api/… → 409: {…}`.
- **Formatting.** The code blocks here are close to, not exactly, Prettier's output. Run `npx prettier --write` on every file a task creates or modifies before that task's lint step; `npm run format:check` gates the wave.
- **Page tests mock `swr`.** They prove call shapes, not SWR behavior. Anything that depends on real SWR semantics (the three-argument `mutate`, `refreshInterval` as a function) is checked in the real browser in Task 9.

---

## Review Focus

Five conditions the spec implies that a person using this will hit and that no happy-path test exercises. Each line names the owning task, which adds the test that pins it.

1. **ScreenSprite is off (or was just turned off in another tab) while the reader is on a `/screen/*` URL.** They land on `/settings#screen`, not on a broken page or a spinner that never ends. A 403 from any screen route re-reads the settings, so the gate redirects without a reload. → Task 5, tests `redirects a disabled reader to settings` and `a 403 re-reads the settings`.
2. **A poster is missing or fails to load** (Wikipedia moved the file, TVmaze 404s, a candidate had none). The tile shows a typographic card in the display face, never a broken-image icon, and a corrected title with a new URL tries its image again. → Task 3, tests `falls back when the image fails` and `retries when the url changes`.
3. **The reader reloads, or closes the import modal, while enrichment runs.** Settings finds the running job through `GET /api/screen/enrich/active` and shows its progress again. → Task 8, test `recovers the running job`.
4. **A recommendation cites a trait, title or book that has since been deleted.** The chip renders as plain text; it is never a link or button that opens nothing. → Task 6, test `renders deleted evidence as plain text`.
5. **A 390 px phone.** The Books | Screen switch fits beside the wordmark and the account button with no horizontal scroll, and the screen bottom nav has at most five items. → Task 2, test `the screen bottom nav stays within the thumb budget` and the mobile header test; Task 9 measures `scrollWidth` at 390 px in a real browser.

---

## Decisions this plan makes (spec left them open)

1. **`screenApi` is a separate object with its own request helper.** The existing `get`/`post` helpers throw `Error("POST /x → 409: {json}")`. Changing them would alter every book screen's error copy. Screen calls go through `screenRequest`, which throws `ApiRequestError` whose `message` is the server's `detail`.
2. **The library fetches every title once and filters in the browser.** `GET /api/screen/titles` supports `type` and `status`, but one list serves the filter chips, the duplicate lookup and the profile's evidence map from a single SWR key.
3. **Recommendation cards show no description.** `title_recommendations` stores a description but not its source, and spec §7.9 requires every description to name its source. The card shows tile, type, year, rationale and chips (§7.2); the `/screen` footer credits the sources.
4. **Acted-on recommendations stay visible with their outcome** ("On your watchlist", "Marked as watched", "Skipped") instead of disappearing. The list is a page, not a swipe deck, and a vanished card reads as a lost click.
5. **"Clear my rating" clears only the in-app rating.** `PATCH /api/screen/titles/[id]` with `rating: 0` clears `app_rating`, and the effective rating then falls back to the Letterboxd one. When a Letterboxd rating exists the button says "Use my Letterboxd rating", so it never promises something it cannot do.
6. **No title taste-signal control in v1.** Wave 6 made `POST /api/taste-signal` accept `target_kind: 'title'`, but the only book entry point for signals is the swipe deck, which has no screen twin, and spec §7.3 lists no signal control for the title modal. `recordTasteSignal` is left unchanged; a "More like this" control is a follow-up.
7. **The title evidence label is `Title (Year)` with a Film or TV marker** (icon plus visually hidden text). In the reveal flow, whose beats carry plain strings, a title reads `Title (film)` or `Title (TV)`.

---

## File map

| File | Action | Responsibility |
|---|---|---|
| `lib/api.ts` | Modify | Screen types, `ApiRequestError`, `screenRequest`, `screenApi`, screen SWR keys, `SCREEN_REJECT_REASONS` labels, `BOOKS_ALL_KEY`, `REVEAL_TITLES_KEY`; `Trait` gains the title id lists; `ProfileStatus` gains `changed_titles`/`changed_title_ids`. |
| `lib/nav.ts` | Modify | `Section`, `sectionFor`, `SCREEN_NAV_ROUTES`, `navRoutesFor`. |
| `lib/useScreenSettings.ts` | Create | SWR hook over `GET /api/settings/screen`. |
| `lib/screen.ts` | Create | Pure helpers: sorting, labels, `needsCorrection`, `titleEvidenceMap`, `traitsWarning`, `errorMessage`. |
| `lib/screenCache.ts` | Create | `invalidateScreenState`, `invalidateTitleEdits`, `handleScreenError`. |
| `components/SectionSwitch.tsx` | Create | Books \| Screen segmented links. |
| `components/Wordmark.tsx` | Create | ShelfSprite logo, or the mark plus a "ScreenSprite" text wordmark. |
| `components/NavBar.tsx` | Modify | Section-aware wordmark, home link, eyebrow, rail routes; the switch. |
| `components/BottomNav.tsx` | Modify | Section-aware routes. |
| `components/RejectReasonPicker.tsx` | Create | The reject-reason modal, extracted from the swipe page. |
| `app/(main)/swipe/page.tsx` | Modify | Uses `RejectReasonPicker`; no behavior change. |
| `components/screen/TitleTile.tsx` | Create | Poster with typographic fallback. |
| `components/screen/Attribution.tsx` | Create | `DescriptionSource`, `ScreenCredits`. |
| `components/screen/TitleDetailModal.tsx` | Create | Rate, status, review, favorite, exclude, attribution, correction entry, remove. |
| `components/screen/CatalogSearch.tsx` | Create | Search form and results for add and correction. |
| `components/screen/AddTitleModal.tsx` | Create | Search, pick, set status/rating/review, add. |
| `components/screen/CorrectTitleModal.tsx` | Create | Search, pick, correct. |
| `components/screen/ScreenGate.tsx` | Create | Redirects a reader without ScreenSprite. |
| `app/(main)/screen/layout.tsx` | Create | Server layout: `metadata.title`, gate, credits footer. |
| `app/(main)/screen/library/page.tsx` | Create | Library grid, filters, sticky sort, modals. |
| `components/screen/TitleRecCard.tsx` | Create | One recommendation with chips and actions. |
| `app/(main)/screen/page.tsx` | Create | For you: filter, run, cards, reject picker, read-only book modal. |
| `components/BookDetailModal.tsx` | Modify | `readOnly` prop. |
| `components/profile/ProfileView.tsx` | Create | The profile page body, moved; supplies title evidence. |
| `app/(main)/profile/page.tsx` | Modify | Renders `ProfileView`. |
| `app/(main)/screen/profile/page.tsx` | Create | Renders `ProfileView`. |
| `components/profile/TraitRow.tsx` | Modify | Renders title evidence. |
| `lib/revealBeats.ts` | Modify | Title evidence in beats; `titlesSettled`. |
| `components/reveal/RevealSequence.tsx` | Modify | Fetches titles when ScreenSprite is on. |
| `components/screen/ScreenSettingsCard.tsx` | Create | Enable, import, progress, retry, disable with the §5.7 warning. |
| `components/screen/LetterboxdImportModal.tsx` | Create | ZIP upload. |
| `components/screen/ScreenEnrichProgress.tsx` | Create | Polls the job; progress bar. |
| `app/(main)/settings/page.tsx` | Modify | Mounts the card at `#screen`; danger-zone copy and "Delete screen library". |
| `app/__tests__/rejectModal.test.tsx` | Modify | Its source-level guard follows the extracted component. |
| `docs/frontend.md` | Modify | A ScreenSprite section. |

Tests are listed in each task.

---

### Task 0: Preconditions

**Files:** none.

**Interfaces:** none.

This wave consumes routes and wire fields from waves 1, 2 and 4–7. Confirm they exist before writing client code against them. A missing name means an earlier wave is incomplete: **stop and report**, do not write a stand-in.

- [ ] **Step 1: Check the routes exist**

Run:

```bash
ls app/api/settings/screen/route.ts app/api/settings/screen/opt-out-preview/route.ts \
  app/api/screen/import/route.ts app/api/screen/enrich/start/route.ts \
  app/api/screen/enrich/active/route.ts app/api/screen/titles/route.ts \
  "app/api/screen/titles/[id]/route.ts" "app/api/screen/titles/[id]/correct/route.ts" \
  app/api/screen/library/route.ts app/api/screen/search/route.ts \
  app/api/screen/recommend/route.ts app/api/screen/recommendations/route.ts \
  "app/api/screen/recommendations/[id]/feedback/route.ts"
```

Expected: all 13 paths listed, no "No such file".

- [ ] **Step 2: Check the wire fields and components this wave relies on**

Run:

```bash
grep -n "exhibit_title_ids" lib/server/traits.ts
grep -n "changed_title_ids" app/api/profile/status/route.ts
grep -n "rebuild_reason" lib/api.ts
grep -n "traits_removed" app/api/settings/screen/route.ts
grep -n "export interface TitleEvidence" components/profile/TraitRow.tsx
grep -n "titleEvidence" components/profile/TraitsSection.tsx
grep -n "export function titleRecOut" lib/server/screenRecs.ts
grep -n "export const SCREEN_REJECT_REASONS" lib/server/screenRecs.ts
```

Expected: every command prints at least one line. `lib/api.ts` already has `ProfileStatus.rebuild_reason` from wave 2.

- [ ] **Step 3: Read the Next guides this wave touches**

Read the App Router guides in `node_modules/next/dist/docs/` for layouts with `metadata`, `useRouter().replace`, `usePathname`, `useSearchParams` under `Suspense`, and the `next/image` component (the `unoptimized`, `fill` and `onError` props). Note anything that contradicts this plan and report it before Task 1.

- [ ] **Step 4: Record the baseline**

Run: `npm test 2>&1 | grep -E "^Tests:"` and write the count down. Every later task's Jest run should end at this count plus that task's new tests.

---

### Task 1: The screen client in `lib/api.ts`

**Files:**
- Modify: `lib/api.ts`
- Test: `lib/__tests__/screenApi.test.ts`

**Interfaces:**
- Consumes: the private `authHeaders()` and `API_BASE` in `lib/api.ts`; `EnrichJobOut`; the wave 4–7 routes checked in Task 0.
- Produces (every later task):

```ts
export type MediaType = 'movie' | 'tv';
export type TitleStatus = 'watched' | 'watching' | 'dropped' | 'want';
export type ScreenMediaFilter = 'both' | 'movie' | 'tv';
export interface ScreenSettings { enabled: boolean; toggled_at: string | null; title_count: number }
export interface ScreenSettingsUpdate extends ScreenSettings { traits_removed?: number }
export interface TitleEnrichmentOut { confidence_label: string | null; resolution_confidence: number; match_method: string | null; identity_source: 'auto' | 'manual' | 'corrected'; image_url: string | null; description: string | null; description_source: 'wikipedia' | 'tvmaze' | null; description_url: string | null; wikipedia_page: string | null; genres: string[]; directors: string[]; creators: string[]; duplicate_of_title_id: number | null }
export interface TitleOut { /* the index's TitleOut, field for field */ }
export interface ScreenCandidate { /* wave 5's ScreenCandidate, field for field */ }
export interface TitleRec { /* wave 7's TitleRecOut, field for field */ }
export interface ScreenRecommendRunResult { run_id: string | null; served: number; media_filter: ScreenMediaFilter; candidates: number; note?: string }
export interface ScreenImportResult { inserted: number; updated: number; unchanged: number; job: EnrichJobOut }
export interface ScreenOptOutPreview { traits: number; confirmed: number }
export interface ScreenLibraryPurgeResult { titles_removed: number; title_recommendations_removed: number; title_signals_removed: number; traits_removed: number; recommendations_removed: number; profile_reset: true }
export interface TitleUpdate { rating?: number; review?: string; status?: TitleStatus; is_favorite?: boolean; exclude_from_profile?: boolean }
export interface AddTitleRequest { candidate: ScreenCandidate; status: TitleStatus; rating: number | null; review: string | null }
export type ScreenRecDecision = 'accepted' | 'already_watched' | 'rejected';
export interface ScreenRecFeedback { status: ScreenRecDecision; reject_reasons?: string[]; user_note?: string }
export interface ScreenRecFeedbackResult { id: number; status: ScreenRecDecision; user_note: string | null; reject_reasons: string[] | null; title: TitleOut | null }
export class ApiRequestError extends Error { readonly status: number; readonly detail: string }
export const screenApi: { settings, setEnabled, optOutPreview, importLetterboxd, activeJob, startEnrich, titles, updateTitle, deleteTitle, deleteLibrary, search, addTitle, correctTitle, recommend, recommendations, recFeedback };
export const SCREEN_SETTINGS_KEY = 'screen-settings';
export const SCREEN_TITLES_KEY = 'screen-titles';
export const SCREEN_RECS_KEY = 'screen-recommendations';
export const SCREEN_ACTIVE_JOB_KEY = 'screen-enrich-active';
export const BOOKS_ALL_KEY = 'books-all';
export const REVEAL_TITLES_KEY = 'reveal-titles';
export const SCREEN_REJECT_REASONS: Record<string, string>;
// Trait gains: exhibit_title_ids?: number[]; contrast_title_ids?: number[]
// ProfileStatus gains: changed_titles?: number; changed_title_ids?: number[]
```

`BOOKS_ALL_KEY` names the key the profile page already uses as a local `BOOKS_KEY = 'books-all'`; the For you page reuses it so both share one cached book list. The title id lists and `changed_titles` are optional so that every existing book-era test fixture still type-checks; wave 6 always sends them.

- [ ] **Step 1: Confirm Jest owns the test path**

Run: `npx jest --listTests lib/__tests__/screenApi.test.ts`
Expected: prints nothing now; after Step 2 it must print the file's absolute path. If it does not, stop.

- [ ] **Step 2: Write the failing test**

Create `lib/__tests__/screenApi.test.ts`:

```ts
/**
 * @jest-environment jsdom
 */
import {
  ApiRequestError,
  screenApi,
  SCREEN_REJECT_REASONS,
  type ScreenCandidate,
} from '@/lib/api';

jest.mock('@/utils/supabase/client', () => ({
  authEnabled: false,
  getSupabaseClient: () => null,
}));

const fetchMock = jest.fn();

function answer(status: number, body: unknown, raw?: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => raw ?? JSON.stringify(body),
  };
}

const candidate: ScreenCandidate = {
  media_type: 'movie',
  title: 'Heat',
  year: 1995,
  wikidata_qid: 'Q614264',
  tvmaze_id: null,
  image_url: null,
  description: null,
  description_source: null,
  description_url: null,
  wikipedia_page: 'Heat (1995 film)',
  genres: ['crime film'],
  directors: ['Michael Mann'],
  creators: [],
  writers: ['Michael Mann'],
  countries: ['United States'],
  original_language: 'en',
  based_on: [],
  main_subjects: [],
  series: [],
  production_companies: [],
  sitelinks: 60,
};

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe('screenApi', () => {
  it('encodes the search query and type', async () => {
    fetchMock.mockResolvedValue(answer(200, []));
    await screenApi.search('Amélie & co', 'movie');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/screen/search?q=Am%C3%A9lie+%26+co&type=movie');
    expect(init.method).toBe('GET');
  });

  it('throws ApiRequestError carrying the server detail', async () => {
    fetchMock.mockResolvedValue(
      answer(409, { detail: '"Heat" is already in your ScreenSprite library.' })
    );
    const err = await screenApi
      .addTitle({ candidate, status: 'watched', rating: null, review: null })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect((err as ApiRequestError).status).toBe(409);
    expect((err as ApiRequestError).message).toBe(
      '"Heat" is already in your ScreenSprite library.'
    );
  });

  it('falls back to the raw text when the error body is not JSON', async () => {
    fetchMock.mockResolvedValue(answer(502, null, 'Bad gateway'));
    const err = (await screenApi.titles().catch((e: unknown) => e)) as ApiRequestError;
    expect(err.status).toBe(502);
    expect(err.detail).toBe('Bad gateway');
  });

  it('names the method and path when the error body is empty', async () => {
    fetchMock.mockResolvedValue(answer(500, null, ''));
    const err = (await screenApi.titles().catch((e: unknown) => e)) as ApiRequestError;
    expect(err.detail).toBe('GET /screen/titles failed (500)');
  });

  it('sends JSON bodies with a content type', async () => {
    fetchMock.mockResolvedValue(answer(200, { run_id: null, served: 0 }));
    await screenApi.recommend('tv');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/screen/recommend');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ media_filter: 'tv' });
  });

  it('uploads the ZIP as multipart with no JSON content type', async () => {
    fetchMock.mockResolvedValue(answer(200, { inserted: 1, updated: 0, unchanged: 0, job: {} }));
    const file = new File(['PK'], 'letterboxd.zip', { type: 'application/zip' });
    await screenApi.importLetterboxd(file);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/screen/import');
    expect(init.body).toBeInstanceOf(FormData);
    expect(((init.body as FormData).get('file') as File).name).toBe('letterboxd.zip');
    expect(init.headers['Content-Type']).toBeUndefined();
  });

  it('starts enrichment without a limit', async () => {
    fetchMock.mockResolvedValue(answer(200, { job_id: 'j1' }));
    await screenApi.startEnrich();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ force: false, limit: null });
  });

  it('posts feedback to the recommendation', async () => {
    fetchMock.mockResolvedValue(answer(200, { id: 4, status: 'rejected', title: null }));
    await screenApi.recFeedback(4, { status: 'rejected', reject_reasons: ['too_long'] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/screen/recommendations/4/feedback');
    expect(JSON.parse(init.body)).toEqual({ status: 'rejected', reject_reasons: ['too_long'] });
  });

  it('labels exactly the server vocabulary', () => {
    // Mirrors SCREEN_REJECT_REASONS in lib/server/screenRecs.ts (wave 7). Jest cannot import that
    // module (it pulls in the database), so the list is pinned here; change both together.
    expect(Object.keys(SCREEN_REJECT_REASONS)).toEqual([
      'wrong_genre',
      'too_dark',
      'too_long',
      'not_now',
      'overhyped',
      'wrong_vibe',
    ]);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx jest lib/__tests__/screenApi.test.ts`
Expected: FAIL — `screenApi`, `ApiRequestError` and `SCREEN_REJECT_REASONS` are not exported.

- [ ] **Step 4: Widen `Trait` and `ProfileStatus`**

In `lib/api.ts`, add two fields to `interface Trait`, after `contrasts`:

```ts
  /** Title ids this trait cites (wave 6). Absent on book-era fixtures; the API always sends them. */
  exhibit_title_ids?: number[];
  contrast_title_ids?: number[];
```

and two to `interface ProfileStatus`, after `changed_book_ids`:

```ts
  /** Titles changed since the last build (wave 6); they dirty the profile like books. */
  changed_titles?: number;
  changed_title_ids?: number[];
```

- [ ] **Step 5: Add the screen client**

Append to the end of `lib/api.ts`:

```ts
// ─── ScreenSprite (movies & TV) ─────────────────────────────────────────────

export type MediaType = 'movie' | 'tv';
export type TitleStatus = 'watched' | 'watching' | 'dropped' | 'want';
export type ScreenMediaFilter = 'both' | 'movie' | 'tv';

/** GET /settings/screen. */
export interface ScreenSettings {
  enabled: boolean;
  toggled_at: string | null;
  title_count: number;
}

/** PUT /settings/screen. Disabling also reports how many traits the opt-out removed. */
export interface ScreenSettingsUpdate extends ScreenSettings {
  traits_removed?: number;
}

export interface TitleEnrichmentOut {
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
}

/** One film or show in the reader's library (lib/server/titles.ts#titleOut). */
export interface TitleOut {
  id: number;
  media_type: MediaType;
  title: string;
  year: number | null;
  status: TitleStatus;
  /** Effective: app_rating ?? letterboxd_rating. */
  rating: number | null;
  app_rating: number | null;
  letterboxd_rating: number | null;
  /** Effective: app_review ?? letterboxd_review. */
  review: string | null;
  app_review: string | null;
  letterboxd_review: string | null;
  last_watched_on: string | null;
  is_favorite: boolean;
  exclude_from_profile: boolean;
  wikidata_qid: string | null;
  tvmaze_id: number | null;
  created_at: string;
  enrichment: TitleEnrichmentOut | null;
}

/** A catalog record from search, passed back unchanged to add or correct. */
export interface ScreenCandidate {
  media_type: MediaType;
  title: string;
  year: number | null;
  wikidata_qid: string | null;
  tvmaze_id: number | null;
  image_url: string | null;
  description: string | null;
  description_source: 'wikipedia' | 'tvmaze' | null;
  description_url: string | null;
  wikipedia_page: string | null;
  genres: string[];
  directors: string[];
  creators: string[];
  writers: string[];
  countries: string[];
  original_language: string | null;
  based_on: Array<{ qid: string; title: string | null; author: string | null }>;
  main_subjects: string[];
  series: Array<{ qid: string; label: string | null }>;
  production_companies: Array<{ qid: string; label: string | null }>;
  sitelinks: number;
}

/** One persisted screen recommendation (lib/server/screenRecs.ts#titleRecOut). */
export interface TitleRec {
  id: number;
  run_id: string;
  rank: number;
  media_type: MediaType;
  media_filter: ScreenMediaFilter;
  title: string;
  year: number | null;
  wikidata_qid: string | null;
  tvmaze_id: number | null;
  image_url: string | null;
  genres: string[];
  description: string | null;
  retrieval_pool: string | null;
  seed_reason: string | null;
  score: number;
  rationale: string | null;
  grounded_trait_ids: number[];
  grounded_book_ids: number[];
  grounded_title_ids: number[];
  status: 'served' | 'accepted' | 'rejected' | 'already_watched';
  user_note: string | null;
  reject_reasons: string[] | null;
  created_at: string | null;
}

/** POST /screen/recommend. A run with run_id null persisted nothing (issue #64). */
export interface ScreenRecommendRunResult {
  run_id: string | null;
  served: number;
  media_filter: ScreenMediaFilter;
  candidates: number;
  note?: string;
}

export interface ScreenImportResult {
  inserted: number;
  updated: number;
  unchanged: number;
  job: EnrichJobOut;
}

export interface ScreenOptOutPreview {
  traits: number;
  confirmed: number;
}

export interface ScreenLibraryPurgeResult {
  titles_removed: number;
  title_recommendations_removed: number;
  title_signals_removed: number;
  traits_removed: number;
  recommendations_removed: number;
  profile_reset: true;
}

/** PATCH /screen/titles/{id}. rating 0 clears the in-app rating; review '' clears the in-app review. */
export interface TitleUpdate {
  rating?: number;
  review?: string;
  status?: TitleStatus;
  is_favorite?: boolean;
  exclude_from_profile?: boolean;
}

export interface AddTitleRequest {
  candidate: ScreenCandidate;
  status: TitleStatus;
  rating: number | null;
  review: string | null;
}

export type ScreenRecDecision = 'accepted' | 'already_watched' | 'rejected';

export interface ScreenRecFeedback {
  status: ScreenRecDecision;
  /** Only with 'rejected', and only when non-empty (the route rejects an empty list). */
  reject_reasons?: string[];
  user_note?: string;
}

export interface ScreenRecFeedbackResult {
  id: number;
  status: ScreenRecDecision;
  user_note: string | null;
  reject_reasons: string[] | null;
  /** The matched or created title for accepted/already_watched; null when rejected. */
  title: TitleOut | null;
}

/**
 * A non-2xx answer from a screen route. `message` is the server's `detail`, which is written
 * for people, so screens can show it as is.
 */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(detail);
    this.name = 'ApiRequestError';
    this.status = status;
    this.detail = detail;
  }
}

async function screenRequest<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown
): Promise<T> {
  const headers: Record<string, string> = { ...(await authHeaders()) };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) {
    // The browser sets the multipart boundary; a hand-set Content-Type would break it.
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${API_BASE}${path}`, { method, cache: 'no-store', headers, body: payload });
  if (!res.ok) {
    const text = await res.text();
    let detail = text || `${method} ${path} failed (${res.status})`;
    try {
      const parsed = JSON.parse(text) as { detail?: unknown };
      if (typeof parsed.detail === 'string') detail = parsed.detail;
    } catch {
      // Not JSON (a proxy error page, say): keep the text.
    }
    throw new ApiRequestError(res.status, detail);
  }
  return res.json() as Promise<T>;
}

export const screenApi = {
  settings: () => screenRequest<ScreenSettings>('GET', '/settings/screen'),
  setEnabled: (enabled: boolean) =>
    screenRequest<ScreenSettingsUpdate>('PUT', '/settings/screen', { enabled }),
  optOutPreview: () =>
    screenRequest<ScreenOptOutPreview>('GET', '/settings/screen/opt-out-preview'),
  importLetterboxd: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return screenRequest<ScreenImportResult>('POST', '/screen/import', form);
  },
  activeJob: () => screenRequest<{ job: EnrichJobOut | null }>('GET', '/screen/enrich/active'),
  startEnrich: (opts: { force?: boolean } = {}) =>
    screenRequest<EnrichJobOut>('POST', '/screen/enrich/start', {
      force: opts.force ?? false,
      limit: null,
    }),
  titles: () => screenRequest<TitleOut[]>('GET', '/screen/titles'),
  updateTitle: (id: number, body: TitleUpdate) =>
    screenRequest<TitleOut>('PATCH', `/screen/titles/${id}`, body),
  deleteTitle: (id: number) =>
    screenRequest<{ id: number; title: string; removed: true }>('DELETE', `/screen/titles/${id}`),
  deleteLibrary: () => screenRequest<ScreenLibraryPurgeResult>('DELETE', '/screen/library'),
  search: (q: string, type: MediaType) =>
    screenRequest<ScreenCandidate[]>('GET', `/screen/search?${new URLSearchParams({ q, type })}`),
  addTitle: (body: AddTitleRequest) => screenRequest<TitleOut>('POST', '/screen/titles', body),
  correctTitle: (id: number, candidate: ScreenCandidate) =>
    screenRequest<TitleOut>('POST', `/screen/titles/${id}/correct`, { candidate }),
  recommend: (mediaFilter: ScreenMediaFilter) =>
    screenRequest<ScreenRecommendRunResult>('POST', '/screen/recommend', {
      media_filter: mediaFilter,
    }),
  recommendations: () => screenRequest<TitleRec[]>('GET', '/screen/recommendations'),
  recFeedback: (id: number, body: ScreenRecFeedback) =>
    screenRequest<ScreenRecFeedbackResult>('POST', `/screen/recommendations/${id}/feedback`, body),
};

/** Shared SWR keys for ScreenSprite. lib/screenCache.ts invalidates them together. */
export const SCREEN_SETTINGS_KEY = 'screen-settings';
export const SCREEN_TITLES_KEY = 'screen-titles';
export const SCREEN_RECS_KEY = 'screen-recommendations';
export const SCREEN_ACTIVE_JOB_KEY = 'screen-enrich-active';
/** Every library book (limit 500): the profile's evidence map and the screen book chips. */
export const BOOKS_ALL_KEY = 'books-all';
/** The reveal flow's title list (components/reveal/RevealSequence.tsx). */
export const REVEAL_TITLES_KEY = 'reveal-titles';

/** Screen rejection vocabulary (spec §6.7): the book list without tried_author. */
export const SCREEN_REJECT_REASONS: Record<string, string> = {
  wrong_genre: 'Wrong genre',
  too_dark: 'Too dark',
  too_long: 'Too long (runtime or seasons)',
  not_now: 'Not in the mood',
  overhyped: 'Feels overhyped',
  wrong_vibe: 'Wrong vibe',
};
```

`new URLSearchParams({ q, type })` stringifies with `+` for spaces and percent-encodes the rest, which is what the test pins.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx jest lib/__tests__/screenApi.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 7: Type-check**

Run: `npm run type-check`
Expected: no errors. A new error in an existing test fixture that builds a `Trait` or `ProfileStatus` means a field was added as required; the three additions above are optional.

- [ ] **Step 8: Commit**

```bash
git add lib/api.ts lib/__tests__/screenApi.test.ts
git commit -m "feat(screen): typed ScreenSprite client and SWR keys (#96)"
```

---

### Task 2: Section-aware navigation

**Files:**
- Modify: `lib/nav.ts`, `components/NavBar.tsx`, `components/BottomNav.tsx`, `components/__tests__/nav.test.tsx`
- Create: `lib/useScreenSettings.ts`, `components/SectionSwitch.tsx`, `components/Wordmark.tsx`
- Test: `components/__tests__/nav.test.tsx` (extended), `components/__tests__/sectionNav.test.tsx`

**Interfaces:**
- Consumes: `screenApi.settings`, `SCREEN_SETTINGS_KEY`, `ScreenSettings` (Task 1); `BrandLogo`.
- Produces:

```ts
// lib/nav.ts
export type Section = 'books' | 'screen';
export function sectionFor(pathname: string | null): Section;
export const SCREEN_NAV_ROUTES: readonly NavRoute[];
export function navRoutesFor(section: Section): readonly NavRoute[];
// lib/useScreenSettings.ts
export function useScreenSettings(): {
  settings: ScreenSettings | undefined;
  enabled: boolean;
  isLoading: boolean;
  error: unknown;
  mutate: KeyedMutator<ScreenSettings>;
};
// components/SectionSwitch.tsx
export default function SectionSwitch(props: { active: Section; className?: string }): JSX.Element;
// components/Wordmark.tsx
export default function Wordmark(props: { section: Section; compact?: boolean }): JSX.Element;
```

Spec §7.1 and §7.11. The section is derived from the pathname and never stored. The screen nav set is For you, Library and Profile; Settings stays reachable from the rail's utility links, the account modal and the profile page's mobile links, exactly as for books. The switch renders only when ScreenSprite is on. With it off, `NAV_ROUTES` and the header render exactly as today.

At 390 px the header holds the wordmark, the switch and the account button. The account button drops to its icon below the `sm` breakpoint **only while the switch is showing**, and the ShelfSprite logo narrows from 150 px to 112 px under the same condition. Its accessible name stays "Account".

- [ ] **Step 1: Extend the route-table test**

In `components/__tests__/nav.test.tsx`, change the import to

```ts
import { NAV_ROUTES, SCREEN_NAV_ROUTES, navRoutesFor, sectionFor } from '@/lib/nav';
```

and append inside the file, after the existing `describe` block:

```ts
describe('sectionFor', () => {
  it.each([
    ['/screen', 'screen'],
    ['/screen/library', 'screen'],
    ['/screen/profile', 'screen'],
    ['/', 'books'],
    ['/library', 'books'],
    ['/profile', 'books'],
    ['/screenings', 'books'],
    ['/settings', 'books'],
  ])('%s is the %s section', (path, section) => {
    expect(sectionFor(path)).toBe(section);
  });

  it('treats an unknown pathname as books', () => {
    expect(sectionFor(null)).toBe('books');
  });
});

describe('screen route table', () => {
  it('lists For you, Library and Profile under /screen', () => {
    expect(SCREEN_NAV_ROUTES.filter((r) => r.primary).map((r) => [r.href, r.label])).toEqual([
      ['/screen', 'For you'],
      ['/screen/library', 'Library'],
      ['/screen/profile', 'Profile'],
    ]);
  });

  it('the screen bottom nav stays within the thumb budget', () => {
    expect(SCREEN_NAV_ROUTES.filter((r) => r.primary).length).toBeLessThanOrEqual(5);
  });

  it('gives every screen route one label and an icon', () => {
    const hrefs = SCREEN_NAV_ROUTES.map((r) => r.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const r of SCREEN_NAV_ROUTES) expect(typeof r.Icon).not.toBe('undefined');
  });

  it('picks the table by section', () => {
    expect(navRoutesFor('books')).toBe(NAV_ROUTES);
    expect(navRoutesFor('screen')).toBe(SCREEN_NAV_ROUTES);
  });
});
```

- [ ] **Step 2: Write the rendering test**

Create `components/__tests__/sectionNav.test.tsx`:

```tsx
/**
 * @jest-environment jsdom
 */
import { render, screen, within } from '@testing-library/react';
import BottomNav from '@/components/BottomNav';
import NavBar from '@/components/NavBar';

let pathname = '/';
let screenEnabled = false;

jest.mock('next/navigation', () => ({ usePathname: () => pathname }));
jest.mock('@/utils/supabase/client', () => ({ authEnabled: false, getSupabaseClient: () => null }));
jest.mock('@/components/FeedbackLauncher', () => ({ __esModule: true, default: () => null }));
jest.mock('swr', () => ({
  __esModule: true,
  default: (key: string) => ({
    data:
      key === 'screen-settings'
        ? { enabled: screenEnabled, toggled_at: null, title_count: 0 }
        : undefined,
    error: undefined,
    isLoading: false,
    mutate: jest.fn(),
  }),
  mutate: jest.fn(),
}));

function bottomLinks() {
  const nav = screen.getByRole('navigation', { name: 'Main navigation' });
  return within(nav)
    .getAllByRole('link')
    .map((a) => a.textContent);
}

afterEach(() => {
  pathname = '/';
  screenEnabled = false;
});

describe('BottomNav', () => {
  it('shows the five book routes in the books section', () => {
    pathname = '/library';
    render(<BottomNav />);
    expect(bottomLinks()).toEqual(['Home', 'Swipe', 'Discover', 'Library', 'Profile']);
  });

  it('shows the screen routes under /screen and marks the current one', () => {
    pathname = '/screen/library';
    render(<BottomNav />);
    expect(bottomLinks()).toEqual(['For you', 'Library', 'Profile']);
    expect(screen.getByRole('link', { name: 'Library' })).toHaveAttribute('aria-current', 'page');
  });
});

describe('NavBar', () => {
  it('renders no switch while ScreenSprite is off', () => {
    render(<NavBar />);
    expect(screen.queryByRole('navigation', { name: 'Section' })).toBeNull();
    expect(screen.getByRole('link', { name: 'ShelfSprite home' })).toHaveAttribute('href', '/');
    expect(screen.getByText('Your reading room')).toBeInTheDocument();
  });

  it('renders the switch with Books current on a book page', () => {
    screenEnabled = true;
    pathname = '/library';
    render(<NavBar />);
    const sw = screen.getByRole('navigation', { name: 'Section' });
    expect(within(sw).getByRole('link', { name: 'Books' })).toHaveAttribute('aria-current', 'true');
    expect(within(sw).getByRole('link', { name: 'Screen' })).toHaveAttribute('href', '/screen');
  });

  it('brands the screen section and sends its home link to /screen', () => {
    screenEnabled = true;
    pathname = '/screen/profile';
    render(<NavBar />);
    expect(screen.getByRole('link', { name: 'ScreenSprite home' })).toHaveAttribute(
      'href',
      '/screen'
    );
    expect(screen.getByText('ScreenSprite')).toBeInTheDocument();
    expect(screen.getByText('Your screening room')).toBeInTheDocument();
    const sw = screen.getByRole('navigation', { name: 'Section' });
    expect(within(sw).getByRole('link', { name: 'Screen' })).toHaveAttribute(
      'aria-current',
      'true'
    );
  });

  it('keeps the account button named while its label is visually hidden on phones', () => {
    screenEnabled = true;
    render(<NavBar />);
    expect(screen.getByRole('button', { name: 'Account' })).toBeInTheDocument();
    expect(screen.getByText('Account')).toHaveClass('sr-only');
  });

  it('leaves the account label visible when there is no switch', () => {
    render(<NavBar />);
    expect(screen.getByText('Account')).not.toHaveClass('sr-only');
  });
});
```

Run: `npx jest --listTests components/__tests__/sectionNav.test.tsx`
Expected: prints the file's path.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx jest components/__tests__/nav.test.tsx components/__tests__/sectionNav.test.tsx`
Expected: FAIL — `SCREEN_NAV_ROUTES`, `navRoutesFor` and `sectionFor` are not exported, and the NavBar has no section behavior.

- [ ] **Step 4: Extend `lib/nav.ts`**

Replace the lucide import with

```ts
import {
  BookOpen,
  Clapperboard,
  Compass,
  Home,
  Settings,
  Shuffle,
  Sparkles,
  User,
} from 'lucide-react';
```

and append:

```ts
export type Section = 'books' | 'screen';

/**
 * The active section, derived from the pathname and never stored (spec §7.1): `/screen`
 * exactly or anything under `/screen/`. `/screenings` is not the screen section.
 */
export function sectionFor(pathname: string | null): Section {
  if (pathname === '/screen' || pathname?.startsWith('/screen/')) return 'screen';
  return 'books';
}

/** The ScreenSprite nav set (spec §7.1). Settings is shared with books. */
export const SCREEN_NAV_ROUTES: readonly NavRoute[] = [
  { href: '/screen', label: 'For you', Icon: Sparkles, primary: true },
  { href: '/screen/library', label: 'Library', Icon: Clapperboard, primary: true },
  { href: '/screen/profile', label: 'Profile', Icon: User, primary: true },
  { href: '/settings', label: 'Settings', Icon: Settings, primary: false },
] as const;

export function navRoutesFor(section: Section): readonly NavRoute[] {
  return section === 'screen' ? SCREEN_NAV_ROUTES : NAV_ROUTES;
}
```

- [ ] **Step 5: Write `lib/useScreenSettings.ts`**

```ts
'use client';

import useSWR from 'swr';
import { screenApi, SCREEN_SETTINGS_KEY, type ScreenSettings } from '@/lib/api';

/**
 * The reader's ScreenSprite opt-in. `enabled` is false until the settings load, so nothing
 * screen-only flashes onto a book page for a reader who never turned it on.
 */
export function useScreenSettings() {
  const { data, error, isLoading, mutate } = useSWR<ScreenSettings>(SCREEN_SETTINGS_KEY, () =>
    screenApi.settings()
  );
  return { settings: data, enabled: data?.enabled ?? false, isLoading, error, mutate };
}
```

- [ ] **Step 6: Write `components/SectionSwitch.tsx`**

```tsx
'use client';

import Link from 'next/link';
import type { Section } from '@/lib/nav';

const OPTIONS = [
  { section: 'books', href: '/', label: 'Books' },
  { section: 'screen', href: '/screen', label: 'Screen' },
] as const;

/** Books | Screen (spec §7.1, §7.11). Short labels so it fits beside the wordmark at 390 px. */
export default function SectionSwitch({
  active,
  className = '',
}: {
  active: Section;
  className?: string;
}) {
  return (
    <nav
      aria-label="Section"
      className={[
        'inline-flex shrink-0 rounded-lg border border-border bg-elevated p-0.5',
        className,
      ].join(' ')}
    >
      {OPTIONS.map((o) => {
        const current = o.section === active;
        return (
          <Link
            key={o.section}
            href={o.href}
            aria-current={current ? 'true' : undefined}
            className={[
              'rounded-md px-3 py-1.5 text-xs font-semibold transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              current ? 'bg-surface text-text shadow-sm' : 'text-muted hover:text-text',
            ].join(' ')}
          >
            {o.label}
          </Link>
        );
      })}
    </nav>
  );
}
```

- [ ] **Step 7: Write `components/Wordmark.tsx`**

```tsx
import Image from 'next/image';
import BrandLogo from '@/components/BrandLogo';
import type { Section } from '@/lib/nav';

/**
 * The rail and mobile-header wordmark (spec §7.11). In the screen section it is the existing
 * mark plus a "ScreenSprite" text wordmark; a ScreenSprite logo is a follow-up (§12).
 * `compact` narrows the ShelfSprite logo on phones while the section switch shares the header.
 */
export default function Wordmark({ section, compact = false }: { section: Section; compact?: boolean }) {
  if (section === 'screen') {
    return (
      <span className="flex items-center gap-2">
        <Image
          src="/icon.svg"
          alt=""
          width={28}
          height={28}
          priority
          unoptimized
          className="h-7 w-7 rounded-md"
        />
        <span className="font-display text-[17px] font-bold tracking-tight text-text lg:text-xl">
          ScreenSprite
        </span>
      </span>
    );
  }
  return (
    <BrandLogo
      alt=""
      priority
      sizes="170px"
      className={['h-auto lg:w-[170px]', compact ? 'w-[112px]' : 'w-[150px]'].join(' ')}
    />
  );
}
```

`text-[17px]` is deliberate: `text-base` is a colour token in this project and would paint the wordmark in the background colour.

- [ ] **Step 8: Update `components/NavBar.tsx`**

Replace the imports of `NAV_ROUTES` and `BrandLogo` with:

```tsx
import { navRoutesFor, sectionFor } from '@/lib/nav';
import { useScreenSettings } from '@/lib/useScreenSettings';
import SectionSwitch from '@/components/SectionSwitch';
import Wordmark from '@/components/Wordmark';
```

At the top of `NavBar()`, after `const pathname = usePathname();`, add:

```tsx
  const section = sectionFor(pathname);
  const { enabled: screenEnabled } = useScreenSettings();
  const showSwitch = screenEnabled;
```

Replace the home link

```tsx
        <Link href="/" aria-label="ShelfSprite home" className="shrink-0 rounded">
          <BrandLogo alt="" priority sizes="160px" className="h-auto w-[150px] lg:w-[170px]" />
        </Link>
```

with

```tsx
        <Link
          href={section === 'screen' ? '/screen' : '/'}
          aria-label={section === 'screen' ? 'ScreenSprite home' : 'ShelfSprite home'}
          className="shrink-0 rounded"
        >
          <Wordmark section={section} compact={showSwitch} />
        </Link>
        {showSwitch && <SectionSwitch active={section} className="lg:mt-6 lg:self-start" />}
```

In the desktop `<nav>`, replace the eyebrow text `Your reading room` with
`{section === 'screen' ? 'Your screening room' : 'Your reading room'}`, and replace
`NAV_ROUTES.filter((r) => r.primary)` with `navRoutesFor(section).filter((r) => r.primary)`.

Replace the mobile account button's children

```tsx
          <User size={18} aria-hidden="true" /> Account
```

with

```tsx
          <User size={18} aria-hidden="true" />
          <span className={showSwitch ? 'sr-only sm:not-sr-only' : undefined}>Account</span>
```

Nothing else in the file changes. The `<header>` renders the switch once; in the mobile row it sits between the wordmark and the account button, and in the desktop rail (a column) it sits under the wordmark.

- [ ] **Step 9: Update `components/BottomNav.tsx`**

Replace

```tsx
import { NAV_ROUTES } from '@/lib/nav';

const links = NAV_ROUTES.filter((r) => r.primary);
```

with

```tsx
import { navRoutesFor, sectionFor } from '@/lib/nav';
```

and at the top of `BottomNav()`, after `const pathname = usePathname();`, add:

```tsx
  const links = navRoutesFor(sectionFor(pathname)).filter((r) => r.primary);
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `npx jest components/__tests__/nav.test.tsx components/__tests__/sectionNav.test.tsx`
Expected: PASS. The five original route-table tests still pass unchanged.

- [ ] **Step 11: Lint and type-check**

Run: `npx eslint lib/nav.ts lib/useScreenSettings.ts components/NavBar.tsx components/BottomNav.tsx components/SectionSwitch.tsx components/Wordmark.tsx components/__tests__/sectionNav.test.tsx components/__tests__/nav.test.tsx && npm run type-check`
Expected: no errors.

- [ ] **Step 12: Commit**

```bash
git add lib/nav.ts lib/useScreenSettings.ts components/SectionSwitch.tsx components/Wordmark.tsx components/NavBar.tsx components/BottomNav.tsx components/__tests__/nav.test.tsx components/__tests__/sectionNav.test.tsx
git commit -m "feat(screen): Books | Screen switch and section-aware nav (#96)"
```

---

### Task 3: Shared pieces — helpers, cache, tile, attribution, reject picker

**Files:**
- Create: `lib/screen.ts`, `lib/screenCache.ts`, `lib/__tests__/fixtures/screenFixtures.ts`, `components/screen/TitleTile.tsx`, `components/screen/Attribution.tsx`, `components/RejectReasonPicker.tsx`
- Modify: `app/(main)/swipe/page.tsx`, `app/__tests__/rejectModal.test.tsx`
- Test: `lib/__tests__/screen.test.ts`, `lib/__tests__/screenCache.test.ts`, `components/__tests__/TitleTile.test.tsx`, `components/__tests__/Attribution.test.tsx`, `components/__tests__/RejectReasonPicker.test.tsx`

**Interfaces:**
- Consumes: Task 1's types, keys and `ApiRequestError`; `Modal`, `Button` from `@/components/ui`.
- Produces:

```ts
// lib/screen.ts
export type TitleSort = 'recent' | 'title' | 'rating' | 'year';
export const TITLE_SORTS: readonly TitleSort[];
export const TITLE_SORT_LABELS: Record<TitleSort, string>;
export const TITLE_STATUSES: readonly TitleStatus[];
export const TITLE_STATUS_LABELS: Record<TitleStatus, string>;
export function mediaLabel(type: MediaType): 'Film' | 'TV';
export function titleLabel(title: string, year: number | null): string; // 'Heat (1995)' | 'Heat'
export function sortTitles(titles: readonly TitleOut[], sort: TitleSort): TitleOut[];
export function needsCorrection(t: TitleOut): boolean; // enrichment.confidence_label === 'LOW'
export interface TitleRef { id: number; title: string; year: number | null; media_type: MediaType }
export function titleEvidenceMap(titles: readonly TitleOut[]): Map<number, TitleRef>;
export function traitsWarning(p: ScreenOptOutPreview): string;
export function errorMessage(e: unknown, fallback: string): string;
// lib/screenCache.ts
export const SCREEN_STATE_KEYS: readonly string[];
export function invalidateScreenState(): Promise<void>;
export function invalidateTitleEdits(): Promise<void>;
export function handleScreenError(e: unknown): void;
// components/screen/TitleTile.tsx
export default function TitleTile(props: { title: string; year: number | null; mediaType: MediaType; imageUrl: string | null; className?: string; sizes?: string }): JSX.Element;
// components/screen/Attribution.tsx
export function DescriptionSource(props: { source: 'wikipedia' | 'tvmaze' | null; url: string | null; page: string | null }): JSX.Element | null;
export function ScreenCredits(): JSX.Element;
// components/RejectReasonPicker.tsx
export interface RejectReasonPickerProps { labelId: string; heading: string; hint: string; reasons: Record<string, string>; skipLabel: string; onSubmit: (reasons: string[]) => void; onCancel: () => void }
export default function RejectReasonPicker(props: RejectReasonPickerProps): JSX.Element;
// lib/__tests__/fixtures/screenFixtures.ts (tests only)
export function makeTitle(over?: Partial<TitleOut>): TitleOut;
export function makeCandidate(over?: Partial<ScreenCandidate>): ScreenCandidate;
export function makeRec(over?: Partial<TitleRec>): TitleRec;
```

`titleEvidenceMap` returns `TitleRef`, which is structurally identical to wave 1's `TitleEvidence` (`components/profile/TraitRow.tsx`), so the map is passed to `TraitsSection` without a cast and `lib/` never imports from `components/`.

Spec §7.2 (reject picker), §7.7 (invalidation), §7.8 (images), §7.9 (attribution). `ScreenCredits` renders no hooks, so the server layout in Task 5 can render it directly.

- [ ] **Step 1: Write the shared test fixtures**

Create `lib/__tests__/fixtures/screenFixtures.ts` (not a test file: Jest's `testMatch` only picks up `*.test.ts(x)`):

```ts
import type { ScreenCandidate, TitleOut, TitleRec } from '@/lib/api';

/** Synthetic library titles for UI tests. Never a real export. */
export function makeTitle(over: Partial<TitleOut> = {}): TitleOut {
  return {
    id: 1,
    media_type: 'movie',
    title: 'Heat',
    year: 1995,
    status: 'watched',
    rating: 4,
    app_rating: null,
    letterboxd_rating: 4,
    review: null,
    app_review: null,
    letterboxd_review: null,
    last_watched_on: '2026-08-01',
    is_favorite: false,
    exclude_from_profile: false,
    wikidata_qid: 'Q100',
    tvmaze_id: null,
    created_at: '2026-09-01T10:00:00',
    enrichment: {
      confidence_label: 'HIGH',
      resolution_confidence: 0.95,
      match_method: 'title_year',
      identity_source: 'auto',
      image_url: 'https://upload.wikimedia.org/wikipedia/en/0/00/heat.jpg',
      description: 'A crime film about a detective and a thief.',
      description_source: 'wikipedia',
      description_url: 'https://en.wikipedia.org/wiki/Heat_(1995_film)',
      wikipedia_page: 'Heat (1995 film)',
      genres: ['crime film'],
      directors: ['Michael Mann'],
      creators: [],
      duplicate_of_title_id: null,
    },
    ...over,
  };
}

export function makeCandidate(over: Partial<ScreenCandidate> = {}): ScreenCandidate {
  return {
    media_type: 'movie',
    title: 'Heat',
    year: 1995,
    wikidata_qid: 'Q100',
    tvmaze_id: null,
    image_url: null,
    description: 'A crime film.',
    description_source: 'wikipedia',
    description_url: 'https://en.wikipedia.org/wiki/Heat_(1995_film)',
    wikipedia_page: 'Heat (1995 film)',
    genres: ['crime film'],
    directors: ['Michael Mann'],
    creators: [],
    writers: ['Michael Mann'],
    countries: ['United States'],
    original_language: 'en',
    based_on: [],
    main_subjects: [],
    series: [],
    production_companies: [],
    sitelinks: 60,
    ...over,
  };
}

export function makeRec(over: Partial<TitleRec> = {}): TitleRec {
  return {
    id: 1,
    run_id: 'run000000001',
    rank: 1,
    media_type: 'movie',
    media_filter: 'both',
    title: 'Thief',
    year: 1981,
    wikidata_qid: 'Q200',
    tvmaze_id: null,
    image_url: null,
    genres: ['crime film'],
    description: null,
    retrieval_pool: 'metadata',
    seed_reason: null,
    score: 0.9,
    rationale: 'Same patient, procedural tension you rated highly.',
    grounded_trait_ids: [],
    grounded_book_ids: [],
    grounded_title_ids: [],
    status: 'served',
    user_note: null,
    reject_reasons: null,
    created_at: '2026-09-20T10:00:00',
    ...over,
  };
}
```

- [ ] **Step 2: Write the failing helper tests**

Create `lib/__tests__/screen.test.ts`:

```ts
import { makeTitle } from './fixtures/screenFixtures';
import {
  errorMessage,
  needsCorrection,
  sortTitles,
  titleEvidenceMap,
  titleLabel,
  traitsWarning,
} from '@/lib/screen';
import { ApiRequestError } from '@/lib/api';

const a = makeTitle({ id: 1, title: 'Alien', year: 1979, rating: 3, last_watched_on: '2026-01-05' });
const b = makeTitle({ id: 2, title: 'blade Runner', year: 1982, rating: 5, last_watched_on: null, created_at: '2026-03-01T09:00:00' });
const c = makeTitle({ id: 3, title: 'Casablanca', year: null, rating: null, last_watched_on: '2026-02-10' });

const ids = (xs: { id: number }[]) => xs.map((x) => x.id);

describe('sortTitles', () => {
  it('recent: last watched, else the day it was added, newest first', () => {
    expect(ids(sortTitles([a, b, c], 'recent'))).toEqual([2, 3, 1]);
  });
  it('title: case-insensitive A to Z', () => {
    expect(ids(sortTitles([c, b, a], 'title'))).toEqual([1, 2, 3]);
  });
  it('rating: highest first, unrated last', () => {
    expect(ids(sortTitles([c, a, b], 'rating'))).toEqual([2, 1, 3]);
  });
  it('year: newest first, unknown year last', () => {
    expect(ids(sortTitles([c, a, b], 'year'))).toEqual([2, 1, 3]);
  });
  it('does not mutate its input', () => {
    const input = [c, a, b];
    sortTitles(input, 'title');
    expect(ids(input)).toEqual([3, 1, 2]);
  });
});

describe('needsCorrection', () => {
  it('is true only for a LOW match', () => {
    const low = makeTitle();
    low.enrichment!.confidence_label = 'LOW';
    expect(needsCorrection(low)).toBe(true);
    expect(needsCorrection(makeTitle())).toBe(false);
    expect(needsCorrection(makeTitle({ enrichment: null }))).toBe(false);
  });
});

describe('labels', () => {
  it('adds the year when known', () => {
    expect(titleLabel('Heat', 1995)).toBe('Heat (1995)');
    expect(titleLabel('Paprika', null)).toBe('Paprika');
  });

  it('maps titles to evidence refs by id', () => {
    const map = titleEvidenceMap([a, makeTitle({ id: 9, media_type: 'tv', title: 'Severance', year: 2022 })]);
    expect(map.get(9)).toEqual({ id: 9, title: 'Severance', year: 2022, media_type: 'tv' });
    expect(map.size).toBe(2);
  });
});

describe('traitsWarning', () => {
  it('uses the spec 5.7 wording', () => {
    expect(traitsWarning({ traits: 3, confirmed: 1 })).toBe(
      '3 traits drew on your viewing history and will be removed, including 1 you confirmed.'
    );
  });
  it('is singular for one trait and drops a zero confirmed count', () => {
    expect(traitsWarning({ traits: 1, confirmed: 0 })).toBe(
      '1 trait drew on your viewing history and will be removed.'
    );
  });
  it('says so when nothing will be removed', () => {
    expect(traitsWarning({ traits: 0, confirmed: 0 })).toBe(
      'No traits drew on your viewing history, so every trait stays.'
    );
  });
});

describe('errorMessage', () => {
  it('prefers the error message and falls back otherwise', () => {
    expect(errorMessage(new ApiRequestError(409, 'Already there.'), 'x')).toBe('Already there.');
    expect(errorMessage('nope', 'Try again.')).toBe('Try again.');
  });
});
```

Create `lib/__tests__/screenCache.test.ts`:

```ts
import { mutate } from 'swr';
import { ApiRequestError } from '@/lib/api';
import {
  handleScreenError,
  invalidateScreenState,
  invalidateTitleEdits,
  SCREEN_STATE_KEYS,
} from '@/lib/screenCache';

jest.mock('swr', () => ({ __esModule: true, mutate: jest.fn(() => Promise.resolve()) }));
jest.mock('@/utils/supabase/client', () => ({ authEnabled: false, getSupabaseClient: () => null }));

const mutateMock = mutate as unknown as jest.Mock;

beforeEach(() => mutateMock.mockClear());

describe('invalidateScreenState', () => {
  it('covers traits, archetype, reveal, profile status and every screen key but settings', () => {
    expect([...SCREEN_STATE_KEYS].sort()).toEqual(
      [
        'archetype',
        'profile',
        'profile-status',
        'profile-traits',
        'reveal-books',
        'reveal-highlights',
        'reveal-stats',
        'reveal-titles',
        'reveal-traits',
        'screen-enrich-active',
        'screen-recommendations',
        'screen-titles',
      ].sort()
    );
  });

  it('uses the three-argument form for every key', async () => {
    await invalidateScreenState();
    expect(mutateMock).toHaveBeenCalledTimes(SCREEN_STATE_KEYS.length);
    for (const call of mutateMock.mock.calls) {
      expect(call[1]).toBeUndefined();
      expect(call[2]).toEqual({ revalidate: true });
    }
  });
});

describe('invalidateTitleEdits', () => {
  it('revalidates titles and profile status and clears the reveal titles', async () => {
    await invalidateTitleEdits();
    const keys = mutateMock.mock.calls.map((c) => c[0]);
    expect(keys).toEqual(['screen-titles', 'profile-status', 'reveal-titles']);
    expect(mutateMock.mock.calls[2]).toEqual(['reveal-titles', undefined, { revalidate: true }]);
  });
});

describe('handleScreenError', () => {
  it('re-reads the settings on a 403', () => {
    handleScreenError(new ApiRequestError(403, 'ScreenSprite is not enabled for this account.'));
    expect(mutateMock).toHaveBeenCalledWith('screen-settings');
  });
  it('ignores other failures', () => {
    handleScreenError(new ApiRequestError(500, 'boom'));
    handleScreenError(new Error('network'));
    expect(mutateMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx jest lib/__tests__/screen.test.ts lib/__tests__/screenCache.test.ts`
Expected: FAIL — `@/lib/screen` and `@/lib/screenCache` do not exist.

- [ ] **Step 4: Write `lib/screen.ts`**

```ts
import type { MediaType, ScreenOptOutPreview, TitleOut, TitleStatus } from '@/lib/api';

export type TitleSort = 'recent' | 'title' | 'rating' | 'year';
export const TITLE_SORTS: readonly TitleSort[] = ['recent', 'title', 'rating', 'year'];
export const TITLE_SORT_LABELS: Record<TitleSort, string> = {
  recent: 'Recently watched',
  title: 'Title',
  rating: 'Your rating',
  year: 'Release year',
};

export const TITLE_STATUSES: readonly TitleStatus[] = ['watched', 'watching', 'want', 'dropped'];
export const TITLE_STATUS_LABELS: Record<TitleStatus, string> = {
  watched: 'Watched',
  watching: 'Watching',
  want: 'Want to watch',
  dropped: 'Dropped',
};

export function mediaLabel(type: MediaType): 'Film' | 'TV' {
  return type === 'tv' ? 'TV' : 'Film';
}

export function titleLabel(title: string, year: number | null): string {
  return year === null ? title : `${title} (${year})`;
}

function recentKey(t: TitleOut): string {
  // Letterboxd imports share one created_at, so the watch date is the useful signal.
  return t.last_watched_on ?? t.created_at.slice(0, 10);
}

function byName(a: TitleOut, b: TitleOut): number {
  return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
}

/** A new array; an exhaustive switch, which is why useStickySort filters stale keys. */
export function sortTitles(titles: readonly TitleOut[], sort: TitleSort): TitleOut[] {
  const out = [...titles];
  switch (sort) {
    case 'recent':
      return out.sort((a, b) => recentKey(b).localeCompare(recentKey(a)) || byName(a, b));
    case 'title':
      return out.sort((a, b) => byName(a, b) || (a.year ?? 0) - (b.year ?? 0));
    case 'rating':
      return out.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || byName(a, b));
    case 'year':
      return out.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || byName(a, b));
  }
}

/** LOW-confidence matches offer correction (spec §4.4, §7.3). */
export function needsCorrection(t: TitleOut): boolean {
  return t.enrichment?.confidence_label === 'LOW';
}

/** Structurally identical to components/profile/TraitRow.tsx#TitleEvidence. */
export interface TitleRef {
  id: number;
  title: string;
  year: number | null;
  media_type: MediaType;
}

export function titleEvidenceMap(titles: readonly TitleOut[]): Map<number, TitleRef> {
  return new Map(
    titles.map((t) => [t.id, { id: t.id, title: t.title, year: t.year, media_type: t.media_type }])
  );
}

/** The opt-out confirmation (spec §5.7). */
export function traitsWarning({ traits, confirmed }: ScreenOptOutPreview): string {
  if (traits === 0) return 'No traits drew on your viewing history, so every trait stays.';
  const lead = traits === 1 ? '1 trait drew' : `${traits} traits drew`;
  const tail = confirmed > 0 ? `, including ${confirmed} you confirmed.` : '.';
  return `${lead} on your viewing history and will be removed${tail}`;
}

/** An error's message (ApiRequestError carries the server's detail), else the fallback. */
export function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}
```

- [ ] **Step 5: Write `lib/screenCache.ts`**

```ts
import { mutate } from 'swr';
import {
  ApiRequestError,
  ARCHETYPE_KEY,
  PROFILE_STATUS_KEY,
  REVEAL_TITLES_KEY,
  SCREEN_ACTIVE_JOB_KEY,
  SCREEN_RECS_KEY,
  SCREEN_SETTINGS_KEY,
  SCREEN_TITLES_KEY,
  TRAITS_KEY,
} from '@/lib/api';

/**
 * Everything that depends on the screen library or the opt-in (spec §7.7). 'profile' is the
 * swipe page's trait key; the reveal keys are RevealSequence's. The settings key is left out on
 * purpose: callers write the fresh settings they just received instead of blanking them, which
 * would flash the nav switch and the gate.
 */
export const SCREEN_STATE_KEYS: readonly string[] = [
  SCREEN_TITLES_KEY,
  SCREEN_RECS_KEY,
  SCREEN_ACTIVE_JOB_KEY,
  TRAITS_KEY,
  'profile',
  ARCHETYPE_KEY,
  PROFILE_STATUS_KEY,
  'reveal-stats',
  'reveal-traits',
  'reveal-highlights',
  'reveal-books',
  REVEAL_TITLES_KEY,
];

/**
 * After disabling ScreenSprite or deleting its library. Three-argument form: most of these
 * pages are not mounted, and a bare mutate(key) would leave their stale data cached
 * (docs/frontend.md).
 */
export async function invalidateScreenState(): Promise<void> {
  await Promise.all(SCREEN_STATE_KEYS.map((key) => mutate(key, undefined, { revalidate: true })));
}

/**
 * After a title rating, review, favorite, exclusion, correction or removal: the shared profile
 * is dirty now (spec §7.7). Titles and status are subscribed wherever this runs (the page and
 * the app-wide banner), so the bare form revalidates them; the reveal list is not mounted.
 */
export async function invalidateTitleEdits(): Promise<void> {
  await Promise.all([
    mutate(SCREEN_TITLES_KEY),
    mutate(PROFILE_STATUS_KEY),
    mutate(REVEAL_TITLES_KEY, undefined, { revalidate: true }),
  ]);
}

/**
 * SWR onError for screen reads. A 403 means ScreenSprite was turned off (perhaps in another
 * tab): re-read the settings, which the always-mounted NavBar subscribes to, so ScreenGate
 * redirects without a reload.
 */
export function handleScreenError(e: unknown): void {
  if (e instanceof ApiRequestError && e.status === 403) void mutate(SCREEN_SETTINGS_KEY);
}
```

- [ ] **Step 6: Run the helper tests**

Run: `npx jest lib/__tests__/screen.test.ts lib/__tests__/screenCache.test.ts`
Expected: PASS.

- [ ] **Step 7: Write the failing tile and attribution tests**

Create `components/__tests__/TitleTile.test.tsx`:

```tsx
/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import TitleTile from '@/components/screen/TitleTile';

const URL_A = 'https://upload.wikimedia.org/wikipedia/en/0/00/heat.jpg';
const URL_B = 'https://static.tvmaze.com/uploads/images/original_untouched/1/2.jpg';

describe('TitleTile', () => {
  it('hotlinks the poster unchanged', () => {
    render(<TitleTile title="Heat" year={1995} mediaType="movie" imageUrl={URL_A} />);
    expect(screen.getByAltText('Poster for Heat')).toHaveAttribute('src', URL_A);
  });

  it('falls back when the image fails', () => {
    render(<TitleTile title="Heat" year={1995} mediaType="movie" imageUrl={URL_A} />);
    fireEvent.error(screen.getByAltText('Poster for Heat'));
    const tile = screen.getByTestId('title-tile-fallback');
    expect(tile).toHaveTextContent('Heat');
    expect(tile).toHaveTextContent('1995');
    expect(tile).toHaveTextContent('Film');
    expect(screen.queryByAltText('Poster for Heat')).toBeNull();
  });

  it('retries when the url changes', () => {
    const { rerender } = render(
      <TitleTile title="Heat" year={1995} mediaType="movie" imageUrl={URL_A} />
    );
    fireEvent.error(screen.getByAltText('Poster for Heat'));
    rerender(<TitleTile title="Heat" year={1995} mediaType="movie" imageUrl={URL_B} />);
    expect(screen.getByAltText('Poster for Heat')).toHaveAttribute('src', URL_B);
  });

  it('renders the typographic tile when there is no image', () => {
    render(<TitleTile title="Severance" year={null} mediaType="tv" imageUrl={null} />);
    const tile = screen.getByTestId('title-tile-fallback');
    expect(tile).toHaveTextContent('TV');
    expect(tile).toHaveTextContent('Severance');
  });
});
```

Create `components/__tests__/Attribution.test.tsx`:

```tsx
/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import { DescriptionSource, ScreenCredits } from '@/components/screen/Attribution';

describe('DescriptionSource', () => {
  it('names and links the Wikipedia article with its licence', () => {
    render(
      <DescriptionSource
        source="wikipedia"
        url="https://en.wikipedia.org/wiki/Heat_(1995_film)"
        page="Heat (1995 film)"
      />
    );
    expect(screen.getByText(/From Wikipedia/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Heat (1995 film)' })).toHaveAttribute(
      'href',
      'https://en.wikipedia.org/wiki/Heat_(1995_film)'
    );
    expect(screen.getByRole('link', { name: 'CC BY-SA 4.0' })).toHaveAttribute(
      'href',
      'https://creativecommons.org/licenses/by-sa/4.0/'
    );
  });

  it('builds the article link from the page name when the url is missing', () => {
    render(<DescriptionSource source="wikipedia" url={null} page="Heat (1995 film)" />);
    expect(screen.getByRole('link', { name: 'Heat (1995 film)' })).toHaveAttribute(
      'href',
      'https://en.wikipedia.org/wiki/Heat_(1995_film)'
    );
  });

  it('credits TVmaze with a link back', () => {
    render(
      <DescriptionSource source="tvmaze" url="https://www.tvmaze.com/shows/44778/severance" page={null} />
    );
    expect(screen.getByRole('link', { name: 'TVmaze' })).toHaveAttribute(
      'href',
      'https://www.tvmaze.com/shows/44778/severance'
    );
  });

  it('renders nothing without a source', () => {
    const { container } = render(<DescriptionSource source={null} url={null} page={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('ScreenCredits', () => {
  it('credits Wikidata, Wikipedia and TVmaze', () => {
    render(<ScreenCredits />);
    for (const name of ['Wikidata', 'Wikipedia', 'TVmaze']) {
      expect(screen.getByRole('link', { name })).toBeInTheDocument();
    }
  });
});
```

Run: `npx jest --listTests components/__tests__/TitleTile.test.tsx components/__tests__/Attribution.test.tsx`
Expected: both paths print. Then run them: `npx jest components/__tests__/TitleTile.test.tsx components/__tests__/Attribution.test.tsx` — FAIL, the modules do not exist.

- [ ] **Step 8: Write `components/screen/TitleTile.tsx`**

```tsx
'use client';

import Image from 'next/image';
import { useState } from 'react';
import type { MediaType } from '@/lib/api';
import { mediaLabel } from '@/lib/screen';

interface TitleTileProps {
  title: string;
  year: number | null;
  mediaType: MediaType;
  imageUrl: string | null;
  className?: string;
  sizes?: string;
}

/**
 * A poster, hotlinked (spec §7.8): `unoptimized` means the browser loads straight from
 * upload.wikimedia.org or static.tvmaze.com and ShelfSprite never copies or re-encodes the file.
 * It also bypasses the loader's remotePatterns check, which must stay narrow. A missing or failed
 * image falls back to a typographic tile. The failure is remembered per URL, so a corrected
 * title's new poster gets its own try without an effect.
 */
export default function TitleTile({
  title,
  year,
  mediaType,
  imageUrl,
  className = '',
  sizes = '160px',
}: TitleTileProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImage = imageUrl !== null && imageUrl !== '' && failedUrl !== imageUrl;

  return (
    <div
      className={['relative aspect-[2/3] overflow-hidden rounded-lg bg-elevated', className].join(
        ' '
      )}
    >
      {showImage ? (
        <Image
          src={imageUrl}
          alt={`Poster for ${title}`}
          fill
          sizes={sizes}
          unoptimized
          className="object-cover"
          onError={() => setFailedUrl(imageUrl)}
        />
      ) : (
        <div
          data-testid="title-tile-fallback"
          className="flex h-full flex-col justify-between bg-accent-quiet p-3"
        >
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-accent">
            {mediaLabel(mediaType)}
          </span>
          <span className="line-clamp-4 font-display text-lg font-semibold leading-tight text-text">
            {title}
          </span>
          <span className="font-mono text-xs text-muted">{year ?? ''}</span>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 9: Write `components/screen/Attribution.tsx`**

```tsx
const CC_BY_SA = 'https://creativecommons.org/licenses/by-sa/4.0/';
const LINK = 'underline underline-offset-2 hover:text-muted';

function wikipediaUrl(page: string): string {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(page.replace(/ /g, '_'))}`;
}

/**
 * The source line under a description (spec §7.9): Wikipedia names and links the article with
 * CC BY-SA; TVmaze is credited with a link back, which its API terms require.
 */
export function DescriptionSource({
  source,
  url,
  page,
}: {
  source: 'wikipedia' | 'tvmaze' | null;
  url: string | null;
  page: string | null;
}) {
  if (source === 'wikipedia') {
    const href = url ?? (page ? wikipediaUrl(page) : 'https://en.wikipedia.org/');
    return (
      <p className="text-xs text-faint">
        From Wikipedia:{' '}
        <a href={href} target="_blank" rel="noopener noreferrer" className={LINK}>
          {page ?? 'the article'}
        </a>{' '}
        (
        <a href={CC_BY_SA} target="_blank" rel="noopener noreferrer" className={LINK}>
          CC BY-SA 4.0
        </a>
        )
      </p>
    );
  }
  if (source === 'tvmaze') {
    return (
      <p className="text-xs text-faint">
        Summary from{' '}
        <a
          href={url ?? 'https://www.tvmaze.com/'}
          target="_blank"
          rel="noopener noreferrer"
          className={LINK}
        >
          TVmaze
        </a>{' '}
        (
        <a href={CC_BY_SA} target="_blank" rel="noopener noreferrer" className={LINK}>
          CC BY-SA 4.0
        </a>
        )
      </p>
    );
  }
  return null;
}

/** The footer on every /screen page (spec §7.9). No hooks: the server layout renders it. */
export function ScreenCredits() {
  return (
    <footer className="mx-auto mt-12 max-w-[960px] border-t border-border pt-4 text-xs leading-relaxed text-faint">
      Film and TV data from{' '}
      <a href="https://www.wikidata.org/" target="_blank" rel="noopener noreferrer" className={LINK}>
        Wikidata
      </a>{' '}
      (CC0). Descriptions from{' '}
      <a href="https://en.wikipedia.org/" target="_blank" rel="noopener noreferrer" className={LINK}>
        Wikipedia
      </a>{' '}
      and{' '}
      <a href="https://www.tvmaze.com/" target="_blank" rel="noopener noreferrer" className={LINK}>
        TVmaze
      </a>{' '}
      (CC BY-SA 4.0). Posters load directly from those sites.
    </footer>
  );
}
```

- [ ] **Step 10: Run the tile and attribution tests**

Run: `npx jest components/__tests__/TitleTile.test.tsx components/__tests__/Attribution.test.tsx`
Expected: PASS.

- [ ] **Step 11: Mutation-check the fallback**

Temporarily change `failedUrl !== imageUrl` to `true` in `TitleTile.tsx` and re-run the tile test. Expected: `falls back when the image fails` FAILS. Restore it and confirm the file passes.

- [ ] **Step 12: Write the failing picker test**

Create `components/__tests__/RejectReasonPicker.test.tsx`:

```tsx
/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import RejectReasonPicker from '@/components/RejectReasonPicker';

const REASONS = { too_dark: 'Too dark', wrong_vibe: 'Wrong vibe', not_now: 'Not in the mood' };

function renderPicker() {
  const onSubmit = jest.fn();
  const onCancel = jest.fn();
  render(
    <RejectReasonPicker
      labelId="pick-title"
      heading="What missed?"
      hint="Optional."
      reasons={REASONS}
      skipLabel="Skip this one"
      onSubmit={onSubmit}
      onCancel={onCancel}
    />
  );
  return { onSubmit, onCancel };
}

describe('RejectReasonPicker', () => {
  it('is a labelled dialog with one toggle per reason', () => {
    renderPicker();
    expect(screen.getByRole('dialog', { name: 'What missed?' })).toBeInTheDocument();
    for (const label of Object.values(REASONS)) {
      expect(screen.getByRole('button', { name: label })).toHaveAttribute('aria-pressed', 'false');
    }
  });

  it('submits no reasons under the skip label', () => {
    const { onSubmit } = renderPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Skip this one' }));
    expect(onSubmit).toHaveBeenCalledWith([]);
  });

  it('submits the chosen reasons in the order they were picked', () => {
    const { onSubmit } = renderPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Wrong vibe' }));
    fireEvent.click(screen.getByRole('button', { name: 'Too dark' }));
    fireEvent.click(screen.getByRole('button', { name: 'Not in the mood' }));
    fireEvent.click(screen.getByRole('button', { name: 'Not in the mood' }));
    expect(screen.getByRole('button', { name: 'Wrong vibe' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Skip with reason' }));
    expect(onSubmit).toHaveBeenCalledWith(['wrong_vibe', 'too_dark']);
  });

  it('cancels from the button and from Escape', () => {
    const { onCancel, onSubmit } = renderPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
```

Replace the whole of `app/__tests__/rejectModal.test.tsx` with:

```tsx
/**
 * @jest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('reject-reason modal copy', () => {
  it('does not offer two buttons that do the same thing', () => {
    // Guard at the source level: the picker must not render a "Skip" button that shares its
    // handler with the submit button. The modal moved out of the swipe page in wave 8.
    const picker = readFileSync(join(__dirname, '../../components/RejectReasonPicker.tsx'), 'utf8');
    expect(picker.match(/onClick=\{submit\}/g) ?? []).toHaveLength(1);
  });

  it('keeps the swipe page on the shared picker', () => {
    const swipe = readFileSync(join(__dirname, '../(main)/swipe/page.tsx'), 'utf8');
    expect(swipe.match(/<RejectReasonPicker/g) ?? []).toHaveLength(1);
  });
});
```

Run: `npx jest components/__tests__/RejectReasonPicker.test.tsx app/__tests__/rejectModal.test.tsx`
Expected: FAIL — the component does not exist and the swipe page still has its inline modal.

- [ ] **Step 13: Write `components/RejectReasonPicker.tsx`**

```tsx
'use client';

import { useState } from 'react';
import { Button, Modal } from '@/components/ui';

export interface RejectReasonPickerProps {
  labelId: string;
  heading: string;
  hint: string;
  /** key -> label, in display order. */
  reasons: Record<string, string>;
  /** The submit label when no reason is picked. */
  skipLabel: string;
  /** The picked keys, in the order they were picked. */
  onSubmit: (reasons: string[]) => void;
  onCancel: () => void;
}

/**
 * "What missed?" (spec §7.2). Presentational: each caller owns its vocabulary and endpoint.
 * Extracted from the swipe page, whose behavior it keeps exactly.
 */
export default function RejectReasonPicker({
  labelId,
  heading,
  hint,
  reasons,
  skipLabel,
  onSubmit,
  onCancel,
}: RejectReasonPickerProps) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  function submit() {
    onSubmit([...selected]);
  }

  return (
    <Modal
      labelId={labelId}
      onClose={onCancel}
      className="w-full max-w-sm rounded-2xl bg-surface p-6 shadow-xl"
    >
      <p id={labelId} className="mb-1 text-sm font-semibold text-text">
        {heading}
      </p>
      <p className="mb-4 text-xs text-muted">{hint}</p>
      <div className="flex flex-wrap gap-2">
        {Object.entries(reasons).map(([key, label]) => {
          const active = selected.has(key);
          return (
            <button
              key={key}
              type="button"
              aria-pressed={active}
              onClick={() => toggle(key)}
              className={[
                'rounded-full border px-3 py-1 text-xs font-medium transition',
                active
                  ? 'border-accent bg-accent/20 text-accent'
                  : 'border-border bg-base text-muted hover:border-accent hover:text-accent',
              ].join(' ')}
            >
              {label}
            </button>
          );
        })}
      </div>
      <div className="mt-5 flex justify-end gap-3">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={submit}>
          {selected.size > 0 ? 'Skip with reason' : skipLabel}
        </Button>
      </div>
    </Modal>
  );
}
```

The swipe page's buttons had no `type`; the new reason toggles declare `type="button"` and `aria-pressed`, which changes nothing visible (they are not inside a form).

- [ ] **Step 14: Move the swipe page onto the picker**

In `app/(main)/swipe/page.tsx`:

1. In the `@/components/ui` import, remove `Modal`. Add `import RejectReasonPicker from '@/components/RejectReasonPicker';` after the `SwipeCard` import.
2. Delete the state line `const [selectedReasons, setSelectedReasons] = useState<Set<string>>(new Set());`.
3. In `handleDecide`, delete the line `setSelectedReasons(new Set());` inside the `if (status === 'rejected')` branch.
4. Delete the whole `toggleReason` callback.
5. Replace `submitReject` with:

```tsx
  const submitReject = useCallback(
    async (reasons: string[]) => {
      if (pendingRejectId === null) return;
      const recId = pendingRejectId;
      setPendingRejectId(null);
      setDismissed((prev) => new Set([...prev, recId]));
      try {
        await rejectRecWithReasons(recId, reasons);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed to save decision.');
        setDismissed((prev) => {
          const next = new Set(prev);
          next.delete(recId);
          return next;
        });
      }
    },
    [pendingRejectId, toast]
  );
```

6. Replace the whole `{pendingRejectId !== null && ( <Modal … </Modal> )}` block at the end of the JSX with:

```tsx
      {pendingRejectId !== null && (
        <RejectReasonPicker
          labelId="reject-reason-title"
          heading="What missed?"
          hint="Optional. Every reason makes the next batch smarter."
          reasons={REJECT_REASONS}
          skipLabel="Skip this book"
          onSubmit={(reasons) => void submitReject(reasons)}
          onCancel={() => setPendingRejectId(null)}
        />
      )}
```

Run: `grep -n "selectedReasons\|toggleReason\|<Modal" "app/(main)/swipe/page.tsx"`
Expected: no output.

- [ ] **Step 15: Run the picker tests and the whole Jest suite**

Run: `npx jest components/__tests__/RejectReasonPicker.test.tsx app/__tests__/rejectModal.test.tsx`
Expected: PASS.

Run: `npm test 2>&1 | grep -E "^Tests:"`
Expected: all pass (the Task 0 baseline plus this wave's new tests so far).

- [ ] **Step 16: Lint and type-check**

Run: `npx eslint lib/screen.ts lib/screenCache.ts components/screen components/RejectReasonPicker.tsx "app/(main)/swipe/page.tsx" lib/__tests__ components/__tests__ app/__tests__/rejectModal.test.tsx && npm run type-check`
Expected: no errors.

- [ ] **Step 17: Commit**

```bash
git add lib/screen.ts lib/screenCache.ts lib/__tests__/fixtures/screenFixtures.ts lib/__tests__/screen.test.ts lib/__tests__/screenCache.test.ts components/screen/TitleTile.tsx components/screen/Attribution.tsx components/RejectReasonPicker.tsx "app/(main)/swipe/page.tsx" app/__tests__/rejectModal.test.tsx components/__tests__/TitleTile.test.tsx components/__tests__/Attribution.test.tsx components/__tests__/RejectReasonPicker.test.tsx
git commit -m "feat(screen): title tile, attribution, screen cache helpers, shared reject picker (#96)"
```

---

### Task 4: Title modals — detail, search, add, correct

**Files:**
- Create: `components/screen/TitleDetailModal.tsx`, `components/screen/CatalogSearch.tsx`, `components/screen/AddTitleModal.tsx`, `components/screen/CorrectTitleModal.tsx`
- Test: `components/__tests__/TitleDetailModal.test.tsx`, `components/__tests__/TitleSearchModals.test.tsx`

**Interfaces:**
- Consumes: `screenApi.updateTitle`, `deleteTitle`, `search`, `addTitle`, `correctTitle`, and the types (Task 1); `TitleTile`, `DescriptionSource`, `lib/screen.ts` helpers, `invalidateTitleEdits`, fixtures (Task 3); `Modal`, `Button`, `Badge`, `StarRating`, `Input`, `useToast`.
- Produces:

```ts
// components/screen/TitleDetailModal.tsx
export default function TitleDetailModal(props: {
  title: TitleOut;
  duplicateOf: TitleOut | null;
  onClose: () => void;
  onCorrect?: (title: TitleOut) => void;
}): JSX.Element;
// components/screen/CatalogSearch.tsx
export default function CatalogSearch(props: {
  initialQuery?: string;
  initialType?: MediaType;
  pickLabel: string;
  onPick: (c: ScreenCandidate) => void;
  busy?: boolean;
}): JSX.Element;
// components/screen/AddTitleModal.tsx
export default function AddTitleModal(props: { onClose: () => void; onAdded: (t: TitleOut) => void }): JSX.Element;
// components/screen/CorrectTitleModal.tsx
export default function CorrectTitleModal(props: { title: TitleOut; onClose: () => void; onCorrected: (t: TitleOut) => void }): JSX.Element;
```

Spec §3.2 (rating and review rules), §3.5 (manual add), §4.4 (correction), §7.3. The detail modal sends only the fields the reader touched, so a save never writes an untouched Letterboxd value into the in-app columns. A backdrop click with unsaved changes is ignored (`Modal`'s `confirmClose`); Escape and Cancel still close. Search runs on submit only: `GET /api/screen/search` is rate-limited to 30 a minute.

- [ ] **Step 1: Write the failing detail-modal test**

Create `components/__tests__/TitleDetailModal.test.tsx`:

```tsx
/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mutate } from 'swr';
import { ApiRequestError, screenApi, type TitleOut } from '@/lib/api';
import { ToastProvider } from '@/components/ui';
import TitleDetailModal from '@/components/screen/TitleDetailModal';
import { makeTitle } from '@/lib/__tests__/fixtures/screenFixtures';

jest.mock('@/lib/api', () => ({
  ...jest.requireActual('@/lib/api'),
  screenApi: { updateTitle: jest.fn(), deleteTitle: jest.fn() },
}));
jest.mock('swr', () => ({ __esModule: true, default: jest.fn(), mutate: jest.fn(() => Promise.resolve()) }));

const updateTitle = screenApi.updateTitle as jest.Mock;
const deleteTitle = screenApi.deleteTitle as jest.Mock;

function renderModal(
  title: TitleOut,
  opts: { duplicateOf?: TitleOut | null; onCorrect?: (t: TitleOut) => void } = {}
) {
  const onClose = jest.fn();
  render(
    <ToastProvider>
      <TitleDetailModal
        title={title}
        duplicateOf={opts.duplicateOf ?? null}
        onClose={onClose}
        onCorrect={opts.onCorrect}
      />
    </ToastProvider>
  );
  return { onClose };
}

beforeEach(() => {
  updateTitle.mockReset().mockImplementation(async (id: number) => makeTitle({ id }));
  deleteTitle.mockReset().mockResolvedValue({ id: 1, title: 'Heat', removed: true });
  (mutate as jest.Mock).mockClear();
});

describe('TitleDetailModal', () => {
  it('saves only the fields that changed and dirties the profile', async () => {
    const { onClose } = renderModal(makeTitle());
    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), {
      target: { value: 'dropped' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(updateTitle).toHaveBeenCalledWith(1, { status: 'dropped' });
    expect(mutate).toHaveBeenCalledWith('profile-status');
  });

  it('closes without a request when nothing changed', async () => {
    const { onClose } = renderModal(makeTitle());
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(updateTitle).not.toHaveBeenCalled();
  });

  it('sends a new rating', async () => {
    renderModal(makeTitle({ rating: null, letterboxd_rating: null }));
    fireEvent.click(screen.getByRole('radio', { name: '3 stars' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateTitle).toHaveBeenCalledWith(1, { rating: 3 }));
  });

  it('offers the Letterboxd rating back when an in-app rating overrides it', async () => {
    renderModal(makeTitle({ rating: 4.5, app_rating: 4.5, letterboxd_rating: 4 }));
    fireEvent.click(screen.getByRole('button', { name: 'Use my Letterboxd rating' }));
    await waitFor(() => expect(updateTitle).toHaveBeenCalledWith(1, { rating: 0 }));
  });

  it('offers to clear an in-app rating with no Letterboxd rating under it', () => {
    renderModal(makeTitle({ rating: 3, app_rating: 3, letterboxd_rating: null }));
    expect(screen.getByRole('button', { name: 'Clear my rating' })).toBeInTheDocument();
  });

  it('offers no clear button without an in-app rating', () => {
    renderModal(makeTitle());
    expect(screen.queryByRole('button', { name: /Clear my rating|Use my Letterboxd rating/ })).toBeNull();
  });

  it('shows the server detail when a save is refused', async () => {
    updateTitle.mockRejectedValue(
      new ApiRequestError(422, 'A review requires a rating. Rate the title 0.5 to 5 (same update is fine) before saving a review.')
    );
    renderModal(makeTitle({ rating: null, letterboxd_rating: null }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Your review' }), {
      target: { value: 'Tense.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A review requires a rating.');
  });

  it('offers correction only for a LOW match', () => {
    const onCorrect = jest.fn();
    const low = makeTitle();
    low.enrichment!.confidence_label = 'LOW';
    renderModal(low, { onCorrect });
    fireEvent.click(screen.getByRole('button', { name: 'Fix the match' }));
    expect(onCorrect).toHaveBeenCalledWith(low);
  });

  it('hides correction for a confident match', () => {
    renderModal(makeTitle(), { onCorrect: jest.fn() });
    expect(screen.queryByRole('button', { name: 'Fix the match' })).toBeNull();
  });

  it('marks a possible duplicate and removes this one after confirming', async () => {
    const dup = makeTitle({ id: 5 });
    dup.enrichment!.duplicate_of_title_id = 2;
    const { onClose } = renderModal(dup, { duplicateOf: makeTitle({ id: 2 }) });
    expect(screen.getByText('Possible duplicate of Heat (1995)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove this one' }));
    expect(deleteTitle).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm: remove this one' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(deleteTitle).toHaveBeenCalledWith(5);
    expect(mutate).toHaveBeenCalledWith('profile-status');
  });

  it('renders an unenriched title with the fallback tile and no source line', () => {
    renderModal(makeTitle({ enrichment: null }));
    expect(screen.getByTestId('title-tile-fallback')).toBeInTheDocument();
    expect(screen.getByText('No description on file for this one.')).toBeInTheDocument();
    expect(screen.queryByText(/From Wikipedia/)).toBeNull();
  });

  it('credits the description source', () => {
    renderModal(makeTitle());
    expect(screen.getByRole('link', { name: 'Heat (1995 film)' })).toBeInTheDocument();
  });
});
```

Run: `npx jest --listTests components/__tests__/TitleDetailModal.test.tsx` (prints the path), then `npx jest components/__tests__/TitleDetailModal.test.tsx`.
Expected: FAIL — the module does not exist.

- [ ] **Step 2: Write `components/screen/TitleDetailModal.tsx`**

```tsx
'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import { screenApi, type TitleOut, type TitleStatus, type TitleUpdate } from '@/lib/api';
import { Badge, Button, Modal, StarRating, useToast } from '@/components/ui';
import TitleTile from '@/components/screen/TitleTile';
import { DescriptionSource } from '@/components/screen/Attribution';
import {
  errorMessage,
  mediaLabel,
  needsCorrection,
  titleLabel,
  TITLE_STATUSES,
  TITLE_STATUS_LABELS,
} from '@/lib/screen';
import { invalidateTitleEdits } from '@/lib/screenCache';

const LABEL_ID = 'title-detail-modal-title';

interface Props {
  title: TitleOut;
  /** The title this one may duplicate (enrichment.duplicate_of_title_id), when loaded. */
  duplicateOf: TitleOut | null;
  onClose: () => void;
  /** Offered only for LOW-confidence matches (spec §4.4, §7.3). */
  onCorrect?: (title: TitleOut) => void;
}

/**
 * One film or show (spec §7.3). Rating and review semantics are §3.2's: the fields shown are the
 * effective ones (in-app over Letterboxd), a save sends only what the reader touched, rating 0
 * clears only the in-app rating, and an emptied review clears only the in-app review.
 */
export default function TitleDetailModal({ title, duplicateOf, onClose, onCorrect }: Props) {
  const toast = useToast();
  const [status, setStatus] = useState<TitleStatus>(title.status);
  const [rating, setRating] = useState<number>(title.rating ?? 0);
  const [review, setReview] = useState<string>(title.review ?? '');
  const [favorite, setFavorite] = useState(title.is_favorite);
  const [exclude, setExclude] = useState(title.exclude_from_profile);
  const [saving, setSaving] = useState(false);
  const [removeArmed, setRemoveArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enr = title.enrichment;
  const isDuplicate = enr?.duplicate_of_title_id != null;
  const people = title.media_type === 'tv' ? (enr?.creators ?? []) : (enr?.directors ?? []);
  const meta = [
    mediaLabel(title.media_type),
    title.year === null ? null : String(title.year),
    people.slice(0, 2).join(', ') || null,
  ].filter((x): x is string => x !== null);

  function changes(): TitleUpdate {
    const body: TitleUpdate = {};
    if (status !== title.status) body.status = status;
    if (rating !== (title.rating ?? 0)) body.rating = rating;
    if (review.trim() !== (title.review ?? '').trim()) body.review = review.trim();
    if (favorite !== title.is_favorite) body.is_favorite = favorite;
    if (exclude !== title.exclude_from_profile) body.exclude_from_profile = exclude;
    return body;
  }

  async function save() {
    const body = changes();
    if (Object.keys(body).length === 0) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await screenApi.updateTitle(title.id, body);
      await invalidateTitleEdits();
      toast.success('Saved.');
      onClose();
    } catch (e) {
      setError(errorMessage(e, 'That did not save. Try again.'));
    } finally {
      setSaving(false);
    }
  }

  async function clearRating() {
    setSaving(true);
    setError(null);
    try {
      const updated = await screenApi.updateTitle(title.id, { rating: 0 });
      setRating(updated.rating ?? 0);
      await invalidateTitleEdits();
    } catch (e) {
      setError(errorMessage(e, 'The rating did not clear. Try again.'));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setSaving(true);
    setError(null);
    try {
      await screenApi.deleteTitle(title.id);
      await invalidateTitleEdits();
      toast.success(`Removed "${title.title}".`);
      onClose();
    } catch (e) {
      setError(errorMessage(e, 'That did not remove. Try again.'));
      setSaving(false);
    }
  }

  return (
    <Modal
      labelId={LABEL_ID}
      onClose={onClose}
      confirmClose={() => Object.keys(changes()).length === 0}
      className="relative flex max-h-[85vh] w-full max-w-lg flex-col rounded-2xl border border-border bg-surface shadow-xl"
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute right-4 top-4 rounded-full p-1 text-faint hover:bg-elevated hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        <X className="h-4 w-4" />
      </button>

      <div className="overflow-y-auto p-4 sm:p-6">
        <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
          <TitleTile
            title={title.title}
            year={title.year}
            mediaType={title.media_type}
            imageUrl={enr?.image_url ?? null}
            className="w-28 shrink-0"
            sizes="112px"
          />
          <div className="min-w-0 text-center sm:text-left">
            <h2 id={LABEL_ID} className="font-display text-xl font-semibold leading-snug text-text">
              {title.title}
            </h2>
            <p className="mt-1 font-mono text-xs text-faint">{meta.join(' \u00B7 ')}</p>
            {enr && enr.genres.length > 0 && (
              <div className="mt-2 flex flex-wrap justify-center gap-1 sm:justify-start">
                {enr.genres.slice(0, 4).map((g) => (
                  <Badge key={g}>{g}</Badge>
                ))}
              </div>
            )}
            {isDuplicate && (
              <Badge variant="warning" className="mt-2">
                {duplicateOf
                  ? `Possible duplicate of ${titleLabel(duplicateOf.title, duplicateOf.year)}`
                  : 'Possible duplicate'}
              </Badge>
            )}
          </div>
        </div>

        {needsCorrection(title) && onCorrect && (
          <div className="mt-4 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-text">
            <p>
              {`We are not sure we matched the right ${title.media_type === 'tv' ? 'show' : 'film'}.`}
            </p>
            <Button
              size="sm"
              variant="secondary"
              className="mt-2"
              onClick={() => onCorrect(title)}
            >
              Fix the match
            </Button>
          </div>
        )}

        <div className="mt-5 space-y-1">
          {enr?.description ? (
            <>
              <p className="text-sm leading-relaxed text-muted">{enr.description}</p>
              <DescriptionSource
                source={enr.description_source}
                url={enr.description_url}
                page={enr.wikipedia_page}
              />
            </>
          ) : (
            <p className="text-sm italic text-faint">No description on file for this one.</p>
          )}
        </div>

        <div className="mt-6 space-y-4 border-t border-border pt-5">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Status</span>
            <select
              aria-label="Status"
              value={status}
              onChange={(e) => setStatus(e.target.value as TitleStatus)}
              className="w-full rounded-lg border border-border bg-elevated px-3 py-2 text-sm text-text focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
              {TITLE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {TITLE_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </label>

          <div>
            <p className="mb-1 text-xs font-medium text-muted">Your rating</p>
            <div className="flex flex-wrap items-center gap-3">
              <StarRating value={rating} onChange={setRating} allowHalf label="Your rating" />
              {title.app_rating !== null && (
                <button
                  type="button"
                  onClick={() => void clearRating()}
                  disabled={saving}
                  className="text-xs text-muted underline underline-offset-4 hover:text-text disabled:opacity-50"
                >
                  {title.letterboxd_rating !== null ? 'Use my Letterboxd rating' : 'Clear my rating'}
                </button>
              )}
            </div>
          </div>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Your review</span>
            <textarea
              aria-label="Your review"
              value={review}
              onChange={(e) => setReview(e.target.value)}
              rows={3}
              className="w-full rounded-lg border border-border bg-elevated px-3 py-2 text-sm text-text focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            />
            {title.letterboxd_review !== null && (
              <span className="mt-1 block text-xs text-faint">
                Emptying this box brings back your Letterboxd review.
              </span>
            )}
          </label>

          <label className="flex items-center gap-2 text-sm text-text">
            <input
              type="checkbox"
              checked={favorite}
              onChange={(e) => setFavorite(e.target.checked)}
            />
            Favorite
          </label>
          <label className="flex items-start gap-2 text-sm text-text">
            <input
              type="checkbox"
              checked={exclude}
              onChange={(e) => setExclude(e.target.checked)}
              className="mt-1"
            />
            <span>
              Leave out of my taste profile
              <span className="block text-xs text-faint">
                For something you watched for someone else.
              </span>
            </span>
          </label>

          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            {removeArmed ? (
              <Button variant="danger" size="sm" loading={saving} onClick={() => void remove()}>
                {isDuplicate ? 'Confirm: remove this one' : 'Confirm remove'}
              </Button>
            ) : (
              <Button variant="ghost" size="sm" disabled={saving} onClick={() => setRemoveArmed(true)}>
                {isDuplicate ? 'Remove this one' : 'Remove from library'}
              </Button>
            )}
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" disabled={saving} onClick={onClose}>
                Cancel
              </Button>
              <Button size="sm" loading={saving} onClick={() => void save()}>
                Save
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
```

Both selects and the review textarea carry an explicit `aria-label`. A wrapping `<label>` alone would fold the selected option ("Status Watched") or the hint text into the accessible name, and the tests look them up by name.

- [ ] **Step 3: Run the detail-modal test**

Run: `npx jest components/__tests__/TitleDetailModal.test.tsx`
Expected: PASS, 12 tests.

- [ ] **Step 4: Mutation-check "only what changed"**

Temporarily change `if (status !== title.status) body.status = status;` to `body.status = status;` and re-run. Expected: `closes without a request when nothing changed` and `sends a new rating` FAIL. Restore.

- [ ] **Step 5: Write the failing search, add and correct test**

Create `components/__tests__/TitleSearchModals.test.tsx`:

```tsx
/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApiRequestError, screenApi } from '@/lib/api';
import { ToastProvider } from '@/components/ui';
import CatalogSearch from '@/components/screen/CatalogSearch';
import AddTitleModal from '@/components/screen/AddTitleModal';
import CorrectTitleModal from '@/components/screen/CorrectTitleModal';
import { makeCandidate, makeTitle } from '@/lib/__tests__/fixtures/screenFixtures';

jest.mock('@/lib/api', () => ({
  ...jest.requireActual('@/lib/api'),
  screenApi: { search: jest.fn(), addTitle: jest.fn(), correctTitle: jest.fn() },
}));
jest.mock('swr', () => ({ __esModule: true, default: jest.fn(), mutate: jest.fn(() => Promise.resolve()) }));

const search = screenApi.search as jest.Mock;
const addTitle = screenApi.addTitle as jest.Mock;
const correctTitle = screenApi.correctTitle as jest.Mock;

const heat = makeCandidate();

beforeEach(() => {
  search.mockReset().mockResolvedValue([heat]);
  addTitle.mockReset().mockImplementation(async () => makeTitle());
  correctTitle.mockReset().mockImplementation(async () => makeTitle());
});

async function searchFor(q: string) {
  fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: q } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
}

describe('CatalogSearch', () => {
  it('searches the chosen type on submit', async () => {
    const onPick = jest.fn();
    render(<CatalogSearch pickLabel="Add" onPick={onPick} />);
    fireEvent.click(screen.getByRole('radio', { name: 'TV show' }));
    await searchFor('Severance');
    await waitFor(() => expect(search).toHaveBeenCalledWith('Severance', 'tv'));
  });

  it('shows the server detail when the catalog is slow', async () => {
    search.mockRejectedValue(
      new ApiRequestError(503, 'The catalog did not answer in time. Try the search again.')
    );
    render(<CatalogSearch pickLabel="Add" onPick={jest.fn()} />);
    await searchFor('Heat');
    expect(await screen.findByRole('alert')).toHaveTextContent('did not answer in time');
  });

  it('says so when nothing matches', async () => {
    search.mockResolvedValue([]);
    render(<CatalogSearch pickLabel="Add" onPick={jest.fn()} />);
    await searchFor('Qzxv Plumbline Orchard');
    expect(await screen.findByText(/No matches/)).toBeInTheDocument();
  });

  it('hands back the picked candidate unchanged', async () => {
    const onPick = jest.fn();
    render(<CatalogSearch pickLabel="Add" onPick={onPick} />);
    await searchFor('Heat');
    fireEvent.click(await screen.findByRole('button', { name: 'Add: Heat (1995)' }));
    expect(onPick).toHaveBeenCalledWith(heat);
  });
});

function renderAdd() {
  const onAdded = jest.fn();
  render(
    <ToastProvider>
      <AddTitleModal onClose={jest.fn()} onAdded={onAdded} />
    </ToastProvider>
  );
  return { onAdded };
}

async function pickHeat() {
  await searchFor('Heat');
  fireEvent.click(await screen.findByRole('button', { name: 'Add: Heat (1995)' }));
}

describe('AddTitleModal', () => {
  it('adds the pick as watched and unrated by default', async () => {
    const { onAdded } = renderAdd();
    await pickHeat();
    fireEvent.click(screen.getByRole('button', { name: 'Add to library' }));
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect(addTitle).toHaveBeenCalledWith({
      candidate: heat,
      status: 'watched',
      rating: null,
      review: null,
    });
  });

  it('sends the rating and review together', async () => {
    renderAdd();
    await pickHeat();
    fireEvent.click(screen.getByRole('radio', { name: '4 stars' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Review (optional)' }), {
      target: { value: '  Patient and cold.  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add to library' }));
    await waitFor(() =>
      expect(addTitle).toHaveBeenCalledWith(
        expect.objectContaining({ rating: 4, review: 'Patient and cold.' })
      )
    );
  });

  it('asks for a rating before a review, as books do', async () => {
    renderAdd();
    await pickHeat();
    fireEvent.change(screen.getByRole('textbox', { name: 'Review (optional)' }), {
      target: { value: 'Great.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add to library' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A review needs a rating');
    expect(addTitle).not.toHaveBeenCalled();
  });

  it('shows the duplicate message from the server', async () => {
    addTitle.mockRejectedValue(
      new ApiRequestError(409, '"Heat" is already in your ScreenSprite library.')
    );
    renderAdd();
    await pickHeat();
    fireEvent.click(screen.getByRole('button', { name: 'Add to library' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '"Heat" is already in your ScreenSprite library.'
    );
  });
});

describe('CorrectTitleModal', () => {
  it('starts from the title and year and corrects to the pick', async () => {
    const onCorrected = jest.fn();
    const title = makeTitle({ id: 7 });
    render(
      <ToastProvider>
        <CorrectTitleModal title={title} onClose={jest.fn()} onCorrected={onCorrected} />
      </ToastProvider>
    );
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Heat 1995');
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.click(await screen.findByRole('button', { name: 'This one: Heat (1995)' }));
    await waitFor(() => expect(onCorrected).toHaveBeenCalled());
    expect(correctTitle).toHaveBeenCalledWith(7, heat);
  });

  it('shows the clash message from the server', async () => {
    correctTitle.mockRejectedValue(
      new ApiRequestError(409, 'That pick is already in your ScreenSprite library as "Heat".')
    );
    render(
      <ToastProvider>
        <CorrectTitleModal title={makeTitle()} onClose={jest.fn()} onCorrected={jest.fn()} />
      </ToastProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.click(await screen.findByRole('button', { name: 'This one: Heat (1995)' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already in your ScreenSprite library');
  });
});
```

Run: `npx jest --listTests components/__tests__/TitleSearchModals.test.tsx` (prints the path), then run it. Expected: FAIL — the modules do not exist.

- [ ] **Step 6: Write `components/screen/CatalogSearch.tsx`**

```tsx
'use client';

import { useState, type FormEvent } from 'react';
import { screenApi, type MediaType, type ScreenCandidate } from '@/lib/api';
import { Button, Input } from '@/components/ui';
import TitleTile from '@/components/screen/TitleTile';
import { errorMessage, mediaLabel, titleLabel } from '@/lib/screen';

type SearchState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'done'; results: ScreenCandidate[] };

interface Props {
  initialQuery?: string;
  initialType?: MediaType;
  pickLabel: string;
  onPick: (candidate: ScreenCandidate) => void;
  busy?: boolean;
}

/**
 * Catalog search for manual add and correction (spec §3.5, §4.4). Runs on submit only: the
 * route is rate-limited. Results show no description, since a description must carry its
 * source line (§7.9) and a result list has no room for one.
 */
export default function CatalogSearch({
  initialQuery = '',
  initialType = 'movie',
  pickLabel,
  onPick,
  busy = false,
}: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [type, setType] = useState<MediaType>(initialType);
  const [state, setState] = useState<SearchState>({ kind: 'idle' });

  async function submit(e: FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setState({ kind: 'loading' });
    try {
      setState({ kind: 'done', results: await screenApi.search(q, type) });
    } catch (err) {
      setState({ kind: 'error', message: errorMessage(err, 'The search did not finish. Try again.') });
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="space-y-3">
        <div
          role="radiogroup"
          aria-label="Search for"
          className="inline-flex rounded-lg border border-border bg-elevated p-0.5"
        >
          {(['movie', 'tv'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={type === t}
              onClick={() => setType(t)}
              className={[
                'rounded-md px-3 py-1.5 text-xs font-semibold transition-colors',
                type === t ? 'bg-surface text-text shadow-sm' : 'text-muted hover:text-text',
              ].join(' ')}
            >
              {t === 'tv' ? 'TV show' : 'Film'}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <Input
            aria-label="Title"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={type === 'tv' ? 'e.g. Severance' : 'e.g. Heat 1995'}
          />
          <Button
            type="submit"
            loading={state.kind === 'loading'}
            disabled={!query.trim() || state.kind === 'loading'}
          >
            Search
          </Button>
        </div>
      </form>

      {state.kind === 'error' && (
        <p role="alert" className="text-sm text-danger">
          {state.message}
        </p>
      )}
      {state.kind === 'done' && state.results.length === 0 && (
        <p className="text-sm text-muted">No matches. Try the original title, or add the year.</p>
      )}
      {state.kind === 'done' && state.results.length > 0 && (
        <ul className="space-y-3">
          {state.results.map((c) => {
            const label = titleLabel(c.title, c.year);
            const people = (c.media_type === 'tv' ? c.creators : c.directors).slice(0, 2);
            return (
              <li
                key={`${c.wikidata_qid ?? 'none'}-${c.tvmaze_id ?? 'none'}`}
                className="flex items-center gap-3 rounded-lg border border-border p-3"
              >
                <TitleTile
                  title={c.title}
                  year={c.year}
                  mediaType={c.media_type}
                  imageUrl={c.image_url}
                  className="w-12 shrink-0"
                  sizes="48px"
                />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-text">{label}</p>
                  <p className="text-xs text-faint">
                    {[mediaLabel(c.media_type), ...people].join(' \u00B7 ')}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  aria-label={`${pickLabel}: ${label}`}
                  onClick={() => onPick(c)}
                >
                  {pickLabel}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 7: Write `components/screen/AddTitleModal.tsx`**

```tsx
'use client';

import { useState } from 'react';
import { screenApi, type ScreenCandidate, type TitleOut, type TitleStatus } from '@/lib/api';
import { Button, Modal, StarRating, useToast } from '@/components/ui';
import CatalogSearch from '@/components/screen/CatalogSearch';
import TitleTile from '@/components/screen/TitleTile';
import {
  errorMessage,
  mediaLabel,
  titleLabel,
  TITLE_STATUSES,
  TITLE_STATUS_LABELS,
} from '@/lib/screen';
import { invalidateTitleEdits } from '@/lib/screenCache';

const LABEL_ID = 'add-title-heading';

/**
 * Manual add (spec §3.5, decision 16): search, pick, then status and an optional rating. A
 * review needs a rating unless the title was dropped, as for books; the route enforces the same
 * rule and its message wins if the two ever disagree.
 */
export default function AddTitleModal({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (title: TitleOut) => void;
}) {
  const toast = useToast();
  const [picked, setPicked] = useState<ScreenCandidate | null>(null);
  const [status, setStatus] = useState<TitleStatus>('watched');
  const [rating, setRating] = useState(0);
  const [review, setReview] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (!picked) return;
    const text = review.trim();
    if (text && rating === 0 && status !== 'dropped') {
      setError('A review needs a rating. Rate it, or leave the review empty.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const title = await screenApi.addTitle({
        candidate: picked,
        status,
        rating: rating === 0 ? null : rating,
        review: text || null,
      });
      await invalidateTitleEdits();
      toast.success(`Added "${title.title}".`);
      onAdded(title);
    } catch (e) {
      setError(errorMessage(e, 'That did not save. Try again.'));
      setSaving(false);
    }
  }

  return (
    <Modal
      labelId={LABEL_ID}
      onClose={onClose}
      confirmClose={() => picked === null}
      className="relative flex max-h-[85vh] w-full max-w-lg flex-col rounded-2xl border border-border bg-surface shadow-xl"
    >
      <div className="overflow-y-auto p-4 sm:p-6">
        <h2 id={LABEL_ID} className="mb-4 font-display text-xl font-semibold text-text">
          Add a film or show
        </h2>

        {picked === null ? (
          <>
            <CatalogSearch
              pickLabel="Add"
              onPick={(c) => {
                setPicked(c);
                setError(null);
              }}
            />
            <div className="mt-4 flex justify-end">
              <Button variant="ghost" size="sm" onClick={onClose}>
                Cancel
              </Button>
            </div>
          </>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <TitleTile
                title={picked.title}
                year={picked.year}
                mediaType={picked.media_type}
                imageUrl={picked.image_url}
                className="w-12 shrink-0"
                sizes="48px"
              />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-text">{titleLabel(picked.title, picked.year)}</p>
                <p className="text-xs text-faint">{mediaLabel(picked.media_type)}</p>
              </div>
              <Button variant="ghost" size="sm" disabled={saving} onClick={() => setPicked(null)}>
                Change
              </Button>
            </div>

            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">Status</span>
              <select
                aria-label="Status"
                value={status}
                onChange={(e) => setStatus(e.target.value as TitleStatus)}
                className="w-full rounded-lg border border-border bg-elevated px-3 py-2 text-sm text-text"
              >
                {TITLE_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {TITLE_STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </label>

            <div>
              <p className="mb-1 text-xs font-medium text-muted">Rating (optional)</p>
              <StarRating value={rating} onChange={setRating} allowHalf label="Rating" />
            </div>

            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">Review (optional)</span>
              <textarea
                aria-label="Review (optional)"
                value={review}
                onChange={(e) => setReview(e.target.value)}
                rows={3}
                className="w-full rounded-lg border border-border bg-elevated px-3 py-2 text-sm text-text focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              />
            </label>

            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" disabled={saving} onClick={onClose}>
                Cancel
              </Button>
              <Button size="sm" loading={saving} onClick={() => void add()}>
                Add to library
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
```

- [ ] **Step 8: Write `components/screen/CorrectTitleModal.tsx`**

```tsx
'use client';

import { useState } from 'react';
import { screenApi, type ScreenCandidate, type TitleOut } from '@/lib/api';
import { Button, Modal, useToast } from '@/components/ui';
import CatalogSearch from '@/components/screen/CatalogSearch';
import { errorMessage, titleLabel } from '@/lib/screen';
import { invalidateTitleEdits } from '@/lib/screenCache';

const LABEL_ID = 'correct-title-heading';

/**
 * LOW-confidence correction (spec §4.4): the reader picks the right catalog entry. Rating,
 * review and status are untouched; the route marks the match 'corrected', so a later forced
 * enrichment run never re-resolves it.
 */
export default function CorrectTitleModal({
  title,
  onClose,
  onCorrected,
}: {
  title: TitleOut;
  onClose: () => void;
  onCorrected: (title: TitleOut) => void;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(candidate: ScreenCandidate) {
    setSaving(true);
    setError(null);
    try {
      const fixed = await screenApi.correctTitle(title.id, candidate);
      await invalidateTitleEdits();
      toast.success(`Matched to ${titleLabel(candidate.title, candidate.year)}.`);
      onCorrected(fixed);
    } catch (e) {
      setError(errorMessage(e, 'The match did not change. Try again.'));
      setSaving(false);
    }
  }

  return (
    <Modal
      labelId={LABEL_ID}
      onClose={onClose}
      className="relative flex max-h-[85vh] w-full max-w-lg flex-col rounded-2xl border border-border bg-surface shadow-xl"
    >
      <div className="overflow-y-auto p-4 sm:p-6">
        <h2 id={LABEL_ID} className="mb-1 font-display text-xl font-semibold text-text">
          Fix the match
        </h2>
        <p className="mb-4 text-sm text-muted">
          {`Find the right ${title.media_type === 'tv' ? 'show' : 'film'} for ${titleLabel(title.title, title.year)}. Your rating, review and status stay as they are.`}
        </p>
        <CatalogSearch
          initialQuery={title.year === null ? title.title : `${title.title} ${title.year}`}
          initialType={title.media_type}
          pickLabel="This one"
          busy={saving}
          onPick={(c) => void pick(c)}
        />
        {error && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end">
          <Button variant="ghost" size="sm" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}
```

The type toggle starts on the title's current type but stays switchable: a title stored as a film that is really a series (or the reverse) is exactly what correction fixes.

- [ ] **Step 9: Run the search and modal tests**

Run: `npx jest components/__tests__/TitleSearchModals.test.tsx`
Expected: PASS, 10 tests.

- [ ] **Step 10: Lint and type-check**

Run: `npx eslint components/screen components/__tests__/TitleDetailModal.test.tsx components/__tests__/TitleSearchModals.test.tsx && npm run type-check`
Expected: no errors.

- [ ] **Step 11: Commit**

```bash
git add components/screen/TitleDetailModal.tsx components/screen/CatalogSearch.tsx components/screen/AddTitleModal.tsx components/screen/CorrectTitleModal.tsx components/__tests__/TitleDetailModal.test.tsx components/__tests__/TitleSearchModals.test.tsx
git commit -m "feat(screen): title detail, add, search and correction modals (#96)"
```

---

### Task 5: The `/screen` layout, the gate, and the library page

**Files:**
- Create: `components/screen/ScreenGate.tsx`, `app/(main)/screen/layout.tsx`, `app/(main)/screen/library/page.tsx`
- Test: `components/__tests__/ScreenGate.test.tsx`, `app/__tests__/screenLibrary.test.tsx`

**Interfaces:**
- Consumes: `useScreenSettings` (Task 2); `ScreenCredits`, `TitleTile`, `lib/screen.ts`, `handleScreenError`, fixtures (Task 3); the three modals (Task 4); `useStickySort` (`lib/useStickySort.ts`); `PageHeading`.
- Produces:

```ts
// components/screen/ScreenGate.tsx
export default function ScreenGate(props: { children: ReactNode }): JSX.Element;
// app/(main)/screen/layout.tsx
export const metadata: Metadata; // { title: 'ScreenSprite' }
export default function ScreenLayout(props: { children: ReactNode }): JSX.Element;
// app/(main)/screen/library/page.tsx
export default function ScreenLibraryPage(): JSX.Element;
```

Spec §7.1 (redirect), §7.3 (library), §7.9 (footer), §7.11 (title and headings). The layout is a **server** component: it exports `metadata` and renders the client gate. The root layout's title is the plain string `'ShelfSprite'` (no template), so the segment's `'ScreenSprite'` replaces it. `LibraryGate` only gates `/`, `/swipe` and `/library` (`components/LibraryGate.tsx`, the `GATED` set), so a reader with no books reaches every screen page, as the spec requires.

- [ ] **Step 1: Write the failing gate test**

Create `components/__tests__/ScreenGate.test.tsx`:

```tsx
/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import ScreenGate from '@/components/screen/ScreenGate';

const replace = jest.fn();
const retry = jest.fn();
let state: { settings: unknown; error: unknown } = { settings: undefined, error: undefined };

jest.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));
jest.mock('@/lib/useScreenSettings', () => ({
  useScreenSettings: () => ({
    settings: state.settings,
    enabled: (state.settings as { enabled?: boolean } | undefined)?.enabled ?? false,
    isLoading: state.settings === undefined && state.error === undefined,
    error: state.error,
    mutate: retry,
  }),
}));

function renderGate() {
  render(
    <ScreenGate>
      <p>screen page</p>
    </ScreenGate>
  );
}

beforeEach(() => {
  replace.mockClear();
  retry.mockClear();
  state = { settings: undefined, error: undefined };
});

describe('ScreenGate', () => {
  it('redirects a disabled reader to settings', () => {
    state.settings = { enabled: false, toggled_at: null, title_count: 0 };
    renderGate();
    expect(replace).toHaveBeenCalledWith('/settings#screen');
    expect(screen.queryByText('screen page')).toBeNull();
  });

  it('renders the page for an enabled reader', () => {
    state.settings = { enabled: true, toggled_at: null, title_count: 3 };
    renderGate();
    expect(screen.getByText('screen page')).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it('waits while the settings load', () => {
    renderGate();
    expect(screen.queryByText('screen page')).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it('offers a retry when the settings fail to load', () => {
    state.error = new Error('offline');
    renderGate();
    expect(screen.getByRole('alert')).toHaveTextContent('ScreenSprite did not load.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalled();
  });
});
```

Run: `npx jest --listTests components/__tests__/ScreenGate.test.tsx` (prints the path), then `npx jest components/__tests__/ScreenGate.test.tsx`.
Expected: FAIL — the module does not exist.

- [ ] **Step 2: Write `components/screen/ScreenGate.tsx`**

```tsx
'use client';

import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Spinner } from '@/components/ui';
import { useScreenSettings } from '@/lib/useScreenSettings';

/**
 * Every /screen page sits behind the opt-in (spec §7.1): a reader without ScreenSprite goes to
 * the settings card that turns it on. A 403 from any screen read re-reads the settings
 * (lib/screenCache.ts#handleScreenError), so turning ScreenSprite off in another tab lands here
 * too, without a reload.
 */
export default function ScreenGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { settings, error, mutate } = useScreenSettings();
  const disabled = settings !== undefined && !settings.enabled;

  useEffect(() => {
    if (disabled) router.replace('/settings#screen');
  }, [disabled, router]);

  if (settings === undefined && error) {
    return (
      <div role="alert" className="py-24 text-center text-sm text-muted">
        <p>ScreenSprite did not load.</p>
        <Button variant="ghost" size="sm" className="mt-3" onClick={() => void mutate()}>
          Retry
        </Button>
      </div>
    );
  }
  if (settings === undefined || disabled) {
    return (
      <div className="flex justify-center py-24">
        <Spinner size="lg" label="Loading ScreenSprite" />
      </div>
    );
  }
  return <>{children}</>;
}
```

- [ ] **Step 3: Run the gate test**

Run: `npx jest components/__tests__/ScreenGate.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 4: Write `app/(main)/screen/layout.tsx`**

```tsx
import type { Metadata } from 'next';
import ScreenGate from '@/components/screen/ScreenGate';
import { ScreenCredits } from '@/components/screen/Attribution';

export const metadata: Metadata = { title: 'ScreenSprite' };

/**
 * Every /screen page: the ScreenSprite <title> (spec §7.11), the opt-in gate (§7.1), and the
 * source credits (§7.9). Not behind LibraryGate: ScreenSprite needs no books.
 */
export default function ScreenLayout({ children }: { children: React.ReactNode }) {
  return (
    <ScreenGate>
      {children}
      <ScreenCredits />
    </ScreenGate>
  );
}
```

- [ ] **Step 5: Write the failing library-page test**

Create `app/__tests__/screenLibrary.test.tsx`:

```tsx
/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import ScreenLibraryPage from '@/app/(main)/screen/library/page';
import { ToastProvider } from '@/components/ui';
import { handleScreenError } from '@/lib/screenCache';
import type { TitleOut } from '@/lib/api';
import { makeTitle } from '@/lib/__tests__/fixtures/screenFixtures';

let titles: TitleOut[] | undefined;
const configs: Record<string, { onError?: unknown } | undefined> = {};

jest.mock('swr', () => ({
  __esModule: true,
  default: (key: string, _fetcher: unknown, config?: { onError?: unknown }) => {
    configs[key] = config;
    return {
      data: key === 'screen-titles' ? titles : undefined,
      error: undefined,
      isLoading: false,
      mutate: jest.fn(),
    };
  },
  mutate: jest.fn(() => Promise.resolve()),
}));

function renderPage() {
  render(
    <ToastProvider>
      <ScreenLibraryPage />
    </ToastProvider>
  );
}

function gridNames() {
  const grid = screen.getByRole('list', { name: 'Titles' });
  return within(grid)
    .getAllByRole('button')
    .map((b) => b.getAttribute('aria-label'));
}

beforeEach(() => {
  window.localStorage.clear();
  const low = makeTitle({ id: 3, title: 'Alien', year: 1979, status: 'want' });
  low.enrichment!.confidence_label = 'LOW';
  titles = [
    makeTitle({ id: 1, title: 'Heat', year: 1995, status: 'watched' }),
    makeTitle({ id: 2, title: 'Severance', year: 2022, media_type: 'tv', status: 'watching' }),
    low,
  ];
});

describe('/screen/library', () => {
  it('filters by type and by status', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'TV' }));
    expect(gridNames()).toEqual(['Severance (2022)']);
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), {
      target: { value: 'want' },
    });
    expect(gridNames()).toEqual(['Alien (1979), check the match']);
  });

  it('flags titles that need a second look', () => {
    renderPage();
    expect(screen.getByText('Check match')).toBeInTheDocument();
    expect(screen.getByText(/1 title needs a second look/)).toBeInTheDocument();
  });

  it('opens a title', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Heat (1995)' }));
    expect(screen.getByRole('dialog', { name: 'Heat' })).toBeInTheDocument();
  });

  it('shows both ways in when the library is empty', () => {
    titles = [];
    renderPage();
    expect(screen.getByRole('link', { name: 'Import from Letterboxd' })).toHaveAttribute(
      'href',
      '/settings#screen'
    );
    expect(screen.getAllByRole('button', { name: 'Add a title' }).length).toBeGreaterThan(0);
  });

  it('a 403 re-reads the settings', () => {
    renderPage();
    expect(configs['screen-titles']?.onError).toBe(handleScreenError);
  });
});
```

Run: `npx jest --listTests app/__tests__/screenLibrary.test.tsx` (prints the path), then run it.
Expected: FAIL — the page does not exist.

- [ ] **Step 6: Write `app/(main)/screen/library/page.tsx`**

```tsx
'use client';

import { useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { Plus } from 'lucide-react';
import PageHeading from '@/components/PageHeading';
import { Badge, Button, Spinner } from '@/components/ui';
import TitleTile from '@/components/screen/TitleTile';
import TitleDetailModal from '@/components/screen/TitleDetailModal';
import AddTitleModal from '@/components/screen/AddTitleModal';
import CorrectTitleModal from '@/components/screen/CorrectTitleModal';
import {
  screenApi,
  SCREEN_TITLES_KEY,
  type MediaType,
  type TitleOut,
  type TitleStatus,
} from '@/lib/api';
import { handleScreenError } from '@/lib/screenCache';
import {
  errorMessage,
  mediaLabel,
  needsCorrection,
  sortTitles,
  titleLabel,
  TITLE_SORTS,
  TITLE_SORT_LABELS,
  TITLE_STATUSES,
  TITLE_STATUS_LABELS,
  type TitleSort,
} from '@/lib/screen';
import { useStickySort } from '@/lib/useStickySort';

type TypeFilter = 'all' | MediaType;
type StatusFilter = 'all' | TitleStatus;

const TYPE_FILTERS: { value: TypeFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'movie', label: 'Films' },
  { value: 'tv', label: 'TV' },
];

const SELECT =
  'rounded-lg border border-border bg-elevated px-3 py-1.5 text-sm text-text focus:outline-none focus-visible:ring-1 focus-visible:ring-accent';

function tileLabel(t: TitleOut): string {
  return needsCorrection(t)
    ? `${titleLabel(t.title, t.year)}, check the match`
    : titleLabel(t.title, t.year);
}

/** The screen library (spec §7.3): one list, filtered and sorted in the browser. */
export default function ScreenLibraryPage() {
  const {
    data: titles,
    error,
    isLoading,
    mutate,
  } = useSWR<TitleOut[]>(SCREEN_TITLES_KEY, () => screenApi.titles(), {
    onError: handleScreenError,
  });
  const [type, setType] = useState<TypeFilter>('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [sort, setSort] = useStickySort<TitleSort>('screen-library-sort', 'recent', TITLE_SORTS);
  const [openId, setOpenId] = useState<number | null>(null);
  const [correctingId, setCorrectingId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);

  const all = titles ?? [];
  const byId = new Map(all.map((t) => [t.id, t]));
  const visible = sortTitles(
    all.filter(
      (t) => (type === 'all' || t.media_type === type) && (status === 'all' || t.status === status)
    ),
    sort
  );
  const open = openId === null ? null : (byId.get(openId) ?? null);
  const correcting = correctingId === null ? null : (byId.get(correctingId) ?? null);
  const lowCount = all.filter(needsCorrection).length;
  const duplicateOf = (t: TitleOut) => {
    const id = t.enrichment?.duplicate_of_title_id;
    return id == null ? null : (byId.get(id) ?? null);
  };

  return (
    <div className="editorial-page fade-in space-y-6">
      <PageHeading
        eyebrow="Library"
        title="Your ScreenSprite library"
        description="Every film and show you have logged. Rate them, fix a doubtful match, or add what Letterboxd missed."
      >
        <Button onClick={() => setAdding(true)}>
          <Plus size={16} aria-hidden="true" />
          Add a title
        </Button>
      </PageHeading>

      {error && !titles ? (
        <p role="alert" className="text-sm text-danger">
          {errorMessage(error, 'Your screen library did not load.')}{' '}
          <button type="button" className="underline" onClick={() => void mutate()}>
            Retry
          </button>
        </p>
      ) : isLoading && !titles ? (
        <div className="flex justify-center py-16">
          <Spinner size="lg" label="Loading your screen library" />
        </div>
      ) : all.length === 0 ? (
        <div className="rounded-2xl border border-border bg-surface p-8 text-center">
          <p className="font-display text-xl text-text">Nothing here yet.</p>
          <p className="mt-2 text-sm text-muted">
            Import your Letterboxd history, or add a film or show by hand.
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-3">
            <Link
              href="/settings#screen"
              className="inline-flex items-center justify-center rounded-lg bg-accent px-4 py-2 text-sm font-medium text-[color:var(--bg)] hover:bg-accent-hover"
            >
              Import from Letterboxd
            </Link>
            <Button variant="secondary" onClick={() => setAdding(true)}>
              Add a title
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <div
              role="group"
              aria-label="Type"
              className="inline-flex rounded-lg border border-border bg-elevated p-0.5"
            >
              {TYPE_FILTERS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  aria-pressed={type === f.value}
                  onClick={() => setType(f.value)}
                  className={[
                    'rounded-md px-3 py-1.5 text-xs font-semibold transition-colors',
                    type === f.value ? 'bg-surface text-text shadow-sm' : 'text-muted hover:text-text',
                  ].join(' ')}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <select
              aria-label="Status"
              value={status}
              onChange={(e) => setStatus(e.target.value as StatusFilter)}
              className={SELECT}
            >
              <option value="all">Any status</option>
              {TITLE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {TITLE_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
            <select
              aria-label="Sort by"
              value={sort}
              onChange={(e) => setSort(e.target.value as TitleSort)}
              className={SELECT}
            >
              {TITLE_SORTS.map((s) => (
                <option key={s} value={s}>
                  {TITLE_SORT_LABELS[s]}
                </option>
              ))}
            </select>
          </div>

          {lowCount > 0 && (
            <p className="text-xs text-muted">
              {`${lowCount} ${lowCount === 1 ? 'title needs' : 'titles need'} a second look. Open one marked "Check match" to fix it.`}
            </p>
          )}

          {visible.length === 0 ? (
            <p className="py-10 text-center text-sm text-faint">Nothing matches these filters.</p>
          ) : (
            <ul aria-label="Titles" className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
              {visible.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    aria-label={tileLabel(t)}
                    onClick={() => setOpenId(t.id)}
                    className="block w-full rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <TitleTile
                      title={t.title}
                      year={t.year}
                      mediaType={t.media_type}
                      imageUrl={t.enrichment?.image_url ?? null}
                      sizes="(min-width: 1024px) 180px, 45vw"
                    />
                    <span className="mt-2 line-clamp-2 block text-sm font-medium text-text">
                      {t.title}
                    </span>
                    <span className="block font-mono text-xs text-faint">
                      {[
                        mediaLabel(t.media_type),
                        t.year === null ? null : String(t.year),
                        t.rating === null ? null : `${t.rating}\u2605`,
                      ]
                        .filter((x): x is string => x !== null)
                        .join(' \u00B7 ')}
                    </span>
                    {needsCorrection(t) && (
                      <Badge variant="warning" className="mt-1">
                        Check match
                      </Badge>
                    )}
                    {t.enrichment?.duplicate_of_title_id != null && (
                      <Badge variant="warning" className="mt-1">
                        Possible duplicate
                      </Badge>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {open && (
        <TitleDetailModal
          title={open}
          duplicateOf={duplicateOf(open)}
          onClose={() => setOpenId(null)}
          onCorrect={(t) => {
            setOpenId(null);
            setCorrectingId(t.id);
          }}
        />
      )}
      {correcting && (
        <CorrectTitleModal
          title={correcting}
          onClose={() => setCorrectingId(null)}
          onCorrected={() => setCorrectingId(null)}
        />
      )}
      {adding && <AddTitleModal onClose={() => setAdding(false)} onAdded={() => setAdding(false)} />}
    </div>
  );
}
```

The detail modal reads the title from the SWR list by id, so after a save or a correction revalidates, a reopened modal shows the fresh row.

- [ ] **Step 7: Run the library test**

Run: `npx jest app/__tests__/screenLibrary.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 8: Lint, type-check, build**

Run: `npx eslint components/screen/ScreenGate.tsx "app/(main)/screen" components/__tests__/ScreenGate.test.tsx app/__tests__/screenLibrary.test.tsx && npm run type-check && npm run build`
Expected: no errors. The build must list `/screen/library` among the routes; a segment-config or prerender failure here means the server layout is importing something client-only, since the layout renders `ScreenGate` (client) and `ScreenCredits` (no hooks).

- [ ] **Step 9: Commit**

```bash
git add components/screen/ScreenGate.tsx "app/(main)/screen/layout.tsx" "app/(main)/screen/library/page.tsx" components/__tests__/ScreenGate.test.tsx app/__tests__/screenLibrary.test.tsx
git commit -m "feat(screen): /screen layout, opt-in gate and the screen library (#96)"
```

---

### Task 6: For you — `/screen`

**Files:**
- Create: `components/screen/TitleRecCard.tsx`, `app/(main)/screen/page.tsx`
- Modify: `components/BookDetailModal.tsx`
- Test: `components/__tests__/TitleRecCard.test.tsx`, `components/__tests__/BookDetailModal.readOnly.test.tsx`, `app/__tests__/screenForYou.test.tsx`

**Interfaces:**
- Consumes: `screenApi.recommend`, `recommendations`, `recFeedback`, `titles`; `api.profileStatus`, `api.profile`, `api.books`; `SCREEN_RECS_KEY`, `SCREEN_TITLES_KEY`, `TRAITS_KEY`, `BOOKS_ALL_KEY`, `PROFILE_STATUS_KEY`, `SCREEN_REJECT_REASONS` (Task 1); `TitleTile`, `RejectReasonPicker`, `handleScreenError`, `lib/screen.ts` (Task 3); `TitleDetailModal` (Task 4).
- Produces:

```ts
// components/screen/TitleRecCard.tsx
export default function TitleRecCard(props: {
  rec: TitleRec;
  traits: Map<number, Trait>;
  titles: Map<number, TitleOut>;
  books: Map<number, Book>;
  busy: boolean;
  onAccept: () => void;
  onWatched: () => void;
  onReject: () => void;
  onOpenTitle: (t: TitleOut) => void;
  onOpenBook: (b: Book) => void;
}): JSX.Element;
// components/BookDetailModal.tsx: Props gains readOnly?: boolean; onMove and onRemove become optional
// app/(main)/screen/page.tsx
export default function ScreenForYouPage(): JSX.Element;
```

Spec §6.2 (gate), §6.7 (feedback), §7.2. The run is blocked in Home's states with Home's messages (`app/(main)/page.tsx`), pointing at `/screen/profile`. A run that persisted nothing (`run_id` null) leaves the previous run as the latest one, so the page says "Nothing new this time" and labels the cards below as an earlier run; it never presents them as new (issue #64). The server's `note` on an empty run is operator wording ("catalog empty or unreachable?") and is not shown.

The feedback route rejects an empty `reject_reasons` list, so a rejection with no reasons sends `{ status: 'rejected' }` alone. Accepting or marking watched refreshes the title list (a new row may exist); a rejection refreshes profile status (spec §7.7). "Already watched" opens the matched title so the reader can rate it right away.

- [ ] **Step 1: Write the failing card test**

Create `components/__tests__/TitleRecCard.test.tsx`:

```tsx
/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import TitleRecCard from '@/components/screen/TitleRecCard';
import type { Book, TitleOut, TitleRec, Trait } from '@/lib/api';
import { makeRec, makeTitle } from '@/lib/__tests__/fixtures/screenFixtures';

const trait = { id: 5, claim: 'Loves slow-burn procedurals' } as Trait;
const heat = makeTitle({ id: 11 });
const dune = { id: 21, title: 'Dune' } as Book;

function renderCard(rec: TitleRec) {
  const handlers = {
    onAccept: jest.fn(),
    onWatched: jest.fn(),
    onReject: jest.fn(),
    onOpenTitle: jest.fn(),
    onOpenBook: jest.fn(),
  };
  render(
    <TitleRecCard
      rec={rec}
      traits={new Map([[5, trait]])}
      titles={new Map<number, TitleOut>([[11, heat]])}
      books={new Map([[21, dune]])}
      busy={false}
      {...handlers}
    />
  );
  return handlers;
}

describe('TitleRecCard', () => {
  it('links a live trait to the screen profile', () => {
    renderCard(makeRec({ grounded_trait_ids: [5] }));
    expect(screen.getByRole('link', { name: 'Loves slow-burn procedurals' })).toHaveAttribute(
      'href',
      '/screen/profile?trait=5'
    );
  });

  it('opens a live title and a live book', () => {
    const h = renderCard(makeRec({ grounded_title_ids: [11], grounded_book_ids: [21] }));
    fireEvent.click(screen.getByRole('button', { name: 'Film: Heat (1995)' }));
    expect(h.onOpenTitle).toHaveBeenCalledWith(heat);
    fireEvent.click(screen.getByRole('button', { name: 'Dune' }));
    expect(h.onOpenBook).toHaveBeenCalledWith(dune);
  });

  it('renders deleted evidence as plain text', () => {
    renderCard(
      makeRec({ grounded_trait_ids: [99], grounded_title_ids: [98], grounded_book_ids: [97] })
    );
    for (const text of [
      'A trait no longer in your profile',
      'A title no longer in your library',
      'A book no longer in your library',
    ]) {
      expect(screen.getByText(text).closest('a,button')).toBeNull();
    }
  });

  it('offers the three actions while served', () => {
    const h = renderCard(makeRec());
    fireEvent.click(screen.getByRole('button', { name: 'Want to watch' }));
    fireEvent.click(screen.getByRole('button', { name: 'Already watched' }));
    fireEvent.click(screen.getByRole('button', { name: 'Not for me' }));
    expect(h.onAccept).toHaveBeenCalled();
    expect(h.onWatched).toHaveBeenCalled();
    expect(h.onReject).toHaveBeenCalled();
  });

  it('shows the outcome instead of actions once decided', () => {
    renderCard(makeRec({ status: 'accepted' }));
    expect(screen.getByText('On your watchlist')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Want to watch' })).toBeNull();
  });
});
```

Run: `npx jest --listTests components/__tests__/TitleRecCard.test.tsx` (prints the path), then run it. Expected: FAIL — the module does not exist.

- [ ] **Step 2: Write `components/screen/TitleRecCard.tsx`**

```tsx
'use client';

import Link from 'next/link';
import { Film, Tv } from 'lucide-react';
import type { Book, TitleOut, TitleRec, Trait } from '@/lib/api';
import { Button } from '@/components/ui';
import TitleTile from '@/components/screen/TitleTile';
import { mediaLabel, titleLabel } from '@/lib/screen';

const OUTCOME: Record<Exclude<TitleRec['status'], 'served'>, string> = {
  accepted: 'On your watchlist',
  already_watched: 'Marked as watched',
  rejected: 'Skipped',
};

const CHIP = 'inline-flex max-w-full items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs';
const LIVE_CHIP = [
  CHIP,
  'border-border text-muted hover:border-accent hover:text-accent',
  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
].join(' ');
const GONE_CHIP = `${CHIP} border-dashed border-border text-faint`;

interface Props {
  rec: TitleRec;
  traits: Map<number, Trait>;
  titles: Map<number, TitleOut>;
  books: Map<number, Book>;
  busy: boolean;
  onAccept: () => void;
  onWatched: () => void;
  onReject: () => void;
  onOpenTitle: (t: TitleOut) => void;
  onOpenBook: (b: Book) => void;
}

/**
 * One screen recommendation (spec §7.2): tile, type, year, rationale and grounding chips. A
 * trait chip deep-links the profile row (§8); a title chip opens the title; a book chip opens
 * the book read-only. Evidence deleted since the run renders as plain text. No description:
 * the row stores no description source (§7.9).
 */
export default function TitleRecCard({
  rec,
  traits,
  titles,
  books,
  busy,
  onAccept,
  onWatched,
  onReject,
  onOpenTitle,
  onOpenBook,
}: Props) {
  const chipCount =
    rec.grounded_trait_ids.length + rec.grounded_title_ids.length + rec.grounded_book_ids.length;
  const headingId = `rec-${rec.id}-title`;

  return (
    <article
      aria-labelledby={headingId}
      className="flex gap-4 rounded-2xl border border-border bg-surface p-4"
    >
      <TitleTile
        title={rec.title}
        year={rec.year}
        mediaType={rec.media_type}
        imageUrl={rec.image_url}
        className="w-24 shrink-0 sm:w-32"
        sizes="128px"
      />
      <div className="min-w-0 flex-1 space-y-3">
        <div>
          <p className="eyebrow">
            {[mediaLabel(rec.media_type), rec.year === null ? null : String(rec.year)]
              .filter((x): x is string => x !== null)
              .join(' \u00B7 ')}
          </p>
          <h3
            id={headingId}
            className="mt-1 font-display text-xl font-semibold leading-snug text-text"
          >
            {rec.title}
          </h3>
        </div>

        {rec.rationale && <p className="text-sm leading-relaxed text-muted">{rec.rationale}</p>}

        {chipCount > 0 && (
          <ul aria-label="Why this pick" className="flex flex-wrap gap-1.5">
            {rec.grounded_trait_ids.map((id) => {
              const t = traits.get(id);
              return (
                <li key={`trait-${id}`} className="min-w-0 max-w-full">
                  {t ? (
                    <Link href={`/screen/profile?trait=${id}`} className={LIVE_CHIP}>
                      <span className="truncate">{t.claim}</span>
                    </Link>
                  ) : (
                    <span className={GONE_CHIP}>A trait no longer in your profile</span>
                  )}
                </li>
              );
            })}
            {rec.grounded_title_ids.map((id) => {
              const t = titles.get(id);
              return (
                <li key={`title-${id}`}>
                  {t ? (
                    <button type="button" onClick={() => onOpenTitle(t)} className={LIVE_CHIP}>
                      {t.media_type === 'tv' ? (
                        <Tv className="h-3 w-3" aria-hidden="true" />
                      ) : (
                        <Film className="h-3 w-3" aria-hidden="true" />
                      )}
                      <span className="sr-only">{`${mediaLabel(t.media_type)}: `}</span>
                      {titleLabel(t.title, t.year)}
                    </button>
                  ) : (
                    <span className={GONE_CHIP}>A title no longer in your library</span>
                  )}
                </li>
              );
            })}
            {rec.grounded_book_ids.map((id) => {
              const b = books.get(id);
              return (
                <li key={`book-${id}`}>
                  {b ? (
                    <button type="button" onClick={() => onOpenBook(b)} className={LIVE_CHIP}>
                      {b.title}
                    </button>
                  ) : (
                    <span className={GONE_CHIP}>A book no longer in your library</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {rec.status === 'served' ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={onAccept}>
              Want to watch
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={onWatched}>
              Already watched
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={onReject}>
              Not for me
            </Button>
          </div>
        ) : (
          <p className="text-sm font-medium text-accent">{OUTCOME[rec.status]}</p>
        )}
      </div>
    </article>
  );
}
```

- [ ] **Step 3: Run the card test**

Run: `npx jest components/__tests__/TitleRecCard.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 4: Write the failing read-only book-modal test**

Create `components/__tests__/BookDetailModal.readOnly.test.tsx`:

```tsx
/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import BookDetailModal from '@/components/BookDetailModal';
import type { Book } from '@/lib/api';

jest.mock('@/components/SimilarBooksModal', () => ({ __esModule: true, default: () => null }));
jest.mock('@/lib/api', () => ({
  ...jest.requireActual('@/lib/api'),
  api: { bookDescription: jest.fn(async () => ({ description: null })) },
}));

const book = {
  id: 21,
  title: 'Dune',
  author: 'Frank Herbert',
  isbn13: null,
  description: 'A desert planet and the spice that rules it.',
  cover_url: null,
  year_published: 1965,
  page_count: 412,
} as unknown as Book;

const SHELF_ACTIONS = ['Start reading', 'Mark finished', 'Did not finish', 'Remove', 'Find similar reads'];

describe('BookDetailModal', () => {
  it('opens read-only without shelf actions', () => {
    render(<BookDetailModal book={book} readOnly onClose={jest.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Dune' })).toBeInTheDocument();
    expect(screen.getByText('A desert planet and the spice that rules it.')).toBeInTheDocument();
    for (const name of SHELF_ACTIONS) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
  });

  it('keeps its shelf actions for the library', () => {
    const onMove = jest.fn();
    const onClose = jest.fn();
    render(<BookDetailModal book={book} onClose={onClose} onMove={onMove} onRemove={jest.fn()} />);
    for (const name of SHELF_ACTIONS) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole('button', { name: 'Start reading' }));
    expect(onMove).toHaveBeenCalledWith(book, 'currently-reading', false);
    expect(onClose).toHaveBeenCalled();
  });
});
```

Run: `npx jest --listTests components/__tests__/BookDetailModal.readOnly.test.tsx` (prints the path), then run it. Expected: FAIL — `readOnly` is not a prop and the type requires `onMove`/`onRemove` (the type error shows under `npm run type-check`; Jest fails on the shelf buttons still rendering).

- [ ] **Step 5: Add `readOnly` to `components/BookDetailModal.tsx`**

Replace the `Props` interface and the function signature:

```tsx
interface Props {
  book: Book;
  onClose: () => void;
  /** Required unless readOnly. */
  onMove?: (book: Book, shelf: Shelf, thenReview?: boolean) => void;
  onRemove?: (book: Book) => void;
  busy?: boolean;
  /**
   * Screen pages open a cited book with no shelf actions (spec §7.2), so no book page gains or
   * loses a control.
   */
  readOnly?: boolean;
}

const LABEL_ID = 'book-detail-modal-title';

export default function BookDetailModal({
  book,
  onClose,
  onMove,
  onRemove,
  busy = false,
  readOnly = false,
}: Props) {
```

In `handleMove`, change `onMove(book, shelf, thenReview);` to `onMove?.(book, shelf, thenReview);`. In `handleRemove`, change `onRemove(book);` to `onRemove?.(book);`.

Wrap the "Find similar reads" `<button>` in `{!readOnly && ( … )}`, and wrap the whole `{/* Shelf actions */}` `<div className="mt-6 flex flex-wrap gap-2 border-t border-border pt-5"> … </div>` in `{!readOnly && ( … )}`. Nothing else changes; the library page keeps passing all its props.

- [ ] **Step 6: Run the book-modal test**

Run: `npx jest components/__tests__/BookDetailModal.readOnly.test.tsx`
Expected: PASS, 2 tests.

- [ ] **Step 7: Write the failing page test**

Create `app/__tests__/screenForYou.test.tsx`:

```tsx
/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ScreenForYouPage from '@/app/(main)/screen/page';
import { ToastProvider } from '@/components/ui';
import { screenApi, type ProfileStatus, type TitleRec } from '@/lib/api';
import { makeRec, makeTitle } from '@/lib/__tests__/fixtures/screenFixtures';

const OK_STATUS: ProfileStatus = {
  dirty: false,
  changed_books: 0,
  changed_book_ids: [],
  last_profiled_at: '2026-09-20T10:00:00',
  last_profile_kind: 'full',
  rebuild_reason: null,
};

let data: Record<string, unknown> = {};

jest.mock('swr', () => ({
  __esModule: true,
  default: (key: string | null) => ({
    data: key === null ? undefined : data[key],
    error: undefined,
    isLoading: false,
    mutate: jest.fn(() => Promise.resolve()),
  }),
  mutate: jest.fn(() => Promise.resolve()),
}));
jest.mock('@/lib/api', () => ({
  ...jest.requireActual('@/lib/api'),
  screenApi: {
    recommend: jest.fn(),
    recFeedback: jest.fn(),
    recommendations: jest.fn(),
    titles: jest.fn(),
    updateTitle: jest.fn(),
    deleteTitle: jest.fn(),
  },
}));

const recommend = screenApi.recommend as jest.Mock;
const recFeedback = screenApi.recFeedback as jest.Mock;

function renderPage(recs: TitleRec[], status: ProfileStatus = OK_STATUS) {
  data = {
    'profile-status': status,
    'screen-recommendations': recs,
    'profile-traits': [],
    'screen-titles': [],
  };
  render(
    <ToastProvider>
      <ScreenForYouPage />
    </ToastProvider>
  );
}

beforeEach(() => {
  recommend.mockReset();
  recFeedback.mockReset().mockResolvedValue({ id: 1, status: 'rejected', title: null });
});

describe('/screen', () => {
  it('blocks the run without a profile and points at the screen profile', () => {
    renderPage([], { ...OK_STATUS, last_profiled_at: null });
    expect(screen.getByRole('button', { name: 'Find something to watch' })).toBeDisabled();
    expect(screen.getByText(/No taste profile yet/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to profile' })).toHaveAttribute(
      'href',
      '/screen/profile'
    );
  });

  it('blocks the run while the profile is out of date', () => {
    renderPage([], { ...OK_STATUS, dirty: true });
    expect(screen.getByRole('button', { name: 'Find something to watch' })).toBeDisabled();
    expect(screen.getByText(/Your library changed since the last profile build/)).toBeInTheDocument();
  });

  it('says nothing new and labels the earlier run', async () => {
    recommend.mockResolvedValue({ run_id: null, served: 0, media_filter: 'tv', candidates: 0 });
    renderPage([makeRec()]);
    fireEvent.click(screen.getByRole('button', { name: 'TV' }));
    fireEvent.click(screen.getByRole('button', { name: 'Find something to watch' }));
    expect(await screen.findByText(/Nothing new this time/)).toBeInTheDocument();
    expect(recommend).toHaveBeenCalledWith('tv');
    expect(screen.getByText('From an earlier run')).toBeInTheDocument();
  });

  it('rejects without reasons as a bare status, and with reasons as a list', async () => {
    renderPage([makeRec({ id: 1 }), makeRec({ id: 2, title: 'Collateral', year: 2004 })]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Not for me' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Skip this one' }));
    await waitFor(() => expect(recFeedback).toHaveBeenCalledWith(1, { status: 'rejected' }));

    fireEvent.click(screen.getAllByRole('button', { name: 'Not for me' })[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Too long (runtime or seasons)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Skip with reason' }));
    await waitFor(() =>
      expect(recFeedback).toHaveBeenCalledWith(2, {
        status: 'rejected',
        reject_reasons: ['too_long'],
      })
    );
  });

  it('opens the title to rate after Already watched', async () => {
    recFeedback.mockResolvedValue({
      id: 1,
      status: 'already_watched',
      title: makeTitle({ id: 50, title: 'Thief', year: 1981 }),
    });
    renderPage([makeRec()]);
    fireEvent.click(screen.getByRole('button', { name: 'Already watched' }));
    expect(await screen.findByRole('dialog', { name: 'Thief' })).toBeInTheDocument();
    expect(recFeedback).toHaveBeenCalledWith(1, { status: 'already_watched' });
  });
});
```

Run: `npx jest --listTests app/__tests__/screenForYou.test.tsx` (prints the path), then run it. Expected: FAIL — the page does not exist.

- [ ] **Step 8: Write `app/(main)/screen/page.tsx`**

```tsx
'use client';

import { useState } from 'react';
import Link from 'next/link';
import useSWR, { mutate } from 'swr';
import PageHeading from '@/components/PageHeading';
import { Button, Spinner, useToast } from '@/components/ui';
import BookDetailModal from '@/components/BookDetailModal';
import RejectReasonPicker from '@/components/RejectReasonPicker';
import TitleDetailModal from '@/components/screen/TitleDetailModal';
import TitleRecCard from '@/components/screen/TitleRecCard';
import {
  api,
  BOOKS_ALL_KEY,
  PROFILE_STATUS_KEY,
  screenApi,
  SCREEN_RECS_KEY,
  SCREEN_REJECT_REASONS,
  SCREEN_TITLES_KEY,
  TRAITS_KEY,
  type Book,
  type ProfileStatus,
  type ScreenMediaFilter,
  type TitleOut,
  type TitleRec,
  type Trait,
} from '@/lib/api';
import { errorMessage } from '@/lib/screen';
import { handleScreenError } from '@/lib/screenCache';

const FILTERS: { value: ScreenMediaFilter; label: string }[] = [
  { value: 'both', label: 'Both' },
  { value: 'movie', label: 'Movies' },
  { value: 'tv', label: 'TV' },
];

/** For you (spec §7.2): run screen recommendations and act on them. */
export default function ScreenForYouPage() {
  const toast = useToast();
  const [filter, setFilter] = useState<ScreenMediaFilter>('both');
  const [running, setRunning] = useState(false);
  const [emptyRun, setEmptyRun] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [rejectingId, setRejectingId] = useState<number | null>(null);
  const [openTitle, setOpenTitle] = useState<TitleOut | null>(null);
  const [openBook, setOpenBook] = useState<Book | null>(null);

  const {
    data: profileStatus,
    error: profileError,
    mutate: retryProfile,
  } = useSWR<ProfileStatus>(PROFILE_STATUS_KEY, () => api.profileStatus());
  const {
    data: recs,
    error: recsError,
    mutate: mutateRecs,
  } = useSWR<TitleRec[]>(SCREEN_RECS_KEY, () => screenApi.recommendations(), {
    onError: handleScreenError,
  });
  const { data: traits } = useSWR<Trait[]>(TRAITS_KEY, () => api.profile());
  const { data: titles } = useSWR<TitleOut[]>(SCREEN_TITLES_KEY, () => screenApi.titles(), {
    onError: handleScreenError,
  });
  const needsBooks = (recs ?? []).some((r) => r.grounded_book_ids.length > 0);
  const { data: books } = useSWR<Book[]>(needsBooks ? BOOKS_ALL_KEY : null, () =>
    api.books({ limit: 500 })
  );

  // Home's gate and messages (app/(main)/page.tsx), pointed at the screen profile (spec §6.2).
  const noProfile = profileStatus != null && profileStatus.last_profiled_at === null;
  const isDirty = profileStatus?.dirty ?? false;
  const blocked = !profileStatus || noProfile || isDirty;
  const blockMsg = noProfile
    ? 'No taste profile yet. Build one on your profile page first.'
    : isDirty
      ? 'Your library changed since the last profile build. Update it on your profile page.'
      : null;

  const traitMap = new Map((traits ?? []).map((t) => [t.id, t]));
  const titleMap = new Map((titles ?? []).map((t) => [t.id, t]));
  const bookMap = new Map((books ?? []).map((b) => [b.id, b]));
  // Chips resolve against these lists; rendering before they load would call live evidence
  // "no longer in your library" for a moment.
  const evidenceReady =
    traits !== undefined && titles !== undefined && (!needsBooks || books !== undefined);
  const sorted = [...(recs ?? [])].sort((a, b) => a.rank - b.rank);

  async function run() {
    setRunning(true);
    setEmptyRun(false);
    try {
      const result = await screenApi.recommend(filter);
      if (!result.run_id || result.served === 0) {
        // Nothing persisted, so the list below is still the previous run (issue #64).
        setEmptyRun(true);
        return;
      }
      await mutateRecs();
    } catch (e) {
      toast.error(errorMessage(e, 'Recommendations hit a snag. Try again in a moment.'));
    } finally {
      setRunning(false);
    }
  }

  async function decide(rec: TitleRec, status: 'accepted' | 'already_watched') {
    setBusyId(rec.id);
    try {
      const result = await screenApi.recFeedback(rec.id, { status });
      await Promise.all([mutateRecs(), mutate(SCREEN_TITLES_KEY)]);
      if (status === 'already_watched' && result.title) {
        setOpenTitle(result.title);
      } else {
        toast.success(`"${rec.title}" is on your watchlist.`);
      }
    } catch (e) {
      toast.error(errorMessage(e, 'That did not save. Try again.'));
    } finally {
      setBusyId(null);
    }
  }

  async function reject(recId: number, reasons: string[]) {
    setRejectingId(null);
    setBusyId(recId);
    try {
      // The route refuses an empty list, so no reasons means no field.
      await screenApi.recFeedback(
        recId,
        reasons.length > 0 ? { status: 'rejected', reject_reasons: reasons } : { status: 'rejected' }
      );
      await Promise.all([mutateRecs(), mutate(PROFILE_STATUS_KEY)]);
    } catch (e) {
      toast.error(errorMessage(e, 'That did not save. Try again.'));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="editorial-page fade-in space-y-8">
      <PageHeading
        eyebrow="For you"
        title="Your ScreenSprite picks"
        description="Films and shows chosen from your whole taste profile, books included, each with its reason. A run takes a minute or two."
      />

      <section aria-label="Run recommendations" className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <div
            role="group"
            aria-label="What to recommend"
            className="inline-flex rounded-lg border border-border bg-elevated p-0.5"
          >
            {FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                aria-pressed={filter === f.value}
                onClick={() => setFilter(f.value)}
                className={[
                  'rounded-md px-3 py-1.5 text-xs font-semibold transition-colors',
                  filter === f.value
                    ? 'bg-surface text-text shadow-sm'
                    : 'text-muted hover:text-text',
                ].join(' ')}
              >
                {f.label}
              </button>
            ))}
          </div>
          <Button
            size="lg"
            loading={running}
            disabled={running || blocked}
            onClick={() => void run()}
          >
            {running ? 'Choosing carefully\u2026' : 'Find something to watch'}
          </Button>
        </div>
        {blockMsg && (
          <p className="text-sm text-muted">
            {blockMsg}{' '}
            <Link href="/screen/profile" className="underline underline-offset-4">
              Go to profile
            </Link>
          </p>
        )}
        {profileError ? (
          <p className="text-sm text-danger">
            Your profile status did not load.{' '}
            <button type="button" className="underline" onClick={() => void retryProfile()}>
              Retry
            </button>
          </p>
        ) : (
          !profileStatus && (
            <p className="text-sm text-muted" role="status">
              {'Checking your taste profile\u2026'}
            </p>
          )
        )}
        {emptyRun && (
          <p role="status" className="rounded-lg border border-border bg-surface p-3 text-sm text-muted">
            {`Nothing new this time. Try another filter, or run it again later.${sorted.length > 0 ? ' The picks below are from an earlier run.' : ''}`}
          </p>
        )}
      </section>

      {recsError && !recs ? (
        <p role="alert" className="text-sm text-danger">
          {errorMessage(recsError, 'Your picks did not load.')}{' '}
          <button type="button" className="underline" onClick={() => void mutateRecs()}>
            Retry
          </button>
        </p>
      ) : recs === undefined || (sorted.length > 0 && !evidenceReady) ? (
        <div className="flex justify-center py-16">
          <Spinner size="lg" label="Loading your picks" />
        </div>
      ) : sorted.length === 0 ? (
        <p className="py-10 text-center text-sm text-faint">
          No picks yet. Choose Both, Movies or TV and run it.
        </p>
      ) : (
        <section aria-label="Your picks" className="space-y-4">
          {emptyRun && <p className="eyebrow">From an earlier run</p>}
          {sorted.map((rec) => (
            <TitleRecCard
              key={rec.id}
              rec={rec}
              traits={traitMap}
              titles={titleMap}
              books={bookMap}
              busy={busyId === rec.id}
              onAccept={() => void decide(rec, 'accepted')}
              onWatched={() => void decide(rec, 'already_watched')}
              onReject={() => setRejectingId(rec.id)}
              onOpenTitle={setOpenTitle}
              onOpenBook={setOpenBook}
            />
          ))}
        </section>
      )}

      {rejectingId !== null && (
        <RejectReasonPicker
          labelId="screen-reject-title"
          heading="What missed?"
          hint="Optional. Every reason sharpens the next run."
          reasons={SCREEN_REJECT_REASONS}
          skipLabel="Skip this one"
          onSubmit={(reasons) => void reject(rejectingId, reasons)}
          onCancel={() => setRejectingId(null)}
        />
      )}
      {openTitle && (
        <TitleDetailModal
          title={titleMap.get(openTitle.id) ?? openTitle}
          duplicateOf={null}
          onClose={() => setOpenTitle(null)}
        />
      )}
      {openBook && <BookDetailModal book={openBook} readOnly onClose={() => setOpenBook(null)} />}
    </div>
  );
}
```

`TitleDetailModal` gets no `onCorrect` here: correction lives on the library page, and a title the reader just marked watched from a recommendation was matched by its catalog id.

- [ ] **Step 9: Run the page test**

Run: `npx jest app/__tests__/screenForYou.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 10: Mutation-check the empty-run guard**

Temporarily replace `setEmptyRun(true);\n        return;` with `await mutateRecs();` (drop the early return) and re-run. Expected: `says nothing new and labels the earlier run` FAILS. Restore.

- [ ] **Step 11: Lint, type-check, build**

Run: `npx eslint components/screen/TitleRecCard.tsx components/BookDetailModal.tsx "app/(main)/screen/page.tsx" components/__tests__/TitleRecCard.test.tsx components/__tests__/BookDetailModal.readOnly.test.tsx app/__tests__/screenForYou.test.tsx && npm run type-check && npm run build`
Expected: no errors; `/screen` appears in the build's route list.

- [ ] **Step 12: Commit**

```bash
git add components/screen/TitleRecCard.tsx "app/(main)/screen/page.tsx" components/BookDetailModal.tsx components/__tests__/TitleRecCard.test.tsx components/__tests__/BookDetailModal.readOnly.test.tsx app/__tests__/screenForYou.test.tsx
git commit -m "feat(screen): For you page with grounded picks and feedback (#96)"
```

---

### Task 7: One profile view, with films and shows as evidence

**Files:**
- Create: `components/profile/ProfileView.tsx`, `app/(main)/screen/profile/page.tsx`
- Modify: `app/(main)/profile/page.tsx`, `components/profile/TraitRow.tsx`, `lib/revealBeats.ts`, `components/reveal/RevealSequence.tsx`
- Test: `components/__tests__/TraitRow.titles.test.tsx`, `components/__tests__/ProfileView.test.tsx`, `lib/__tests__/revealBeats.titles.test.ts`

**Interfaces:**
- Consumes: wave 1's `TraitsSection` (`titleEvidence?: Map<number, TitleEvidence>`) and `TraitRow` (`TitleEvidence`); `useScreenSettings` (Task 2); `screenApi.titles`, `SCREEN_TITLES_KEY`, `BOOKS_ALL_KEY`, `REVEAL_TITLES_KEY`, `TitleOut`, `Trait.exhibit_title_ids`/`contrast_title_ids` (Task 1); `titleEvidenceMap` (Task 3).
- Produces:

```ts
// components/profile/ProfileView.tsx
export function ProfileView(): JSX.Element;
// lib/revealBeats.ts
export interface BuildBeatsInput { /* existing fields */ titles?: TitleOut[] }
export function titlesSettled(s: {
  screenEnabled: boolean | undefined;
  settingsFailed: boolean;
  titlesLoaded: boolean;
  titlesFailed: boolean;
}): boolean;
```

Spec §7.1 (`/screen/profile` renders the same unified profile), §7.5, §8. Title evidence appears in trait rows and the reveal **only while ScreenSprite is on**: with it off, `ProfileView` fetches no titles and passes no map, so both render exactly as after wave 1. Books come first in every evidence row and titles fill the remaining room under the existing caps (four exhibits, three contrasts in rows; four and one in the reveal), so a book-only trait renders byte-for-byte as before.

The reveal waits for titles only when ScreenSprite is on. A failed settings or titles read counts as settled, so a hiccup degrades to book-only evidence rather than a reveal that never opens.

- [ ] **Step 1: Write the failing `TraitRow` title test**

Create `components/__tests__/TraitRow.titles.test.tsx` (the mocks are wave 1's `TraitRow.test.tsx` mocks):

```tsx
/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import { ToastProvider } from '@/components/ui';
import { TraitRow, type TitleEvidence } from '@/components/profile/TraitRow';
import type { Trait } from '@/lib/api';

jest.mock('@/lib/api', () => ({
  api: { updateTrait: jest.fn() },
  setTraitVerdict: jest.fn(),
  TRAITS_KEY: 'profile-traits',
  PROFILE_STATUS_KEY: 'profile-status',
}));
jest.mock('swr', () => ({ __esModule: true, default: jest.fn(), mutate: jest.fn() }));

function makeTrait(overrides: Partial<Trait> = {}): Trait {
  return {
    id: 7,
    claim: 'Rewards patient, procedural tension',
    reveal_line: null,
    polarity: 'reward',
    exhibits: [1],
    contrasts: [],
    exhibit_title_ids: [11, 12],
    contrast_title_ids: [13],
    inference_confidence: 0.8,
    status: 'proposed',
    user_weight: 1,
    user_note: null,
    created_at: '2026-09-01T00:00:00',
    ...overrides,
  };
}

const bookMap = new Map<number, string>([
  [1, 'The Dispossessed'],
  [2, 'Piranesi'],
  [3, 'Kindred'],
  [4, 'Beloved'],
]);

const titles = new Map<number, TitleEvidence>([
  [11, { id: 11, title: 'Heat', year: 1995, media_type: 'movie' }],
  [12, { id: 12, title: 'Severance', year: 2022, media_type: 'tv' }],
]);

function renderRow(trait: Trait, titleEvidence?: Map<number, TitleEvidence>) {
  render(
    <ToastProvider>
      <TraitRow trait={trait} bookMap={bookMap} open onToggle={jest.fn()} titleEvidence={titleEvidence} />
    </ToastProvider>
  );
}

describe('TraitRow title evidence', () => {
  it('renders cited films and shows after the books, with a marker', () => {
    renderRow(makeTrait(), titles);
    expect(screen.getByText('The Dispossessed')).toBeInTheDocument();
    expect(screen.getByText('Heat (1995)')).toBeInTheDocument();
    expect(screen.getByText('Severance (2022)')).toBeInTheDocument();
    expect(screen.getByText('Film:')).toHaveClass('sr-only');
    expect(screen.getByText('TV:')).toHaveClass('sr-only');
  });

  it('skips a title no longer in the map', () => {
    renderRow(makeTrait(), titles);
    // 13 is the only contrast and it is not in the map, so there is no "unlike" row at all.
    expect(screen.queryByText('unlike')).toBeNull();
  });

  it('stays book-only without the map', () => {
    renderRow(makeTrait());
    expect(screen.getByText('The Dispossessed')).toBeInTheDocument();
    expect(screen.queryByText('Heat (1995)')).toBeNull();
  });

  it('lets books fill the cap first', () => {
    renderRow(makeTrait({ exhibits: [1, 2, 3, 4] }), titles);
    expect(screen.getByText('Beloved')).toBeInTheDocument();
    expect(screen.queryByText('Heat (1995)')).toBeNull();
  });

  it('renders a title-only trait', () => {
    renderRow(makeTrait({ exhibits: [], exhibit_title_ids: [12] }), titles);
    expect(screen.getByText('e.g.')).toBeInTheDocument();
    expect(screen.getByText('Severance (2022)')).toBeInTheDocument();
  });
});
```

Run: `npx jest --listTests components/__tests__/TraitRow.titles.test.tsx` (prints the path), then run it.
Expected: FAIL — no title labels render.

- [ ] **Step 2: Render title evidence in `components/profile/TraitRow.tsx`**

1. Change the lucide import to `import { ChevronDown, Film, Tv } from 'lucide-react';`.
2. Replace the `titleEvidence` prop's doc comment (`/** Wave 8 renders these; this wave only accepts the prop. */`) with `/** Films and shows this trait cites, passed only while ScreenSprite is on (spec §7.5). */`, and the `TitleEvidence` interface's comment with `/** A film or show a trait cites (spec §7.5, §8). */`.
3. Add this component above `export function TraitRow`:

```tsx
function TitleBadge({
  title,
  variant = 'default',
}: {
  title: TitleEvidence;
  variant?: 'default' | 'mono';
}) {
  const Icon = title.media_type === 'tv' ? Tv : Film;
  return (
    <Badge variant={variant} className="inline-flex items-center gap-1">
      <Icon className="h-3 w-3" aria-hidden="true" />
      <span className="sr-only">{title.media_type === 'tv' ? 'TV:' : 'Film:'}</span>
      <span>{title.year === null ? title.title : `${title.title} (${title.year})`}</span>
    </Badge>
  );
}
```

The label sits in its own `<span>` so `getByText('Heat (1995)')` finds an element whose whole text is the label.

4. Change the signature to destructure the prop:

```tsx
export function TraitRow({ trait, bookMap, open, onToggle, titleEvidence }: TraitRowProps) {
```

5. After the `contrastTitles` constant, add:

```tsx
  // Books first, so a book-only trait renders exactly as before; titles fill the same caps.
  const exhibitRefs = (trait.exhibit_title_ids ?? [])
    .map((id) => titleEvidence?.get(id))
    .filter((t): t is TitleEvidence => t !== undefined)
    .slice(0, Math.max(0, 4 - exhibitTitles.length));
  const contrastRefs = (trait.contrast_title_ids ?? [])
    .map((id) => titleEvidence?.get(id))
    .filter((t): t is TitleEvidence => t !== undefined)
    .slice(0, Math.max(0, 3 - contrastTitles.length));
  const hasExhibits = exhibitTitles.length > 0 || exhibitRefs.length > 0;
  const hasContrasts = contrastTitles.length > 0 || contrastRefs.length > 0;
```

6. Replace the evidence block — from `{(exhibitTitles.length > 0 || contrastTitles.length > 0) && (` through its closing `)}` — with:

```tsx
            {(hasExhibits || hasContrasts) && (
              <div className="space-y-1.5">
                {hasExhibits && (
                  <div className="flex flex-wrap gap-1">
                    <span className="mr-1 text-xs text-faint">e.g.</span>
                    {exhibitTitles.slice(0, 4).map((t) => (
                      <Badge key={t} variant="mono">
                        {t}
                      </Badge>
                    ))}
                    {exhibitRefs.map((t) => (
                      <TitleBadge key={`title-${t.id}`} title={t} variant="mono" />
                    ))}
                  </div>
                )}
                {hasContrasts && (
                  <div className="flex flex-wrap gap-1">
                    <span className="mr-1 text-xs text-faint">unlike</span>
                    {contrastTitles.slice(0, 3).map((t) => (
                      <Badge key={t}>{t}</Badge>
                    ))}
                    {contrastRefs.map((t) => (
                      <TitleBadge key={`title-${t.id}`} title={t} />
                    ))}
                  </div>
                )}
              </div>
            )}
```

- [ ] **Step 3: Run both `TraitRow` test files**

Run: `npx jest components/__tests__/TraitRow.titles.test.tsx components/__tests__/TraitRow.test.tsx`
Expected: PASS. Wave 1's `TraitRow.test.tsx` passes unchanged: that is the book-only identity check.

- [ ] **Step 4: Write the failing reveal test**

Create `lib/__tests__/revealBeats.titles.test.ts` (fixtures copied from `lib/__tests__/revealBeats.test.ts`):

```ts
import { buildBeats, titlesSettled, type Beat } from '../revealBeats';
import type { ArchetypeOut, Book, ProfileHighlights, Stats, TitleOut, Trait } from '../api';
import { makeTitle } from './fixtures/screenFixtures';

function trait(over: Partial<Trait>): Trait {
  return {
    id: 1,
    claim: 'c',
    reveal_line: 'You do a thing.',
    polarity: 'reward',
    exhibits: [],
    contrasts: [],
    inference_confidence: 0.8,
    status: 'proposed',
    user_weight: 1,
    user_note: null,
    created_at: '',
    ...over,
  };
}

function axis(score: number, letter: string) {
  return { score, letter, rationale: 'because' };
}

const archetype: ArchetypeOut = {
  code: 'ICDH',
  name: 'The Devoted Fan',
  tagline: 'I live in this world now.',
  hook: 'reread the whole series to get ready for the new one',
  lens: axis(-0.6, 'I'),
  engine: axis(0.7, 'C'),
  range: axis(0.5, 'D'),
  resonance: axis(-0.4, 'H'),
  derived_at: '',
  is_stale: false,
};

const highlights: ProfileHighlights = {
  thin: false,
  n_authors: 40,
  top_genres: [
    { subject: 'Fantasy', share: 0.5 },
    { subject: 'Sci-Fi', share: 0.3 },
  ],
  top_authors: ['Le Guin', 'Mitchell', 'Chekhov'],
  format_mix: {
    novel: 3,
    novella: 1,
    collection: 0,
    series: 6,
    dominant: 'series',
    low_confidence: false,
  },
  era_split: { pre_2000: 10, post_2000: 30 },
};

const stats: Stats = {
  total: 120,
  rated: 100,
  unrated: 20,
  shelves: {},
  mean_rating: 4.3,
  by_star: { '5': 40, '4': 30, '3': 20, '2': 7, '1': 3 },
};

const books = [{ id: 1, title: 'The Dispossessed' } as Book];
const titles: TitleOut[] = [
  makeTitle({ id: 11, title: 'Heat', year: 1995 }),
  makeTitle({ id: 12, title: 'Severance', year: 2022, media_type: 'tv', status: 'dropped' }),
];

function rewardBeat(beats: Beat[]) {
  const beat = beats.find((b) => b.kind === 'reward-trait');
  if (!beat || beat.kind !== 'reward-trait') throw new Error('no reward beat');
  return beat;
}

describe('buildBeats with title evidence', () => {
  const cited = trait({ exhibits: [1], exhibit_title_ids: [11, 12] });

  it('adds cited titles after the books, marked film or TV', () => {
    const beats = buildBeats({ stats, traits: [cited], archetype, highlights, books, titles });
    expect(rewardBeat(beats).exhibitTitles).toEqual([
      'The Dispossessed',
      'Heat (film)',
      'Severance (TV)',
    ]);
  });

  it('is unchanged without titles', () => {
    const beats = buildBeats({ stats, traits: [cited], archetype, highlights, books });
    expect(rewardBeat(beats).exhibitTitles).toEqual(['The Dispossessed']);
  });

  it('reads an aversion with only title evidence from the title', () => {
    const aversion = trait({ id: 2, polarity: 'aversion', exhibits: [], exhibit_title_ids: [12] });
    const beats = buildBeats({ stats, traits: [aversion], archetype, highlights, books, titles });
    const beat = beats.find((b) => b.kind === 'aversions');
    if (!beat || beat.kind !== 'aversions') throw new Error('no aversions beat');
    expect(beat.items[0].evidence).toBe('You never finished Severance (TV). We noticed.');
  });
});

describe('titlesSettled', () => {
  it.each([
    [{ screenEnabled: undefined, settingsFailed: false, titlesLoaded: false, titlesFailed: false }, false],
    [{ screenEnabled: undefined, settingsFailed: true, titlesLoaded: false, titlesFailed: false }, true],
    [{ screenEnabled: false, settingsFailed: false, titlesLoaded: false, titlesFailed: false }, true],
    [{ screenEnabled: true, settingsFailed: false, titlesLoaded: false, titlesFailed: false }, false],
    [{ screenEnabled: true, settingsFailed: false, titlesLoaded: true, titlesFailed: false }, true],
    [{ screenEnabled: true, settingsFailed: false, titlesLoaded: false, titlesFailed: true }, true],
  ])('%o -> %s', (input, expected) => {
    expect(titlesSettled(input)).toBe(expected);
  });
});
```

Run: `npx jest lib/__tests__/revealBeats.titles.test.ts`
Expected: FAIL — `titlesSettled` is not exported and titles are ignored.

- [ ] **Step 5: Extend `lib/revealBeats.ts`**

1. Add `TitleOut` to the type import from `./api`.
2. Add to `BuildBeatsInput`:

```ts
  /** The screen library, passed only while ScreenSprite is on (spec §7.5). */
  titles?: TitleOut[];
```

3. Add below `aversionEvidence`'s current definition, and change `aversionEvidence` as shown:

```ts
/** How a cited film or show reads inside a beat's plain strings. */
function titleEvidenceLabel(t: TitleOut): string {
  return `${t.title} (${t.media_type === 'tv' ? 'TV' : 'film'})`;
}

function titleAversionEvidence(trait: Trait, titleById: Map<number, TitleOut>): string {
  const titleId = (trait.exhibit_title_ids ?? [])[0];
  const t = titleId != null ? titleById.get(titleId) : undefined;
  if (!t) return '';
  const label = titleEvidenceLabel(t);
  if (t.status === 'dropped') return `You never finished ${label}. We noticed.`;
  const stars = t.rating ?? 1;
  return `${label}, ${stars} star${stars === 1 ? '' : 's'}. It did not land.`;
}
```

In `aversionEvidence`, add a third parameter `titleById: Map<number, TitleOut>` and change `if (!book) return '';` to `if (!book) return titleAversionEvidence(trait, titleById);`.

4. In `buildBeats`, after `const title = (id: number) => byId.get(id)?.title;`, add:

```ts
  const titleById = new Map((input.titles ?? []).map((t) => [t.id, t]));
  const screenTitle = (id: number) => {
    const t = titleById.get(id);
    return t ? titleEvidenceLabel(t) : undefined;
  };
```

and change the reward beat's two arrays to:

```ts
      exhibitTitles: [
        ...(t.exhibits ?? []).map(title),
        ...(t.exhibit_title_ids ?? []).map(screenTitle),
      ]
        .filter(Boolean)
        .slice(0, 4) as string[],
      contrastTitles: [
        ...(t.contrasts ?? []).map(title),
        ...(t.contrast_title_ids ?? []).map(screenTitle),
      ]
        .filter(Boolean)
        .slice(0, 1) as string[],
```

and the aversions line to `items: aversions.map((t) => ({ trait: t, evidence: aversionEvidence(t, byId, titleById) })),`.

5. Append:

```ts
/**
 * Whether the reveal may start as far as titles are concerned (spec §7.5): at once while
 * ScreenSprite is off, once the titles load while it is on. A failed settings or titles read
 * counts as settled, so a hiccup degrades to book-only evidence instead of a reveal that never
 * opens.
 */
export function titlesSettled(s: {
  screenEnabled: boolean | undefined;
  settingsFailed: boolean;
  titlesLoaded: boolean;
  titlesFailed: boolean;
}): boolean {
  if (s.screenEnabled === undefined) return s.settingsFailed;
  if (!s.screenEnabled) return true;
  return s.titlesLoaded || s.titlesFailed;
}
```

- [ ] **Step 6: Run both reveal test files**

Run: `npx jest lib/__tests__/revealBeats.titles.test.ts lib/__tests__/revealBeats.test.ts`
Expected: PASS; the existing file passes unchanged.

- [ ] **Step 7: Fetch titles in `components/reveal/RevealSequence.tsx`**

Add to the `@/lib/api` import: `REVEAL_TITLES_KEY`, `screenApi`, `type TitleOut`. Change the `revealBeats` import to `import { buildBeats, titlesSettled, type Beat } from '@/lib/revealBeats';` and add `import { useScreenSettings } from '@/lib/useScreenSettings';`.

After the `directive` SWR line, add:

```tsx
  // Title evidence only while ScreenSprite is on (spec §7.5); see titlesSettled.
  const { settings: screenSettings, error: screenError } = useScreenSettings();
  const screenEnabled = screenSettings?.enabled;
  const { data: titles, error: titlesErr } = useSWR<TitleOut[]>(
    screenEnabled ? REVEAL_TITLES_KEY : null,
    () => screenApi.titles()
  );
  const titlesReady = titlesSettled({
    screenEnabled,
    settingsFailed: screenError !== undefined,
    titlesLoaded: titles !== undefined,
    titlesFailed: titlesErr !== undefined,
  });
```

Change `const ready = stats && traits && archetype && highlights && books;` to

```tsx
  const ready = stats && traits && archetype && highlights && books && titlesReady;
```

and the `buildBeats` call and its dependency list to:

```tsx
    return buildBeats({
      stats,
      traits,
      archetype,
      highlights,
      books,
      directive,
      titles: screenEnabled ? titles : undefined,
    });
  }, [ready, stats, traits, archetype, highlights, books, directive, screenEnabled, titles]);
```

- [ ] **Step 8: Write the failing `ProfileView` test**

Create `components/__tests__/ProfileView.test.tsx`:

```tsx
/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import { ProfileView } from '@/components/profile/ProfileView';
import { ToastProvider } from '@/components/ui';
import type { Trait } from '@/lib/api';
import { makeTitle } from '@/lib/__tests__/fixtures/screenFixtures';

jest.mock('@/components/TasteHero', () => ({ TasteHero: () => <div /> }));
jest.mock('@/components/CustomInstructions', () => ({ __esModule: true, default: () => <div /> }));
jest.mock('@/components/ShelfSprite', () => ({ __esModule: true, default: () => <div /> }));
jest.mock('@/components/reveal/RevealSequence', () => ({ __esModule: true, default: () => null }));
jest.mock('@/hooks/useFeedbackPrompt', () => ({
  useFeedbackPrompt: () => ({ fire: jest.fn(), modal: null }),
}));
jest.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));

const trait: Trait = {
  id: 7,
  claim: 'Rewards patient, procedural tension',
  reveal_line: null,
  polarity: 'reward',
  exhibits: [],
  contrasts: [],
  exhibit_title_ids: [11],
  contrast_title_ids: [],
  inference_confidence: 0.8,
  status: 'proposed',
  user_weight: 1,
  user_note: null,
  created_at: '2026-09-01T00:00:00',
};

let screenEnabled = true;
const requested: (string | null)[] = [];

jest.mock('swr', () => ({
  __esModule: true,
  default: (key: string | null) => {
    requested.push(key);
    const data: Record<string, unknown> = {
      'screen-settings': { enabled: screenEnabled, toggled_at: null, title_count: 1 },
      'screen-titles': [makeTitle({ id: 11, title: 'Heat', year: 1995 })],
      'profile-traits': [trait],
    };
    return { data: key === null ? undefined : data[key], error: undefined, isLoading: false, mutate: jest.fn() };
  },
  mutate: jest.fn(),
}));

function renderView() {
  render(
    <ToastProvider>
      <ProfileView />
    </ToastProvider>
  );
}

beforeEach(() => {
  requested.length = 0;
});

describe('ProfileView', () => {
  it('passes title evidence while ScreenSprite is on', () => {
    screenEnabled = true;
    renderView();
    expect(screen.getByText('Heat (1995)')).toBeInTheDocument();
    expect(screen.getByText(/What your books, films and shows have in common/)).toBeInTheDocument();
  });

  it('stays book-only and fetches no titles while it is off', () => {
    screenEnabled = false;
    renderView();
    expect(screen.queryByText('Heat (1995)')).toBeNull();
    expect(requested).not.toContain('screen-titles');
    expect(screen.getByText(/What your books have in common/)).toBeInTheDocument();
  });
});
```

The trait row is collapsed, but its panel is only `hidden`, and `getByText` does not filter hidden elements.

Run: `npx jest --listTests components/__tests__/ProfileView.test.tsx` (prints the path), then run it. Expected: FAIL — the module does not exist.

- [ ] **Step 9: Move the page body into `components/profile/ProfileView.tsx`**

Create `components/profile/ProfileView.tsx` with the **entire current contents** of `app/(main)/profile/page.tsx` (as wave 1 left it: the import block, the three key constants, `RatingSection`, `GenreSection`, `Skeleton` and `ProfilePage`), then make exactly these edits in the new file:

1. Rename `export default function ProfilePage()` to `export function ProfileView()`.
2. Delete the line `const BOOKS_KEY = 'books-all';` and change `useSWR<Book[]>(BOOKS_KEY,` to `useSWR<Book[]>(BOOKS_ALL_KEY,`.
3. Add `useMemo` to the `react` import. Add `BOOKS_ALL_KEY`, `screenApi`, `SCREEN_TITLES_KEY` and `type TitleOut` to the `@/lib/api` import. Add:

```tsx
import { useScreenSettings } from '@/lib/useScreenSettings';
import { titleEvidenceMap } from '@/lib/screen';
```

4. After the `allBooks` SWR line, add:

```tsx
  const { enabled: screenEnabled } = useScreenSettings();
  const { data: titles } = useSWR<TitleOut[]>(screenEnabled ? SCREEN_TITLES_KEY : null, () =>
    screenApi.titles()
  );
  // Films and shows as evidence only while ScreenSprite is on (spec §7.5). undefined keeps
  // TraitRow and the reveal exactly as they are for a books-only reader.
  const titleEvidence = useMemo(
    () => (screenEnabled && titles ? titleEvidenceMap(titles) : undefined),
    [screenEnabled, titles]
  );
```

5. In `<PageHeading …>`, change the `description` to:

```tsx
        description={
          screenEnabled
            ? 'What your books, films and shows have in common, and what makes a story work for you. Keep the parts that ring true. Correct the rest.'
            : 'What your books have in common, and what makes a story work for you. Keep the parts that ring true. Correct the rest.'
        }
```

6. Change the `<TraitsSection … />` element to pass `titleEvidence={titleEvidence}`.

Then replace the whole of `app/(main)/profile/page.tsx` with:

```tsx
import { ProfileView } from '@/components/profile/ProfileView';

/** The unified taste profile. /screen/profile renders the same view (spec §7.1). */
export default function ProfilePage() {
  return <ProfileView />;
}
```

and create `app/(main)/screen/profile/page.tsx`:

```tsx
import { ProfileView } from '@/components/profile/ProfileView';

/** The same unified taste profile, inside the ScreenSprite section (spec §7.1). */
export default function ScreenProfilePage() {
  return <ProfileView />;
}
```

Both pages are server components rendering the client view (it keeps its `'use client'` line). The `?trait=` watcher inside `TraitsSection` already sits under a `Suspense` boundary (wave 1), so both prerender.

Run: `grep -n "BOOKS_KEY\|export default" components/profile/ProfileView.tsx`
Expected: no output.

- [ ] **Step 10: Run the profile tests**

Run: `npx jest components/__tests__/ProfileView.test.tsx app/__tests__/profileAdminLink.test.tsx components/__tests__/TraitsSection.test.tsx`
Expected: PASS. `profileAdminLink.test.tsx` renders `ProfilePage`, now a thin wrapper, and must pass unchanged.

- [ ] **Step 11: Lint, type-check, build**

Run: `npx eslint components/profile "app/(main)/profile/page.tsx" "app/(main)/screen/profile/page.tsx" lib/revealBeats.ts components/reveal/RevealSequence.tsx components/__tests__/TraitRow.titles.test.tsx components/__tests__/ProfileView.test.tsx lib/__tests__/revealBeats.titles.test.ts && npm run type-check && npm run build`
Expected: no errors; `/screen/profile` and `/profile` both appear in the route list.

- [ ] **Step 12: Commit**

```bash
git add components/profile/ProfileView.tsx components/profile/TraitRow.tsx "app/(main)/profile/page.tsx" "app/(main)/screen/profile/page.tsx" lib/revealBeats.ts components/reveal/RevealSequence.tsx components/__tests__/TraitRow.titles.test.tsx components/__tests__/ProfileView.test.tsx lib/__tests__/revealBeats.titles.test.ts
git commit -m "feat(screen): unified profile view with film and TV evidence (#96)"
```

---

### Task 8: Settings — the ScreenSprite card and the danger zone

**Files:**
- Create: `components/screen/ScreenSettingsCard.tsx`, `components/screen/LetterboxdImportModal.tsx`, `components/screen/ScreenEnrichProgress.tsx`
- Modify: `app/(main)/settings/page.tsx`
- Test: `components/__tests__/ScreenSettingsCard.test.tsx`, `app/__tests__/settingsScreen.test.tsx`

**Interfaces:**
- Consumes: `screenApi.setEnabled`, `optOutPreview`, `importLetterboxd`, `activeJob`, `startEnrich`, `deleteLibrary`; `api.enrichStatus`; `EnrichJobOut`; the screen keys (Task 1); `useScreenSettings` (Task 2); `traitsWarning`, `errorMessage`, `invalidateScreenState` (Task 3).
- Produces:

```ts
export default function ScreenSettingsCard(): JSX.Element;
export default function LetterboxdImportModal(props: { onClose: () => void; onImported: (r: ScreenImportResult) => void }): JSX.Element;
export default function ScreenEnrichProgress(props: { jobId: string; onFinished: (job: EnrichJobOut) => void }): JSX.Element;
```

Spec §3.1 (the first import turns ScreenSprite on), §5.7 (the opt-out warning), §7.4, §7.6, §7.7. The card sits at `<section id="screen">`, which `ScreenGate` redirects to. It shows in every state, because Settings is where ScreenSprite is turned on.

Progress polls the shared `GET /api/enrich/status/{job_id}` every 2 s until the job is `done` or `error`. After a reload, or after the modal closes mid-upload, the card finds the running job through `GET /api/screen/enrich/active` (Review Focus 3). "Retry enrichment" restarts the job without re-importing; the route reuses an active job, so a double click is harmless.

Turning ScreenSprite off asks first, with the §5.7 sentence from `GET /api/settings/screen/opt-out-preview`, and only then sends `PUT {enabled:false}`. The danger zone names the media in each description once the reader has screen data. "Delete screen library" appears when ScreenSprite is on **or** the reader still has titles: the route is deliberately not gated on the opt-in (wave 4), so a reader who turned it off can still remove their viewing history.

- [ ] **Step 1: Confirm SWR accepts a function `refreshInterval`**

Run: `grep -n "refreshInterval" node_modules/swr/dist/_internal/types.d.ts | head -5`
Expected: the option is typed `number | ((latestData: Data | undefined) => number)`. If it is only `number`, stop and report: `ScreenEnrichProgress` depends on it.

- [ ] **Step 2: Write the failing card test**

Create `components/__tests__/ScreenSettingsCard.test.tsx`:

```tsx
/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ScreenSettingsCard from '@/components/screen/ScreenSettingsCard';
import { ToastProvider } from '@/components/ui';
import { ApiRequestError, screenApi, type EnrichJobOut } from '@/lib/api';

let data: Record<string, unknown> = {};

jest.mock('swr', () => ({
  __esModule: true,
  default: (key: string | string[] | null) => ({
    data: key === null ? undefined : data[Array.isArray(key) ? key.join(':') : key],
    error: undefined,
    isLoading: false,
    mutate: jest.fn(() => Promise.resolve()),
  }),
  mutate: jest.fn(() => Promise.resolve()),
}));
jest.mock('@/lib/api', () => ({
  ...jest.requireActual('@/lib/api'),
  screenApi: {
    setEnabled: jest.fn(),
    optOutPreview: jest.fn(),
    importLetterboxd: jest.fn(),
    activeJob: jest.fn(),
    startEnrich: jest.fn(),
  },
}));

const setEnabled = screenApi.setEnabled as jest.Mock;
const optOutPreview = screenApi.optOutPreview as jest.Mock;
const importLetterboxd = screenApi.importLetterboxd as jest.Mock;

function job(over: Partial<EnrichJobOut> = {}): EnrichJobOut {
  return {
    job_id: 'j1',
    status: 'running',
    progress: 4,
    total: 10,
    error: null,
    started_at: '2026-09-22T10:00:00',
    finished_at: null,
    ...over,
  };
}

function renderCard(enabled: boolean, extra: Record<string, unknown> = {}) {
  data = {
    'screen-settings': { enabled, toggled_at: null, title_count: enabled ? 3 : 0 },
    ...extra,
  };
  render(
    <ToastProvider>
      <ScreenSettingsCard />
    </ToastProvider>
  );
}

beforeEach(() => {
  setEnabled.mockReset();
  optOutPreview.mockReset();
  importLetterboxd.mockReset();
});

describe('ScreenSettingsCard', () => {
  it('offers import and opt-in while off', () => {
    renderCard(false);
    expect(screen.getByRole('heading', { name: /ScreenSprite/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import from Letterboxd' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Turn on without importing' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Turn off ScreenSprite' })).toBeNull();
  });

  it('warns before turning off, in the words of spec 5.7', async () => {
    optOutPreview.mockResolvedValue({ traits: 3, confirmed: 1 });
    setEnabled.mockResolvedValue({ enabled: false, toggled_at: null, title_count: 3, traits_removed: 3 });
    renderCard(true);
    fireEvent.click(screen.getByRole('button', { name: 'Turn off ScreenSprite' }));
    expect(
      await screen.findByText(
        '3 traits drew on your viewing history and will be removed, including 1 you confirmed.'
      )
    ).toBeInTheDocument();
    expect(setEnabled).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Turn off ScreenSprite' }));
    await waitFor(() => expect(setEnabled).toHaveBeenCalledWith(false));
  });

  it('keeps ScreenSprite on when the reader backs out', async () => {
    optOutPreview.mockResolvedValue({ traits: 0, confirmed: 0 });
    renderCard(true);
    fireEvent.click(screen.getByRole('button', { name: 'Turn off ScreenSprite' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Keep it on' }));
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it('recovers the running job', () => {
    renderCard(true, {
      'screen-enrich-active': { job: job({ job_id: 'j9' }) },
      'enrich-status:j9': job({ job_id: 'j9' }),
    });
    const bar = screen.getByRole('progressbar', { name: 'Matching your films and shows' });
    expect(bar).toHaveAttribute('aria-valuenow', '40');
    expect(screen.getByText(/Matched 4 of 10/)).toBeInTheDocument();
  });

  it('tracks the job an import starts', async () => {
    importLetterboxd.mockResolvedValue({
      inserted: 5,
      updated: 0,
      unchanged: 0,
      job: job({ job_id: 'j1', status: 'pending', progress: 0, total: 0 }),
    });
    renderCard(false, { 'enrich-status:j1': job({ job_id: 'j1', status: 'pending', progress: 0, total: 0 }) });
    fireEvent.click(screen.getByRole('button', { name: 'Import from Letterboxd' }));
    const file = new File(['PK'], 'letterboxd.zip', { type: 'application/zip' });
    fireEvent.change(screen.getByLabelText('Letterboxd export (.zip)'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByRole('progressbar')).toBeInTheDocument();
    expect(importLetterboxd).toHaveBeenCalledWith(file);
    expect(screen.getByText(/Getting ready to match your titles/)).toBeInTheDocument();
  });

  it('shows why an import was refused', async () => {
    importLetterboxd.mockRejectedValue(
      new ApiRequestError(422, 'That ZIP has no watched.csv. Upload the export exactly as Letterboxd sent it.')
    );
    renderCard(false);
    fireEvent.click(screen.getByRole('button', { name: 'Import from Letterboxd' }));
    const file = new File(['PK'], 'other.zip', { type: 'application/zip' });
    fireEvent.change(screen.getByLabelText('Letterboxd export (.zip)'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That ZIP has no watched.csv.');
  });
});
```

The 422 message in the last test is illustrative; the component shows whatever `detail` the route sends.

Run: `npx jest --listTests components/__tests__/ScreenSettingsCard.test.tsx` (prints the path), then run it. Expected: FAIL — the modules do not exist.

- [ ] **Step 3: Write `components/screen/ScreenEnrichProgress.tsx`**

```tsx
'use client';

import { useEffect, useRef } from 'react';
import useSWR from 'swr';
import { api, type EnrichJobOut } from '@/lib/api';

const POLL_MS = 2_000;

function isFinal(job: EnrichJobOut | undefined): boolean {
  return job?.status === 'done' || job?.status === 'error';
}

/**
 * The screen job's progress (spec §7.4). Polls the shared job-status route until the job
 * finishes. Progress is the server's recount of persisted rows (CLAUDE.md), so a reload
 * resumes at the right number.
 */
export default function ScreenEnrichProgress({
  jobId,
  onFinished,
}: {
  jobId: string;
  onFinished: (job: EnrichJobOut) => void;
}) {
  const { data: job, error } = useSWR<EnrichJobOut>(
    ['enrich-status', jobId],
    () => api.enrichStatus(jobId),
    { refreshInterval: (latest) => (isFinal(latest) ? 0 : POLL_MS) }
  );
  const reported = useRef<string | null>(null);

  useEffect(() => {
    if (job && isFinal(job) && reported.current !== job.job_id) {
      reported.current = job.job_id;
      onFinished(job);
    }
  }, [job, onFinished]);

  if (error && !job) {
    return (
      <p className="text-sm text-muted">
        Progress did not load. Matching keeps running; reload to check again.
      </p>
    );
  }

  const total = job?.total ?? 0;
  const progress = job?.progress ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((progress / total) * 100)) : 0;
  const line = !job
    ? 'Checking progress\u2026'
    : job.status === 'done'
      ? `Done. Matched ${progress} of ${total}.`
      : job.status === 'error'
        ? `Matching stopped (${job.error ?? 'unknown error'}). Retry enrichment to pick up where it left off.`
        : total === 0
          ? 'Getting ready to match your titles\u2026'
          : `Matched ${progress} of ${total}\u2026`;

  return (
    <div className="space-y-2">
      <div
        role="progressbar"
        aria-label="Matching your films and shows"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="h-2 overflow-hidden rounded-full bg-elevated"
      >
        <div
          className={[
            'h-2 rounded-full transition-all',
            job?.status === 'error' ? 'bg-danger' : 'bg-accent',
          ].join(' ')}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p aria-live="polite" className="text-xs text-muted">
        {line}
      </p>
    </div>
  );
}
```

- [ ] **Step 4: Write `components/screen/LetterboxdImportModal.tsx`**

```tsx
'use client';

import { useState } from 'react';
import { screenApi, type ScreenImportResult } from '@/lib/api';
import { Button, Modal } from '@/components/ui';
import { errorMessage } from '@/lib/screen';

const LABEL_ID = 'letterboxd-import-title';

/**
 * Letterboxd ZIP upload (spec §3.4, §7.4). Closing mid-upload is allowed: the request keeps
 * going, onImported still fires, and the card picks the job up either way.
 */
export default function LetterboxdImportModal({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: (result: ScreenImportResult) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload() {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      onImported(await screenApi.importLetterboxd(file));
    } catch (e) {
      setError(errorMessage(e, 'The import did not finish. Nothing was changed.'));
      setUploading(false);
    }
  }

  return (
    <Modal
      labelId={LABEL_ID}
      onClose={onClose}
      confirmClose={() => !uploading}
      className="w-full max-w-md rounded-2xl border border-border bg-surface p-6 shadow-xl"
    >
      <h2 id={LABEL_ID} className="font-display text-xl font-semibold text-text">
        Import from Letterboxd
      </h2>
      <p className="mt-2 text-sm text-muted">
        Upload the ZIP from Letterboxd (Settings, then Data, then Export your data). ScreenSprite
        reads your watched films, ratings, reviews, watchlist and Favorite Films. It never
        overwrites a rating or review you made here, and importing turns ScreenSprite on.
      </p>
      <label className="mt-4 block">
        <span className="mb-1 block text-xs font-medium text-muted">Letterboxd export (.zip)</span>
        <input
          type="file"
          accept=".zip,application/zip"
          aria-label="Letterboxd export (.zip)"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setError(null);
          }}
          className="block w-full text-sm text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-elevated file:px-3 file:py-2 file:text-sm file:text-text"
        />
      </label>
      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={uploading} onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" loading={uploading} disabled={!file || uploading} onClick={() => void upload()}>
          Import
        </Button>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 5: Write `components/screen/ScreenSettingsCard.tsx`**

```tsx
'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import useSWR, { mutate } from 'swr';
import { Button, Card, useToast } from '@/components/ui';
import LetterboxdImportModal from '@/components/screen/LetterboxdImportModal';
import ScreenEnrichProgress from '@/components/screen/ScreenEnrichProgress';
import {
  PROFILE_STATUS_KEY,
  screenApi,
  SCREEN_ACTIVE_JOB_KEY,
  SCREEN_TITLES_KEY,
  type EnrichJobOut,
  type ScreenImportResult,
  type ScreenOptOutPreview,
} from '@/lib/api';
import { errorMessage, traitsWarning } from '@/lib/screen';
import { invalidateScreenState } from '@/lib/screenCache';
import { useScreenSettings } from '@/lib/useScreenSettings';

/** "ScreenSprite — movies & TV" (spec §7.4), mounted at /settings#screen. */
export default function ScreenSettingsCard() {
  const toast = useToast();
  const { settings, error, mutate: mutateSettings } = useScreenSettings();
  const enabled = settings?.enabled ?? false;
  const { data: active } = useSWR<{ job: EnrichJobOut | null }>(
    enabled ? SCREEN_ACTIVE_JOB_KEY : null,
    () => screenApi.activeJob()
  );
  const [jobId, setJobId] = useState<string | null>(null);
  // A job this page started, else the one the server says is running (after a reload).
  const trackedJobId = jobId ?? active?.job?.job_id ?? null;
  const [importOpen, setImportOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<ScreenOptOutPreview | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const finished = useCallback((job: EnrichJobOut) => {
    // Keep showing the final line even when the job was recovered rather than started here.
    setJobId(job.job_id);
    void mutate(SCREEN_TITLES_KEY, undefined, { revalidate: true });
    void mutate(SCREEN_ACTIVE_JOB_KEY, undefined, { revalidate: true });
    // Newly resolved titles are profile evidence: the profile may be dirty now.
    void mutate(PROFILE_STATUS_KEY);
  }, []);

  async function turnOn() {
    setBusy(true);
    setActionError(null);
    try {
      const next = await screenApi.setEnabled(true);
      await mutateSettings(next, { revalidate: false });
      await mutate(PROFILE_STATUS_KEY);
      toast.success('ScreenSprite is on.');
    } catch (e) {
      setActionError(errorMessage(e, 'ScreenSprite did not turn on. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  async function askToTurnOff() {
    setBusy(true);
    setActionError(null);
    try {
      setPreview(await screenApi.optOutPreview());
    } catch (e) {
      setActionError(errorMessage(e, 'Could not check what turning off would remove. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    setActionError(null);
    try {
      const { traits_removed: removed = 0, ...next } = await screenApi.setEnabled(false);
      await mutateSettings(next, { revalidate: false });
      await invalidateScreenState();
      setPreview(null);
      setJobId(null);
      toast.success(
        removed > 0
          ? `ScreenSprite is off. ${removed} ${removed === 1 ? 'trait' : 'traits'} removed.`
          : 'ScreenSprite is off.'
      );
    } catch (e) {
      setActionError(errorMessage(e, 'ScreenSprite did not turn off. Nothing changed.'));
    } finally {
      setBusy(false);
    }
  }

  async function imported(result: ScreenImportResult) {
    setImportOpen(false);
    setJobId(result.job.job_id);
    toast.success(
      `Imported ${result.inserted} new and ${result.updated} updated. Matching them to the catalog now.`
    );
    await Promise.all([
      mutateSettings(),
      mutate(SCREEN_TITLES_KEY, undefined, { revalidate: true }),
      mutate(PROFILE_STATUS_KEY),
    ]);
  }

  async function retry() {
    setBusy(true);
    setActionError(null);
    try {
      const started = await screenApi.startEnrich();
      setJobId(started.job_id);
    } catch (e) {
      setActionError(errorMessage(e, 'Enrichment did not restart. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="mb-1 font-display text-lg font-semibold text-text">
        {'ScreenSprite \u2014 movies & TV'}
      </h2>

      {settings === undefined ? (
        error ? (
          <p className="text-sm text-danger">
            ScreenSprite settings did not load.{' '}
            <button type="button" className="underline" onClick={() => void mutateSettings()}>
              Retry
            </button>
          </p>
        ) : (
          <p className="text-sm text-faint">{'Loading\u2026'}</p>
        )
      ) : enabled ? (
        <div className="space-y-4">
          <p className="text-sm text-muted">
            {`${settings.title_count} ${settings.title_count === 1 ? 'film or show' : 'films and shows'} in your library. They share one taste profile with your books.`}
          </p>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/screen"
              className="inline-flex items-center justify-center rounded-lg bg-accent px-4 py-2 text-sm font-medium text-[color:var(--bg)] hover:bg-accent-hover"
            >
              Open ScreenSprite
            </Link>
            <Button variant="secondary" onClick={() => setImportOpen(true)}>
              Import from Letterboxd
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => void retry()}>
              Retry enrichment
            </Button>
          </div>
          {preview ? (
            <div className="space-y-3 rounded-lg border border-danger/30 bg-danger/5 p-4">
              <p className="text-sm font-medium text-text">Turn off ScreenSprite?</p>
              <p className="text-sm text-muted">{traitsWarning(preview)}</p>
              <p className="text-xs text-faint">
                Your films and shows stay in your library, and your profile will need a full
                rebuild. You can turn ScreenSprite back on anytime.
              </p>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setPreview(null)}>
                  Keep it on
                </Button>
                <Button variant="danger" size="sm" loading={busy} onClick={() => void turnOff()}>
                  Turn off ScreenSprite
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="ghost" disabled={busy} onClick={() => void askToTurnOff()}>
              Turn off ScreenSprite
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-muted">
            ScreenSprite adds movies and TV to ShelfSprite. Your films and shows join your books in
            one taste profile, and you get film and TV picks with a reason for each.
          </p>
          <p className="text-xs text-faint">
            From Letterboxd: Settings, then Data, then Export your data. Upload the ZIP as it is.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setImportOpen(true)}>Import from Letterboxd</Button>
            <Button variant="secondary" loading={busy} onClick={() => void turnOn()}>
              Turn on without importing
            </Button>
          </div>
        </div>
      )}

      {trackedJobId && (
        <div className="mt-4">
          <ScreenEnrichProgress jobId={trackedJobId} onFinished={finished} />
        </div>
      )}
      {actionError && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {actionError}
        </p>
      )}
      {importOpen && (
        <LetterboxdImportModal
          onClose={() => setImportOpen(false)}
          onImported={(r) => void imported(r)}
        />
      )}
    </Card>
  );
}
```

The progress view sits outside the on/off branches: an import turns ScreenSprite on, but the settings revalidate a moment after the import answers, and the progress must not wait for that.

- [ ] **Step 6: Run the card test**

Run: `npx jest components/__tests__/ScreenSettingsCard.test.tsx`
Expected: PASS, 6 tests.

- [ ] **Step 7: Mutation-check the recovery**

Temporarily change `const trackedJobId = jobId ?? active?.job?.job_id ?? null;` to `const trackedJobId = jobId;` and re-run. Expected: `recovers the running job` FAILS. Restore.

- [ ] **Step 8: Write the failing settings-page test**

Create `app/__tests__/settingsScreen.test.tsx`:

```tsx
/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mutate } from 'swr';
import SettingsPage from '@/app/(main)/settings/page';
import { ToastProvider } from '@/components/ui';
import { screenApi } from '@/lib/api';

let settings: { enabled: boolean; toggled_at: null; title_count: number } | undefined;

jest.mock('swr', () => ({
  __esModule: true,
  default: (key: string | null) => ({
    data: key === 'screen-settings' ? settings : undefined,
    error: undefined,
    isLoading: false,
    mutate: jest.fn(() => Promise.resolve()),
  }),
  mutate: jest.fn(() => Promise.resolve()),
  useSWRConfig: () => ({ mutate: jest.fn() }),
}));
jest.mock('@/utils/supabase/client', () => ({ authEnabled: false, getSupabaseClient: () => null }));
jest.mock('@/lib/api', () => ({
  ...jest.requireActual('@/lib/api'),
  screenApi: {
    ...jest.requireActual('@/lib/api').screenApi,
    deleteLibrary: jest.fn(async () => ({
      titles_removed: 12,
      title_recommendations_removed: 0,
      title_signals_removed: 0,
      traits_removed: 4,
      recommendations_removed: 0,
      profile_reset: true,
    })),
  },
}));

function renderPage() {
  const view = render(
    <ToastProvider>
      <SettingsPage />
    </ToastProvider>
  );
  return view.container;
}

describe('/settings with ScreenSprite', () => {
  it('mounts the card where the gate sends people', () => {
    settings = { enabled: false, toggled_at: null, title_count: 0 };
    const container = renderPage();
    expect(container.querySelector('section#screen')).not.toBeNull();
  });

  it('keeps the danger zone book-only for a reader with no screen data', () => {
    settings = { enabled: false, toggled_at: null, title_count: 0 };
    renderPage();
    expect(screen.queryByRole('button', { name: 'Delete screen library' })).toBeNull();
    expect(
      screen.getByText('Deletes your taste traits and recommendations. Your books stay put; rebuild anytime.')
    ).toBeInTheDocument();
  });

  it('names the media once ScreenSprite is on', () => {
    settings = { enabled: true, toggled_at: null, title_count: 12 };
    renderPage();
    expect(screen.getByText(/Your books, films and shows stay put/)).toBeInTheDocument();
    expect(screen.getByText(/Your films and shows stay\./)).toBeInTheDocument();
    expect(screen.getByText(/books, films and shows, profile, recommendations/)).toBeInTheDocument();
  });

  it('still offers Delete screen library after opting out with titles left', () => {
    settings = { enabled: false, toggled_at: null, title_count: 12 };
    renderPage();
    expect(screen.getByRole('button', { name: 'Delete screen library' })).toBeInTheDocument();
  });

  it('deletes the screen library and invalidates screen state', async () => {
    settings = { enabled: true, toggled_at: null, title_count: 12 };
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Delete screen library' }));
    fireEvent.click(screen.getByRole('button', { name: "I'm sure, do it" }));
    await waitFor(() => expect(screenApi.deleteLibrary).toHaveBeenCalled());
    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith('screen-titles', undefined, { revalidate: true })
    );
    expect(mutate).toHaveBeenCalledWith('screen-settings');
  });
});
```

Run: `npx jest --listTests app/__tests__/settingsScreen.test.tsx` (prints the path), then run it. Expected: FAIL — no `#screen` section and no screen-aware copy.

- [ ] **Step 9: Update `app/(main)/settings/page.tsx`**

1. Add to the `@/lib/api` import: `SCREEN_RECS_KEY`, `SCREEN_SETTINGS_KEY`, `screenApi`. Add:

```tsx
import ScreenSettingsCard from '@/components/screen/ScreenSettingsCard';
import { useScreenSettings } from '@/lib/useScreenSettings';
import { invalidateScreenState } from '@/lib/screenCache';
```

2. At the top of `SettingsPage()`, after `const toast = useToast();`, add:

```tsx
  const { settings: screenSettings } = useScreenSettings();
  const screenEnabled = screenSettings?.enabled ?? false;
  // The screen-library purge is not gated on the opt-in (wave 4), so a reader who turned
  // ScreenSprite off with titles left can still delete them.
  const hasScreenData = screenEnabled || (screenSettings?.title_count ?? 0) > 0;
```

3. After the "Import books" `<section>`, add:

```tsx
        {/* ScreenSprite (spec §7.4). ScreenGate sends /screen/* here while it is off. */}
        <section id="screen" className="mb-6 scroll-mt-24">
          <ScreenSettingsCard />
        </section>
```

4. In the danger zone, change the "Reset taste profile" action's `description` and `onRun`:

```tsx
              description={
                hasScreenData
                  ? 'Deletes your taste traits, archetype, and both book and ScreenSprite recommendations. Your books, films and shows stay put; rebuild anytime.'
                  : 'Deletes your taste traits and recommendations. Your books stay put; rebuild anytime.'
              }
              buttonLabel="Reset profile"
              onRun={async () => {
                await api.clearProfile();
                await Promise.all([
                  mutate('profile', [], { revalidate: false }),
                  mutate(PROFILE_STATUS_KEY),
                  mutate('recommendations', [], { revalidate: false }),
                  mutate(SCREEN_RECS_KEY, [], { revalidate: false }),
                ]);
              }}
```

5. Change the "Clear library" `description` to:

```tsx
              description={
                hasScreenData
                  ? 'Deletes every book, all book enrichment, your taste profile, and both book and ScreenSprite recommendations: a factory reset for your books. Your films and shows stay.'
                  : 'Deletes every book, all enrichment, and your taste profile: a factory reset for your library.'
              }
```

6. Between "Clear library" and "Delete account data", add:

```tsx
            {hasScreenData && (
              <DangerAction
                title="Delete screen library"
                description="Deletes every film and show, their catalog matches, ScreenSprite recommendations and title signals, and your shared taste profile. Your books stay; rebuild your profile afterwards."
                buttonLabel="Delete screen library"
                onRun={async () => {
                  const result = await screenApi.deleteLibrary();
                  await invalidateScreenState();
                  await mutate(SCREEN_SETTINGS_KEY);
                  toast.success(
                    `Deleted ${result.titles_removed} ${result.titles_removed === 1 ? 'title' : 'titles'}. Rebuild your profile from your books when you are ready.`
                  );
                }}
              />
            )}
```

7. Change the "Delete account data" `description` to:

```tsx
              description={
                hasScreenData
                  ? 'Deletes ALL your data: books, films and shows, profile, recommendations, and your stored Anthropic key.'
                  : 'Deletes ALL your data: library, profile, recommendations, and your stored Anthropic key.'
              }
```

The "Delete screen library" title and its button share the label; the test clicks the button by role.

- [ ] **Step 10: Run the settings tests**

Run: `npx jest app/__tests__/settingsScreen.test.tsx app/__tests__/settings.test.tsx components/__tests__/ScreenSettingsCard.test.tsx`
Expected: PASS. The original `settings.test.tsx` passes unchanged (its SWR mock answers `undefined` for every key, so the card shows its loading line).

- [ ] **Step 11: Lint, type-check, build**

Run: `npx eslint components/screen "app/(main)/settings/page.tsx" components/__tests__/ScreenSettingsCard.test.tsx app/__tests__/settingsScreen.test.tsx && npm run type-check && npm run build`
Expected: no errors.

- [ ] **Step 12: Commit**

```bash
git add components/screen/ScreenSettingsCard.tsx components/screen/LetterboxdImportModal.tsx components/screen/ScreenEnrichProgress.tsx "app/(main)/settings/page.tsx" components/__tests__/ScreenSettingsCard.test.tsx app/__tests__/settingsScreen.test.tsx
git commit -m "feat(screen): ScreenSprite settings card, import progress and screen danger zone (#96)"
```

---

### Task 9: Docs, full gate, and real-browser verification

**Files:**
- Modify: `docs/frontend.md`

**Interfaces:** none new.

- [ ] **Step 1: Update `docs/frontend.md`**

Add this section after "## Key files":

```markdown
## ScreenSprite (movies & TV)

An opt-in section (spec `docs/superpowers/specs/2026-09-22-screen-media-design.md` §7). User-facing
copy says ScreenSprite; code, routes and keys say `screen`.

- **Navigation.** `lib/nav.ts#sectionFor(pathname)` derives the section from the URL (`/screen`
  or `/screen/*`); it is never stored. `navRoutesFor(section)` picks `NAV_ROUTES` or
  `SCREEN_NAV_ROUTES` (For you, Library, Profile) for the rail and the bottom nav.
  `components/SectionSwitch.tsx` (Books | Screen) renders only while ScreenSprite is on, and the
  wordmark (`components/Wordmark.tsx`) reads ScreenSprite inside the section. At 390 px the
  account button drops to its icon and the logo narrows while the switch shows.
- **The gate.** `app/(main)/screen/layout.tsx` is a server layout (`metadata.title`
  `'ScreenSprite'`) wrapping `components/screen/ScreenGate.tsx`, which sends a reader without
  ScreenSprite to `/settings#screen`. Screen reads pass `handleScreenError`
  (`lib/screenCache.ts`) as SWR `onError`: a 403 re-reads the settings so the gate redirects
  without a reload. Screen routes are not behind `LibraryGate`.
- **Client.** `lib/api.ts#screenApi` throws `ApiRequestError(status, detail)`; show `message`,
  which is the route's `detail`. Keys: `SCREEN_SETTINGS_KEY`, `SCREEN_TITLES_KEY`,
  `SCREEN_RECS_KEY`, `SCREEN_ACTIVE_JOB_KEY`, `REVEAL_TITLES_KEY`, `BOOKS_ALL_KEY`.
- **Invalidation (§7.7).** `invalidateTitleEdits()` after any title edit, correction, removal or
  add (profile status goes dirty). `invalidateScreenState()` after turning ScreenSprite off or
  deleting the screen library (traits, archetype, reveal, status, every screen key, in the
  three-argument form). Neither blanks `SCREEN_SETTINGS_KEY`; callers write the fresh settings.
- **Images.** `components/screen/TitleTile.tsx` hotlinks posters with `next/image`
  `unoptimized`, so nothing is copied and `images.remotePatterns` stays limited to the book
  cover hosts. A missing or failed image falls back to a typographic tile, remembered per URL.
  Posters never appear on the marketing page.
- **Attribution (§7.9).** Every shown description carries `DescriptionSource` (Wikipedia names
  and links the article, CC BY-SA 4.0; TVmaze links back). Every `/screen` page ends with
  `ScreenCredits`. Recommendation cards and search results show no description.
- **Profile.** `components/profile/ProfileView.tsx` is the profile body; `/profile` and
  `/screen/profile` both render it. It passes a title evidence map to `TraitsSection` only while
  ScreenSprite is on; `TraitRow` and `lib/revealBeats.ts` put books first and let titles fill
  the remaining evidence slots, so a books-only reader sees no change.
- **Reject picker.** `components/RejectReasonPicker.tsx` is shared by `/swipe` (book vocabulary)
  and `/screen` (`SCREEN_REJECT_REASONS`). An empty reason list is sent as a bare
  `{status: 'rejected'}` to the screen route, which refuses an empty list.
```

- [ ] **Step 2: Run the full gate**

```bash
npm run test:server 2>&1 | grep -E "Test Files|Tests "
npm test 2>&1 | grep -E "^(Test Suites|Tests):"
npm run type-check
npm run lint
npm run format:check
npm run build
```

Expected: all pass. Extract the counts with the `grep`s above; do not slice output. The Jest count is Task 0's baseline plus this wave's new tests. `next build` lists `/screen`, `/screen/library` and `/screen/profile`.

- [ ] **Step 3: Confirm the boundaries held**

```bash
git diff --stat main -- next.config.mjs "app/(marketing)" public/marketing
git diff main -- "app/(main)/page.tsx" "app/(main)/library/page.tsx" "app/(main)/discover/page.tsx" "app/(main)/to-read/page.tsx"
```

Expected: both print nothing. No new image host, no marketing change (§7.10), and no book page other than Swipe (picker extraction), Profile and Settings changed.

- [ ] **Step 4: Start an isolated local run**

Follow the `marketing-screenshot-pipeline` memory note. Put the copy **beside the repository under `$HOME`**, not in `/tmp`: the note records that Turbopack rejects a `node_modules` symlink pointing outside the inferred workspace root when the copy lives in `/tmp`.

```bash
VERIFY="$HOME/Documents/Code/shelfsprite-w8-verify"
mkdir -p "$VERIFY"
# Tracked + untracked-but-not-ignored files only; secrets files, .next and node_modules are
# gitignored, so the command never names them.
git ls-files -z --cached --others --exclude-standard | rsync -a --from0 --files-from=- ./ "$VERIFY"/
ln -sfn "$PWD/node_modules" "$VERIFY/node_modules"
ls -a "$VERIFY"   # names only; confirm no dot-env entry. If there is one: STOP, delete the copy.

docker ps --format '{{.Names}} {{.Ports}}' | grep 55438 && echo "STOP: port 55438 busy"
docker run -d --name ss-w8-pg -e POSTGRES_PASSWORD=postgres -p 55438:5432 postgres:17
export VERIFY_DB=postgres://postgres:postgres@localhost:55438/postgres
cd "$VERIFY" && DATABASE_URL=$VERIFY_DB npm run db:migrate
cd "$VERIFY" && DATABASE_URL=$VERIFY_DB ALLOW_LOCAL_AUTH=true CRON_SECRET=local-verify-secret \
  npx next dev -p 3100
```

Run the dev server in the background and watch its log. If Turbopack still rejects the `node_modules` symlink, run `npm ci` inside the copy instead of linking (no `sudo`), and record that the note's procedure needed it.

Seed books and build the Letterboxd-shaped ZIP (real film titles, a synthetic user; never Chase's export):

```bash
B=http://localhost:3100/api
curl -s -F file=@lib/server/__tests__/fixtures/sample_goodreads.csv $B/import
python3 - <<'PY'
import zipfile
files = {
  "profile.csv": "Date Joined,Username,Given Name,Family Name,Email Address,Location,Website,Bio,Pronoun,Favorite Films\n2020-01-01,synthetic_user,Sam,Example,sam@example.invalid,,,,they/them,\n",
  "watched.csv": "Date,Name,Year,Letterboxd URI\n2024-01-05,Forrest Gump,1994,https://boxd.it/aaa1\n2024-01-06,Her,2013,https://boxd.it/aaa2\n2024-01-07,Spirited Away,2001,https://boxd.it/aaa3\n2024-01-08,Chernobyl,2019,https://boxd.it/aaa4\n2024-01-09,Paprika,,https://boxd.it/aaa5\n2024-01-10,Qzxv Plumbline Orchard,2011,https://boxd.it/aaa6\n2024-01-11,Heat,1995,https://boxd.it/aaa7\n2024-01-12,Arrival,2016,https://boxd.it/aaa8\n",
  "ratings.csv": "Date,Name,Year,Letterboxd URI,Rating\n2024-01-05,Forrest Gump,1994,https://boxd.it/aaa1,4\n2024-01-07,Spirited Away,2001,https://boxd.it/aaa3,5\n2024-01-11,Heat,1995,https://boxd.it/aaa7,4.5\n2024-01-12,Arrival,2016,https://boxd.it/aaa8,5\n",
  "watchlist.csv": "Date,Name,Year,Letterboxd URI\n2024-06-01,Nosferatu,2024,https://boxd.it/bbb1\n",
}
with zipfile.ZipFile("/tmp/shelfsprite-w8-letterboxd.zip", "w", zipfile.ZIP_DEFLATED) as z:
    for name, text in files.items():
        z.writestr(name, text.encode("utf-8"))
PY
```

- [ ] **Step 5: Desktop flow without an Anthropic key (claude-in-chrome)**

Load the browser tools in one `ToolSearch` call (`select:` the core set plus `file_upload`, `read_network_requests`, `read_console_messages`, `get_page_text`, `find` and `gif_creator`), call `tabs_context_mcp`, and open a new tab on `http://localhost:3100`. Avoid anything that raises a browser `alert`/`confirm`; nothing in this wave does. Record a GIF of steps 2–4 (`w8_import_and_library.gif`). Record what you observe at each step:

1. **Off.** `/settings`: the card reads "ScreenSprite — movies & TV" with Import and Turn on; the rail has no switch; the danger zone has no "Delete screen library". Navigate to `/screen/library`: you land on `/settings#screen` with the card in view.
2. **Import.** Upload the ZIP through the card. The progress bar appears and advances. Reload the page mid-run: the bar comes back at the current count (Review Focus 3). Let it finish.
3. **Switch and brand.** The rail shows Books | Screen. Click Screen: `/screen`, wordmark "ScreenSprite", home link to `/screen`, eyebrow "Your screening room", rail For you / Library / Profile, and the tab title "ScreenSprite". Click Books: back on `/`, exactly as before.
4. **Library.** Posters render; in `read_network_requests`, poster requests go straight to `upload.wikimedia.org` / `static.tvmaze.com` and none goes through `/_next/image` (§7.8). The unresolved "Qzxv Plumbline Orchard" shows the typographic tile (Review Focus 2). Filter to TV (Chernobyl), sort by rating, reload: the sort sticks. "Paprika" shows "Check match": open it, Fix the match, search, pick the 2006 film; the badge is gone. Add a title: search "Severance" as TV, add it rated 4 (201), then add it again: the modal shows "is already in your ScreenSprite library" inline. Open Heat: rate 5, write a review, Save: the re-profile banner appears. Remove Arrival: toast, gone from the grid.
5. **For you, blocked.** `/screen`: the run button is disabled with "No taste profile yet…" and a "Go to profile" link to `/screen/profile`.
6. **Turn off and on.** In Settings, Turn off ScreenSprite: the warning says no traits drew on your viewing history (none exist yet); Keep it on leaves everything alone; Turn off completes, the switch disappears, and `/screen` redirects to settings. Turn it back on without importing: the library is still there.
7. **Book pages unchanged.** With ScreenSprite on, `/`, `/library`, `/swipe` and `/discover` look as they did with it off, apart from the switch. On `/swipe` with a served batch, reject one book: the "What missed?" picker behaves exactly as before (skip with and without a reason).
8. **Console.** `read_console_messages` with pattern `Error|Warning` on each screen page: no hydration or `next/image` errors.

- [ ] **Step 6: 390 px and 1440 px layout (headless Chrome over CDP)**

The extension cannot resize the window under Wayland (the memory note), so measure at 390 px with headless Chrome. Write this script to the session scratchpad directory (not the repository) as `mobile-check.mjs`:

```js
// WIDTH=390 node mobile-check.mjs <base-url> <out-dir> <path>...   (WIDTH defaults to 390)
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [base, out, ...paths] = process.argv.slice(2);
const width = Number(process.env.WIDTH ?? 390);
const chrome = spawn(
  'google-chrome',
  ['--headless=new', '--remote-debugging-port=9333', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'ss-cdp-'))}`, 'about:blank'],
  { stdio: 'ignore' }
);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let targets = [];
for (let i = 0; i < 20 && !targets.length; i++) {
  await wait(500);
  targets = await fetch('http://127.0.0.1:9333/json').then((r) => r.json()).catch(() => []);
}
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
const send = (method, params = {}) =>
  new Promise((r) => {
    const id = ++seq;
    pending.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width,
  height: width < 640 ? 844 : 900,
  deviceScaleFactor: 2,
  mobile: width < 640,
});
const probe = `(() => {
  const sw = document.querySelector('nav[aria-label="Section"]');
  return {
    path: location.pathname,
    title: document.title,
    scrollWidth: document.documentElement.scrollWidth,
    bottomNav: [...document.querySelectorAll('nav[aria-label="Main navigation"] a')].map((a) => a.textContent.trim()),
    switchRight: sw ? Math.round(sw.getBoundingClientRect().right) : null,
  };
})()`;
for (const p of paths) {
  await send('Page.navigate', { url: base + p });
  await wait(8000);
  const r = await send('Runtime.evaluate', { expression: probe, returnByValue: true });
  console.log(JSON.stringify(r.result.result.value));
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(
    join(out, `${width}${p.replace(/\W+/g, '_') || '_root'}.png`),
    Buffer.from(shot.result.data, 'base64')
  );
}
ws.close();
chrome.kill();
```

Run it (Node 22 has a global `WebSocket`):

```bash
node <scratchpad>/mobile-check.mjs http://localhost:3100 <scratchpad> / /library /screen /screen/library /screen/profile /settings
WIDTH=1440 node <scratchpad>/mobile-check.mjs http://localhost:3100 <scratchpad> / /screen /screen/library /settings
```

The 1440 pass is the spec's desktop width, whatever size the extension's window happens to be. Expected at 390 for every path: `scrollWidth` ≤ 390 and, where the switch shows, `switchRight` ≤ 390 (Review Focus 5). `bottomNav` is the five book routes on book paths and exactly `["For you","Library","Profile"]` on screen paths; `title` is "ScreenSprite" on screen paths. At 1440, `scrollWidth` ≤ 1440 and the rail shows the switch under the wordmark. Read each PNG: at 390 the wordmark, the switch and the account icon sit on one row without overlap. A value over the width is a finding; fix the layout, not the check.

- [ ] **Step 7: Flow with Claude calls (needs Chase)**

Ask Chase to restart the dev server with the Anthropic key exported **in his own shell**; the executor never reads, prints or writes it. With that server, at desktop width:

9. `/screen/profile`: Build profile. Open a trait row that cites a film or show: its evidence shows the Film/TV marker and `Title (Year)`. Book evidence comes first.
10. Replay my reveal: a reward beat lists a title as `Title (film)` or `Title (TV)`; the reveal opens without stalling.
11. `/screen`: run Both, then Movies, then TV. Each shows cards with rationale and chips. A trait chip opens `/screen/profile?trait=<id>` with that row open and scrolled to; a title chip opens the title modal; a book chip opens the book read-only (no Start reading, Remove or Find similar reads).
12. Want to watch on one card: "On your watchlist", and the title is in the library as Want to watch. Already watched on another: the title modal opens; rate it. Not for me with no reason, then with "Too long (runtime or seasons)" on a third: both save; the profile banner shows after the rating.
13. Remove from the library a title that a card cites, reload `/screen`: that chip is plain text (Review Focus 4).
14. Update the profile, then Settings → Turn off ScreenSprite: the warning names how many traits drew on your viewing history and how many you confirmed (confirm one first to see a non-zero second number). Confirm: those traits are gone from `/profile`, which shows no title evidence; `/screen` redirects to settings.
15. Turn ScreenSprite back on, then Delete screen library from the danger zone: the library shows its empty state and the profile needs a rebuild; books are untouched.

If Chase has not provided a key-bearing server, record "Steps 9–15 not run: need an Anthropic key in Chase's shell" and report the wave as verified up to the Claude calls. Do not call it done.

Clean up: stop the dev server, `docker rm -f ss-w8-pg`, `rm -rf "$VERIFY" /tmp/shelfsprite-w8-letterboxd.zip`, and delete the scratchpad PNGs once reported.

Record what you observed in the ledger. Any divergence from the expectations above is a finding to report, not something to reconcile silently.

- [ ] **Step 8: Commit the docs**

```bash
git add docs/frontend.md
git commit -m "docs(screen): document the ScreenSprite UI (#96)"
```

- [ ] **Step 9: Report to Chase**

This wave adds **no migration** and no server change. Report the gate counts, the real-flow observations (with the GIF and the 390 px PNGs), whether steps 9–15 are waiting on him, and anything that looked wrong. This is the last wave: the branch is ready for the single PR that closes #96 and #97 once Chase has reviewed it.
