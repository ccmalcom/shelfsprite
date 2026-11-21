/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import NextReadPage from '@/app/(main)/next-read/page';
import { api } from '@/lib/api';

const mutate = jest.fn();
jest.mock('swr', () => ({
  __esModule: true,
  default: () => ({ data: undefined, isLoading: false, error: undefined }),
  mutate: (...args: unknown[]) => mutate(...args),
}));
jest.mock('@/lib/api', () => ({
  ...jest.requireActual('@/lib/api'),
  api: {
    ...jest.requireActual('@/lib/api').api,
    nextRead: jest.fn(),
    setBookShelf: jest.fn(),
  },
}));

const nextRead = api.nextRead as jest.Mock;
const setBookShelf = api.setBookShelf as jest.Mock;

const book = (id: number, title: string) => ({
  id,
  title,
  author: `${title} Author`,
  cover_url: null,
  exclusive_shelf: 'to-read',
});

describe('/next-read', () => {
  beforeEach(() => {
    nextRead.mockReset();
    setBookShelf.mockReset();
    mutate.mockClear();
  });

  it('shows the picks with their reasons, once', async () => {
    nextRead.mockResolvedValue({
      count: 2,
      to_read_count: 2,
      considered: 2,
      model: 'm',
      picks: [
        { rank: 1, score: 0.9, rationale: 'Quiet and sharp.', book: book(7, 'Gilead') },
        { rank: 2, score: 0.7, rationale: 'A longer swing.', book: book(8, 'Middlemarch') },
      ],
    });
    render(<NextReadPage />);
    expect(await screen.findByText('Gilead')).toBeInTheDocument();
    expect(screen.getByText('Quiet and sharp.')).toBeInTheDocument();
    expect(screen.getByText('Read this next')).toBeInTheDocument();
    expect(nextRead).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/most recently saved/)).not.toBeInTheDocument();
  });

  it('"Start reading" moves the book to Currently reading', async () => {
    nextRead.mockResolvedValue({
      count: 1,
      to_read_count: 200,
      considered: 150,
      model: 'm',
      picks: [{ rank: 1, score: 0.9, rationale: 'r', book: book(7, 'Gilead') }],
    });
    setBookShelf.mockResolvedValue({ id: 7 });
    render(<NextReadPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start reading' }));
    await waitFor(() => expect(setBookShelf).toHaveBeenCalledWith(7, 'currently-reading'));
    expect(await screen.findByText('On your Currently reading shelf.')).toBeInTheDocument();
    expect(mutate).toHaveBeenCalledWith('books-to-read', undefined, { revalidate: true });
    expect(screen.getByText(/150 most recently saved books of 200/)).toBeInTheDocument();
  });

  it('shows the server’s reason when there is nothing to rank', async () => {
    nextRead.mockRejectedValue(
      new Error('Your to-read shelf is empty. Save a few books to it first.')
    );
    render(<NextReadPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('to-read shelf is empty');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
