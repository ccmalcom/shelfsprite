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
