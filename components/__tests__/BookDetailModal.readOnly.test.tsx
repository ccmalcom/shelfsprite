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

const SHELF_ACTIONS = [
  'Start reading',
  'Mark finished',
  'Did not finish',
  'Remove',
  'Find similar reads',
];

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
