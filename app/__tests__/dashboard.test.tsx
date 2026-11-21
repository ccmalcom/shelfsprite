/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import HomePage from '@/app/(main)/page';
import { ToastProvider } from '@/components/ui';
import { api } from '@/lib/api';

const mutate = jest.fn();
let mockProfileStatus: unknown;
let mockSwrData: Record<string, unknown> = {};
jest.mock('swr', () => ({
  __esModule: true,
  default: (key: string) => ({
    data: key === 'profile-status' ? mockProfileStatus : mockSwrData[key],
    isLoading: false,
    error: undefined,
  }),
  mutate: (...args: unknown[]) => mutate(...args),
}));
const push = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
jest.mock('@/lib/api', () => ({
  ...jest.requireActual('@/lib/api'),
  api: {
    ...jest.requireActual('@/lib/api').api,
    runRecommend: jest.fn(),
    setNextReadPrompt: jest.fn(),
  },
}));

const runRecommend = api.runRecommend as jest.Mock;
const setNextReadPrompt = api.setNextReadPrompt as jest.Mock;

/** A to-read shelf of `n` books, as GET /books?shelf=to-read returns it. */
const shelf = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1, title: `Saved ${i + 1}`, author: null }));

// HomePage calls useToast, which throws outside a provider.
function renderDashboard() {
  return render(
    <ToastProvider>
      <HomePage />
    </ToastProvider>
  );
}

describe('dashboard', () => {
  beforeEach(() => {
    mockProfileStatus = { last_profiled_at: '2026-09-01', dirty: false };
    mockSwrData = {};
    push.mockClear();
    mutate.mockClear();
    runRecommend.mockReset();
    setNextReadPrompt.mockReset();
  });

  it('puts reading actions above the compact identity', () => {
    const { container } = renderDashboard();
    expect(container.innerHTML.indexOf('Find my next books')).toBeLessThan(
      container.innerHTML.indexOf('Your reader type')
    );
    expect(screen.getByRole('heading', { name: 'Currently reading' })).toBeInTheDocument();
  });

  it.each([
    undefined,
    { last_profiled_at: null, dirty: false },
    { last_profiled_at: '2026-09-01', dirty: true, changed_books: 2 },
  ])('blocks recommendations until a current profile is known: %p', (status) => {
    mockProfileStatus = status;
    renderDashboard();
    expect(screen.getByRole('button', { name: /find my next books/i })).toBeDisabled();
  });

  it('does not block on dirt the run gate ignores (trait verdicts, skipped picks)', () => {
    // POST /recommend refuses only on changed books; a reveal verdict or a skipped pick
    // marks the profile dirty without changing any book.
    mockProfileStatus = { last_profiled_at: '2026-09-01', dirty: true, changed_books: 0 };
    renderDashboard();
    expect(screen.getByRole('button', { name: /find my next books/i })).toBeEnabled();
    expect(screen.queryByText(/your library changed/i)).not.toBeInTheDocument();
  });

  it('sends the reader to the swipe deck once a run actually served picks', async () => {
    runRecommend.mockResolvedValue({ run_id: 'abc123abc123', served: 10 });
    renderDashboard();
    fireEvent.click(screen.getByRole('button', { name: /find my next books/i }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/swipe'));
    // The deck reads SWR key 'recommendations'; the explicit `undefined` clears the
    // cached entry, without which /swipe paints the previous, fully-swiped batch until
    // its refetch resolves.
    expect(mutate).toHaveBeenCalledWith('recommendations', undefined, { revalidate: true });
  });

  it('keeps the reader on the home page when a run serves nothing', async () => {
    runRecommend.mockResolvedValue({
      run_id: null,
      served: 0,
      note: 'The reranker returned no usable picks from 60 candidates.',
    });
    renderDashboard();
    fireEvent.click(screen.getByRole('button', { name: /find my next books/i }));
    await waitFor(() => expect(screen.getByText(/no usable picks/i)).toBeInTheDocument());
    expect(push).not.toHaveBeenCalled();
  });

  it('greets a reader with no recommendation runs yet as a first visit', () => {
    mockSwrData = { 'user-profile': { display_name: 'Ada' }, recommendations: [] };
    renderDashboard();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Welcome, Ada.');
  });

  it('welcomes a reader back once a run exists', () => {
    mockSwrData = { 'user-profile': { display_name: 'Ada' }, recommendations: [{ id: 1 }] };
    renderDashboard();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Welcome back, Ada.');
  });

  describe('to-read prompt', () => {
    const findButton = () => screen.getByRole('button', { name: /find my next books/i });

    it('offers the shelf first once ten books are saved, and runs nothing yet', () => {
      mockSwrData = { 'books-to-read': shelf(10), 'settings-next-read': { prompt: true } };
      renderDashboard();
      fireEvent.click(findButton());
      expect(screen.getByRole('dialog')).toHaveTextContent('You have 10 books waiting.');
      expect(runRecommend).not.toHaveBeenCalled();
    });

    it('sends "Pick from my to-read shelf" to the next-read page', () => {
      mockSwrData = { 'books-to-read': shelf(12), 'settings-next-read': { prompt: true } };
      renderDashboard();
      fireEvent.click(findButton());
      fireEvent.click(screen.getByRole('button', { name: /pick from my to-read shelf/i }));
      expect(push).toHaveBeenCalledWith('/next-read');
      expect(runRecommend).not.toHaveBeenCalled();
      expect(setNextReadPrompt).not.toHaveBeenCalled();
    });

    it('"Find new books anyway" with "Don\'t ask again" saves the opt-out and runs', async () => {
      mockSwrData = { 'books-to-read': shelf(10), 'settings-next-read': { prompt: true } };
      setNextReadPrompt.mockResolvedValue({ prompt: false });
      runRecommend.mockResolvedValue({ run_id: 'abc123abc123', served: 10 });
      renderDashboard();
      fireEvent.click(findButton());
      fireEvent.click(screen.getByRole('checkbox', { name: /don't ask again/i }));
      fireEvent.click(screen.getByRole('button', { name: /find new books anyway/i }));
      expect(setNextReadPrompt).toHaveBeenCalledWith(false);
      await waitFor(() => expect(push).toHaveBeenCalledWith('/swipe'));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('asks while the setting has not loaded, since the prompt is on by default', () => {
      mockSwrData = { 'books-to-read': shelf(10) };
      renderDashboard();
      fireEvent.click(findButton());
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it.each([
      ['the reader turned it off', shelf(25), { prompt: false }],
      ['fewer than ten are saved', shelf(9), { prompt: true }],
    ])('goes straight to a run when %s', async (_why, books, settings) => {
      mockSwrData = { 'books-to-read': books, 'settings-next-read': settings };
      runRecommend.mockResolvedValue({ run_id: 'abc123abc123', served: 10 });
      renderDashboard();
      fireEvent.click(findButton());
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      await waitFor(() => expect(runRecommend).toHaveBeenCalled());
    });
  });
});
