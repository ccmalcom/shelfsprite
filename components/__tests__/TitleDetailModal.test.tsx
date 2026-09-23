/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mutate } from 'swr';
import { ApiRequestError, screenApi, type TitleOut } from '@/lib/api';
import { ToastProvider } from '@/components/ui';
import TitleDetailModal from '@/components/screen/TitleDetailModal';
import { makeTitle } from '@/lib/__tests__/fixtures/screenFixtures';

jest.mock('@/lib/api', () => ({
  ...jest.requireActual('@/lib/api'),
  screenApi: { updateTitle: jest.fn(), deleteTitle: jest.fn() },
}));
jest.mock('swr', () => ({
  __esModule: true,
  default: jest.fn(),
  mutate: jest.fn(() => Promise.resolve()),
}));

const updateTitle = screenApi.updateTitle as jest.Mock;
const deleteTitle = screenApi.deleteTitle as jest.Mock;

function renderModal(
  title: TitleOut,
  opts: { duplicateOf?: TitleOut | null; onCorrect?: (t: TitleOut) => void } = {}
) {
  const onClose = jest.fn();
  render(
    <ToastProvider>
      <TitleDetailModal
        title={title}
        duplicateOf={opts.duplicateOf ?? null}
        onClose={onClose}
        onCorrect={opts.onCorrect}
      />
    </ToastProvider>
  );
  return { onClose };
}

beforeEach(() => {
  updateTitle.mockReset().mockImplementation(async (id: number) => makeTitle({ id }));
  deleteTitle.mockReset().mockResolvedValue({ id: 1, title: 'Heat', removed: true });
  (mutate as jest.Mock).mockClear();
});

describe('TitleDetailModal', () => {
  it('saves only the fields that changed and dirties the profile', async () => {
    const { onClose } = renderModal(makeTitle());
    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), {
      target: { value: 'dropped' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(updateTitle).toHaveBeenCalledWith(1, { status: 'dropped' });
    expect(mutate).toHaveBeenCalledWith('profile-status');
  });

  it('closes without a request when nothing changed', async () => {
    const { onClose } = renderModal(makeTitle());
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(updateTitle).not.toHaveBeenCalled();
  });

  it('sends a new rating', async () => {
    renderModal(makeTitle({ rating: null, letterboxd_rating: null }));
    fireEvent.click(screen.getByRole('radio', { name: '3 stars' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateTitle).toHaveBeenCalledWith(1, { rating: 3 }));
  });

  it('offers the Letterboxd rating back when an in-app rating overrides it', async () => {
    renderModal(makeTitle({ rating: 4.5, app_rating: 4.5, letterboxd_rating: 4 }));
    fireEvent.click(screen.getByRole('button', { name: 'Use my Letterboxd rating' }));
    await waitFor(() => expect(updateTitle).toHaveBeenCalledWith(1, { rating: 0 }));
  });

  it('offers to clear an in-app rating with no Letterboxd rating under it', () => {
    renderModal(makeTitle({ rating: 3, app_rating: 3, letterboxd_rating: null }));
    expect(screen.getByRole('button', { name: 'Clear my rating' })).toBeInTheDocument();
  });

  it('offers no clear button without an in-app rating', () => {
    renderModal(makeTitle());
    expect(
      screen.queryByRole('button', { name: /Clear my rating|Use my Letterboxd rating/ })
    ).toBeNull();
  });

  it('shows the server detail when a save is refused', async () => {
    updateTitle.mockRejectedValue(
      new ApiRequestError(
        422,
        'A review requires a rating. Rate the title 0.5 to 5 (same update is fine) before saving a review.'
      )
    );
    renderModal(makeTitle({ rating: null, letterboxd_rating: null }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Your review' }), {
      target: { value: 'Tense.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A review requires a rating.');
  });

  it('offers correction only for a LOW match', () => {
    const onCorrect = jest.fn();
    const low = makeTitle();
    low.enrichment!.confidence_label = 'LOW';
    renderModal(low, { onCorrect });
    fireEvent.click(screen.getByRole('button', { name: 'Fix the match' }));
    expect(onCorrect).toHaveBeenCalledWith(low);
  });

  it('hides correction for a confident match', () => {
    renderModal(makeTitle(), { onCorrect: jest.fn() });
    expect(screen.queryByRole('button', { name: 'Fix the match' })).toBeNull();
  });

  it('marks a possible duplicate and removes this one after confirming', async () => {
    const dup = makeTitle({ id: 5 });
    dup.enrichment!.duplicate_of_title_id = 2;
    const { onClose } = renderModal(dup, { duplicateOf: makeTitle({ id: 2 }) });
    expect(screen.getByText('Possible duplicate of Heat (1995)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove this one' }));
    expect(deleteTitle).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm: remove this one' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(deleteTitle).toHaveBeenCalledWith(5);
    expect(mutate).toHaveBeenCalledWith('profile-status');
  });

  it('renders an unenriched title with the fallback tile and no source line', () => {
    renderModal(makeTitle({ enrichment: null }));
    expect(screen.getByTestId('title-tile-fallback')).toBeInTheDocument();
    expect(screen.getByText('No description on file for this one.')).toBeInTheDocument();
    expect(screen.queryByText(/From Wikipedia/)).toBeNull();
  });

  it('credits the description source', () => {
    renderModal(makeTitle());
    expect(screen.getByRole('link', { name: 'Heat (1995 film)' })).toBeInTheDocument();
  });
});
