/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import YearCard from '@/components/YearCard';
import type { GoalsResponse } from '@/lib/api';

let mockData: GoalsResponse | undefined;
let mockError: Error | undefined;
jest.mock('swr', () => ({
  __esModule: true,
  default: () => ({ data: mockData, isLoading: false, error: mockError }),
  mutate: jest.fn(),
}));

const base: GoalsResponse = {
  year: 2026,
  stats: {
    books: 42,
    pages: 11204,
    unknown_pages: 0,
    authors: 28,
    new_authors: 9,
    undated: 0,
    top_genres: [
      { subject: 'Fiction', count: 18 },
      { subject: 'History', count: 9 },
    ],
    top_authors: [{ author: 'Le Guin', count: 3 }],
  },
  goals: [],
  subjects: [],
};

const withData = (over: Partial<GoalsResponse>) => {
  mockData = { ...base, ...over } as GoalsResponse;
  mockError = undefined;
};

describe('YearCard', () => {
  it('shows the year numbers and top genres', () => {
    withData({});
    render(<YearCard />);
    expect(screen.getByText('Your 2026')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('Fiction')).toBeInTheDocument();
    expect(screen.getByText('Le Guin')).toBeInTheDocument();
  });

  it('renders goal progress and a done state', () => {
    withData({
      goals: [
        {
          id: 1,
          year: 2026,
          kind: 'books',
          subject: null,
          target: 100,
          progress: 42,
          unknown: 0,
          done: false,
        },
        {
          id: 2,
          year: 2026,
          kind: 'new_authors',
          subject: null,
          target: 2,
          progress: 9,
          unknown: 0,
          done: true,
        },
      ],
    });
    render(<YearCard />);
    expect(screen.getByText('42 / 100')).toBeInTheDocument();
    expect(screen.getByText('9 / 2')).toBeInTheDocument();
    expect(screen.getByText('Done')).toHaveClass('bg-success-quiet', 'text-success');
    expect(screen.getByText('9 / 2').parentElement).toHaveTextContent('Done');
    expect(screen.getByText('42 / 100').parentElement).not.toHaveTextContent('Done');
  });

  it('renders an inline error without blocking the page', () => {
    mockData = undefined;
    mockError = new Error('failed');
    render(<YearCard />);
    expect(screen.getByText("Your goals didn't load. Refresh to retry.")).toHaveClass(
      'text-danger'
    );
  });

  it('names the unknown-pages caveat on a pages goal', () => {
    withData({
      goals: [
        {
          id: 3,
          year: 2026,
          kind: 'pages',
          subject: null,
          target: 20000,
          progress: 11204,
          unknown: 3,
          done: false,
        },
      ],
    });
    render(<YearCard />);
    expect(screen.getByText(/3 books have no page count/i)).toBeInTheDocument();
  });

  it('names the undated backlog only when there is one', () => {
    withData({ stats: { ...base.stats, undated: 12 } });
    const { unmount } = render(<YearCard />);
    expect(screen.getByText(/12 read books have no date/i)).toBeInTheDocument();
    unmount();

    withData({});
    render(<YearCard />);
    expect(screen.queryByText(/have no date/i)).not.toBeInTheDocument();
  });

  it('collapses to one line for a year with no dated reads', () => {
    withData({
      stats: {
        ...base.stats,
        books: 0,
        pages: 0,
        authors: 0,
        new_authors: 0,
        top_genres: [],
        top_authors: [],
      },
    });
    render(<YearCard />);
    expect(screen.getByText(/nothing dated in 2026 yet/i)).toBeInTheDocument();
  });

  it('invites a first goal when there are none', () => {
    withData({});
    render(<YearCard />);
    expect(screen.getByText(/no goals for 2026/i)).toBeInTheDocument();
  });
});
