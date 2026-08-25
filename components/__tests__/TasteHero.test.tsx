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

// TasteHero calls useToast, which throws outside a provider.
function renderHero() {
  return render(
    <ToastProvider>
      <TasteHero />
    </ToastProvider>
  );
}

describe('TasteHero', () => {
  it('renders the archetype panel as a drenched user-colored field', () => {
    const { container } = renderHero();
    const panel = container.firstElementChild as HTMLElement;
    expect(panel.className).toContain('bg-user-surface');
    expect(panel.className).not.toContain('bg-surface');
  });

  it('names the archetype in ink that sits on the drenched panel', () => {
    renderHero();
    expect(screen.getByText('The Cerebral Architect').className).toContain('text-user-ink');
  });

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
});
