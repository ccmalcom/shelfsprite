/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ManualStep, enrichEstimate } from '@/components/SetupWizard';
import { ToastProvider } from '@/components/ui';
import type { Book } from '@/lib/api';

const mockSetBookFeedback = jest.fn();
const mockRemoveBook = jest.fn();

jest.mock('swr', () => ({
  __esModule: true,
  default: () => ({ data: undefined, mutate: jest.fn() }),
  mutate: jest.fn(async () => undefined),
}));

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }));

jest.mock('next/image', () => ({
  __esModule: true,
  // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
  default: (props: Record<string, unknown>) => <img {...(props as never)} />,
}));

jest.mock('@/hooks/useFeedbackPrompt', () => ({
  useFeedbackPrompt: () => ({ fire: jest.fn(), modal: null }),
}));

jest.mock('@/components/reveal/RevealSequence', () => ({ __esModule: true, default: () => null }));

function book(id: number, title: string, rating: number | null): Book {
  return {
    id,
    title,
    author: 'Toni Morrison',
    isbn13: null,
    exclusive_shelf: 'read',
    goodreads_rating: 0,
    app_rating: rating,
    app_review: null,
    effective_rating: rating,
    year_published: null,
    page_count: null,
    date_read: null,
    date_added: '2026-10-30',
    cover_url: null,
    confidence_label: 'MANUAL',
    resolution_confidence: 1,
    exclude_from_profile: false,
    is_favorite: false,
  };
}

// The modal is covered elsewhere; this stub hands the step two books as if added.
jest.mock('@/components/AddBookModal', () => ({
  __esModule: true,
  default: ({ onAdded }: { onAdded: (b: Book) => void }) => (
    <button
      type="button"
      onClick={() => {
        onAdded(book(1, 'Beloved', 5));
        onAdded(book(2, 'Sula', 3));
      }}
    >
      stub add
    </button>
  ),
}));

jest.mock('@/lib/api', () => ({
  api: {
    setBookFeedback: (...args: unknown[]) => mockSetBookFeedback(...args),
    removeBook: (...args: unknown[]) => mockRemoveBook(...args),
    stats: jest.fn(async () => ({})),
  },
  API_KEY_STATUS_KEY: '/settings/api-key',
  PROFILE_STATUS_KEY: '/profile/status',
  USER_PROFILE_KEY: '/me',
}));

function renderWithTwoBooks() {
  render(
    <ToastProvider>
      <ManualStep onDone={jest.fn()} />
    </ToastProvider>
  );
  fireEvent.click(screen.getByRole('button', { name: '+ Add a book' }));
  fireEvent.click(screen.getByRole('button', { name: 'stub add' }));
}

beforeEach(() => {
  mockSetBookFeedback.mockReset();
  mockRemoveBook.mockReset();
});

describe('setup manual step', () => {
  it('removes a book added by mistake', async () => {
    mockRemoveBook.mockResolvedValue({ id: 2, title: 'Sula', removed: true });
    renderWithTwoBooks();

    fireEvent.click(screen.getByRole('button', { name: 'Remove Sula' }));

    await waitFor(() => expect(screen.queryByText('Sula')).not.toBeInTheDocument());
    expect(mockRemoveBook).toHaveBeenCalledWith(2);
    expect(screen.getByText('Beloved')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Finish with 1 book' })).toBeInTheDocument();
  });

  it('keeps the book when the remove fails', async () => {
    mockRemoveBook.mockRejectedValue(new Error('Remove failed (500)'));
    renderWithTwoBooks();

    fireEvent.click(screen.getByRole('button', { name: 'Remove Sula' }));

    expect(await screen.findByText('Remove failed (500)')).toBeInTheDocument();
    expect(screen.getByText('Sula')).toBeInTheDocument();
  });

  it('changes a rating in place, including to a half star', async () => {
    mockSetBookFeedback.mockResolvedValue({ app_rating: 3.5, effective_rating: 3.5 });
    renderWithTwoBooks();

    const sula = screen.getByRole('radiogroup', { name: /Rating for Sula/ });
    fireEvent.click(within(sula).getByRole('radio', { name: '3.5 stars' }));

    await waitFor(() =>
      expect(within(sula).getByRole('radio', { name: '3.5 stars' })).toHaveAttribute(
        'aria-checked',
        'true'
      )
    );
    expect(mockSetBookFeedback).toHaveBeenCalledWith(2, { rating: 3.5 });
  });

  it('states the real cold-start threshold rather than "five or six favorites"', () => {
    renderWithTwoBooks();
    expect(screen.getByText(/at least 12, including 8 you loved/)).toBeInTheDocument();
    expect(screen.queryByText(/five or six/i)).not.toBeInTheDocument();
  });
});

describe('enrichEstimate', () => {
  it('says under a minute for a small library', () => {
    expect(enrichEstimate(13)).toBe('Usually under a minute for a library this size.');
  });

  it('scales with a large library', () => {
    expect(enrichEstimate(1200)).toBe('About 10 minutes for 1,200 books.');
  });
});
