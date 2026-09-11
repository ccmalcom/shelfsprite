/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import CurrentReads from '@/components/CurrentReads';
import { api } from '@/lib/api';

const mockBook = {
  id: 1,
  title: 'Piranesi',
  author: 'Susanna Clarke',
  cover_url: null,
  exclusive_shelf: 'currently-reading',
};
jest.mock('swr', () => ({
  __esModule: true,
  default: function useMockSWR() {
    const [data, setData] = useState([mockBook]);
    return {
      data,
      mutate: async (updater?: (books: unknown[]) => unknown[]) => {
        if (updater) setData(updater as never);
      },
    };
  },
  mutate: jest.fn(),
}));
jest.mock('@/lib/api', () => ({
  ...jest.requireActual('@/lib/api'),
  api: { setBookShelf: jest.fn() },
}));
jest.mock('@/components/BookEditModal', () => ({
  __esModule: true,
  default: ({ book }: { book: { title: string } }) => <div role="dialog">Review {book.title}</div>,
}));

afterEach(() => jest.clearAllMocks());
it('keeps the review open after finishing the last current read', async () => {
  (api.setBookShelf as jest.Mock).mockResolvedValue({});
  render(<CurrentReads />);
  fireEvent.click(screen.getByRole('button', { name: 'Mark finished' }));
  await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('Piranesi'));
  expect(screen.getByText(/Nothing in progress/)).toBeInTheDocument();
  expect(api.setBookShelf).toHaveBeenCalledWith(1, 'read');
});
it('keeps the book on the shelf when finishing fails', async () => {
  (api.setBookShelf as jest.Mock).mockRejectedValue(new Error('Please retry'));
  render(<CurrentReads />);
  fireEvent.click(screen.getByRole('button', { name: 'Mark finished' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Please retry');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Piranesi' })).toBeInTheDocument();
});
