/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import ScreenLibraryPage from '@/app/(main)/screen/library/page';
import { ToastProvider } from '@/components/ui';
import { handleScreenError } from '@/lib/screenCache';
import type { TitleOut } from '@/lib/api';
import { makeTitle } from '@/lib/__tests__/fixtures/screenFixtures';

let titles: TitleOut[] | undefined;
const configs: Record<string, { onError?: unknown } | undefined> = {};

jest.mock('swr', () => ({
  __esModule: true,
  default: (key: string, _fetcher: unknown, config?: { onError?: unknown }) => {
    configs[key] = config;
    return {
      data: key === 'screen-titles' ? titles : undefined,
      error: undefined,
      isLoading: false,
      mutate: jest.fn(),
    };
  },
  mutate: jest.fn(() => Promise.resolve()),
}));

function renderPage() {
  render(
    <ToastProvider>
      <ScreenLibraryPage />
    </ToastProvider>
  );
}

function gridNames() {
  const grid = screen.getByRole('list', { name: 'Titles' });
  return within(grid)
    .getAllByRole('button')
    .map((b) => b.getAttribute('aria-label'));
}

beforeEach(() => {
  window.localStorage.clear();
  const low = makeTitle({ id: 3, title: 'Alien', year: 1979, status: 'want' });
  low.enrichment!.confidence_label = 'LOW';
  titles = [
    makeTitle({ id: 1, title: 'Heat', year: 1995, status: 'watched' }),
    makeTitle({ id: 2, title: 'Severance', year: 2022, media_type: 'tv', status: 'watching' }),
    low,
  ];
});

describe('/screen/library', () => {
  it('filters by type and by status', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'TV' }));
    expect(gridNames()).toEqual(['Severance (2022)']);
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), {
      target: { value: 'want' },
    });
    expect(gridNames()).toEqual(['Alien (1979), check the match']);
  });

  it('loads the first row of posters eagerly and the rest lazily', () => {
    // Five columns at its widest: any tile in the first row can be the LCP element.
    titles = Array.from({ length: 7 }, (_, i) =>
      makeTitle({ id: i + 1, title: `Film ${i + 1}`, year: 2000 + i })
    );
    renderPage();
    const loading = within(screen.getByRole('list', { name: 'Titles' }))
      .getAllByRole('img')
      .map((img) => img.getAttribute('loading'));
    expect(loading).toEqual(['eager', 'eager', 'eager', 'eager', 'eager', 'lazy', 'lazy']);
  });

  it('flags titles that need a second look', () => {
    renderPage();
    expect(screen.getByText('Check match')).toBeInTheDocument();
    expect(screen.getByText(/1 title needs a second look/)).toBeInTheDocument();
  });

  it('opens a title', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Heat (1995)' }));
    expect(screen.getByRole('dialog', { name: 'Heat' })).toBeInTheDocument();
  });

  it('shows both ways in when the library is empty', () => {
    titles = [];
    renderPage();
    expect(screen.getByRole('link', { name: 'Import from Letterboxd' })).toHaveAttribute(
      'href',
      '/settings#screen'
    );
    expect(screen.getAllByRole('button', { name: 'Add a title' }).length).toBeGreaterThan(0);
  });

  it('a 403 re-reads the settings', () => {
    renderPage();
    expect(configs['screen-titles']?.onError).toBe(handleScreenError);
  });
});
