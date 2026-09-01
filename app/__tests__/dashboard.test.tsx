/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import HomePage from '@/app/(main)/page';
import { ToastProvider } from '@/components/ui';
import { api } from '@/lib/api';

jest.mock('@/components/TasteHero', () => ({
  TasteHero: () => <div data-testid="taste-hero" />,
}));
const mutate = jest.fn();
jest.mock('swr', () => ({
  __esModule: true,
  default: () => ({ data: undefined, isLoading: false, error: undefined }),
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
    push.mockClear();
    mutate.mockClear();
    runRecommend.mockReset();
  });

  it('renders the taste hero', () => {
    renderDashboard();
    expect(screen.getByTestId('taste-hero')).toBeInTheDocument();
  });

  it('places the hero above the quiet utility tier', () => {
    const { container } = renderDashboard();
    const html = container.innerHTML;
    expect(html.indexOf('taste-hero')).toBeGreaterThan(-1);
    expect(html.indexOf('taste-hero')).toBeLessThan(html.indexOf('Ready for new picks?'));
  });

  it('sends the reader to the swipe deck once a run actually served picks', async () => {
    runRecommend.mockResolvedValue({ run_id: 'abc123abc123', served: 10 });
    renderDashboard();
    fireEvent.click(screen.getByRole('button', { name: /find my next books/i }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/swipe'));
    // The deck reads SWR key 'recommendations'; without this it can paint the
    // previous, fully-swiped batch from cache.
    expect(mutate).toHaveBeenCalledWith('recommendations');
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
