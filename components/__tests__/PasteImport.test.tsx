/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import PasteImport from '@/components/onboarding/PasteImport';
import { ToastProvider } from '@/components/ui';
import type { BookMatchResult, CatalogMatch } from '@/lib/api';

const mockMatchBooks = jest.fn();
const mockAddBooks = jest.fn();
const mockCatalogSearch = jest.fn();

jest.mock('next/image', () => ({
  __esModule: true,
  // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
  default: (props: Record<string, unknown>) => <img {...(props as never)} />,
}));

jest.mock('@/lib/api', () => ({
  ...jest.requireActual('@/lib/api'),
  api: {
    matchBooks: (...args: unknown[]) => mockMatchBooks(...args),
    addBooks: (...args: unknown[]) => mockAddBooks(...args),
    catalogSearch: (...args: unknown[]) => mockCatalogSearch(...args),
  },
}));

function hit(title: string, author: string, over: Partial<CatalogMatch> = {}): CatalogMatch {
  return {
    source: 'openlibrary',
    catalog_id: `/works/${title.replace(/\W+/g, '')}`,
    title,
    author,
    year: 2001,
    year_kind: 'first_published',
    isbn13: null,
    cover_url: null,
    subjects: ['Fiction'],
    description: `About ${title}.`,
    in_library: false,
    ...over,
  };
}

/** Answers each pasted title from this table; unknown titles are unmatched. */
function catalogAnswers(
  table: Record<string, { best: CatalogMatch; alternatives?: CatalogMatch[] }>
) {
  mockMatchBooks.mockImplementation(async (items: { title: string }[]) => ({
    results: items.map((item, index): BookMatchResult => {
      const row = table[item.title];
      return row
        ? { index, status: 'matched', best: row.best, alternatives: row.alternatives ?? [] }
        : { index, status: 'unmatched' };
    }),
  }));
}

const onAdded = jest.fn();

function renderPaste() {
  render(
    <ToastProvider>
      <PasteImport onAdded={onAdded} onCancel={jest.fn()} />
    </ToastProvider>
  );
}

async function pasteAndMatch(text: string) {
  renderPaste();
  fireEvent.change(screen.getByLabelText('Your list'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Find these books' }));
  await screen.findByRole('list', { name: 'Books to add' });
}

beforeEach(() => {
  mockMatchBooks.mockReset();
  mockAddBooks.mockReset();
  mockCatalogSearch.mockReset();
  onAdded.mockReset();
  mockAddBooks.mockImplementation(async (books: { title: string }[]) => ({
    added: books.map((b, i) => ({ id: i + 1, title: b.title })),
    duplicates: [],
    errors: [],
  }));
});

describe('PasteImport', () => {
  it('counts parsed titles as you paste, ignoring page noise', () => {
    renderPaste();
    expect(screen.getByRole('button', { name: 'Find these books' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Your list'), {
      target: { value: 'Circe\nRead more\nBy: Madeline Miller\n$9.99\nDune' },
    });
    expect(screen.getByText('2 titles found.')).toBeInTheDocument();
  });

  it('pastes, reviews and confirms through the bulk add path with ratings', async () => {
    catalogAnswers({
      Circe: { best: hit('Circe', 'Madeline Miller') },
      Dune: { best: hit('Dune', 'Frank Herbert') },
    });
    await pasteAndMatch('Circe by Madeline Miller\n- Dune\nNot a real book at all');

    expect(mockMatchBooks).toHaveBeenCalledWith(
      [
        { title: 'Circe', author: 'Madeline Miller' },
        { title: 'Dune', author: null },
        { title: 'Not a real book at all', author: null },
      ],
      'best'
    );
    const list = screen.getByRole('list', { name: 'Books to add' });
    expect(within(list).getByText('Circe')).toBeInTheDocument();
    expect(within(list).getByText('Madeline Miller · 2001')).toBeInTheDocument();
    expect(within(list).getByText('From your list: Circe by Madeline Miller')).toBeInTheDocument();
    expect(screen.getByText('No match found (1)')).toBeInTheDocument();

    const circe = screen.getByRole('radiogroup', { name: /Your rating for Circe/ });
    fireEvent.click(within(circe).getByRole('radio', { name: '4.5 stars' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 books' }));

    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect(mockAddBooks).toHaveBeenCalledWith([
      {
        title: 'Circe',
        author: 'Madeline Miller',
        year: 2001,
        isbn13: null,
        shelf: 'read',
        rating: 4.5,
        cover_url: null,
        subjects: ['Fiction'],
        description: 'About Circe.',
        catalog_source: 'openlibrary',
        catalog_id: '/works/Circe',
      },
      expect.objectContaining({ title: 'Dune', rating: undefined }),
    ]);
    expect(await screen.findByText('Added 2 books.')).toBeInTheDocument();
  });

  it('swaps a wrong match for an alternative with "Not this book"', async () => {
    catalogAnswers({
      'The Road': {
        best: hit('The Road', 'Jack London'),
        alternatives: [hit('The Road', 'Cormac McCarthy')],
      },
    });
    await pasteAndMatch('The Road');

    fireEvent.click(screen.getByRole('button', { name: 'Not this book' }));
    fireEvent.click(screen.getByRole('button', { name: /Cormac McCarthy/ }));

    const list = screen.getByRole('list', { name: 'Books to add' });
    expect(within(list).queryByText(/Jack London/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 book' }));
    await waitFor(() =>
      expect(mockAddBooks).toHaveBeenCalledWith([
        expect.objectContaining({ title: 'The Road', author: 'Cormac McCarthy' }),
      ])
    );
  });

  it('swaps to a fresh search result when no alternative fits', async () => {
    catalogAnswers({ Rebecca: { best: hit('Rebecca', 'Sara Shepard') } });
    mockCatalogSearch.mockResolvedValue([hit('Rebecca', 'Daphne du Maurier')]);
    await pasteAndMatch('Rebecca');

    fireEvent.click(screen.getByRole('button', { name: 'Not this book' }));
    fireEvent.click(await screen.findByRole('button', { name: /Daphne du Maurier/ }));

    fireEvent.click(screen.getByRole('button', { name: 'Add 1 book' }));
    await waitFor(() =>
      expect(mockAddBooks).toHaveBeenCalledWith([
        expect.objectContaining({ author: 'Daphne du Maurier' }),
      ])
    );
    expect(mockCatalogSearch).toHaveBeenCalledWith('Rebecca', 6);
  });

  it('removes a book and drops an unmatched line', async () => {
    catalogAnswers({
      Circe: { best: hit('Circe', 'Madeline Miller') },
      Dune: { best: hit('Dune', 'Frank Herbert') },
    });
    await pasteAndMatch('Circe\nDune\nZzyzx');

    fireEvent.click(screen.getByRole('button', { name: 'Remove Dune' }));
    fireEvent.click(screen.getByRole('button', { name: 'Drop Zzyzx' }));

    expect(screen.queryByText('No match found (1)')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 book' }));
    await waitFor(() =>
      expect(mockAddBooks).toHaveBeenCalledWith([expect.objectContaining({ title: 'Circe' })])
    );
  });

  it('flags books already in the library and lines that repeat a book, and sends neither', async () => {
    catalogAnswers({
      Beloved: { best: hit('Beloved', 'Toni Morrison', { in_library: true }) },
      Sula: { best: hit('Sula', 'Toni Morrison') },
      'Sula: A Novel': { best: hit('Sula', 'Toni Morrison') },
    });
    await pasteAndMatch('Beloved\nSula\nSula: A Novel');
    expect(screen.getByText('Already in your library')).toBeInTheDocument();
    expect(screen.getByText('Listed twice')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: /Your rating for Beloved/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 book' }));
    await waitFor(() =>
      expect(mockAddBooks).toHaveBeenCalledWith([expect.objectContaining({ title: 'Sula' })])
    );
  });

  it('drops a Kindle author line that only repeats the author above it', async () => {
    catalogAnswers({ 'Project Hail Mary': { best: hit('Project Hail Mary', 'Andy Weir') } });
    await pasteAndMatch('Project Hail Mary\nWeir, Andy\nAcquired on March 3, 2024');
    expect(screen.queryByText(/No match found/)).not.toBeInTheDocument();
    expect(screen.getByText('2 lines were skipped as page text or repeats.')).toBeInTheDocument();
  });

  it('searches an unmatched line by hand and adds the pick', async () => {
    catalogAnswers({});
    mockCatalogSearch.mockResolvedValue([hit('Piranesi', 'Susanna Clarke')]);
    renderPaste();
    fireEvent.change(screen.getByLabelText('Your list'), { target: { value: 'piranesi clark' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find these books' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Search' }));
    fireEvent.click(await screen.findByRole('button', { name: /Susanna Clarke/ }));
    expect(screen.queryByText(/No match found/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 book' }));
    await waitFor(() =>
      expect(mockAddBooks).toHaveBeenCalledWith([expect.objectContaining({ title: 'Piranesi' })])
    );
  });

  it('reports duplicates the server found instead of claiming they were added', async () => {
    catalogAnswers({ Circe: { best: hit('Circe', 'Madeline Miller') } });
    mockAddBooks.mockResolvedValue({
      added: [],
      duplicates: [{ index: 0, title: 'Circe' }],
      errors: [],
    });
    await pasteAndMatch('Circe');
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 book' }));
    expect(
      await screen.findByText('Added 0 books. 1 was already in your library.')
    ).toBeInTheDocument();
  });
});
