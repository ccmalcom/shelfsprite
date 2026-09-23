/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ScreenSettingsCard from '@/components/screen/ScreenSettingsCard';
import { ToastProvider } from '@/components/ui';
import { ApiRequestError, screenApi, type EnrichJobOut } from '@/lib/api';

let data: Record<string, unknown> = {};

jest.mock('swr', () => ({
  __esModule: true,
  default: (key: string | string[] | null) => ({
    data: key === null ? undefined : data[Array.isArray(key) ? key.join(':') : key],
    error: undefined,
    isLoading: false,
    mutate: jest.fn(() => Promise.resolve()),
  }),
  mutate: jest.fn(() => Promise.resolve()),
}));
jest.mock('@/lib/api', () => ({
  ...jest.requireActual('@/lib/api'),
  screenApi: {
    setEnabled: jest.fn(),
    optOutPreview: jest.fn(),
    importLetterboxd: jest.fn(),
    activeJob: jest.fn(),
    startEnrich: jest.fn(),
  },
}));

const setEnabled = screenApi.setEnabled as jest.Mock;
const optOutPreview = screenApi.optOutPreview as jest.Mock;
const importLetterboxd = screenApi.importLetterboxd as jest.Mock;

function job(over: Partial<EnrichJobOut> = {}): EnrichJobOut {
  return {
    job_id: 'j1',
    status: 'running',
    progress: 4,
    total: 10,
    error: null,
    started_at: '2026-09-22T10:00:00',
    finished_at: null,
    ...over,
  };
}

function renderCard(enabled: boolean, extra: Record<string, unknown> = {}) {
  data = {
    'screen-settings': { enabled, toggled_at: null, title_count: enabled ? 3 : 0 },
    ...extra,
  };
  render(
    <ToastProvider>
      <ScreenSettingsCard />
    </ToastProvider>
  );
}

beforeEach(() => {
  setEnabled.mockReset();
  optOutPreview.mockReset();
  importLetterboxd.mockReset();
});

describe('ScreenSettingsCard', () => {
  it('offers import and opt-in while off', () => {
    renderCard(false);
    expect(screen.getByRole('heading', { name: /ScreenSprite/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import from Letterboxd' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Turn on without importing' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Turn off ScreenSprite' })).toBeNull();
  });

  it('warns before turning off, in the words of spec 5.7', async () => {
    optOutPreview.mockResolvedValue({ traits: 3, confirmed: 1 });
    setEnabled.mockResolvedValue({
      enabled: false,
      toggled_at: null,
      title_count: 3,
      traits_removed: 3,
    });
    renderCard(true);
    fireEvent.click(screen.getByRole('button', { name: 'Turn off ScreenSprite' }));
    expect(
      await screen.findByText(
        '3 traits drew on your viewing history and will be removed, including 1 you confirmed.'
      )
    ).toBeInTheDocument();
    expect(setEnabled).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Turn off ScreenSprite' }));
    await waitFor(() => expect(setEnabled).toHaveBeenCalledWith(false));
  });

  it('keeps ScreenSprite on when the reader backs out', async () => {
    optOutPreview.mockResolvedValue({ traits: 0, confirmed: 0 });
    renderCard(true);
    fireEvent.click(screen.getByRole('button', { name: 'Turn off ScreenSprite' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Keep it on' }));
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it('recovers the running job', () => {
    renderCard(true, {
      'screen-enrich-active': { job: job({ job_id: 'j9' }) },
      'enrich-status:j9': job({ job_id: 'j9' }),
    });
    const bar = screen.getByRole('progressbar', { name: 'Matching your films and shows' });
    expect(bar).toHaveAttribute('aria-valuenow', '40');
    expect(screen.getByText(/Matched 4 of 10/)).toBeInTheDocument();
  });

  it('tracks the job an import starts', async () => {
    importLetterboxd.mockResolvedValue({
      inserted: 5,
      updated: 0,
      unchanged: 0,
      job: job({ job_id: 'j1', status: 'pending', progress: 0, total: 0 }),
    });
    renderCard(false, {
      'enrich-status:j1': job({ job_id: 'j1', status: 'pending', progress: 0, total: 0 }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Import from Letterboxd' }));
    const file = new File(['PK'], 'letterboxd.zip', { type: 'application/zip' });
    fireEvent.change(screen.getByLabelText('Letterboxd export (.zip)'), {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByRole('progressbar')).toBeInTheDocument();
    expect(importLetterboxd).toHaveBeenCalledWith(file);
    expect(screen.getByText(/Getting ready to match your titles/)).toBeInTheDocument();
  });

  it('shows why an import was refused', async () => {
    importLetterboxd.mockRejectedValue(
      new ApiRequestError(
        422,
        'That ZIP has no watched.csv. Upload the export exactly as Letterboxd sent it.'
      )
    );
    renderCard(false);
    fireEvent.click(screen.getByRole('button', { name: 'Import from Letterboxd' }));
    const file = new File(['PK'], 'other.zip', { type: 'application/zip' });
    fireEvent.change(screen.getByLabelText('Letterboxd export (.zip)'), {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That ZIP has no watched.csv.');
  });
});
