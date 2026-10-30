/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import TitleRecCard from '@/components/screen/TitleRecCard';
import type { Book, TitleOut, TitleRec, Trait } from '@/lib/api';
import { makeRec, makeTitle } from '@/lib/__tests__/fixtures/screenFixtures';

const reward = (id: number, claim: string, over: Partial<Trait> = {}) =>
  ({ id, claim, polarity: 'reward', status: 'proposed', ...over }) as Trait;
const trait = reward(5, 'Loves slow-burn procedurals');
const LONG_CLAIM =
  'Rewards films that hold a single quiet domestic setting and let small gestures carry the drama';
const traitList: Trait[] = [
  trait,
  reward(6, LONG_CLAIM),
  reward(7, 'Loves ensemble casts'),
  reward(8, 'Loves long takes'),
  reward(9, 'Penalizes effects that feel engineered for awards', { polarity: 'aversion' }),
  reward(10, 'Loves heist plots', { status: 'rejected' }),
];
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
      traits={new Map(traitList.map((t) => [t.id, t]))}
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
    fireEvent.click(screen.getByRole('button', { name: 'Book: Dune' }));
    expect(h.onOpenBook).toHaveBeenCalledWith(dune);
  });

  it('shows a word-boundary label for a long trait, with the full claim as tooltip', () => {
    renderCard(makeRec({ grounded_trait_ids: [6] }));
    const link = screen.getByRole('link', { name: LONG_CLAIM });
    expect(link).toHaveAttribute('title', LONG_CLAIM);
    const shown = link.textContent ?? '';
    expect(shown.length).toBeLessThanOrEqual(40);
    expect(shown.endsWith('\u2026')).toBe(true);
    expect(LONG_CLAIM.startsWith(shown.slice(0, -1))).toBe(true);
  });

  it('caps trait reasons at three, skipping aversions and dismissed traits', () => {
    renderCard(makeRec({ grounded_trait_ids: [9, 10, 5, 6, 7, 8] }));
    const links = screen.getAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/screen/profile?trait=5',
      '/screen/profile?trait=6',
      '/screen/profile?trait=7',
    ]);
    expect(screen.queryByRole('link', { name: /Penalizes/ })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Loves heist plots' })).toBeNull();
  });

  it('hides the reasons list when only aversions were cited', () => {
    renderCard(makeRec({ grounded_trait_ids: [9] }));
    expect(screen.queryByRole('list', { name: 'Why this pick' })).toBeNull();
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
