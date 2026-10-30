/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DoneStep } from '@/components/SetupWizard';
import { ToastProvider } from '@/components/ui';

const mockRunRecommend = jest.fn();
const mockMutate = jest.fn(async () => undefined);
const push = jest.fn();

jest.mock('swr', () => ({
  __esModule: true,
  default: () => ({ data: undefined, mutate: jest.fn() }),
  mutate: (...args: unknown[]) => mockMutate(...(args as [])),
}));

jest.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

jest.mock('next/image', () => ({
  __esModule: true,
  // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
  default: (props: Record<string, unknown>) => <img {...(props as never)} />,
}));

jest.mock('@/hooks/useFeedbackPrompt', () => ({
  useFeedbackPrompt: () => ({ fire: jest.fn(), modal: null }),
}));

// The reveal itself is covered elsewhere; this stub only exposes the handoff it is given.
jest.mock('@/components/reveal/RevealSequence', () => ({
  __esModule: true,
  default: ({ onFinish, finishing }: { onFinish: () => void; finishing?: boolean }) => (
    <button type="button" onClick={onFinish} disabled={finishing}>
      {finishing ? 'Choosing carefully' : 'Get my first recommendations'}
    </button>
  ),
}));

jest.mock('@/lib/api', () => ({
  api: { runRecommend: (...args: unknown[]) => mockRunRecommend(...args) },
  API_KEY_STATUS_KEY: '/settings/api-key',
  PROFILE_STATUS_KEY: '/profile/status',
  USER_PROFILE_KEY: '/me',
}));

function openHandoff(onComplete = jest.fn()) {
  render(
    <ToastProvider>
      <DoneStep profiled onComplete={onComplete} />
    </ToastProvider>
  );
  fireEvent.click(screen.getByRole('button', { name: /show me what you found/i }));
  return onComplete;
}

beforeEach(() => {
  mockRunRecommend.mockReset();
  mockMutate.mockClear();
  push.mockClear();
});

describe('setup done step handoff', () => {
  it('runs the first batch before opening the deck', async () => {
    let resolveRun: (v: unknown) => void = () => {};
    mockRunRecommend.mockReturnValue(new Promise((r) => (resolveRun = r)));
    const onComplete = openHandoff();

    fireEvent.click(screen.getByRole('button', { name: /get my first recommendations/i }));
    expect(mockRunRecommend).toHaveBeenCalledWith(10);
    // While the run is in flight the button waits, and the wizard stays mounted.
    expect(screen.getByRole('button', { name: /choosing carefully/i })).toBeDisabled();
    expect(onComplete).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();

    resolveRun({ run_id: 'abc123abc123', served: 10 });
    await waitFor(() => expect(push).toHaveBeenCalledWith('/swipe'));
    expect(mockMutate).toHaveBeenCalledWith('recommendations', undefined, { revalidate: true });
    expect(onComplete).toHaveBeenCalled();
  });

  it('falls back to home when the run serves nothing', async () => {
    mockRunRecommend.mockResolvedValue({ run_id: null, served: 0, note: 'No usable picks.' });
    openHandoff();
    fireEvent.click(screen.getByRole('button', { name: /get my first recommendations/i }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/'));
    expect(push).not.toHaveBeenCalledWith('/swipe');
    expect(screen.getByText('No usable picks.')).toBeInTheDocument();
  });

  it('falls back to home when the run fails', async () => {
    mockRunRecommend.mockRejectedValue(new Error('Your Anthropic key was rejected.'));
    openHandoff();
    fireEvent.click(screen.getByRole('button', { name: /get my first recommendations/i }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/'));
    expect(screen.getByText(/key was rejected/i)).toBeInTheDocument();
  });
});
