/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import ScreenGate from '@/components/screen/ScreenGate';

const replace = jest.fn();
const retry = jest.fn();
let state: { settings: unknown; error: unknown } = { settings: undefined, error: undefined };

jest.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));
jest.mock('@/lib/useScreenSettings', () => ({
  useScreenSettings: () => ({
    settings: state.settings,
    enabled: (state.settings as { enabled?: boolean } | undefined)?.enabled ?? false,
    isLoading: state.settings === undefined && state.error === undefined,
    error: state.error,
    mutate: retry,
  }),
}));

function renderGate() {
  render(
    <ScreenGate>
      <p>screen page</p>
    </ScreenGate>
  );
}

beforeEach(() => {
  replace.mockClear();
  retry.mockClear();
  state = { settings: undefined, error: undefined };
});

describe('ScreenGate', () => {
  it('redirects a disabled reader to settings', () => {
    state.settings = { enabled: false, toggled_at: null, title_count: 0 };
    renderGate();
    expect(replace).toHaveBeenCalledWith('/settings#screen');
    expect(screen.queryByText('screen page')).toBeNull();
  });

  it('renders the page for an enabled reader', () => {
    state.settings = { enabled: true, toggled_at: null, title_count: 3 };
    renderGate();
    expect(screen.getByText('screen page')).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it('waits while the settings load', () => {
    renderGate();
    expect(screen.queryByText('screen page')).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it('offers a retry when the settings fail to load', () => {
    state.error = new Error('offline');
    renderGate();
    expect(screen.getByRole('alert')).toHaveTextContent('ScreenSprite did not load.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalled();
  });
});
