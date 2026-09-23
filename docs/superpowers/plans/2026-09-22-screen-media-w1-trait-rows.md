# Wave 1 — Compact Expandable Trait Rows (#97) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the `/profile` taste-traits list from a wall of full cards into compact, independently expandable rows, with a `?trait=<id>` deep link that opens and scrolls to one row.

**Architecture:** The trait list moves out of `app/(main)/profile/page.tsx` into two components. `components/profile/TraitRow.tsx` is a controlled disclosure: its header is a single `<button aria-expanded aria-controls>` carrying the polarity badge, a two-line-clamped claim, confidence, status and weight markers, and a chevron; its panel holds evidence, verdict buttons, and a **Reword** button that enters the existing edit textarea. `components/profile/TraitsSection.tsx` owns the All/Loves/Avoids filter and the set of open row ids, and mounts a tiny `TraitParamWatcher` inside a `<Suspense>` boundary that reads `?trait=` with `useSearchParams` and asks the section to focus that row exactly once per parameter value. No API, schema, or server change.

**Tech Stack:** React 18 client components, Next.js App Router (`useSearchParams` from `next/navigation`), SWR, Tailwind 3.4 (`line-clamp-2` is built in), lucide-react, Jest + React Testing Library (jsdom).

**Spec:** `docs/superpowers/specs/2026-09-22-screen-media-design.md` §8 (the requirement), §0 decision 12, §1 rows "Next's app router navigates with `history.pushState`" and "No tests cover the profile trait UI today". Cross-wave names come from `docs/superpowers/plans/2026-09-22-screen-media-00-index.md` ("Frontend" under the contract). Read both before starting.

**Issue:** #97 — "make taste traits section collapsible maybe? Just a wall to scroll past right now".

---

## Global Constraints

Every task's requirements implicitly include this section. These are copied from the index's "Global constraints (every wave)".

- **Two test runners with disjoint ownership.** `npm run test:server` (Vitest) owns exactly `lib/server/**` and `app/api/**`; `npm test` (Jest) owns everything else. Before naming a single test file as a gate, confirm the runner sees it: `npx vitest list <path>` or `npx jest --listTests <path>`. A gate that matches zero tests exits 0.
- **Full gate at the end of every wave**, from the repository root: `npm run test:server`, `npm test`, `npm run type-check`, `npm run lint`, `npm run format:check`, `npm run build`. `npm run build` is the only gate that catches Next segment-config and prerender failures — and this wave adds a `useSearchParams` call, which Next requires under a `<Suspense>` boundary on a prerendered page. The build does **not** pin that boundary for `/profile`: the page renders skeletons while SWR loads, which is always the case at prerender, so the section never mounts at build time and removing the boundary would still build. Keep the boundary as a defensive requirement; do not report the build as having verified it.
- **Real-flow verification before a wave is called done** (spec §10). Tests alone never close a wave. Use an isolated local run: a scratch Postgres in Docker plus a local-mode dev server (`ALLOW_LOCAL_AUTH=true`) with **no `.env` file in scope**, following the procedure recorded in the project memory note `marketing-screenshot-pipeline`. Never point a verification run at the production database. Record what you actually observe, not what a plan predicts.
- **Secrets.** Never open, print, or name the contents of `.env*` files; check presence only. Never ask Codex to inspect them.
- **Ratings.** `numeric(2,1)` with drizzle `mode: 'number'` on every rating column. `0` on an API mutation means "clear". The manual `isValidRating` guard owns the 422 message; do not move the grid rule into Zod. (Not touched by this wave.)
- **Wire format.** API JSON is snake_case. (No API change in this wave.)
- **Long-running routes** export the literal `export const maxDuration = 300;`. (None added in this wave.)
- **Tenancy.** Every query on a user-owned table filters by `user_id`. (No query added in this wave.)
- **Schema changes.** None in this wave. `lib/server/schema.ts` is not touched.
- **`.tsx` string literals are ASCII-only**; put a non-ASCII value in an expression container (`{'…'}`), never in a bare JSX attribute. `text-base` is a colour, not a size.
- **Copy.** User-facing copy says **ScreenSprite**; code says `screen`. (Nothing screen-facing ships in this wave.)
- **Git.** Work on `feat/screen-media`. Chase commits manually by default: a plan's "Commit" step runs only when Chase has authorized commits for that execution session; otherwise stage the listed paths and leave them. Plain commit messages, no `Co-Authored-By` trailer; end each with the `Claude-Session:` line from the session's attribution instructions. Subjects for this wave: `feat(profile): … (#97)`. **Do not open a PR** — one PR for the whole branch closes #96 and #97 after wave 8.
- **Next.js here is not the Next.js you know.** Before writing route, page or `next/image` code, read the relevant guide in `node_modules/next/dist/docs/`. For this wave: `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-search-params.md` ("Behavior → Prerendering": a static page that calls `useSearchParams` from a Client Component must wrap it in `<Suspense>` or the production build fails).
- **Lint is stricter than it looks.** `eslint-config-next` 16 enables `eslint-plugin-react-hooks` 7 with `react-hooks/set-state-in-effect`, `react-hooks/refs` and `react-hooks/set-state-in-render` at **error**. Never call a `useState` setter synchronously inside `useEffect`, and never read or write `ref.current` during render. The code below is shaped around those rules; do not "simplify" it back into a setState-in-effect.

---

## Design decisions already settled

Treat these as fixed requirements.

1. **Rows, not a collapsible section.** Spec §0 decision 12. Every row starts collapsed; rows are independent (several may be open); open state lives in `TraitsSection` component state and is never persisted.
2. **The whole header is one `<button>`.** It carries `aria-expanded` and `aria-controls` (pointing at the panel id `trait-panel-<id>`), following `TasteHero`'s disclosure pattern (`components/TasteHero.tsx:428`, which uses `aria-expanded`) and adding `aria-controls` per spec §8. Enter and Space work because it is a native button. Clicking the claim toggles the row; it no longer enters edit mode.
3. **The panel is always in the DOM, `hidden` when collapsed**, so `aria-controls` always resolves to a real element. React Testing Library's `*ByRole` queries ignore hidden content, which the tests rely on.
4. **"Full claim" when expanded is the header claim with the clamp removed**, not a second copy of the text in the panel. Spec §8 lists "full claim" in the expanded panel; rendering the claim twice would be noise. The clamp is `line-clamp-2` when collapsed and absent when open.
5. **Evidence labels change to spec wording:** exhibits read `e.g.` and contrasts read `unlike` (today they read "Evidence:" and "Contrast:"). The 4-exhibit and 3-contrast display caps are kept.
6. **Editing blocks collapse.** While the Reword textarea is open, clicking the header does nothing (the button carries `aria-disabled="true"`). Save or Cancel exits; Cmd/Ctrl+Enter saves and Escape cancels, unchanged.
7. **Deep link via `?trait=<id>`, read with `useSearchParams`** (reactive to client navigation; a hash would not be, because Next's router uses `history.pushState` and fires no `hashchange` — spec §1). It is applied **once per parameter value, after traits have loaded**: the section only renders after the page's loading gate, and the watcher only focuses an id present in the loaded list. Focusing: if the current filter hides the trait, the filter resets to All; the row opens; the page scrolls to it. Unknown, non-integer, or empty ids do nothing. A later SWR revalidation (for example after a verdict) must not re-open or re-scroll.
8. **`titleEvidence` is plumbed but unused in this wave.** The index contract requires `TraitRow` to accept `titleEvidence?: Map<number, TitleEvidence>` and to export `TitleEvidence`; wave 8 renders it. `TraitsSection` passes it through as an optional prop too, so wave 8 only has to supply the map. Do not destructure it in `TraitRow` (an unused binding would trip `no-unused-vars`).
9. **The filter buttons gain `aria-pressed`.** It is a small accessibility improvement and gives the tests a stable way to read the active filter.

---

## Review Focus

Inputs the spec implies but no happy-path test would exercise. Each has a pinning test in the task named.

1. **A deep link to a trait hidden by the current filter** (user picked Loves, then followed a chip to an Avoids trait) — the filter must reset to All and the row must open and scroll. Pinned in Task 2, `resets a hiding filter to All before opening a deep-linked trait`.
2. **Clicking the header while rewording** — the row must stay open and the draft must survive; losing typed text to a stray click is the worst outcome here. Pinned in Task 1, `does not collapse while rewording`.
3. **SWR revalidation after a deep link** (a verdict mutates `TRAITS_KEY`, the list re-renders with a new array) — the page must not scroll back to the deep-linked row. Pinned in Task 2, `applies a deep link once even when traits re-render`.
4. **Malformed or unknown `?trait=` values** (`999`, `abc`, empty) — nothing opens, nothing scrolls, the filter is untouched, nothing throws. Pinned in Task 2, `ignores unknown and malformed trait params`.
5. **Scannability while collapsed** — confirmed, edited and rejected status, reduced weight, and rejected dimming must all be visible without expanding, or the compaction hides the state the reader needs. Pinned in Task 1, `shows verdict state on the collapsed row`.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `components/profile/TraitRow.tsx` | Create | One controlled disclosure row: header button, panel with evidence, verdicts, Reword/edit. Exports `TraitRow`, `TraitRowProps`, `TitleEvidence`. |
| `components/profile/TraitsSection.tsx` | Create | Heading, helper copy, All/Loves/Avoids filter, open-id set, deep-link focusing, empty-profile CTA (`BuildProfileCTA` moves here), and the `TraitParamWatcher` inside `<Suspense>`. Default-exports nothing; named export `TraitsSection`. |
| `components/__tests__/TraitRow.test.tsx` | Create | Jest/jsdom coverage of the row. |
| `components/__tests__/TraitsSection.test.tsx` | Create | Jest/jsdom coverage of the section, filter interplay, and deep link. |
| `app/(main)/profile/page.tsx` | Modify | Delete `TraitCard`, `BuildProfileCTA`, `TraitsSection`; import the new `TraitsSection`; trim now-unused imports. |
| `docs/frontend.md` | Modify (line 93) | Describe the compact rows and the `?trait=` deep link. |

---

## Handoff batching

This plan is written for a controller session dispatching one subagent per task. It is short enough to run in one batch; keep the `.superpowers/sdd/` ledger current after every task anyway.

- **Batch A:** Task 1, Task 2, Task 3, Task 4

---

### Task 1: `TraitRow` — the compact disclosure row

**Files:**
- Create: `components/profile/TraitRow.tsx`
- Test: `components/__tests__/TraitRow.test.tsx`

**Interfaces:**
- Consumes (all existing): `api.updateTrait(traitId: number, req: { claim?: string; user_note?: string }): Promise<Trait>`, `setTraitVerdict(id: number, body: { status?: 'confirmed' | 'rejected'; user_weight?: number }): Promise<Trait>`, `TRAITS_KEY` (`'profile-traits'`), `PROFILE_STATUS_KEY` (`'profile-status'`), `type Trait` — all from `@/lib/api`; `mutate` from `swr`; `Button`, `Badge`, `useToast` from `@/components/ui`; `ChevronDown` from `lucide-react`.
- Produces (relied on by Task 2 and by wave 8):
  - `export interface TitleEvidence { id: number; title: string; year: number | null; media_type: 'movie' | 'tv' }`
  - `export interface TraitRowProps { trait: Trait; bookMap: Map<number, string>; open: boolean; onToggle: () => void; titleEvidence?: Map<number, TitleEvidence> }`
  - `export function TraitRow(props: TraitRowProps): JSX.Element`
  - DOM ids: the row wrapper is `id="trait-<id>"` (the scroll target); the panel is `id="trait-panel-<id>"`.

- [ ] **Step 1: Confirm Jest will pick the new test path up**

Run: `npx jest --listTests components/__tests__/TraitRow.test.tsx`
Expected: prints nothing yet (the file does not exist). After Step 2 the same command must print the file's absolute path; if it does not, stop — the gate would silently match zero tests.

- [ ] **Step 2: Write the failing test**

Create `components/__tests__/TraitRow.test.tsx`:

```tsx
/**
 * @jest-environment jsdom
 */
import { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '@/components/ui';
import { TraitRow } from '@/components/profile/TraitRow';
import type { Trait } from '@/lib/api';

const mockUpdateTrait = jest.fn();
const mockSetTraitVerdict = jest.fn();
const mockMutate = jest.fn();

jest.mock('@/lib/api', () => ({
  api: { updateTrait: (...args: unknown[]) => mockUpdateTrait(...args) },
  setTraitVerdict: (...args: unknown[]) => mockSetTraitVerdict(...args),
  TRAITS_KEY: 'profile-traits',
  PROFILE_STATUS_KEY: 'profile-status',
}));

jest.mock('swr', () => ({
  __esModule: true,
  default: jest.fn(),
  mutate: (...args: unknown[]) => mockMutate(...args),
}));

function makeTrait(overrides: Partial<Trait> = {}): Trait {
  return {
    id: 7,
    claim: 'Rewards dense political world-building over fast plotting',
    reveal_line: null,
    polarity: 'reward',
    exhibits: [1, 2],
    contrasts: [3],
    inference_confidence: 0.82,
    status: 'proposed',
    user_weight: 1,
    user_note: null,
    created_at: '2026-09-01T00:00:00',
    ...overrides,
  };
}

const bookMap = new Map<number, string>([
  [1, 'The Dispossessed'],
  [2, 'A Memory Called Empire'],
  [3, 'Red Rising'],
]);

// A stateful stand-in for TraitsSection, which owns open state in the real app.
function Harness({ trait, startOpen = false }: { trait: Trait; startOpen?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  return (
    <ToastProvider>
      <TraitRow trait={trait} bookMap={bookMap} open={open} onToggle={() => setOpen((o) => !o)} />
    </ToastProvider>
  );
}

function header(): HTMLElement {
  return screen.getByRole('button', { name: /Rewards dense political/ });
}

beforeEach(() => {
  mockUpdateTrait.mockReset().mockResolvedValue(makeTrait());
  mockSetTraitVerdict.mockReset();
  mockMutate.mockReset().mockResolvedValue(undefined);
});

describe('TraitRow', () => {
  it('starts collapsed with a native button header that controls a hidden panel', () => {
    const { container } = render(<Harness trait={makeTrait()} />);
    const button = header();
    expect(button.tagName).toBe('BUTTON');
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveAttribute('aria-controls', 'trait-panel-7');
    const panel = container.querySelector('#trait-panel-7') as HTMLElement;
    expect(panel).not.toBeNull();
    expect(panel.hidden).toBe(true);
    expect(screen.queryByRole('button', { name: 'Reword' })).toBeNull();
    expect(container.querySelector('#trait-7')).not.toBeNull();
  });

  it('clamps the claim to two lines when collapsed and shows it in full when open', () => {
    render(<Harness trait={makeTrait()} />);
    const claim = screen.getByText('Rewards dense political world-building over fast plotting');
    expect(claim.className).toContain('line-clamp-2');
    fireEvent.click(header());
    expect(claim.className).not.toContain('line-clamp-2');
  });

  it('toggles open and closed when the claim itself is clicked, without entering edit', () => {
    render(<Harness trait={makeTrait()} />);
    fireEvent.click(screen.getByText('Rewards dense political world-building over fast plotting'));
    expect(header()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByRole('textbox', { name: 'Edit trait claim' })).toBeNull();
    fireEvent.click(header());
    expect(header()).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows evidence with the e.g. and unlike labels in the open panel', () => {
    render(<Harness trait={makeTrait()} startOpen />);
    expect(screen.getByText('e.g.')).toBeInTheDocument();
    expect(screen.getByText('The Dispossessed')).toBeInTheDocument();
    expect(screen.getByText('A Memory Called Empire')).toBeInTheDocument();
    expect(screen.getByText('unlike')).toBeInTheDocument();
    expect(screen.getByText('Red Rising')).toBeInTheDocument();
  });

  it('shows verdict state on the collapsed row', () => {
    const { container, rerender } = render(
      <Harness trait={makeTrait({ status: 'confirmed', user_weight: 0.5 })} />
    );
    expect(header()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('confirmed')).toBeInTheDocument();
    expect(screen.getByText('0.5x')).toBeInTheDocument();
    expect(screen.getByText('82%')).toBeInTheDocument();

    rerender(<Harness trait={makeTrait({ status: 'rejected' })} />);
    expect(screen.getByText('rejected')).toBeInTheDocument();
    expect((container.querySelector('#trait-7') as HTMLElement).className).toContain('opacity-50');
    expect(
      screen.getByText('Rewards dense political world-building over fast plotting').className
    ).toContain('line-through');

    rerender(<Harness trait={makeTrait({ status: 'edited' })} />);
    expect(screen.getByText('edited')).toBeInTheDocument();

    rerender(<Harness trait={makeTrait({ status: 'proposed', user_weight: 1 })} />);
    expect(screen.queryByText('proposed')).toBeNull();
    expect(screen.queryByText(/x$/)).toBeNull();
  });

  it('marks the aversion polarity as Avoids', () => {
    render(<Harness trait={makeTrait({ polarity: 'aversion', claim: 'Avoids military SF' })} />);
    expect(screen.getByText('Avoids')).toBeInTheDocument();
  });

  it('records a verdict from the panel', async () => {
    const trait = makeTrait();
    mockSetTraitVerdict.mockResolvedValue({ ...trait, status: 'confirmed' });
    render(<Harness trait={trait} startOpen />);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(mockSetTraitVerdict).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ status: 'confirmed' })
      )
    );
    await waitFor(() => expect(mockMutate).toHaveBeenCalledWith('profile-status'));
  });

  it('records Apply less as a 0.5 weight', async () => {
    const trait = makeTrait();
    mockSetTraitVerdict.mockResolvedValue({ ...trait, user_weight: 0.5 });
    render(<Harness trait={trait} startOpen />);
    fireEvent.click(screen.getByRole('button', { name: 'Apply less' }));
    await waitFor(() =>
      expect(mockSetTraitVerdict).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ user_weight: 0.5 })
      )
    );
  });

  it('rewords through the Reword button and saves', async () => {
    render(<Harness trait={makeTrait()} startOpen />);
    fireEvent.click(screen.getByRole('button', { name: 'Reword' }));
    const box = screen.getByRole('textbox', { name: 'Edit trait claim' });
    expect(box).toHaveValue('Rewards dense political world-building over fast plotting');
    fireEvent.change(box, { target: { value: 'Rewards dense political world-building' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mockUpdateTrait).toHaveBeenCalledWith(7, {
        claim: 'Rewards dense political world-building',
      })
    );
    await waitFor(() => expect(mockMutate).toHaveBeenCalledWith('profile-traits'));
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: 'Edit trait claim' })).toBeNull()
    );
  });

  it('saves with Ctrl+Enter and cancels with Escape', async () => {
    render(<Harness trait={makeTrait()} startOpen />);
    fireEvent.click(screen.getByRole('button', { name: 'Reword' }));
    const box = screen.getByRole('textbox', { name: 'Edit trait claim' });
    fireEvent.change(box, { target: { value: 'Something else entirely' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'Edit trait claim' })).toBeNull();
    expect(mockUpdateTrait).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Reword' }));
    const again = screen.getByRole('textbox', { name: 'Edit trait claim' });
    expect(again).toHaveValue('Rewards dense political world-building over fast plotting');
    fireEvent.change(again, { target: { value: 'Something else entirely' } });
    fireEvent.keyDown(again, { key: 'Enter', ctrlKey: true });
    await waitFor(() =>
      expect(mockUpdateTrait).toHaveBeenCalledWith(7, { claim: 'Something else entirely' })
    );
  });

  it('does not collapse while rewording', () => {
    render(<Harness trait={makeTrait()} startOpen />);
    fireEvent.click(screen.getByRole('button', { name: 'Reword' }));
    const box = screen.getByRole('textbox', { name: 'Edit trait claim' });
    fireEvent.change(box, { target: { value: 'Half-typed draft' } });

    fireEvent.click(header());

    expect(header()).toHaveAttribute('aria-expanded', 'true');
    expect(header()).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('textbox', { name: 'Edit trait claim' })).toHaveValue(
      'Half-typed draft'
    );
  });

  it('hides verdict buttons while rewording', () => {
    render(<Harness trait={makeTrait()} startOpen />);
    fireEvent.click(screen.getByRole('button', { name: 'Reword' }));
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reword' })).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx jest components/__tests__/TraitRow.test.tsx`
Expected: FAIL — `Cannot find module '@/components/profile/TraitRow'`.

- [ ] **Step 4: Write the implementation**

Create `components/profile/TraitRow.tsx`:

```tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import { mutate } from 'swr';
import { ChevronDown } from 'lucide-react';
import { api, setTraitVerdict, type Trait, PROFILE_STATUS_KEY, TRAITS_KEY } from '@/lib/api';
import { Badge, Button, useToast } from '@/components/ui';

/**
 * A film or show a trait cites. Unused until wave 8 of the screen-media plan, which passes a
 * map of these so title evidence can render beside book evidence (spec §7.5, §8).
 */
export interface TitleEvidence {
  id: number;
  title: string;
  year: number | null;
  media_type: 'movie' | 'tv';
}

export interface TraitRowProps {
  trait: Trait;
  bookMap: Map<number, string>;
  /** Controlled by TraitsSection so the ?trait= deep link can open a row. */
  open: boolean;
  onToggle: () => void;
  /** Wave 8 renders these; this wave only accepts the prop. */
  titleEvidence?: Map<number, TitleEvidence>;
}

type BadgeVariant = 'default' | 'success' | 'danger' | 'accent';

function statusVariant(status: string): BadgeVariant {
  if (status === 'edited') return 'accent';
  if (status === 'confirmed') return 'success';
  if (status === 'rejected') return 'danger';
  return 'default';
}

export function TraitRow({ trait, bookMap, open, onToggle }: TraitRowProps) {
  const toast = useToast();
  const isReward = trait.polarity === 'reward';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(trait.claim);
  const [saving, setSaving] = useState(false);
  const [verdicting, setVerdicting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
      textareaRef.current.focus();
    }
  }, [editing, draft]);

  function startReword() {
    setDraft(trait.claim);
    setEditing(true);
  }

  async function save() {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === trait.claim) {
      setEditing(false);
      setDraft(trait.claim);
      return;
    }
    setSaving(true);
    try {
      await api.updateTrait(trait.id, { claim: trimmed });
      await mutate(TRAITS_KEY);
      toast.success('Noted. Your profile just got sharper.');
      setEditing(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    setEditing(false);
    setDraft(trait.claim);
  }

  async function handleVerdict(status?: 'confirmed' | 'rejected', user_weight?: number) {
    setVerdicting(true);
    try {
      const updated = await setTraitVerdict(trait.id, { status, user_weight });
      await mutate(
        TRAITS_KEY,
        (prev: Trait[] | undefined) => (prev ?? []).map((t) => (t.id === updated.id ? updated : t)),
        { revalidate: false }
      );
      await mutate(PROFILE_STATUS_KEY);
      toast.success("Updated. We'll recommend accordingly.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Update failed.');
    } finally {
      setVerdicting(false);
    }
  }

  function handleHeaderClick() {
    // Collapsing mid-edit would hide (and on a filter change, discard) a half-typed draft.
    if (editing) return;
    onToggle();
  }

  const exhibitTitles = (trait.exhibits ?? [])
    .map((id) => bookMap.get(id))
    .filter(Boolean) as string[];
  const contrastTitles = (trait.contrasts ?? [])
    .map((id) => bookMap.get(id))
    .filter(Boolean) as string[];

  const polarityVariant = isReward ? 'success' : 'danger';
  const polarityLabel = isReward ? 'Loves' : 'Avoids';
  const borderClass = isReward ? 'border-success/30 bg-success/5' : 'border-danger/30 bg-danger/5';

  const isRejected = trait.status === 'rejected';
  const isConfirmed = trait.status === 'confirmed';
  const hasLowWeight = trait.user_weight != null && trait.user_weight < 1.0;
  const panelId = `trait-panel-${trait.id}`;

  return (
    <div
      id={`trait-${trait.id}`}
      className={[
        'scroll-mt-6 rounded-xl border transition',
        borderClass,
        isRejected ? 'opacity-50' : '',
      ].join(' ')}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-disabled={editing ? true : undefined}
        onClick={handleHeaderClick}
        className={[
          'flex w-full items-start gap-3 rounded-xl p-4 text-left',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
        ].join(' ')}
      >
        <Badge variant={polarityVariant} className="mt-0.5 shrink-0">
          {polarityLabel}
        </Badge>
        <span
          className={[
            'min-w-0 flex-1 text-sm',
            open ? '' : 'line-clamp-2',
            isRejected ? 'line-through text-faint' : 'text-text',
          ].join(' ')}
        >
          {trait.claim}
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <span className="font-mono text-xs text-faint">
            {Math.round(trait.inference_confidence * 100)}%
          </span>
          {trait.status !== 'proposed' && (
            <Badge variant={statusVariant(trait.status)}>{trait.status}</Badge>
          )}
          {hasLowWeight && trait.user_weight != null && (
            <span className="font-mono text-xs text-faint" title="Reduced weight">
              {`${Math.round(trait.user_weight * 10) / 10}x`}
            </span>
          )}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={[
            'mt-0.5 h-4 w-4 shrink-0 text-faint transition-transform',
            open ? 'rotate-180' : '',
          ].join(' ')}
        />
      </button>

      <div id={panelId} hidden={!open} className="space-y-3 px-4 pb-4 pl-14">
        {editing ? (
          <>
            <textarea
              aria-label="Edit trait claim"
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={1}
              className={[
                'w-full resize-none rounded-lg border border-accent bg-elevated px-3 py-2',
                'text-sm text-text focus:outline-none focus-visible:ring-1 focus-visible:ring-accent',
              ].join(' ')}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save();
                if (e.key === 'Escape') cancel();
              }}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" loading={saving} onClick={() => void save()}>
                {saving ? 'Saving\u2026' : 'Save'}
              </Button>
              <Button size="sm" variant="ghost" onClick={cancel}>
                Cancel
              </Button>
              <span className="text-xs text-faint">Cmd+Enter to save · Esc to cancel</span>
            </div>
          </>
        ) : (
          <>
            {(exhibitTitles.length > 0 || contrastTitles.length > 0) && (
              <div className="space-y-1.5">
                {exhibitTitles.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    <span className="mr-1 text-xs text-faint">e.g.</span>
                    {exhibitTitles.slice(0, 4).map((t) => (
                      <Badge key={t} variant="mono">
                        {t}
                      </Badge>
                    ))}
                  </div>
                )}
                {contrastTitles.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    <span className="mr-1 text-xs text-faint">unlike</span>
                    {contrastTitles.slice(0, 3).map((t) => (
                      <Badge key={t}>{t}</Badge>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant={isConfirmed ? 'primary' : 'ghost'}
                disabled={verdicting}
                onClick={() => void handleVerdict('confirmed')}
                title="That's me"
              >
                Confirm
              </Button>
              <Button
                size="sm"
                variant={isRejected ? 'danger' : 'ghost'}
                disabled={verdicting}
                onClick={() => void handleVerdict('rejected')}
                title="Not me"
              >
                Not me
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={verdicting}
                onClick={() => void handleVerdict(undefined, 0.5)}
                title="Turn this down"
              >
                Apply less
              </Button>
              <Button size="sm" variant="ghost" onClick={startReword}>
                Reword
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
```

Notes for the implementer:
- `Confirm`, `Not me` and `Apply less` carry `title` attributes; RTL's accessible name for a button with visible text is the text, so `getByRole('button', { name: 'Confirm' })` matches. If it does not, check that `Button` spreads `...props` onto the `<button>` (it does today, `components/ui/Button.tsx:~53`).
- The `·` in `Cmd+Enter to save · Esc to cancel` is JSX text, which the ASCII rule allows. `'Saving\u2026'` stays an escape inside a JavaScript string, as it is in today's `TraitCard`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx jest components/__tests__/TraitRow.test.tsx`
Expected: PASS, 12 tests.

- [ ] **Step 6: Mutation-check the load-bearing guard**

Temporarily delete the line `if (editing) return;` in `handleHeaderClick` and re-run the test file.
Expected: `does not collapse while rewording` FAILS. Restore the line and confirm the file passes again. If nothing went red, the test is not pinning the guard — fix the test before moving on.

- [ ] **Step 7: Lint and type-check the new file**

Run: `npx eslint components/profile/TraitRow.tsx components/__tests__/TraitRow.test.tsx && npm run type-check`
Expected: no errors. (A `react-hooks/set-state-in-effect` error here means a setter crept into the effect; the only effect in this file sizes and focuses the textarea.)

- [ ] **Step 8: Commit**

```bash
git add components/profile/TraitRow.tsx components/__tests__/TraitRow.test.tsx
git commit -m "feat(profile): compact expandable trait row (#97)

Claude-Session: <session line from attribution instructions>"
```

---

### Task 2: `TraitsSection` — filter, open set, and the `?trait=` deep link

**Files:**
- Create: `components/profile/TraitsSection.tsx`
- Test: `components/__tests__/TraitsSection.test.tsx`

**Interfaces:**
- Consumes: `TraitRow`, `type TitleEvidence` from Task 1 (`@/components/profile/TraitRow`); `useSearchParams` from `next/navigation`; `Button`, `Card` from `@/components/ui`; `ShelfSprite` default export from `@/components/ShelfSprite` (props `variant`, `sizes`, `className` — as used today at `app/(main)/profile/page.tsx:289`); `type Trait` from `@/lib/api`.
- Produces (relied on by Task 3 and wave 8):
  - `export interface TraitsSectionProps { traits: Trait[]; bookMap: Map<number, string>; onBuildProfile: () => Promise<void>; titleEvidence?: Map<number, TitleEvidence> }`
  - `export function TraitsSection(props: TraitsSectionProps): JSX.Element`
  - Behavior contract: renders only after its parent has loaded traits; `?trait=<integer id>` of a loaded trait opens that row, resets a hiding filter to All, and scrolls `#trait-<id>` into view, once per parameter value.

- [ ] **Step 1: Write the failing test**

Create `components/__tests__/TraitsSection.test.tsx`:

```tsx
/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { ToastProvider } from '@/components/ui';
import { TraitsSection } from '@/components/profile/TraitsSection';
import type { Trait } from '@/lib/api';

let mockSearch = new URLSearchParams();

jest.mock('next/navigation', () => ({
  useSearchParams: () => mockSearch,
}));

jest.mock('@/lib/api', () => ({
  api: { updateTrait: jest.fn() },
  setTraitVerdict: jest.fn(),
  TRAITS_KEY: 'profile-traits',
  PROFILE_STATUS_KEY: 'profile-status',
}));

jest.mock('swr', () => ({
  __esModule: true,
  default: jest.fn(),
  mutate: jest.fn(),
}));

// ShelfSprite renders next/image; jsdom needs a plain img (same stub as TasteHero.test.tsx).
jest.mock('next/image', () => ({
  __esModule: true,
  // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
  default: (props: Record<string, unknown>) => <img {...(props as never)} />,
}));

const scrollIntoView = jest.fn();

beforeAll(() => {
  // jsdom does not implement scrollIntoView.
  Element.prototype.scrollIntoView = scrollIntoView;
});

beforeEach(() => {
  mockSearch = new URLSearchParams();
  scrollIntoView.mockReset();
});

function trait(id: number, polarity: 'reward' | 'aversion', claim: string): Trait {
  return {
    id,
    claim,
    reveal_line: null,
    polarity,
    exhibits: [],
    contrasts: [],
    inference_confidence: 0.7,
    status: 'proposed',
    user_weight: 1,
    user_note: null,
    created_at: '2026-09-01T00:00:00',
  };
}

const TRAITS: Trait[] = [
  trait(1, 'reward', 'Rewards dense prose'),
  trait(2, 'reward', 'Rewards found family'),
  trait(3, 'aversion', 'Avoids military SF'),
];

function renderSection(traits: Trait[] = TRAITS) {
  const onBuildProfile = jest.fn().mockResolvedValue(undefined);
  const utils = render(
    <ToastProvider>
      <TraitsSection traits={traits} bookMap={new Map()} onBuildProfile={onBuildProfile} />
    </ToastProvider>
  );
  const rerenderWith = (next: Trait[]) =>
    utils.rerender(
      <ToastProvider>
        <TraitsSection traits={next} bookMap={new Map()} onBuildProfile={onBuildProfile} />
      </ToastProvider>
    );
  return { ...utils, rerenderWith };
}

function rowButton(claim: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(claim) });
}

function filterButton(name: RegExp): HTMLElement {
  return screen.getByRole('button', { name });
}

describe('TraitsSection', () => {
  it('starts with every row collapsed', () => {
    renderSection();
    for (const t of TRAITS) expect(rowButton(t.claim)).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens rows independently, several at once', () => {
    renderSection();
    fireEvent.click(rowButton('Rewards dense prose'));
    fireEvent.click(rowButton('Avoids military SF'));
    expect(rowButton('Rewards dense prose')).toHaveAttribute('aria-expanded', 'true');
    expect(rowButton('Avoids military SF')).toHaveAttribute('aria-expanded', 'true');
    expect(rowButton('Rewards found family')).toHaveAttribute('aria-expanded', 'false');
  });

  it('replaces the click-to-reword helper copy', () => {
    renderSection();
    expect(screen.queryByText(/Click any trait to reword it/)).toBeNull();
    expect(screen.getByText(/Open a trait to confirm, reject, or reword it\./)).toBeInTheDocument();
  });

  it('filters by polarity and keeps open state across filter changes', () => {
    renderSection();
    fireEvent.click(rowButton('Rewards dense prose'));
    fireEvent.click(filterButton(/Avoids \(1\)/));
    expect(filterButton(/Avoids \(1\)/)).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: /Rewards dense prose/ })).toBeNull();
    fireEvent.click(filterButton(/All \(3\)/));
    expect(rowButton('Rewards dense prose')).toHaveAttribute('aria-expanded', 'true');
  });

  it('shows the empty-filter message', () => {
    renderSection([trait(1, 'reward', 'Rewards dense prose')]);
    fireEvent.click(filterButton(/Avoids \(0\)/));
    expect(screen.getByText('Nothing under this filter.')).toBeInTheDocument();
  });

  it('shows the build CTA and no watcher when there are no traits', () => {
    mockSearch = new URLSearchParams('trait=1');
    renderSection([]);
    expect(screen.getByRole('button', { name: /Build profile/ })).toBeInTheDocument();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('opens and scrolls to a deep-linked trait', () => {
    mockSearch = new URLSearchParams('trait=2');
    renderSection();
    expect(rowButton('Rewards found family')).toHaveAttribute('aria-expanded', 'true');
    expect(rowButton('Rewards dense prose')).toHaveAttribute('aria-expanded', 'false');
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.instances[0]).toBe(document.getElementById('trait-2'));
  });

  it('resets a hiding filter to All before opening a deep-linked trait', () => {
    const { rerenderWith } = renderSection();
    fireEvent.click(filterButton(/Loves \(2\)/));
    expect(screen.queryByRole('button', { name: /Avoids military SF/ })).toBeNull();

    mockSearch = new URLSearchParams('trait=3');
    rerenderWith(TRAITS);

    expect(filterButton(/All \(3\)/)).toHaveAttribute('aria-pressed', 'true');
    expect(rowButton('Avoids military SF')).toHaveAttribute('aria-expanded', 'true');
    expect(scrollIntoView.mock.instances[0]).toBe(document.getElementById('trait-3'));
  });

  it('keeps a filter that already shows the deep-linked trait', () => {
    const { rerenderWith } = renderSection();
    fireEvent.click(filterButton(/Loves \(2\)/));
    mockSearch = new URLSearchParams('trait=1');
    rerenderWith(TRAITS);
    expect(filterButton(/Loves \(2\)/)).toHaveAttribute('aria-pressed', 'true');
    expect(rowButton('Rewards dense prose')).toHaveAttribute('aria-expanded', 'true');
  });

  it('follows a new ?trait= value after client navigation', () => {
    mockSearch = new URLSearchParams('trait=1');
    const { rerenderWith } = renderSection();
    mockSearch = new URLSearchParams('trait=3');
    rerenderWith(TRAITS);
    expect(rowButton('Avoids military SF')).toHaveAttribute('aria-expanded', 'true');
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(scrollIntoView.mock.instances[1]).toBe(document.getElementById('trait-3'));
  });

  it('applies a deep link once even when traits re-render', () => {
    mockSearch = new URLSearchParams('trait=2');
    const { rerenderWith } = renderSection();
    fireEvent.click(rowButton('Rewards found family')); // reader collapses it
    rerenderWith(TRAITS.map((t) => ({ ...t }))); // SWR revalidation: new array, same ids
    expect(rowButton('Rewards found family')).toHaveAttribute('aria-expanded', 'false');
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('ignores unknown and malformed trait params', () => {
    for (const value of ['999', 'abc', '', '2.5', '-1']) {
      scrollIntoView.mockReset();
      mockSearch = new URLSearchParams(`trait=${value}`);
      const { unmount } = renderSection();
      for (const t of TRAITS) expect(rowButton(t.claim)).toHaveAttribute('aria-expanded', 'false');
      expect(filterButton(/All \(3\)/)).toHaveAttribute('aria-pressed', 'true');
      expect(scrollIntoView).not.toHaveBeenCalled();
      unmount();
    }
  });
});
```

- [ ] **Step 2: Confirm the runner sees it, then verify it fails**

Run: `npx jest --listTests components/__tests__/TraitsSection.test.tsx`
Expected: prints the file's absolute path.

Run: `npx jest components/__tests__/TraitsSection.test.tsx`
Expected: FAIL — `Cannot find module '@/components/profile/TraitsSection'`.

- [ ] **Step 3: Write the implementation**

Create `components/profile/TraitsSection.tsx`:

```tsx
'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { Trait } from '@/lib/api';
import { Button, Card } from '@/components/ui';
import ShelfSprite from '@/components/ShelfSprite';
import { TraitRow, type TitleEvidence } from './TraitRow';

type Filter = 'all' | 'reward' | 'aversion';

export interface TraitsSectionProps {
  traits: Trait[];
  bookMap: Map<number, string>;
  onBuildProfile: () => Promise<void>;
  /** Wave 8 supplies this; TraitRow renders it. */
  titleEvidence?: Map<number, TitleEvidence>;
}

// ─── Build profile CTA (moved verbatim from app/(main)/profile/page.tsx) ──────

function BuildProfileCTA({ onBuild }: { onBuild: () => Promise<void> }) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handle() {
    setRunning(true);
    setError(null);
    try {
      await onBuild();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'The profile build failed. Your books are untouched; try again.'
      );
      setRunning(false);
    }
  }

  return (
    <Card className="text-center space-y-4">
      <ShelfSprite
        variant="analyze"
        sizes="128px"
        className={['mx-auto h-32 w-32', running ? 'motion-safe:animate-pulse' : ''].join(' ')}
      />
      <p className="text-muted font-medium">No taste profile yet.</p>
      <p className="text-sm text-faint">
        Claude will read your rated books and infer what you love and avoid. This takes about 30
        seconds and needs your Anthropic API key.
      </p>
      <Button loading={running} onClick={handle}>
        {running ? 'Building profile\u2026' : 'Build profile'}
      </Button>
      {error && <p className="text-sm text-danger">{error}</p>}
    </Card>
  );
}

// ─── ?trait= watcher ──────────────────────────────────────────────────────────

/**
 * Reads ?trait=<id> and asks the section to focus that trait once per parameter value.
 *
 * Lives in its own component because useSearchParams must sit under a <Suspense> boundary
 * or `next build` fails on the prerendered /profile page. It holds no useState: the focus
 * work is done by the parent's callback, so react-hooks/set-state-in-effect has nothing to
 * flag here. The applied-value ref is written only inside the effect (react-hooks/refs).
 */
function TraitParamWatcher({
  traitIds,
  onFocus,
}: {
  traitIds: number[];
  onFocus: (id: number) => void;
}) {
  const param = useSearchParams().get('trait');
  const applied = useRef<string | null>(null);

  useEffect(() => {
    if (param === null) {
      applied.current = null;
      return;
    }
    if (applied.current === param) return;
    if (!/^\d+$/.test(param)) return;
    const id = Number(param);
    if (!traitIds.includes(id)) return;
    applied.current = param;
    onFocus(id);
  }, [param, traitIds, onFocus]);

  return null;
}

// ─── Section ──────────────────────────────────────────────────────────────────

export function TraitsSection({
  traits,
  bookMap,
  onBuildProfile,
  titleEvidence,
}: TraitsSectionProps) {
  const [filter, setFilter] = useState<Filter>('all');
  const [openIds, setOpenIds] = useState<Set<number>>(() => new Set());
  // A fresh object per focus request, so focusing the same id twice still scrolls twice.
  const [scrollRequest, setScrollRequest] = useState<{ id: number } | null>(null);

  const rewards = traits.filter((t) => t.polarity === 'reward');
  const aversions = traits.filter((t) => t.polarity === 'aversion');
  const visible = filter === 'all' ? traits : filter === 'reward' ? rewards : aversions;
  // Stable between renders that do not change `traits`: the watcher's effect depends on it, and
  // an unstable dep would make the once-per-value ref the only thing preventing a render loop.
  const traitIds = useMemo(() => traits.map((t) => t.id), [traits]);

  useEffect(() => {
    if (scrollRequest === null) return;
    document
      .getElementById(`trait-${scrollRequest.id}`)
      ?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [scrollRequest]);

  function toggle(id: number) {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // useCallback for the same reason as traitIds: it is a dep of the watcher's effect.
  const focusTrait = useCallback(
    (id: number) => {
      const target = traits.find((t) => t.id === id);
      if (!target) return;
      if (filter !== 'all' && target.polarity !== filter) setFilter('all');
      setOpenIds((prev) => {
        if (prev.has(id)) return prev;
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      setScrollRequest({ id });
    },
    [traits, filter]
  );

  const filterBtnClass = (active: boolean) =>
    [
      'rounded-md px-2.5 py-1 text-xs capitalize transition',
      'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
      active ? 'bg-elevated text-text' : 'text-muted hover:text-text',
    ].join(' ');

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-display text-lg font-semibold text-text">Taste traits</h2>
          <p className="mt-0.5 text-xs text-faint">
            Claude inferred these from your ratings. Open a trait to confirm, reject, or reword it.
          </p>
        </div>
        <div className="flex gap-1 rounded-lg border border-border bg-elevated p-1">
          {(['all', 'reward', 'aversion'] as const).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={filterBtnClass(filter === f)}
            >
              {f === 'all'
                ? `All (${traits.length})`
                : f === 'reward'
                  ? `Loves (${rewards.length})`
                  : `Avoids (${aversions.length})`}
            </button>
          ))}
        </div>
      </div>

      {traits.length > 0 && (
        <Suspense fallback={null}>
          <TraitParamWatcher traitIds={traitIds} onFocus={focusTrait} />
        </Suspense>
      )}

      {traits.length === 0 ? (
        <BuildProfileCTA onBuild={onBuildProfile} />
      ) : visible.length === 0 ? (
        <p className="py-10 text-center text-faint">Nothing under this filter.</p>
      ) : (
        <div className="space-y-3">
          {visible.map((t) => (
            <TraitRow
              key={t.id}
              trait={t}
              bookMap={bookMap}
              open={openIds.has(t.id)}
              onToggle={() => toggle(t.id)}
              titleEvidence={titleEvidence}
            />
          ))}
        </div>
      )}
    </section>
  );
}
```

Why the pieces are shaped this way (do not collapse them):
- `focusTrait` is called from the watcher's effect but is the **parent's** function, so its `setFilter`/`setOpenIds`/`setScrollRequest` calls are not a setState-in-effect inside the component that owns the state; the lint rule tracks setters of the component whose effect it is inspecting.
- The scroll runs in the parent's effect **after** the state commit, so `#trait-<id>` exists (the filter reset has re-rendered the row) before `scrollIntoView`. The effect reads state only and calls no setter.
- `scrollIntoView?.(…)` keeps a missing browser method from throwing.
- The empty-traits branch never mounts the watcher, so a `?trait=` on a profile-less account is a no-op.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest components/__tests__/TraitsSection.test.tsx`
Expected: PASS, 12 tests.

If `opens and scrolls to a deep-linked trait` fails because `scrollIntoView` was called zero times, check that the stub is installed on `Element.prototype` before render (the `beforeAll`) and that the section's scroll effect depends on `scrollRequest`.

- [ ] **Step 5: Mutation-check the once-per-value guard**

Temporarily change `if (applied.current === param) return;` to `if (false) return;` and re-run the file under a timeout:
`timeout 120 npx jest components/__tests__/TraitsSection.test.tsx`.
Expected: `applies a deep link once even when traits re-render` FAILS (the row re-opens and `scrollIntoView` is called again). Restore the line and confirm the file passes.
If the run is killed by `timeout` instead of failing, the watcher's deps are unstable (a Fable review reproduced an infinite render loop, 100% CPU with no output, when `traitIds` and `focusTrait` were recreated every render). Check the `useMemo`/`useCallback` above, then re-run the mutant. A hang is not an acceptable red.

Then temporarily delete `if (filter !== 'all' && target.polarity !== filter) setFilter('all');` and re-run.
Expected: `resets a hiding filter to All before opening a deep-linked trait` FAILS. Restore it.

- [ ] **Step 6: Lint and type-check**

Run: `npx eslint components/profile/TraitsSection.tsx components/__tests__/TraitsSection.test.tsx && npm run type-check`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add components/profile/TraitsSection.tsx components/__tests__/TraitsSection.test.tsx
git commit -m "feat(profile): trait section with open-state and ?trait= deep link (#97)

Claude-Session: <session line from attribution instructions>"
```

---

### Task 3: Mount the new section on `/profile` and update the frontend doc

**Files:**
- Modify: `app/(main)/profile/page.tsx` (delete lines 35–368: `TraitCard`, `BuildProfileCTA`, `TraitsSection`; rewrite the import block at lines 1–29)
- Modify: `docs/frontend.md:93`

**Interfaces:**
- Consumes: `TraitsSection` from Task 2 (`@/components/profile/TraitsSection`), with props `traits`, `bookMap`, `onBuildProfile`.
- Produces: nothing new. The page's `ProfilePage` default export keeps its current behavior apart from the trait list.

- [ ] **Step 1: Delete the three in-page components**

In `app/(main)/profile/page.tsx`, delete everything from the line `// ─── Trait card ───…` (line 35) through the blank line after the closing brace of `function TraitsSection` (lines 35–368; 367 is the brace, 368 is blank), stopping before `// ─── Rating distribution ───…`. `RatingSection`, `GenreSection`, `Skeleton` and `ProfilePage` stay.

- [ ] **Step 2: Replace the import block**

Replace lines 1–29 (from `'use client';` through `import ShelfSprite from '@/components/ShelfSprite';`) with:

```tsx
'use client';

import PageHeading from '@/components/PageHeading';

import { useState, useRef, useEffect } from 'react';
import useSWR, { mutate } from 'swr';
import Link from 'next/link';
import { Settings, Shield } from 'lucide-react';
import {
  api,
  type Trait,
  type Stats,
  type SubjectBreakdown,
  type Book,
  adminMe,
  ADMIN_ME_KEY,
  PROFILE_STATUS_KEY,
  TRAITS_KEY,
} from '@/lib/api';
import { Card } from '@/components/ui';
import { TasteHero } from '@/components/TasteHero';
import CustomInstructions from '@/components/CustomInstructions';
import RevealSequence from '@/components/reveal/RevealSequence';
import { useFeedbackPrompt } from '@/hooks/useFeedbackPrompt';
import { TraitsSection } from '@/components/profile/TraitsSection';
```

What was removed and why: `setTraitVerdict`, `Button`, `Badge`, `useToast` and `ShelfSprite` were used only by the deleted components. `ProfileStatus`, `UserProfile` and `USER_PROFILE_KEY` were already unused before this change; confirm with `grep -n "ProfileStatus\|UserProfile\|USER_PROFILE_KEY" "app/(main)/profile/page.tsx"` after the edit — it must print nothing. If it prints a use site, keep that import.

- [ ] **Step 3: Leave the mount site as is**

The existing call in `ProfilePage` already matches the new component's props — confirm the line still reads:

```tsx
          <TraitsSection traits={traits} bookMap={bookMap} onBuildProfile={handleBuildProfile} />
```

`TraitsSection` renders only inside the `isLoading ? <Skeleton /> : …` branch, which is what makes the deep link apply "after traits load" (spec §8).

- [ ] **Step 4: Type-check, lint, and run the Jest suite**

Run: `npm run type-check && npx eslint "app/(main)/profile/page.tsx" && npm test`
Expected: all pass. An unused-import warning or error names the import to remove.

- [ ] **Step 5: Build (the Suspense gate)**

Run: `npm run build`
Expected: succeeds, and `/profile` appears in the route table. This gate does not exercise the `<Suspense>` boundary (see Global Constraints: the section mounts only after the client fetch), so a green build says nothing about it either way. If a "Missing Suspense boundary with useSearchParams" error does appear, the watcher escaped its `<Suspense>`: fix `TraitsSection.tsx`, not the page.

- [ ] **Step 6: Update the frontend doc**

In `docs/frontend.md`, replace the `/profile` bullet at line 93 with:

```markdown
- `/profile` — `TasteHero` archetype card at top; taste traits as compact, independently expandable rows (`components/profile/TraitsSection.tsx`, `components/profile/TraitRow.tsx`): a collapsed row shows polarity, a two-line claim, confidence, any non-`proposed` status, the reduced-weight marker and rejected dimming; the expanded panel holds evidence (`e.g.` / `unlike`), Confirm / Not me / Apply less, and **Reword**, which opens the inline editor (a row cannot collapse while editing). `?trait=<id>` opens and scrolls to that trait once traits load, resetting the Loves/Avoids filter to All when it would hide it; it is read with `useSearchParams` inside a `<Suspense>` boundary (required for the production build) because Next's router navigates with `history.pushState`, so a `#hash` would not react to client navigation. Then the `CustomInstructions` editor, rating distribution, genre breakdown. Also carries the **mobile escape-hatch row** (`sm:hidden`, top-right): links to `/settings` and — gated on `me?.is_admin` — `/admin`. Both routes are unreachable on a phone otherwise, since the `NavBar` link row is `hidden sm:flex` and the `BottomNav` is capped at 5 items (issue #80).
```

Run: `npx prettier --check docs/frontend.md "app/(main)/profile/page.tsx" components/profile components/__tests__/TraitRow.test.tsx components/__tests__/TraitsSection.test.tsx`
Expected: all files formatted. If not, run `npx prettier --write` on the same paths and re-check.

- [ ] **Step 7: Commit**

```bash
git add "app/(main)/profile/page.tsx" docs/frontend.md
git commit -m "feat(profile): mount compact trait rows on /profile (#97)

Claude-Session: <session line from attribution instructions>"
```

---

### Task 4: Full gate and real-browser verification

**Files:** none created; this task is verification. Record observations in the `.superpowers/sdd/` ledger.

- [ ] **Step 1: Run the complete gate**

Run each from the repository root and confirm each passes before moving on:

```bash
npm run test:server
npm test
npm run type-check
npm run lint
npm run format:check
npm run build
```

`npm run test:server` is unaffected by this wave but is part of the gate; run it anyway.

- [ ] **Step 2: Start an isolated local run with 10+ fictional traits**

Follow the procedure in the project memory note `marketing-screenshot-pipeline`: a scratch Postgres in Docker and a local-mode dev server (`ALLOW_LOCAL_AUTH=true`, a non-production `NODE_ENV`) started with **no `.env` file in scope**. Apply the migrations to the scratch database with `DATABASE_URL=<scratch url> npm run db:migrate`. Do not use the production database, and do not spend a real Claude call — seed fictional rows directly instead. Against the scratch database only:

```sql
insert into books (user_id, title, author, goodreads_rating, source)
values
  ('local', 'The Glass Orchard', 'Ines Varga', 5, 'manual'),
  ('local', 'Salt and Signal', 'Tomas Reyes', 4.5, 'manual'),
  ('local', 'A Quiet Engine', 'Mara Holt', 2, 'manual');

insert into taste_traits (user_id, claim, polarity, exhibits, contrasts, inference_confidence, status, user_weight)
values
  ('local', 'Rewards slow, interior character studies where the plot is mostly weather and memory, and lingers on the way a single household changes over a decade', 'reward', '[1,2]', '[3]', 0.86, 'proposed', 1),
  ('local', 'Rewards found family', 'reward', '[1]', '[]', 0.8, 'confirmed', 1),
  ('local', 'Rewards unreliable narrators', 'reward', '[2]', '[]', 0.74, 'edited', 1),
  ('local', 'Rewards dense political world-building', 'reward', '[1,2]', '[]', 0.7, 'proposed', 0.5),
  ('local', 'Rewards short novels under 250 pages', 'reward', '[2]', '[]', 0.66, 'proposed', 1),
  ('local', 'Rewards epistolary structure', 'reward', '[1]', '[]', 0.61, 'proposed', 1),
  ('local', 'Rewards translated fiction', 'reward', '[2]', '[]', 0.58, 'proposed', 1),
  ('local', 'Avoids military SF', 'aversion', '[3]', '[1]', 0.83, 'proposed', 1),
  ('local', 'Avoids grimdark cynicism', 'aversion', '[3]', '[]', 0.72, 'rejected', 1),
  ('local', 'Avoids second-person narration', 'aversion', '[3]', '[]', 0.6, 'proposed', 1),
  ('local', 'Avoids long series commitments', 'aversion', '[3]', '[2]', 0.55, 'proposed', 1),
  ('local', 'Avoids heist plots', 'aversion', '[3]', '[]', 0.5, 'proposed', 1);
```

Adjust the evidence ids to the book ids the insert actually returned (`select id, title from books where user_id = 'local'`). Record the trait ids with `select id, polarity, claim from taste_traits where user_id = 'local' order by id`.

- [ ] **Step 3: Exercise the rows at 1440 px and at 390 px**

In a real browser at 1440 px wide, then again at 390 px, on `/profile`:

1. Every row is collapsed on load; the long first claim is clamped to two lines; confirmed, edited and rejected badges, the `0.5x` marker, and the rejected row's dimming and strike-through are all visible without expanding.
2. Click a claim: the row expands, the claim shows in full, the chevron flips, and no editor opens. Open a second row: both stay open.
3. Tab to a row header and press Enter, then Space: each toggles it and focus stays on the header.
4. In an open row, click **Reword**, type part of a new claim, then click the row header: the row stays open and the draft stays. Press Escape: the editor closes with the old claim. Reword again and save with Cmd/Ctrl+Enter: the new claim persists after a reload.
5. Confirm / Not me / Apply less each update the badge or marker on the collapsed row after collapsing it.
6. Switch the filter to Loves and back to All: rows you had opened are still open.
7. At 390 px, check the header wraps cleanly (badge, claim, percentage, chevron) with no horizontal scroll.

- [ ] **Step 4: Exercise the deep link**

Using the recorded ids:

1. Load `/profile?trait=<id of "Avoids military SF">` directly: that row opens and the page scrolls to it once traits load. Repeat with a cold cache (hard reload with the cache disabled): `TasteHero` above the section waits on four SWR keys, including `archetype`, that the page gate does not, so its skeleton-to-card swap can land after the scroll and push the row down. Record whether the row ends up in view; this is an observation, not a predicted pass. If it drifts, report it as a follow-up rather than fixing it in this wave.
2. The filter-reset path needs a **client-side** navigation (a full load resets the filter anyway), and no in-app link produces `?trait=` until wave 8's grounding chips. Use browser history instead: with `/profile?trait=<avoids id>` loaded, click **Profile** in the nav rail (a client navigation to `/profile`; the page stays mounted), select **Loves**, then press the browser **Back** button. Back is a client-side popstate, so `useSearchParams` changes to the Avoids id again: the filter must reset to All and that row must open and scroll into view.
3. Load `/profile?trait=999999` and `/profile?trait=abc`: nothing opens, nothing scrolls, no console error.
4. After a deep link opens a row, click Confirm on another trait: the page does not jump back to the deep-linked row.

- [ ] **Step 5: Record and hand back**

Write what you observed for Steps 3–4 (including anything that differed from this plan's predictions) into the ledger. Stop the dev server and remove the scratch container. Do not open a PR: the branch ships as one PR after wave 8.
