/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mutate } from 'swr';
import SettingsPage from '@/app/(main)/settings/page';
import { ToastProvider } from '@/components/ui';
import { screenApi } from '@/lib/api';

let settings: { enabled: boolean; toggled_at: null; title_count: number } | undefined;

jest.mock('swr', () => ({
  __esModule: true,
  default: (key: string | null) => ({
    data: key === 'screen-settings' ? settings : undefined,
    error: undefined,
    isLoading: false,
    mutate: jest.fn(() => Promise.resolve()),
  }),
  mutate: jest.fn(() => Promise.resolve()),
  useSWRConfig: () => ({ mutate: jest.fn() }),
}));
jest.mock('@/utils/supabase/client', () => ({ authEnabled: false, getSupabaseClient: () => null }));
jest.mock('@/lib/api', () => ({
  ...jest.requireActual('@/lib/api'),
  screenApi: {
    ...jest.requireActual('@/lib/api').screenApi,
    deleteLibrary: jest.fn(async () => ({
      titles_removed: 12,
      title_recommendations_removed: 0,
      title_signals_removed: 0,
      traits_removed: 4,
      recommendations_removed: 0,
      profile_reset: true,
    })),
  },
}));

function renderPage() {
  const view = render(
    <ToastProvider>
      <SettingsPage />
    </ToastProvider>
  );
  return view.container;
}

describe('/settings with ScreenSprite', () => {
  it('mounts the card where the gate sends people', () => {
    settings = { enabled: false, toggled_at: null, title_count: 0 };
    const container = renderPage();
    expect(container.querySelector('section#screen')).not.toBeNull();
  });

  it('keeps the danger zone book-only for a reader with no screen data', () => {
    settings = { enabled: false, toggled_at: null, title_count: 0 };
    renderPage();
    expect(screen.queryByRole('button', { name: 'Delete screen library' })).toBeNull();
    expect(
      screen.getByText(
        'Deletes your taste traits and recommendations. Your books stay put; rebuild anytime.'
      )
    ).toBeInTheDocument();
  });

  it('names the media once ScreenSprite is on', () => {
    settings = { enabled: true, toggled_at: null, title_count: 12 };
    renderPage();
    expect(screen.getByText(/Your books, films and shows stay put/)).toBeInTheDocument();
    expect(screen.getByText(/Your films and shows stay\./)).toBeInTheDocument();
    expect(
      screen.getByText(/books, films and shows, profile, recommendations/)
    ).toBeInTheDocument();
  });

  it('still offers Delete screen library after opting out with titles left', () => {
    settings = { enabled: false, toggled_at: null, title_count: 12 };
    renderPage();
    expect(screen.getByRole('button', { name: 'Delete screen library' })).toBeInTheDocument();
  });

  it('deletes the screen library and invalidates screen state', async () => {
    settings = { enabled: true, toggled_at: null, title_count: 12 };
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Delete screen library' }));
    fireEvent.click(screen.getByRole('button', { name: "I'm sure, do it" }));
    await waitFor(() => expect(screenApi.deleteLibrary).toHaveBeenCalled());
    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith('screen-titles', undefined, { revalidate: true })
    );
    expect(mutate).toHaveBeenCalledWith('screen-settings');
  });
});
