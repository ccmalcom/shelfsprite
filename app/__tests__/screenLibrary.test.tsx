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
let search = '';
const replace = jest.fn((url: string) => {
  search = new URL(url, 'http://localhost').search;
});
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

// The real modal needs a catalog search round trip; this stands in for a finished add.
jest.mock('@/components/screen/AddTitleModal', () => ({
  __esModule: true,
  default: ({ onAdded }: { onAdded: (t: TitleOut) => void }) => (
    <button type="button" onClick={() => onAdded(makeTitle({ id: 9, status: 'want' }))}>
      Finish adding
    </button>
  ),
}));

jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(search),
  useRouter: () => ({ replace }),
}));

function page() {
  return (
    <ToastProvider>
      <ScreenLibraryPage />
    </ToastProvider>
  );
}

function renderPage(query = '') {
  search = query;
  return render(page());
}

function shelf(name: RegExp) {
  return within(screen.getByRole('navigation', { name: 'Library shelves' })).getByRole('button', {
    name,
  });
}

function gridNames() {
  const grid = screen.getByRole('list', { name: 'Titles' });
  return within(grid)
    .getAllByRole('button')
    .map((b) => b.getAttribute('aria-label'));
}

beforeEach(() => {
  window.localStorage.clear();
  replace.mockClear();
  const low = makeTitle({ id: 3, title: 'Alien', year: 1979, status: 'want' });
  low.enrichment!.confidence_label = 'LOW';
  titles = [
    makeTitle({ id: 1, title: 'Heat', year: 1995, status: 'watched' }),
    makeTitle({ id: 2, title: 'Severance', year: 2022, media_type: 'tv', status: 'watching' }),
    low,
  ];
});

describe('/screen/library', () => {
  it('opens on the watched shelf, with a count on every shelf that has titles', () => {
    renderPage();
    expect(gridNames()).toEqual(['Heat (1995)']);
    expect(shelf(/^Watched/)).toHaveAttribute('aria-current', 'true');
    expect(shelf(/^Watched/)).toHaveTextContent('1');
    expect(shelf(/Want to watch/)).toHaveTextContent('1');
    expect(shelf(/Dropped/)).not.toHaveTextContent(/\d/);
  });

  it('?tab=want is the watchlist', () => {
    renderPage('?tab=want');
    expect(gridNames()).toEqual(['Alien (1979), check the match']);
    expect(shelf(/Want to watch/)).toHaveAttribute('aria-current', 'true');
  });

  it('an unknown tab falls back to watched', () => {
    renderPage('?tab=bogus');
    expect(gridNames()).toEqual(['Heat (1995)']);
  });

  it('switching shelves keeps the shelf in the URL', () => {
    const { rerender } = renderPage();
    fireEvent.click(shelf(/Watching/));
    expect(replace).toHaveBeenCalledWith('/screen/library?tab=watching');
    rerender(page());
    expect(gridNames()).toEqual(['Severance (2022)']);
  });

  it('filters by type within the shelf', () => {
    titles!.push(makeTitle({ id: 4, title: 'The Wire', year: 2002, media_type: 'tv' }));
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'TV' }));
    expect(gridNames()).toEqual(['The Wire (2002)']);
    fireEvent.click(screen.getByRole('button', { name: 'Films' }));
    expect(gridNames()).toEqual(['Heat (1995)']);
  });

  it('searches the shelf by title or director', () => {
    titles!.push(makeTitle({ id: 4, title: 'Thief', year: 1981 }));
    titles![3]!.enrichment!.directors = ['Someone Else'];
    renderPage();
    const box = screen.getByRole('searchbox', { name: /Search/ });
    fireEvent.change(box, { target: { value: 'thi' } });
    expect(gridNames()).toEqual(['Thief (1981)']);
    fireEvent.change(box, { target: { value: 'mann' } });
    expect(gridNames()).toEqual(['Heat (1995)']);
    fireEvent.change(box, { target: { value: 'zzz' } });
    expect(screen.queryByRole('list', { name: 'Titles' })).not.toBeInTheDocument();
    expect(screen.getByText('Nothing matches these filters.')).toBeInTheDocument();
  });

  it('a new title opens the shelf it went on', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: '+ Add a title' }));
    fireEvent.click(screen.getByRole('button', { name: 'Finish adding' }));
    expect(replace).toHaveBeenCalledWith('/screen/library?tab=want');
  });

  it('says so when a shelf is empty', () => {
    renderPage('?tab=dropped');
    expect(screen.getByText('Nothing on this shelf yet.')).toBeInTheDocument();
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

  it('flags titles that need a second look, from any shelf', () => {
    renderPage();
    // Alien is on the watchlist, not the open shelf, but library care counts the whole library.
    expect(screen.getByText('Library care \u00B7 1 match check')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '1 title needs a match check' }));
    const dialog = screen.getByRole('dialog', { name: 'Fix the match' });
    expect(dialog).toHaveTextContent('Alien (1979)');
  });

  it('marks a doubtful match on its poster', () => {
    renderPage('?tab=want');
    expect(screen.getByText('Check match')).toBeInTheDocument();
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
