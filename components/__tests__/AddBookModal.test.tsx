/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AddBookModal from '@/components/AddBookModal';
import { ToastProvider } from '@/components/ui';

const mockCatalogSearch = jest.fn();
const mockAddBook = jest.fn();

jest.mock('next/image', () => ({
  __esModule: true,
  // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
  default: (props: Record<string, unknown>) => <img {...(props as never)} />,
}));

jest.mock('@/lib/api', () => ({
  ...jest.requireActual('@/lib/api'),
  api: {
    catalogSearch: (...args: unknown[]) => mockCatalogSearch(...args),
    addBook: (...args: unknown[]) => mockAddBook(...args),
  },
}));

const beloved = {
  source: 'openlibrary',
  catalog_id: '/works/OL1W',
  title: 'Beloved',
  author: 'Toni Morrison',
  year: 1987,
  year_kind: 'first_published',
  isbn13: null,
  cover_url: null,
  subjects: null,
  description: null,
};

async function pickBeloved(hit: Record<string, unknown> = beloved) {
  mockCatalogSearch.mockResolvedValue([hit]);
  render(
    <ToastProvider>
      <AddBookModal onAdded={jest.fn()} onClose={jest.fn()} />
    </ToastProvider>
  );
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'beloved' } });
  fireEvent.click(await screen.findByRole('button', { name: /Beloved/ }));
}

beforeEach(() => {
  mockCatalogSearch.mockReset();
  mockAddBook.mockReset();
  mockAddBook.mockResolvedValue({ id: 1, title: 'Beloved' });
});

describe('AddBookModal', () => {
  it('sends an optional date read for a read book', async () => {
    await pickBeloved();
    fireEvent.change(screen.getByLabelText('Date read'), { target: { value: '2026-03-14' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to library' }));

    await waitFor(() => expect(mockAddBook).toHaveBeenCalled());
    expect(mockAddBook.mock.calls[0][0]).toMatchObject({ shelf: 'read', date_read: '2026-03-14' });
  });

  it('hides the date read off the read shelf and sends none', async () => {
    await pickBeloved();
    fireEvent.change(screen.getByLabelText('Date read'), { target: { value: '2026-03-14' } });
    fireEvent.click(screen.getByRole('button', { name: 'To read' }));
    expect(screen.queryByLabelText('Date read')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add to library' }));

    await waitFor(() => expect(mockAddBook).toHaveBeenCalled());
    expect(mockAddBook.mock.calls[0][0].date_read).toBeUndefined();
  });

  it('shows an original year plainly and labels an edition year', async () => {
    await pickBeloved({ ...beloved, year: 2009, year_kind: 'edition' });
    expect(screen.getByText(/Toni Morrison · 2009 edition/)).toBeInTheDocument();
  });
});
