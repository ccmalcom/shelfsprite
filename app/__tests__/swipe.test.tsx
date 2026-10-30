/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import SwipePage from '@/app/(main)/swipe/page';
import { ToastProvider } from '@/components/ui';
import { PROFILE_STATUS_KEY, REJECT_REASONS, type Recommendation, type Trait } from '@/lib/api';

const mockFeedback = jest.fn();
const mockSetBookFeedback = jest.fn();
const mockMutate = jest.fn();
const mockFire = jest.fn();

const rec = (id: number, over: Partial<Recommendation> = {}): Recommendation => ({
  id,
  run_id: 'run-1',
  rank: id,
  title: `Book ${id}`,
  author: 'Edith Wharton',
  year: 1911,
  isbn13: null,
  cover_url: null,
  subjects: ['Classics'],
  description: 'A winter in Starkfield.',
  catalog_source: null,
  catalog_id: null,
  retrieval_pool: 'metadata',
  seed_reason: null,
  score: 0.9,
  rationale: 'Spare, wintry, and devastating, like the novels you rate highest.',
  grounded_trait_ids: [1, 2],
  grounded_book_ids: [],
  status: 'served',
  user_note: null,
  created_at: '2026-10-30T00:00:00',
  ...over,
});

const trait = (id: number, polarity: string, claim: string): Trait => ({
  id,
  claim,
  reveal_line: null,
  polarity,
  exhibits: null,
  contrasts: null,
  inference_confidence: 0.8,
  status: 'proposed',
  user_weight: null,
  user_note: null,
  created_at: '2026-10-30T00:00:00',
});

let recs: Recommendation[] = [];
const traits = [
  trait(1, 'reward', 'Loves restrained, wintry tragedy'),
  trait(2, 'aversion', 'Averse to sweeping, thesis-driven popular history'),
];

jest.mock('swr', () => ({
  __esModule: true,
  default: (key: string) => ({
    data: key === 'recommendations' ? recs : key === 'profile' ? traits : undefined,
    isLoading: false,
    error: undefined,
    mutate: jest.fn(),
  }),
  mutate: (...args: unknown[]) => mockMutate(...args),
}));

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('@/components/ShelfSprite', () => ({ __esModule: true, default: () => <div /> }));
jest.mock('@/hooks/useFeedbackPrompt', () => ({
  useFeedbackPrompt: () => ({ fire: mockFire, modal: null }),
}));

jest.mock('@/lib/api', () => {
  const actual = jest.requireActual('@/lib/api');
  return {
    ...actual,
    api: {
      ...actual.api,
      feedback: (...args: unknown[]) => mockFeedback(...args),
      setBookFeedback: (...args: unknown[]) => mockSetBookFeedback(...args),
    },
  };
});

function renderSwipe() {
  return render(
    <ToastProvider>
      <SwipePage />
    </ToastProvider>
  );
}

beforeEach(() => {
  recs = [rec(1), rec(2)];
  mockFeedback.mockReset();
  mockFeedback.mockResolvedValue({ status: 'already_read', user_note: null, book: { id: 77 } });
  mockSetBookFeedback.mockReset();
  mockSetBookFeedback.mockResolvedValue({});
  mockMutate.mockClear();
  mockFire.mockClear();
});

describe('swipe page "Already read"', () => {
  it('Cancel records nothing and leaves the card on the deck', () => {
    renderSwipe();
    fireEvent.click(screen.getByRole('button', { name: 'Already read' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockFeedback).not.toHaveBeenCalled();
    expect(screen.getByText('0 / 2 reviewed')).toBeInTheDocument();
  });

  it('records the verdict only on "Mark as read", and holds the profile refresh mid-deck', async () => {
    renderSwipe();
    fireEvent.click(screen.getByRole('button', { name: 'Already read' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark as read' }));

    await waitFor(() => expect(mockFeedback).toHaveBeenCalledWith(1, { status: 'already_read' }));
    // Unrated: no rating call.
    expect(mockSetBookFeedback).not.toHaveBeenCalled();
    expect(screen.getByText('1 / 2 reviewed')).toBeInTheDocument();
    // The banner must not drop in above the card while the deck is still going.
    expect(mockMutate).not.toHaveBeenCalledWith(PROFILE_STATUS_KEY);
  });

  it('saves the rating with the verdict and refreshes the profile once the batch is done', async () => {
    recs = [rec(1)];
    renderSwipe();
    fireEvent.click(screen.getByRole('button', { name: 'Already read' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('radio', { name: '4 stars' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark as read' }));

    await waitFor(() => expect(mockSetBookFeedback).toHaveBeenCalledWith(77, { rating: 4 }));
    await waitFor(() => expect(mockMutate).toHaveBeenCalledWith(PROFILE_STATUS_KEY));
    expect(mockFire).toHaveBeenCalled();
  });
});

describe('swipe page short batches (QA 2026-10-30)', () => {
  // The reranker may now serve fewer than ten picks (floor of five), so the deck must count
  // the batch it has, not assume ten.
  it('counts a six-card deck as six', () => {
    recs = [1, 2, 3, 4, 5, 6].map((id) => rec(id));
    renderSwipe();
    expect(screen.getByText('0 / 6 reviewed')).toBeInTheDocument();
  });

  it('reports the whole short batch once every card is decided, even after a reload', () => {
    recs = [1, 2, 3, 4, 5].map((id) =>
      rec(id, { status: id % 2 ? 'accepted' : 'rejected' } as Partial<Recommendation>)
    );
    renderSwipe();
    expect(screen.getByText("That's the batch.")).toBeInTheDocument();
    expect(screen.getByText(/All 5 picks reviewed\./)).toBeInTheDocument();
  });
});

describe('swipe page skip reasons', () => {
  it('labels exactly the server vocabulary', () => {
    // Mirrors REJECT_REASONS in lib/server/recs.ts, which Jest cannot import (it pulls in
    // the database); change both together.
    expect(Object.keys(REJECT_REASONS)).toEqual([
      'wrong_genre',
      'too_dark',
      'tried_author',
      'too_long',
      'not_now',
      'overhyped',
      'wrong_vibe',
      'too_similar',
      'not_out_yet',
      'not_my_kind',
    ]);
  });

  it('offers the new reasons alongside the old ones', () => {
    renderSwipe();
    fireEvent.click(screen.getByRole('button', { name: 'Not interested' }));
    const dialog = screen.getByRole('dialog');
    for (const label of [
      "Too similar to what I've read",
      'Not out yet',
      'Not the kind of book I read',
      'Wrong genre',
    ]) {
      expect(within(dialog).getByRole('button', { name: label })).toBeInTheDocument();
    }
  });
});

describe('swipe card', () => {
  it('lists loves as matches, never aversions', () => {
    renderSwipe();
    expect(screen.getAllByText('Loves restrained, wintry tragedy').length).toBeGreaterThan(0);
    expect(screen.queryByText(/Averse to/)).not.toBeInTheDocument();
  });

  it('puts "Why for you" ahead of the description', () => {
    renderSwipe();
    const card = screen.getAllByRole('heading', { name: 'Book 1' })[0].closest('div.drag-card');
    const text = card?.textContent ?? '';
    expect(text.indexOf('Why for you')).toBeGreaterThan(-1);
    expect(text.indexOf('Why for you')).toBeLessThan(text.indexOf('About'));
  });
});
