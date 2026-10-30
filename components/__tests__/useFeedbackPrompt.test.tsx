/**
 * @jest-environment jsdom
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { ToastProvider } from '@/components/ui';
import { _resetFeedbackPromptSession, useFeedbackPrompt } from '@/hooks/useFeedbackPrompt';

const mockFeedbackPrompt = jest.fn();

jest.mock('@/lib/api', () => ({
  api: {
    feedbackPrompt: (...args: unknown[]) => mockFeedbackPrompt(...args),
    dismissFeedback: jest.fn(async () => undefined),
    submitFeedback: jest.fn(async () => undefined),
  },
}));

/** Fires its trigger on mount, as the real call sites do. */
function Prompt({ trigger, runId }: { trigger: string; runId?: string }) {
  const { fire, modal } = useFeedbackPrompt(trigger, runId);
  useEffect(() => fire(), [fire]);
  return <>{modal}</>;
}

function renderPrompt(trigger: string, runId?: string) {
  return render(
    <ToastProvider>
      <Prompt trigger={trigger} runId={runId} />
    </ToastProvider>
  );
}

/** A fresh browser session: the tab's sessionStorage and page state are gone. */
function newSession() {
  window.sessionStorage.clear();
  _resetFeedbackPromptSession();
}

const flush = () => act(async () => {});

beforeEach(() => {
  window.localStorage.clear();
  newSession();
  mockFeedbackPrompt.mockReset();
  mockFeedbackPrompt.mockResolvedValue({ show: true });
});

describe('useFeedbackPrompt pacing', () => {
  it('opens at most one prompt per session', async () => {
    const first = renderPrompt('post-recs', 'run-1');
    expect(await screen.findByText('How were these recommendations?')).toBeInTheDocument();
    first.unmount();

    renderPrompt('post-first-profile');
    await flush();
    expect(screen.queryByText('Does your reader profile feel like you?')).not.toBeInTheDocument();
    // The slot was spent, so it does not even ask the server.
    expect(mockFeedbackPrompt).toHaveBeenCalledTimes(1);
  });

  it('waits for another open dialog to close before it shows', async () => {
    const other = document.createElement('div');
    other.setAttribute('role', 'dialog');
    other.setAttribute('aria-modal', 'true');
    document.body.appendChild(other);

    renderPrompt('post-recs', 'run-1');
    await flush();
    expect(screen.queryByText('How were these recommendations?')).not.toBeInTheDocument();

    act(() => other.remove());
    expect(await screen.findByText('How were these recommendations?')).toBeInTheDocument();
  });

  it('never opens the setup prompt where it fires, and asks it in a later session', async () => {
    const setup = renderPrompt('post-setup');
    await flush();
    expect(screen.queryByText('How was getting set up?')).not.toBeInTheDocument();
    expect(mockFeedbackPrompt).not.toHaveBeenCalled();
    setup.unmount();

    // Same session: the deferred prompt waits, and the session's own prompt shows.
    const recs = renderPrompt('post-recs', 'run-1');
    expect(await screen.findByText('How were these recommendations?')).toBeInTheDocument();
    recs.unmount();

    newSession();
    renderPrompt('post-first-profile');
    expect(await screen.findByText('How was getting set up?')).toBeInTheDocument();
    expect(mockFeedbackPrompt).toHaveBeenLastCalledWith('post-setup');
  });

  it('falls back to its own prompt once the deferred one is no longer eligible', async () => {
    renderPrompt('post-setup').unmount();
    newSession();
    mockFeedbackPrompt.mockImplementation(async (trigger: string) => ({
      show: trigger !== 'post-setup',
    }));
    renderPrompt('post-first-profile');
    expect(await screen.findByText('Does your reader profile feel like you?')).toBeInTheDocument();
    await waitFor(() => expect(window.localStorage.length).toBe(0));
  });
});
