/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import ProfilePage from '@/app/(main)/profile/page';
import { ToastProvider } from '@/components/ui';
import { ADMIN_ME_KEY } from '@/lib/api';

jest.mock('@/components/TasteHero', () => ({ TasteHero: () => <div data-testid="taste-hero" /> }));
jest.mock('@/components/CustomInstructions', () => ({
  __esModule: true,
  default: () => <div />,
}));
jest.mock('@/components/ShelfSprite', () => ({ __esModule: true, default: () => <div /> }));
jest.mock('@/hooks/useFeedbackPrompt', () => ({
  useFeedbackPrompt: () => ({ fire: jest.fn(), modal: null }),
}));

// Only the admin-me key matters here; every other key resolves to `undefined`
// so the page falls through to its empty states.
let isAdmin = false;
jest.mock('swr', () => ({
  __esModule: true,
  default: (key: string) => ({
    data: key === 'admin-me' ? { is_admin: isAdmin } : undefined,
    isLoading: false,
    error: undefined,
  }),
  mutate: jest.fn(),
}));

function renderProfile() {
  return render(
    <ToastProvider>
      <ProfilePage />
    </ToastProvider>
  );
}

describe('profile page mobile utility links', () => {
  it('uses the shared admin-me SWR key', () => {
    expect(ADMIN_ME_KEY).toBe('admin-me');
  });

  it('always offers the Settings escape hatch', () => {
    isAdmin = false;
    renderProfile();
    expect(screen.getByRole('link', { name: /settings/i })).toHaveAttribute('href', '/settings');
  });

  it('hides the Admin link from non-admins', () => {
    isAdmin = false;
    renderProfile();
    expect(screen.queryByRole('link', { name: /admin/i })).not.toBeInTheDocument();
  });

  // Regression: /admin had no mobile entry point at all — NavBar's only link is
  // `hidden sm:flex` and /admin cannot live in the 5-item bottom nav.
  it('gives admins a mobile link to /admin', () => {
    isAdmin = true;
    renderProfile();
    expect(screen.getByRole('link', { name: /admin/i })).toHaveAttribute('href', '/admin');
  });
});
