/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import LoginPage from '@/app/login/page';

jest.mock('@/utils/supabase/client', () => ({
  authEnabled: true,
  getSupabaseClient: () => null,
}));
// The page no longer reads the hash itself; it renders <InviteHashRedirect />, which forwards
// window.location to this helper on mount. Stub it so the test never touches navigation.
jest.mock('@/lib/authRedirect', () => ({ forwardInviteHash: () => {} }));

describe('/login', () => {
  it('exposes both credentials fields by accessible name', () => {
    render(<LoginPage />);
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  it('gives the password field a distinct id from the email field', () => {
    render(<LoginPage />);
    expect(screen.getByLabelText('Email').id).not.toBe(screen.getByLabelText('Password').id);
  });
});
