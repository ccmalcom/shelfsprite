/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApiRequestError, screenApi } from '@/lib/api';
import { ToastProvider } from '@/components/ui';
import CatalogSearch from '@/components/screen/CatalogSearch';
import AddTitleModal from '@/components/screen/AddTitleModal';
import CorrectTitleModal from '@/components/screen/CorrectTitleModal';
import { makeCandidate, makeTitle } from '@/lib/__tests__/fixtures/screenFixtures';

jest.mock('@/lib/api', () => ({
  ...jest.requireActual('@/lib/api'),
  screenApi: { search: jest.fn(), addTitle: jest.fn(), correctTitle: jest.fn() },
}));
jest.mock('swr', () => ({
  __esModule: true,
  default: jest.fn(),
  mutate: jest.fn(() => Promise.resolve()),
}));

const search = screenApi.search as jest.Mock;
const addTitle = screenApi.addTitle as jest.Mock;
const correctTitle = screenApi.correctTitle as jest.Mock;

const heat = makeCandidate();

beforeEach(() => {
  search.mockReset().mockResolvedValue([heat]);
  addTitle.mockReset().mockImplementation(async () => makeTitle());
  correctTitle.mockReset().mockImplementation(async () => makeTitle());
});

async function searchFor(q: string) {
  fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: q } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
}

describe('CatalogSearch', () => {
  it('searches the chosen type on submit', async () => {
    const onPick = jest.fn();
    render(<CatalogSearch pickLabel="Add" onPick={onPick} />);
    fireEvent.click(screen.getByRole('radio', { name: 'TV show' }));
    await searchFor('Severance');
    await waitFor(() => expect(search).toHaveBeenCalledWith('Severance', 'tv'));
  });

  it('shows the server detail when the catalog is slow', async () => {
    search.mockRejectedValue(
      new ApiRequestError(503, 'The catalog did not answer in time. Try the search again.')
    );
    render(<CatalogSearch pickLabel="Add" onPick={jest.fn()} />);
    await searchFor('Heat');
    expect(await screen.findByRole('alert')).toHaveTextContent('did not answer in time');
  });

  it('says so when nothing matches', async () => {
    search.mockResolvedValue([]);
    render(<CatalogSearch pickLabel="Add" onPick={jest.fn()} />);
    await searchFor('Qzxv Plumbline Orchard');
    expect(await screen.findByText(/No matches/)).toBeInTheDocument();
  });

  it('hands back the picked candidate unchanged', async () => {
    const onPick = jest.fn();
    render(<CatalogSearch pickLabel="Add" onPick={onPick} />);
    await searchFor('Heat');
    fireEvent.click(await screen.findByRole('button', { name: 'Add: Heat (1995)' }));
    expect(onPick).toHaveBeenCalledWith(heat);
  });
});

function renderAdd() {
  const onAdded = jest.fn();
  const onClose = jest.fn();
  render(
    <ToastProvider>
      <AddTitleModal onClose={onClose} onAdded={onAdded} />
    </ToastProvider>
  );
  return { onAdded, onClose };
}

async function pickHeat() {
  await searchFor('Heat');
  fireEvent.click(await screen.findByRole('button', { name: 'Add: Heat (1995)' }));
}

describe('AddTitleModal', () => {
  it('adds the pick as watched and unrated by default', async () => {
    const { onAdded } = renderAdd();
    await pickHeat();
    fireEvent.click(screen.getByRole('button', { name: 'Add to library' }));
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect(addTitle).toHaveBeenCalledWith({
      candidate: heat,
      status: 'watched',
      rating: null,
      review: null,
      last_watched_on: null,
    });
  });

  it('sends a picked watch date', async () => {
    renderAdd();
    await pickHeat();
    fireEvent.change(screen.getByLabelText('Date watched (optional)'), {
      target: { value: '2025-06-14' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add to library' }));
    await waitFor(() =>
      expect(addTitle).toHaveBeenCalledWith(
        expect.objectContaining({ last_watched_on: '2025-06-14' })
      )
    );
  });

  it('refuses a future watch date without a request', async () => {
    renderAdd();
    await pickHeat();
    fireEvent.change(screen.getByLabelText('Date watched (optional)'), {
      target: { value: '2999-01-01' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add to library' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The date watched cannot be in the future.'
    );
    expect(addTitle).not.toHaveBeenCalled();
  });

  it('drops a picked watch date when the add becomes want-to-watch', async () => {
    renderAdd();
    await pickHeat();
    fireEvent.change(screen.getByLabelText('Date watched (optional)'), {
      target: { value: '2025-06-14' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), {
      target: { value: 'want' },
    });
    expect(screen.queryByLabelText('Date watched (optional)')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add to library' }));
    await waitFor(() =>
      expect(addTitle).toHaveBeenCalledWith(expect.objectContaining({ last_watched_on: null }))
    );
  });

  it('sends the rating and review together', async () => {
    renderAdd();
    await pickHeat();
    fireEvent.click(screen.getByRole('radio', { name: '4 stars' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Review (optional)' }), {
      target: { value: '  Patient and cold.  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add to library' }));
    await waitFor(() =>
      expect(addTitle).toHaveBeenCalledWith(
        expect.objectContaining({ rating: 4, review: 'Patient and cold.' })
      )
    );
  });

  it('asks for a rating before a review, as books do', async () => {
    renderAdd();
    await pickHeat();
    fireEvent.change(screen.getByRole('textbox', { name: 'Review (optional)' }), {
      target: { value: 'Great.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add to library' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A review needs a rating');
    expect(addTitle).not.toHaveBeenCalled();
  });

  it('stays open after an add, keeping the media type and status, with a Done button', async () => {
    const severance = makeCandidate({ media_type: 'tv', title: 'Severance', year: 2022 });
    search.mockResolvedValue([severance]);
    addTitle.mockImplementation(async () =>
      makeTitle({ media_type: 'tv', title: 'Severance', year: 2022, status: 'want' })
    );
    const { onAdded, onClose } = renderAdd();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'TV show' }));
    await searchFor('Severance');
    fireEvent.click(await screen.findByRole('button', { name: 'Add: Severance (2022)' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), {
      target: { value: 'want' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add to library' }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));

    // Back on a cleared search, still on TV, with a confirmation and Done.
    expect(await screen.findByRole('textbox', { name: 'Title' })).toHaveValue('');
    expect(screen.getByRole('radio', { name: 'TV show' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('button', { name: 'Add: Severance (2022)' })).toBeNull();
    // The toast is a status region too, so find the dialog's own line by its text.
    expect(screen.getByText('Added Severance (2022)')).toHaveAttribute('role', 'status');
    expect(onClose).not.toHaveBeenCalled();

    // The next add searches TV again and keeps the chosen status.
    await searchFor('Severance');
    await waitFor(() => expect(search).toHaveBeenLastCalledWith('Severance', 'tv'));
    fireEvent.click(await screen.findByRole('button', { name: 'Add: Severance (2022)' }));
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveValue('want');
    fireEvent.click(screen.getByRole('button', { name: 'Add to library' }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Added Severance (2022) \u00B7 2 so far')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('shows the duplicate message from the server', async () => {
    addTitle.mockRejectedValue(
      new ApiRequestError(409, '"Heat" is already in your ScreenSprite library.')
    );
    renderAdd();
    await pickHeat();
    fireEvent.click(screen.getByRole('button', { name: 'Add to library' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '"Heat" is already in your ScreenSprite library.'
    );
  });
});

describe('CorrectTitleModal', () => {
  it('starts from the title and year and corrects to the pick', async () => {
    const onCorrected = jest.fn();
    const title = makeTitle({ id: 7 });
    render(
      <ToastProvider>
        <CorrectTitleModal title={title} onClose={jest.fn()} onCorrected={onCorrected} />
      </ToastProvider>
    );
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Heat 1995');
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.click(await screen.findByRole('button', { name: 'This one: Heat (1995)' }));
    await waitFor(() => expect(onCorrected).toHaveBeenCalled());
    expect(correctTitle).toHaveBeenCalledWith(7, heat);
  });

  it('shows the clash message from the server', async () => {
    correctTitle.mockRejectedValue(
      new ApiRequestError(409, 'That pick is already in your ScreenSprite library as "Heat".')
    );
    render(
      <ToastProvider>
        <CorrectTitleModal title={makeTitle()} onClose={jest.fn()} onCorrected={jest.fn()} />
      </ToastProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.click(await screen.findByRole('button', { name: 'This one: Heat (1995)' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'already in your ScreenSprite library'
    );
  });
});
