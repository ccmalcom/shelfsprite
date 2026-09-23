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
