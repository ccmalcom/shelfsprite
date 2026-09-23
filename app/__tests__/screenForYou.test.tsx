/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mutate } from 'swr';
import ScreenForYouPage from '@/app/(main)/screen/page';
import { ToastProvider } from '@/components/ui';
import { screenApi, type ProfileStatus, type TitleRec } from '@/lib/api';
import { makeRec, makeTitle } from '@/lib/__tests__/fixtures/screenFixtures';

const OK_STATUS: ProfileStatus = {
  dirty: false,
  changed_books: 0,
  changed_book_ids: [],
  last_profiled_at: '2026-09-20T10:00:00',
  last_profile_kind: 'full',
  rebuild_reason: null,
};

let data: Record<string, unknown> = {};

jest.mock('swr', () => ({
  __esModule: true,
  default: (key: string | null) => ({
    data: key === null ? undefined : data[key],
    error: undefined,
    isLoading: false,
    mutate: jest.fn(() => Promise.resolve()),
  }),
  mutate: jest.fn(() => Promise.resolve()),
}));
jest.mock('@/lib/api', () => ({
  ...jest.requireActual('@/lib/api'),
  screenApi: {
    recommend: jest.fn(),
    recFeedback: jest.fn(),
    recommendations: jest.fn(),
    titles: jest.fn(),
    updateTitle: jest.fn(),
    deleteTitle: jest.fn(),
  },
}));

const recommend = screenApi.recommend as jest.Mock;
const recFeedback = screenApi.recFeedback as jest.Mock;

function renderPage(recs: TitleRec[], status: ProfileStatus = OK_STATUS) {
  data = {
    'profile-status': status,
    'screen-recommendations': recs,
    'profile-traits': [],
    'screen-titles': [],
  };
  render(
    <ToastProvider>
      <ScreenForYouPage />
    </ToastProvider>
  );
}

beforeEach(() => {
  recommend.mockReset();
  recFeedback.mockReset().mockResolvedValue({ id: 1, status: 'rejected', title: null });
  (mutate as jest.Mock).mockClear();
});

describe('/screen', () => {
  it('blocks the run without a profile and points at the screen profile', () => {
    renderPage([], { ...OK_STATUS, last_profiled_at: null });
    expect(screen.getByRole('button', { name: 'Find something to watch' })).toBeDisabled();
    expect(screen.getByText(/No taste profile yet/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to profile' })).toHaveAttribute(
      'href',
      '/screen/profile'
    );
  });

  it('blocks the run while the profile is out of date', () => {
    renderPage([], { ...OK_STATUS, dirty: true });
    expect(screen.getByRole('button', { name: 'Find something to watch' })).toBeDisabled();
    expect(
      screen.getByText(/Your library changed since the last profile build/)
    ).toBeInTheDocument();
  });

  it('says nothing new and labels the earlier run', async () => {
    recommend.mockResolvedValue({ run_id: null, served: 0, media_filter: 'tv', candidates: 0 });
    renderPage([makeRec()]);
    fireEvent.click(screen.getByRole('button', { name: 'TV' }));
    fireEvent.click(screen.getByRole('button', { name: 'Find something to watch' }));
    expect(await screen.findByText(/Nothing new this time/)).toBeInTheDocument();
    expect(recommend).toHaveBeenCalledWith('tv');
    expect(screen.getByText('From an earlier run')).toBeInTheDocument();
  });

  it('rejects without reasons as a bare status, and with reasons as a list', async () => {
    renderPage([makeRec({ id: 1 }), makeRec({ id: 2, title: 'Collateral', year: 2004 })]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Not for me' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Skip this one' }));
    await waitFor(() => expect(recFeedback).toHaveBeenCalledWith(1, { status: 'rejected' }));

    fireEvent.click(screen.getAllByRole('button', { name: 'Not for me' })[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Too long (runtime or seasons)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Skip with reason' }));
    await waitFor(() =>
      expect(recFeedback).toHaveBeenCalledWith(2, {
        status: 'rejected',
        reject_reasons: ['too_long'],
      })
    );
  });

  it.each([
    ['Want to watch', 'accepted'],
    ['Already watched', 'already_watched'],
  ])('refreshes the profile status after %s', async (button, status) => {
    // The server stamps rec feedback for every decision, which can make the profile dirty.
    recFeedback.mockResolvedValue({
      id: 1,
      status,
      title: makeTitle({ id: 50, title: 'Thief', year: 1981 }),
    });
    renderPage([makeRec()]);
    fireEvent.click(screen.getByRole('button', { name: button }));
    await waitFor(() => expect(mutate).toHaveBeenCalledWith('profile-status'));
  });

  it('opens the title to rate after Already watched', async () => {
    recFeedback.mockResolvedValue({
      id: 1,
      status: 'already_watched',
      title: makeTitle({ id: 50, title: 'Thief', year: 1981 }),
    });
    renderPage([makeRec()]);
    fireEvent.click(screen.getByRole('button', { name: 'Already watched' }));
    expect(await screen.findByRole('dialog', { name: 'Thief' })).toBeInTheDocument();
    expect(recFeedback).toHaveBeenCalledWith(1, { status: 'already_watched' });
  });
});
