/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import HomePage from '@/app/(main)/page';
import { ToastProvider } from '@/components/ui';
import { api } from '@/lib/api';

const mutate = jest.fn();
let mockProfileStatus: unknown;
jest.mock('swr', () => ({
  __esModule: true,
  default: (key: string) => ({
    data: key === 'profile-status' ? mockProfileStatus : undefined,
    isLoading: false,
    error: undefined,
  }),
  mutate: (...args: unknown[]) => mutate(...args),
}));
const push = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
jest.mock('@/lib/api', () => ({
  ...jest.requireActual('@/lib/api'),
  api: { ...jest.requireActual('@/lib/api').api, runRecommend: jest.fn() },
}));

const runRecommend = api.runRecommend as jest.Mock;

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
    push.mockClear();
    mutate.mockClear();
    runRecommend.mockReset();
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
    { last_profiled_at: '2026-09-01', dirty: true },
  ])('blocks recommendations until a current profile is known: %p', (status) => {
    mockProfileStatus = status;
    renderDashboard();
    expect(screen.getByRole('button', { name: /find my next books/i })).toBeDisabled();
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
});
