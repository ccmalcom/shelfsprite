# Reader-Type Sprites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the 16 new reader-type mascot illustrations on every surface that
currently shows a reader archetype as text only.

**Architecture:** The sixteen WebP files move to `public/reader-types/`, with the
PNG masters and `manifest.json` parked in a non-served `assets/reader-types/`. A new
client-safe table, `lib/readerSprites.ts`, maps archetype code to sprite path and
display name; a Jest test pins that table (and the shipped artwork) to the existing
`ARCHETYPES` and `ARCHETYPE_HUES` sources of truth. A single presentational
component, `components/ReaderSprite.tsx`, is consumed by the four archetype
surfaces and renders nothing for an unknown code, so every surface keeps its
current text-only layout as a fallback.

**Tech Stack:** Next.js 16 App Router, React 18, TypeScript (strict), Tailwind,
`next/image`, Jest + Testing Library (`components/**`, `lib/**` outside
`lib/server/`), Vitest (`lib/server/**`, `app/api/**`).

**Spec:** None. This is a bounded change; the approved design is reproduced in
"Design Reference" below and this plan is the only document.

## Global Constraints

- The sixteen archetype codes are owned by `lib/server/archetype.ts::ARCHETYPES`.
  Do not add, rename, or re-tagline an archetype in this work.
- The per-code hues are owned by `lib/tasteAccent.ts::ARCHETYPE_HUES`. Do not
  introduce a second copy of a hue value anywhere in `lib/` or `components/`.
- `lib/readerSprites.ts` must import nothing. Client components import it, and the
  repo already treats client-imported `lib/` modules as bundle-size-sensitive (see
  the `lib/server/rating.ts` note in `CLAUDE.md`).
- Never import from `lib/server/**` inside a client component. Test files may
  import it; `jest.config.js` only excludes `lib/server/` from *test discovery*,
  not from module resolution.
- Reader sprites are decorative: every placement sits adjacent to the archetype's
  code or name. Use `alt=""` + `aria-hidden="true"`, matching the stated rule in
  `components/ShelfSprite.tsx`.
- Inside the drenched taste-hero panel, only panel-ink tokens
  (`text-user-ink`, `bg-user-ink/N`) may be used. The neutral `--muted` / `--faint`
  tokens fail AA on those surfaces — see the comment at `components/TasteHero.tsx:314`.
- Ship WebP only from `public/`. The PNGs are 4MB and must not land in `public/`.
- Gates, all run from the repo root: `npm run test:server`, `npm test`,
  `npm run type-check`, `npm run lint`, `npm run format:check`, `npm run build`.

---

## Design Reference

The four surfaces that render an archetype today, all text-only:

| Surface | File | What it shows now |
|---|---|---|
| Taste hero panel | `components/TasteHero.tsx:317` | code chip, axis line, name, tagline, trait chips |
| Explainer modal | `components/TasteHero.tsx:23` | the four axes; mentions "16 named archetypes", shows none |
| Reveal finale beat | `components/reveal/RevealSequence.tsx:232` | code, name, tagline, hook |
| Share card | `components/ArchetypeShareModal.tsx` | DOM preview **and** an 800x560 canvas PNG export |

The artwork was drawn against this app's own palette: `manifest.json`'s `hue` for
each code equals `ARCHETYPE_HUES[code]`, and its `surface`/`vivid` hexes are what
`tasteAccent()` solves for. One consequence is load-bearing: **on the taste hero
panel the sprite's body color is the panel's own background color.** The sprite
gets a `bg-user-ink/10` disc behind it there — the same token the code chip at
`components/TasteHero.tsx:332` already uses — or it half-vanishes into the field.
The other three surfaces sit on neutral dark (`bg-base`, `bg-surface`,
`bg-elevated`) and need no disc.

---

### Task 1: Relocate assets and add the sprite table

**Files:**
- Move: `public/shelfsprite-reader-types/shelfsprite-reader-types/*.webp` (16 files) → `public/reader-types/`
- Move: `public/shelfsprite-reader-types/shelfsprite-reader-types/{manifest.json,README.md,contact-sheet.png}` and the 16 `*.png` → `assets/reader-types/`
- Delete: `public/shelfsprite-reader-types/` (the doubled directory, plus the vendored `reader-sprites.ts`, whose contents are superseded by the module below)
- Create: `lib/readerSprites.ts`
- Test: `lib/__tests__/readerSprites.test.ts`

**Interfaces:**
- Consumes: `ARCHETYPES` from `@/lib/server/archetype` and `ARCHETYPE_HUES` from `@/lib/tasteAccent` (test only).
- Produces: `interface ReaderSpriteAsset { src: string; name: string }`,
  `READER_SPRITES: Record<string, ReaderSpriteAsset>`,
  `READER_SPRITE_CODES: string[]`,
  `readerSprite(code: string | null | undefined): ReaderSpriteAsset | null`.

- [ ] **Step 1: Move the files**

```bash
mkdir -p public/reader-types assets/reader-types
SRC=public/shelfsprite-reader-types/shelfsprite-reader-types
git mv $SRC/*.webp public/reader-types/
git mv $SRC/manifest.json $SRC/README.md $SRC/contact-sheet.png assets/reader-types/
git mv $SRC/*.png assets/reader-types/
git rm $SRC/reader-sprites.ts
rmdir $SRC public/shelfsprite-reader-types
```

Verify: `ls public/reader-types | wc -l` prints `16`, and
`ls assets/reader-types | wc -l` prints `19` (16 PNGs + contact sheet + manifest +
README). `public/shelfsprite-reader-types` must no longer exist.

- [ ] **Step 2: Write the failing test**

Create `lib/__tests__/readerSprites.test.ts`. It runs in Jest's default `node`
environment (no docblock needed). It reads the manifest and the shipped artwork
from disk, the way `lib/__tests__/tasteAccent.test.ts` already reads files.

```ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { READER_SPRITES, READER_SPRITE_CODES, readerSprite } from '@/lib/readerSprites';
import { ARCHETYPES } from '@/lib/server/archetype';
import { ARCHETYPE_HUES } from '@/lib/tasteAccent';

interface ManifestEntry {
  name: string;
  hue: number;
  png: string;
  webp: string;
}

const manifest = JSON.parse(
  readFileSync(join(process.cwd(), 'assets/reader-types/manifest.json'), 'utf8')
) as Record<string, ManifestEntry>;

const CODES = Object.keys(ARCHETYPES);

describe('readerSprites', () => {
  it('covers every archetype code and no others', () => {
    expect(READER_SPRITE_CODES.slice().sort()).toEqual(CODES.slice().sort());
    expect(READER_SPRITE_CODES).toHaveLength(16);
  });

  it('names each sprite exactly as lib/server/archetype.ts names the archetype', () => {
    for (const code of CODES) {
      expect(READER_SPRITES[code]!.name).toBe(ARCHETYPES[code]!.name);
    }
  });

  it('points at artwork that is actually shipped in public/', () => {
    for (const code of CODES) {
      const src = READER_SPRITES[code]!.src;
      expect(src.startsWith('/reader-types/')).toBe(true);
      expect(existsSync(join(process.cwd(), 'public', src.slice(1)))).toBe(true);
    }
  });

  // The artwork was drawn at tasteAccent's hue for each code, so the sprite's body
  // color IS the drenched panel's background color. If either side is ever
  // re-hued without the other, the hero panel silently goes muddy. Pin it.
  it('was drawn at the same hue tasteAccent solves for', () => {
    for (const code of CODES) {
      expect(manifest[code]!.hue).toBe(ARCHETYPE_HUES[code]!);
      expect(manifest[code]!.name).toBe(ARCHETYPES[code]!.name);
    }
  });

  it('serves the exact webp the manifest records', () => {
    for (const code of CODES) {
      expect(READER_SPRITES[code]!.src).toBe(`/reader-types/${manifest[code]!.webp}`);
    }
  });

  it('returns null rather than a broken path for a missing or unknown code', () => {
    expect(readerSprite(null)).toBeNull();
    expect(readerSprite(undefined)).toBeNull();
    expect(readerSprite('')).toBeNull();
    expect(readerSprite('XXXX')).toBeNull();
    expect(readerSprite('toString')).toBeNull();
  });

  it('resolves a known code to its sprite', () => {
    expect(readerSprite('RCDM')).toEqual({
      src: '/reader-types/rcdm-cerebral-architect.webp',
      name: 'The Cerebral Architect',
    });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx jest lib/__tests__/readerSprites.test.ts`
Expected: FAIL — `Cannot find module '@/lib/readerSprites'`.

- [ ] **Step 4: Write the module**

Create `lib/readerSprites.ts`. The `hasOwnProperty` guard is the same shape
`lib/tasteAccent.ts:71` uses, and it is what makes the `'toString'` case above
return null instead of a function.

```ts
// The sixteen reader-type illustrations. Each was drawn at its code's hue from
// lib/tasteAccent.ts, so a sprite and the drenched panel it sits on share a color;
// lib/__tests__/readerSprites.test.ts pins that agreement, and pins these names to
// lib/server/archetype.ts::ARCHETYPES.
//
// Client components import this module, so it deliberately imports nothing --
// same reasoning as the dependency-free rule on lib/server/rating.ts. The names
// are duplicated here rather than imported from lib/server/ for that reason; the
// test is what keeps the copy honest.

export interface ReaderSpriteAsset {
  /** Public path to the 512x512 transparent WebP. */
  src: string;
  /** Archetype display name, e.g. "The Plot Mechanic". */
  name: string;
}

const BASE = '/reader-types';

export const READER_SPRITES: Record<string, ReaderSpriteAsset> = {
  IPBH: { src: `${BASE}/ipbh-wandering-escapist.webp`, name: 'The Wandering Escapist' },
  IPBM: { src: `${BASE}/ipbm-plot-mechanic.webp`, name: 'The Plot Mechanic' },
  IPDH: { src: `${BASE}/ipdh-serial-thrill-seeker.webp`, name: 'The Serial Thrill-Seeker' },
  IPDM: { src: `${BASE}/ipdm-genre-architect.webp`, name: 'The Genre Architect' },
  ICBH: { src: `${BASE}/icbh-empathic-rover.webp`, name: 'The Empathic Rover' },
  ICBM: { src: `${BASE}/icbm-character-analyst.webp`, name: 'The Character Analyst' },
  ICDH: { src: `${BASE}/icdh-devoted-fan.webp`, name: 'The Devoted Fan' },
  ICDM: { src: `${BASE}/icdm-deep-empath.webp`, name: 'The Deep Empath' },
  RPBH: { src: `${BASE}/rpbh-conscious-adventurer.webp`, name: 'The Conscious Adventurer' },
  RPBM: { src: `${BASE}/rpbm-eclectic-critic.webp`, name: 'The Eclectic Critic' },
  RPDH: { src: `${BASE}/rpdh-committed-purist.webp`, name: 'The Committed Purist' },
  RPDM: { src: `${BASE}/rpdm-structural-connoisseur.webp`, name: 'The Structural Connoisseur' },
  RCBH: { src: `${BASE}/rcbh-literary-wanderer.webp`, name: 'The Literary Wanderer' },
  RCBM: { src: `${BASE}/rcbm-cerebral-explorer.webp`, name: 'The Cerebral Explorer' },
  RCDH: { src: `${BASE}/rcdh-canon-keeper.webp`, name: 'The Canon Keeper' },
  RCDM: { src: `${BASE}/rcdm-cerebral-architect.webp`, name: 'The Cerebral Architect' },
};

/** Canonical display order for the "all sixteen" grid. */
export const READER_SPRITE_CODES: string[] = Object.keys(READER_SPRITES);

export function readerSprite(code: string | null | undefined): ReaderSpriteAsset | null {
  if (!code) return null;
  if (!Object.prototype.hasOwnProperty.call(READER_SPRITES, code)) return null;
  return READER_SPRITES[code]!;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx jest lib/__tests__/readerSprites.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
# git mv / git rm already staged the moves and the deletion.
git add public/reader-types assets/reader-types lib/readerSprites.ts lib/__tests__/readerSprites.test.ts
git status --short   # confirm no stray public/shelfsprite-reader-types entries remain
git commit -m "feat: add reader-type sprite assets and lookup table"
```

---

### Task 2: The ReaderSprite component

**Files:**
- Create: `components/ReaderSprite.tsx`
- Test: `components/__tests__/ReaderSprite.test.tsx`

**Interfaces:**
- Consumes: `readerSprite` from `@/lib/readerSprites` (Task 1).
- Produces: default export
  `ReaderSprite({ code, size, className?, priority? }: { code: string | null | undefined; size: number; className?: string; priority?: boolean })`,
  returning `null` when `code` has no sprite.

- [ ] **Step 1: Write the failing test**

Create `components/__tests__/ReaderSprite.test.tsx`. The `next/image` mock is
copied from `app/(marketing)/__tests__/welcome.test.tsx:8-14`, which is the
established way this repo renders `next/image` under jsdom.

```tsx
/**
 * @jest-environment jsdom
 */
import { render } from '@testing-library/react';
import ReaderSprite from '@/components/ReaderSprite';

// next/image needs no network here, but it warns on unknown props in jsdom; render a plain img
jest.mock('next/image', () => ({
  __esModule: true,
  // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
  default: (props: Record<string, unknown>) => <img {...(props as never)} />,
}));

describe('ReaderSprite', () => {
  it('renders the sprite for a known code', () => {
    const { container } = render(<ReaderSprite code="IPBM" size={180} />);
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute('src', '/reader-types/ipbm-plot-mechanic.webp');
  });

  // The adjacent copy always names the archetype, so announcing the image would
  // just repeat it -- same rule as components/ShelfSprite.tsx.
  it('is decorative', () => {
    const { container } = render(<ReaderSprite code="IPBM" size={180} />);
    const img = container.querySelector('img')!;
    expect(img).toHaveAttribute('alt', '');
    expect(img).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders nothing for an unknown code', () => {
    const { container } = render(<ReaderSprite code="XXXX" size={180} />);
    expect(container.querySelector('img')).toBeNull();
  });

  it('renders nothing when no code has been derived yet', () => {
    const { container } = render(<ReaderSprite code={null} size={180} />);
    expect(container.querySelector('img')).toBeNull();
  });

  it('passes the caller class through', () => {
    const { container } = render(<ReaderSprite code="IPBM" size={96} className="mx-auto" />);
    expect(container.querySelector('img')!.className).toContain('mx-auto');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest components/__tests__/ReaderSprite.test.tsx`
Expected: FAIL — `Cannot find module '@/components/ReaderSprite'`.

- [ ] **Step 3: Write the component**

Create `components/ReaderSprite.tsx`, mirroring `components/ShelfSprite.tsx`.

```tsx
import Image from 'next/image';
import { readerSprite } from '@/lib/readerSprites';

interface ReaderSpriteProps {
  /** Four-letter archetype code. Anything unrecognised renders nothing. */
  code: string | null | undefined;
  /** Rendered size in px. Sources are square, 512x512. */
  size: number;
  className?: string;
  priority?: boolean;
}

/**
 * Reader-type illustration. Decorative by the same rule as ShelfSprite: every
 * placement sits beside the archetype's code or name, so announcing the image
 * would only repeat the adjacent text.
 *
 * Returning null for an unknown code is what keeps accounts that pre-date the
 * archetype feature -- and any future code this artwork doesn't cover -- on the
 * text-only layout instead of showing a broken image.
 */
export default function ReaderSprite({
  code,
  size,
  className = '',
  priority = false,
}: ReaderSpriteProps) {
  const sprite = readerSprite(code);
  if (!sprite) return null;

  return (
    <Image
      src={sprite.src}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      priority={priority}
      sizes={`${size}px`}
      className={className}
    />
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest components/__tests__/ReaderSprite.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add components/ReaderSprite.tsx components/__tests__/ReaderSprite.test.tsx
git commit -m "feat: add ReaderSprite presentational component"
```

---

### Task 3: Sprite on the taste hero panel

**Files:**
- Modify: `components/TasteHero.tsx` — imports at `:1-20`, and the archetype panel return at `:317-351`
- Test: `components/__tests__/TasteHero.test.tsx` (existing; restructure the mock and add cases)

**Interfaces:**
- Consumes: `ReaderSprite` (Task 2) and `readerSprite` (Task 1).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Restructure the existing test's mock**

`components/__tests__/TasteHero.test.tsx` currently pins the archetype to a
`const` at lines 8-17. Later steps need to vary the code, and Jest's hoisting rule
only permits a `jest.mock` factory to close over identifiers prefixed with `mock`.
Rename and make it mutable, and add the `next/image` mock.

Replace lines 1-29 of that file with:

```tsx
/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { TasteHero } from '@/components/TasteHero';
import { ToastProvider } from '@/components/ui';

const DEFAULT_ARCHETYPE = {
  code: 'RCDM',
  name: 'The Cerebral Architect',
  tagline: 'You build cathedrals out of ideas.',
  is_stale: false,
  lens: { score: 0.6, rationale: 'r', letter: 'R' },
  engine: { score: -0.4, rationale: 'r', letter: 'C' },
  range: { score: 0.5, rationale: 'r', letter: 'D' },
  resonance: { score: 0.3, rationale: 'r', letter: 'M' },
};

let mockArchetype: typeof DEFAULT_ARCHETYPE = DEFAULT_ARCHETYPE;

beforeEach(() => {
  mockArchetype = DEFAULT_ARCHETYPE;
});

// next/image needs no network here, but it warns on unknown props in jsdom; render a plain img
jest.mock('next/image', () => ({
  __esModule: true,
  // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
  default: (props: Record<string, unknown>) => <img {...(props as never)} />,
}));

jest.mock('swr', () => ({
  __esModule: true,
  default: (key: string) => {
    if (key === 'archetype') return { data: mockArchetype, isLoading: false };
    // Non-empty: an empty trait list routes TasteHero into its no-profile CTA branch.
    if (key === 'profile-traits')
      return { data: [{ id: 1, claim: 'Prefers dense, structural prose' }], isLoading: false };
    if (key === 'profile-subjects') return { data: { overall: [] }, isLoading: false };
    return { data: { last_profiled_at: '2026-01-01', dirty: false }, isLoading: false };
  },
  useSWRConfig: () => ({ mutate: jest.fn() }),
}));
```

Leave the rest of the file (the `renderHero` helper and the two existing
`describe` cases) untouched.

- [ ] **Step 2: Run the existing tests to confirm the restructure is inert**

Run: `npx jest components/__tests__/TasteHero.test.tsx`
Expected: PASS, 2 tests — the same two that passed before.

- [ ] **Step 3: Commit the test restructure**

```bash
git add components/__tests__/TasteHero.test.tsx
git commit -m "test: make TasteHero's archetype mock varyable per test"
```

- [ ] **Step 4: Write the failing tests**

Append inside the existing `describe('TasteHero', ...)` block:

```tsx
  it('shows the reader-type sprite on the panel', () => {
    const { container } = renderHero();
    const img = container.querySelector('img[src="/reader-types/rcdm-cerebral-architect.webp"]');
    expect(img).not.toBeNull();
  });

  // The sprite's body color is the panel's own background color, so it needs the
  // ink disc behind it or it disappears into the drenched field.
  it('seats the sprite on an ink disc so it separates from the drenched panel', () => {
    const { container } = renderHero();
    const disc = container.querySelector('img[src^="/reader-types/"]')!.parentElement!;
    expect(disc.className).toContain('bg-user-ink/10');
  });

  it('falls back to the text-only panel when the code has no sprite', () => {
    mockArchetype = { ...DEFAULT_ARCHETYPE, code: 'XXXX' };
    const { container } = renderHero();
    expect(container.querySelector('img[src^="/reader-types/"]')).toBeNull();
    expect(screen.getByText('The Cerebral Architect')).toBeInTheDocument();
  });
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `npx jest components/__tests__/TasteHero.test.tsx`
Expected: FAIL — the first two cases fail (`expect(received).not.toBeNull()` and a
`null` parent element); the third already passes, which is correct, it is the
fallback guard.

- [ ] **Step 6: Add the imports**

In `components/TasteHero.tsx`, alongside the existing imports:

```tsx
import ReaderSprite from '@/components/ReaderSprite';
import { readerSprite } from '@/lib/readerSprites';
```

- [ ] **Step 7: Add the sprite size next to the other layout vars**

Immediately after `const padClass = compact ? 'p-5' : 'p-8 sm:p-12';` (currently
`components/TasteHero.tsx:158`):

```tsx
  const spriteSize = compact ? 96 : 180;
```

- [ ] **Step 8: Restructure the panel body into a sprite + text row**

In the archetype-display return (currently `components/TasteHero.tsx:317`), leave
the outer `<div style={accentVars} …>` and the "Reader type / What is this?"
header row exactly as they are. Wrap everything from the code chip through the
tagline in a row, and put the sprite first. Replace the block that currently runs
from `<div className="flex items-center gap-3 mb-1">` through
`<p className="text-sm text-user-ink/85 italic mt-2">{archetype.tagline}</p>`
with:

```tsx
      <div className="flex flex-col items-center gap-6 text-center sm:flex-row sm:items-center sm:gap-8 sm:text-left">
        {readerSprite(archetype.code) && (
          // The sprite is drawn at this panel's own hue, so without a contrasting
          // disc it sinks into the field. bg-user-ink/10 is the same token the
          // code chip below uses.
          <div className="shrink-0 rounded-full bg-user-ink/10 p-3">
            <ReaderSprite code={archetype.code} size={spriteSize} priority />
          </div>
        )}

        <div className="min-w-0">
          <div className="flex items-center justify-center gap-3 mb-1 sm:justify-start">
            <span className="inline-flex items-center rounded-full bg-user-ink/10 px-3 py-1 font-mono text-[1rem] font-medium text-user-ink">
              {archetype.code}
            </span>
          </div>
          <p className="font-mono text-xs text-user-ink/85 mb-3">
            {AXIS_META.map((a, i) => {
              const axisData = archetype[a.key];
              const label = axisData.score < 0 ? a.left : a.right;
              return (
                <span key={a.key}>
                  <span className="text-user-ink">{axisData.letter}</span> {label}
                  {i < 3 ? ' · ' : ''}
                </span>
              );
            })}
          </p>
          <h1 className={[headingClass, 'text-user-ink'].join(' ')}>{archetype.name}</h1>
          <p className="text-sm text-user-ink/85 italic mt-2">{archetype.tagline}</p>
        </div>
      </div>
```

Everything below (the trait chips block onward) stays where it is, as a sibling of
this new row.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx jest components/__tests__/TasteHero.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 10: Commit**

```bash
git add components/TasteHero.tsx components/__tests__/TasteHero.test.tsx
git commit -m "feat: show the reader-type sprite on the taste hero panel"
```

---

### Task 4: All sixteen in the explainer modal

**Files:**
- Modify: `components/TasteHero.tsx` — `ArchetypeExplainerModal` at `:23-97`
- Test: `components/__tests__/TasteHero.test.tsx`

**Interfaces:**
- Consumes: `ReaderSprite` (Task 2), `READER_SPRITE_CODES` (Task 1).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Write the failing test**

Append inside `describe('TasteHero', ...)`:

```tsx
  it('shows all sixteen reader types in the explainer', () => {
    const { container } = renderHero();
    fireEvent.click(screen.getByText('What is this?'));
    const grid = container.querySelectorAll('img[src^="/reader-types/"]');
    // 16 in the explainer grid, plus the one on the panel behind it.
    expect(grid).toHaveLength(17);
    expect(screen.getByText('IPBM')).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest components/__tests__/TasteHero.test.tsx -t 'sixteen'`
Expected: FAIL — received length 1.

- [ ] **Step 3: Extend the import added in Task 3**

In `components/TasteHero.tsx`, widen the readerSprites import:

```tsx
import { readerSprite, READER_SPRITE_CODES } from '@/lib/readerSprites';
```

- [ ] **Step 4: Add the grid to the explainer**

In `ArchetypeExplainerModal`, the paragraph beginning "The four letters combine
into one of 16 named archetypes" (currently `components/TasteHero.tsx:79-83`)
promises the set without showing it. Replace that single `<p>` with the paragraph
plus a grid:

```tsx
          <div>
            <p className="text-muted">
              The four letters combine into one of 16 named archetypes, from The Wandering Escapist
              to The Cerebral Architect. Your code is derived from your actual rated books and taste
              traits, so it should feel like you.
            </p>
            <ul className="mt-4 grid grid-cols-4 gap-3">
              {READER_SPRITE_CODES.map((code) => (
                <li key={code} className="flex flex-col items-center gap-1">
                  <ReaderSprite code={code} size={72} className="h-auto w-full max-w-[4.5rem]" />
                  <span className="font-mono text-[0.625rem] text-faint">{code}</span>
                </li>
              ))}
            </ul>
          </div>
```

This modal is `bg-surface` — neutral dark, not a drenched panel — so `text-faint`
is the correct token here and the drenched-panel ink rule does not apply.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest components/__tests__/TasteHero.test.tsx`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add components/TasteHero.tsx components/__tests__/TasteHero.test.tsx
git commit -m "feat: show all sixteen sprites in the reader-type explainer"
```

---

### Task 5: Sprite on the reveal finale beat

**Files:**
- Modify: `components/reveal/RevealSequence.tsx` — imports at `:1-20`, `renderBeat` export at `:124`, `case 'finale'` at `:232-251`
- Test: `components/__tests__/RevealFinale.test.tsx` (create)

**Interfaces:**
- Consumes: `ReaderSprite` (Task 2).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Export the beat renderer**

The finale arm lives in `renderBeat` (`components/reveal/RevealSequence.tsx:124`),
a module-private function that returns JSX. Reaching the finale through the
default export would mean clicking through six preceding beats, so export
`renderBeat` and render that arm directly. Change line 124 from:

```tsx
function renderBeat(
```

to:

```tsx
/** Exported for the beat-level tests; not part of the public component API. */
export function renderBeat(
```

Change nothing else about it — the signature stays
`renderBeat(beat: Beat, h: { next; onFinish; onClose; onVerdict; verdicts })`.

- [ ] **Step 2: Write the failing test**

Create `components/__tests__/RevealFinale.test.tsx`. `Beat`'s finale variant is
`{ kind: 'finale'; archetype: ArchetypeOut; nBooks: number; thin: boolean }`
(`lib/revealBeats.ts:50`), so the fixture needs a complete `ArchetypeOut` —
including `derived_at` and `is_stale`, which the rendered markup never reads but
the type requires.

```tsx
/**
 * @jest-environment jsdom
 */
import { render } from '@testing-library/react';
import { renderBeat } from '@/components/reveal/RevealSequence';
import type { Beat } from '@/lib/revealBeats';

// next/image needs no network here, but it warns on unknown props in jsdom; render a plain img
jest.mock('next/image', () => ({
  __esModule: true,
  // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
  default: (props: Record<string, unknown>) => <img {...(props as never)} />,
}));

const handlers = {
  next: jest.fn(),
  onFinish: jest.fn(),
  onClose: jest.fn(),
  onVerdict: jest.fn(),
  verdicts: {},
};

function finaleBeat(code: string): Beat {
  return {
    kind: 'finale',
    thin: false,
    nBooks: 214,
    archetype: {
      code,
      name: 'The Devoted Fan',
      tagline: 'I live in this world now.',
      hook: 'reread the whole series to get ready for the new one',
      derived_at: '2026-01-01T00:00:00Z',
      is_stale: false,
      lens: { score: -0.6, rationale: 'r', letter: 'I' },
      engine: { score: -0.4, rationale: 'r', letter: 'C' },
      range: { score: 0.5, rationale: 'r', letter: 'D' },
      resonance: { score: -0.3, rationale: 'r', letter: 'H' },
    },
  };
}

describe('reveal finale', () => {
  it('lands the reader-type sprite on the payoff beat', () => {
    const { container } = render(<>{renderBeat(finaleBeat('ICDH'), handlers)}</>);
    expect(container.querySelector('img[src="/reader-types/icdh-devoted-fan.webp"]')).not.toBeNull();
  });

  it('still renders the finale text when the code has no sprite', () => {
    const { container, getByText } = render(<>{renderBeat(finaleBeat('XXXX'), handlers)}</>);
    expect(container.querySelector('img[src^="/reader-types/"]')).toBeNull();
    expect(getByText('The Devoted Fan')).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx jest components/__tests__/RevealFinale.test.tsx`
Expected: FAIL on the first case — `expect(received).not.toBeNull()`.

- [ ] **Step 4: Add the import**

In `components/reveal/RevealSequence.tsx`:

```tsx
import ReaderSprite from '@/components/ReaderSprite';
```

- [ ] **Step 5: Add the sprite to the finale**

In `case 'finale'`, insert the sprite between the lead-in paragraph and the code
line. The finale frame is `bg-base` (neutral dark, see
`components/reveal/revealFrame.tsx:31`), so no disc is needed here. This is the
payoff beat, so it gets the largest render in the app.

```tsx
          <p className="text-sm text-muted">
            {beat.thin
              ? 'Early read: you might be...'
              : `Four axes. ${beat.nBooks} books of evidence. One reader:`}
          </p>
          <ReaderSprite code={beat.archetype.code} size={200} className="mx-auto block" priority />
          <p className="font-mono text-lg text-user">{beat.archetype.code}</p>
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx jest components/__tests__/RevealFinale.test.tsx`
Expected: PASS, 2 tests.

- [ ] **Step 7: Commit**

```bash
git add components/reveal/RevealSequence.tsx components/__tests__/RevealFinale.test.tsx
git commit -m "feat: land the reader-type sprite on the reveal finale"
```

---

### Task 6: Sprite in the share card and its PNG export

**Files:**
- Modify: `components/ArchetypeShareModal.tsx` — imports at `:1-8`, `handleCopyImage` at `:38-99`, card preview at `:120-140`
- Test: `components/__tests__/ArchetypeShareModal.test.tsx` (create)

**Interfaces:**
- Consumes: `ReaderSprite` (Task 2), `readerSprite` (Task 1).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Write the failing test**

Create `components/__tests__/ArchetypeShareModal.test.tsx`. This covers the DOM
preview only. The canvas export is deliberately **not** unit-tested: jsdom has no
2D context, so `canvas.getContext('2d')` returns null and `handleCopyImage`
returns at its existing guard before drawing anything — a test there would assert
the guard, not the export. The export is verified in the browser in Task 7.

```tsx
/**
 * @jest-environment jsdom
 */
import { render } from '@testing-library/react';
import { ArchetypeShareModal } from '@/components/ArchetypeShareModal';
import { ToastProvider } from '@/components/ui';

// next/image needs no network here, but it warns on unknown props in jsdom; render a plain img
jest.mock('next/image', () => ({
  __esModule: true,
  // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
  default: (props: Record<string, unknown>) => <img {...(props as never)} />,
}));

const archetype = {
  code: 'RPBH',
  name: 'The Conscious Adventurer',
  tagline: 'Beautiful prose AND a great story.',
  hook: 'refuses to choose between a page-turner and a poem',
  derived_at: '2026-01-01T00:00:00Z',
  is_stale: false,
  lens: { score: 0.6, rationale: 'r', letter: 'R' },
  engine: { score: -0.4, rationale: 'r', letter: 'P' },
  range: { score: -0.5, rationale: 'r', letter: 'B' },
  resonance: { score: -0.3, rationale: 'r', letter: 'H' },
};

function renderModal(code = archetype.code) {
  return render(
    <ToastProvider>
      <ArchetypeShareModal archetype={{ ...archetype, code } as never} onClose={jest.fn()} />
    </ToastProvider>
  );
}

describe('ArchetypeShareModal', () => {
  it('puts the sprite on the share card preview', () => {
    const { container } = renderModal();
    expect(
      container.querySelector('img[src="/reader-types/rpbh-conscious-adventurer.webp"]')
    ).not.toBeNull();
  });

  it('still renders the card when the code has no sprite', () => {
    const { container, getByText } = renderModal('XXXX');
    expect(container.querySelector('img[src^="/reader-types/"]')).toBeNull();
    expect(getByText('The Conscious Adventurer')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest components/__tests__/ArchetypeShareModal.test.tsx`
Expected: FAIL on the first case — `expect(received).not.toBeNull()`.

- [ ] **Step 3: Add the imports**

In `components/ArchetypeShareModal.tsx`:

```tsx
import ReaderSprite from '@/components/ReaderSprite';
import { readerSprite } from '@/lib/readerSprites';
```

- [ ] **Step 4: Add the sprite to the DOM preview**

The card is `text-center` and every child carries `relative` to sit above the
accent wash. Insert between the `ShelfSprite` wordmark `<p>` and the code `<p>`
(currently `components/ArchetypeShareModal.tsx:132-138`):

```tsx
          <p className="relative font-mono text-xs text-muted mb-3">ShelfSprite</p>
          <ReaderSprite code={archetype.code} size={96} className="relative mx-auto mb-3 block" />
          <p
            className="relative font-mono text-5xl font-bold tracking-widest mb-2"
            style={{ color: accentColor }}
          >
            {archetype.code}
          </p>
```

- [ ] **Step 5: Decode the sprite before drawing the export**

At the top of `handleCopyImage`, after the `ctx` null guard and before the
background fill, load the sprite. Decoding must be awaited: `drawImage` on an
undecoded image silently draws nothing.

```tsx
    // A sprite that won't decode must not cost the user their share image, so a
    // failure here falls through to the original text-only layout below.
    let spriteImg: HTMLImageElement | null = null;
    const sprite = readerSprite(archetype.code);
    if (sprite) {
      try {
        const img = new window.Image();
        img.src = sprite.src;
        await img.decode();
        spriteImg = img;
      } catch {
        spriteImg = null;
      }
    }
```

- [ ] **Step 6: Reflow the canvas layout around the sprite**

The sprite occupies 160px that the current layout does not have. Draw it, then
shift the text baselines — and keep the existing baselines exactly as they are on
the no-sprite path, so that fallback stays pixel-identical to today's export.

Immediately after the existing wordmark `fillText` call, add:

```tsx
    // 800x560 canvas. The sprite sits centered under the accent wash; every text
    // baseline below shifts down to make room, and reverts to today's geometry
    // when there is no sprite to draw.
    if (spriteImg) ctx.drawImage(spriteImg, 320, 80, 160, 160);

    const codeSize = spriteImg ? 80 : 96;
    const codeY = spriteImg ? 320 : 230;
    const nameY = spriteImg ? 372 : 300;
    const taglineY = spriteImg ? 414 : 350;
    const axisY = spriteImg ? 474 : 430;
    const borderY = spriteImg ? 505 : 480;
```

Then change the five draw calls that follow to use those vars:

```tsx
    // Code
    ctx.fillStyle = accentColor;
    ctx.font = `bold ${codeSize}px monospace`;
    ctx.textAlign = 'center';
    ctx.fillText(archetype.code, 400, codeY);

    // Name
    ctx.fillStyle = '#f5f0eb';
    ctx.font = 'bold 36px system-ui, sans-serif';
    ctx.fillText(archetype.name, 400, nameY);

    // Tagline
    ctx.fillStyle = '#a3a09d';
    ctx.font = 'italic 20px system-ui, sans-serif';
    ctx.fillText(archetype.tagline, 400, taglineY);

    // Axis labels row
    ctx.fillStyle = '#6b6866';
    ctx.font = '16px monospace';
    ctx.fillText(axisPairs, 400, axisY);

    // Bottom border — archetype color
    ctx.fillStyle = accentColor;
    ctx.fillRect(56, borderY, 688, 2);
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx jest components/__tests__/ArchetypeShareModal.test.tsx`
Expected: PASS, 2 tests.

- [ ] **Step 8: Commit**

```bash
git add components/ArchetypeShareModal.tsx components/__tests__/ArchetypeShareModal.test.tsx
git commit -m "feat: put the reader-type sprite on the share card and PNG export"
```

---

### Task 7: Full gate pass and browser verification

**Files:** none created; fixes land in whichever file a gate implicates.

**Interfaces:**
- Consumes: everything from Tasks 1-6.
- Produces: a verified, shippable branch.

- [ ] **Step 1: Run every gate**

```bash
npm run test:server
npm test
npm run type-check
npm run lint
npm run format:check
npm run build
```

All six must pass. `npm run build` is not optional here: it is the only gate that
catches Next segment-config and prerender failures, and this change touches
`next/image` on a prerendered page. If `format:check` fails, run `npm run format`
and amend.

- [ ] **Step 2: Confirm no PNG shipped to public/**

```bash
find public/reader-types -type f -not -name '*.webp'
du -sh public/reader-types
```

Expected: no output from `find`, and roughly 572K from `du`.

- [ ] **Step 3: Run the app against a throwaway local library**

The archetype surfaces need a profile with rated books. Use the
`isolated-local-env` skill's SQLite library if it is current, otherwise run
`npm run dev` against the dev Supabase project. Note: that skill's SKILL.md
documents the retired Python backend, so verify its steps before following them.

- [ ] **Step 4: Verify each surface in the browser**

Confirm by eye, not by test output:

1. **Taste hero** — sprite renders at 180px on the drenched panel and reads
   clearly against it; the ink disc is doing its job, not making a grey blob.
   Narrow the window below `sm` and confirm the layout stacks and centers.
2. **Explainer modal** — click "What is this?"; all 16 render in a 4x4 grid, none
   broken, and the grid does not overflow the modal at mobile width.
3. **Reveal finale** — run the reveal to the finale beat; the sprite lands at
   200px above the code.
4. **Share card** — open the share modal, confirm the 96px sprite, then click
   "Copy as image" and **paste the result somewhere to look at it**. The sprite
   must actually be in the PNG, and the text below it must not collide with it.

A green test suite is not verification for any of these four. Fix whatever looks
wrong and re-run the gates.

- [ ] **Step 5: Report**

State which of the four surfaces were visually confirmed and paste the gate
output. If any surface could not be reached (for example, the reveal needs a
freshly derived profile), say so explicitly rather than implying it passed.
