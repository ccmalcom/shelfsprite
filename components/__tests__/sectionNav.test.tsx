/**
 * @jest-environment jsdom
 */
import { render, screen, within } from '@testing-library/react';
import BottomNav from '@/components/BottomNav';
import NavBar from '@/components/NavBar';

let pathname = '/';
let screenEnabled = false;

jest.mock('next/navigation', () => ({ usePathname: () => pathname }));
jest.mock('@/utils/supabase/client', () => ({ authEnabled: false, getSupabaseClient: () => null }));
jest.mock('@/components/FeedbackLauncher', () => ({ __esModule: true, default: () => null }));
jest.mock('swr', () => ({
  __esModule: true,
  default: (key: string) => ({
    data:
      key === 'screen-settings'
        ? { enabled: screenEnabled, toggled_at: null, title_count: 0 }
        : undefined,
    error: undefined,
    isLoading: false,
    mutate: jest.fn(),
  }),
  mutate: jest.fn(),
}));

function bottomLinks() {
  const nav = screen.getByRole('navigation', { name: 'Main navigation' });
  return within(nav)
    .getAllByRole('link')
    .map((a) => a.textContent);
}

afterEach(() => {
  pathname = '/';
  screenEnabled = false;
});

describe('BottomNav', () => {
  it('shows the five book routes in the books section', () => {
    pathname = '/library';
    render(<BottomNav />);
    expect(bottomLinks()).toEqual(['Home', 'Swipe', 'Discover', 'Library', 'Profile']);
  });

  it('shows the screen routes under /screen and marks the current one', () => {
    pathname = '/screen/library';
    render(<BottomNav />);
    expect(bottomLinks()).toEqual(['For you', 'Library', 'Profile']);
    expect(screen.getByRole('link', { name: 'Library' })).toHaveAttribute('aria-current', 'page');
  });
});

describe('NavBar', () => {
  it('renders no switch while ScreenSprite is off', () => {
    render(<NavBar />);
    expect(screen.queryByRole('navigation', { name: 'Section' })).toBeNull();
    expect(screen.getByRole('link', { name: 'ShelfSprite home' })).toHaveAttribute('href', '/');
    expect(screen.getByText('Your reading room')).toBeInTheDocument();
  });

  it('renders the switch with Books current on a book page', () => {
    screenEnabled = true;
    pathname = '/library';
    render(<NavBar />);
    const sw = screen.getByRole('navigation', { name: 'Section' });
    expect(within(sw).getByRole('link', { name: 'Books' })).toHaveAttribute('aria-current', 'true');
    expect(within(sw).getByRole('link', { name: 'Screen' })).toHaveAttribute('href', '/screen');
  });

  it('brands the screen section and sends its home link to /screen', () => {
    screenEnabled = true;
    pathname = '/screen/profile';
    render(<NavBar />);
    expect(screen.getByRole('link', { name: 'ScreenSprite home' })).toHaveAttribute(
      'href',
      '/screen'
    );
    expect(screen.getByText('ScreenSprite')).toBeInTheDocument();
    expect(screen.getByText('Your screening room')).toBeInTheDocument();
    const sw = screen.getByRole('navigation', { name: 'Section' });
    expect(within(sw).getByRole('link', { name: 'Screen' })).toHaveAttribute(
      'aria-current',
      'true'
    );
  });

  it('keeps the account button named while its label is visually hidden on phones', () => {
    screenEnabled = true;
    render(<NavBar />);
    expect(screen.getByRole('button', { name: 'Account' })).toBeInTheDocument();
    expect(screen.getByText('Account')).toHaveClass('sr-only');
  });

  it('leaves the account label visible when there is no switch', () => {
    render(<NavBar />);
    expect(screen.getByText('Account')).not.toHaveClass('sr-only');
  });
});
