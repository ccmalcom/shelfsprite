/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import QuickRate from '@/components/onboarding/QuickRate';
import { ToastProvider } from '@/components/ui';
import type { BookMatchResult } from '@/lib/api';
import { quickRatePicks } from '@/lib/quickRatePicks';

const mockMatchBooks = jest.fn();
const mockAddBooks = jest.fn();

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
    catalogSearch: jest.fn(async () => []),
  },
}));

const UNRESOLVED = new Set(['Dune', 'The Hobbit']);
const SHELVED = new Set<string>(['Neuromancer']);

beforeEach(() => {
  mockMatchBooks.mockReset();
  mockAddBooks.mockReset();
  // Every pick resolves to itself, except a few the catalog does not hold.
  mockMatchBooks.mockImplementation(async (items: { title: string; author: string }[]) => ({
    results: items.map((item, index): BookMatchResult =>
      UNRESOLVED.has(item.title)
        ? { index, status: 'unmatched' }
        : {
            index,
            status: 'matched',
            best: {
              source: 'openlibrary',
              catalog_id: `/works/${index}`,
              title: item.title,
              author: item.author,
              year: 1990,
              year_kind: 'first_published',
              isbn13: null,
              cover_url: null,
              subjects: null,
              description: null,
              in_library: SHELVED.has(item.title),
            },
            alternatives: [],
          }
    ),
  }));
  mockAddBooks.mockImplementation(async (books: { title: string }[]) => ({
    added: books.map((b, i) => ({ id: i + 1, title: b.title, effective_rating: 4 })),
    duplicates: [],
    errors: [],
  }));
});

function rate(title: string, stars: string) {
  const group = screen.getByRole('radiogroup', { name: new RegExp(`Your rating for ${title}:`) });
  fireEvent.click(within(group).getByRole('radio', { name: stars }));
}

async function openGrid(onAdded = jest.fn()) {
  render(
    <ToastProvider>
      <QuickRate onAdded={onAdded} onCancel={jest.fn()} />
    </ToastProvider>
  );
  const show = screen.getByRole('button', { name: 'Pick 2 more' });
  expect(show).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Science fiction' }));
  fireEvent.click(screen.getByRole('button', { name: 'Fantasy' }));
  fireEvent.click(screen.getByRole('button', { name: 'Show me books' }));
  await waitFor(() =>
    expect(screen.queryByText(/Finding books in the catalogs/)).not.toBeInTheDocument()
  );
  return onAdded;
}

describe('QuickRate', () => {
  it('limits the choice to three genres', () => {
    render(
      <ToastProvider>
        <QuickRate onAdded={jest.fn()} onCancel={jest.fn()} />
      </ToastProvider>
    );
    for (const name of ['Fantasy', 'Horror', 'Romance']) {
      fireEvent.click(screen.getByRole('button', { name }));
    }
    expect(screen.getByRole('button', { name: 'Fantasy' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Science fiction' })).toBeDisabled();
  });

  it('resolves the curated picks strictly and shows only resolved, unshelved books', async () => {
    await openGrid();
    expect(quickRatePicks(['scifi', 'fantasy'])).toHaveLength(40);
    // Three of the first 40 are hidden, so the next three picks stand in for them.
    const all = quickRatePicks(['scifi', 'fantasy'], Infinity);
    const sent = mockMatchBooks.mock.calls.flatMap(([items]) => items);
    expect(sent).toEqual(all.slice(0, 43).map((p) => ({ title: p.title, author: p.author })));
    expect(mockMatchBooks.mock.calls.every(([, mode]) => mode === 'strict')).toBe(true);

    const grid = screen.getByRole('list', { name: 'Books to rate' });
    expect(within(grid).getAllByRole('listitem')).toHaveLength(40);
    expect(within(grid).queryByText('Dune')).not.toBeInTheDocument();
    expect(within(grid).queryByText('Neuromancer')).not.toBeInTheDocument();
    expect(within(grid).getByText('Circe')).toBeInTheDocument();
    expect(within(grid).getByText(all[42].title)).toBeInTheDocument();
  });

  it('stops topping up when the genres run out of picks', async () => {
    for (const p of quickRatePicks(['scifi', 'fantasy'], Infinity)) SHELVED.add(p.title);
    try {
      await openGrid();
      expect(mockMatchBooks.mock.calls.flatMap(([items]) => items)).toHaveLength(56);
      expect(
        await screen.findByText(/You already have every book we would show/)
      ).toBeInTheDocument();
    } finally {
      SHELVED.clear();
      SHELVED.add('Neuromancer');
    }
  });

  it('shows progress toward the cold-start threshold as tiles are rated', async () => {
    await openGrid();
    const rated = () =>
      screen.getByRole('progressbar', { name: 'Rated' }).getAttribute('aria-valuenow');
    const loved = () =>
      screen
        .getByRole('progressbar', { name: 'Loved (4 stars or more)' })
        .getAttribute('aria-valuenow');
    expect([rated(), loved()]).toEqual(['0', '0']);

    rate('Circe', '4.5 stars');
    rate('Piranesi', '3 stars');
    expect([rated(), loved()]).toEqual(['2', '1']);

    fireEvent.click(screen.getByRole('button', { name: 'Clear rating for Piranesi' }));
    expect([rated(), loved()]).toEqual(['1', '1']);
    expect(screen.getByRole('button', { name: 'Review 1 rated book' })).toBeEnabled();
  });

  it('sends rated tiles through the shared review and the bulk add path', async () => {
    const onAdded = await openGrid();
    expect(screen.getByRole('button', { name: 'Rate a book to continue' })).toBeDisabled();
    rate('Circe', '5 stars');
    rate('The Martian', '3.5 stars');
    fireEvent.click(screen.getByRole('button', { name: 'Review 2 rated books' }));

    const list = await screen.findByRole('list', { name: 'Books to add' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    // Rated picks are books the reader has read: no shelf choice.
    expect(screen.queryByRole('radiogroup', { name: 'Add these to' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 books' }));

    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect(mockAddBooks).toHaveBeenCalledWith([
      expect.objectContaining({ title: 'The Martian', rating: 3.5, shelf: 'read' }),
      expect.objectContaining({ title: 'Circe', rating: 5, shelf: 'read' }),
    ]);
  });
});
