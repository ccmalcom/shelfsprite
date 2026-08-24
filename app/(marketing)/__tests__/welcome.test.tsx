/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import WelcomePage from '@/app/(marketing)/welcome/page';
import WaitlistForm from '@/app/(marketing)/welcome/WaitlistForm';

// next/image needs no network here, but it warns on unknown props in jsdom; render a plain img
// so the assertions read cleanly.
jest.mock('next/image', () => ({
  __esModule: true,
  // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
  default: (props: Record<string, unknown>) => <img {...(props as never)} />,
}));

const fetchMock = jest.fn();
beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe('welcome page', () => {
  it('renders all six sections', () => {
    render(<WelcomePage />);
    expect(
      screen.getByRole('heading', {
        name: /Your reading history is a CSV file sitting in your downloads folder\./i,
      })
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^Import$/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^Enrich$/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^Recommend$/ })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /The books it recommends exist/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /A profile built from evidence/i })
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Ask for an invite/i })).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
  });

  it('links to /login for people who already have an invite', () => {
    render(<WelcomePage />);
    const signIn = screen.getAllByRole('link', { name: /sign in/i });
    expect(signIn.length).toBeGreaterThan(0);
    signIn.forEach((a) => expect(a).toHaveAttribute('href', '/login'));
  });

  it('gives both screenshots descriptive alt text', () => {
    render(<WelcomePage />);
    expect(screen.getByAltText(/library/i)).toBeInTheDocument();
    expect(screen.getByAltText(/taste profile/i)).toBeInTheDocument();
  });
});

describe('waitlist form', () => {
  function fill(value = 'reader@example.com') {
    fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: /ask for an invite/i }));
  }

  it('replaces the form with a success message on 200', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    render(<WaitlistForm />);
    fill();
    expect(await screen.findByText(/on the list/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /ask for an invite/i })).not.toBeInTheDocument();
  });

  // Sent verbatim, mixed case and all: normalization is the server's job (trim + lowercase in
  // lib/server/inviteRequests.ts). The value is not padded with spaces because an <input
  // type="email"> refuses to submit one, in jsdom and in a real browser alike.
  it('posts the email and the honeypot field to /api/invite-requests', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    render(<WaitlistForm />);
    fill('Reader@Example.COM');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/invite-requests');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ email: 'Reader@Example.COM', website: '' });
  });

  it('shows an invalid-email message on 422 and keeps the form usable', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 422 });
    render(<WaitlistForm />);
    // Native validation accepts a bare host, Zod on the server does not: that gap is exactly
    // when the 422 branch fires in production.
    fill('nope@nope');
    expect(await screen.findByRole('alert')).toHaveTextContent(/email address/i);
    expect(screen.getByRole('button', { name: /ask for an invite/i })).toBeEnabled();
  });

  it('shows a rate-limited message on 429', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429 });
    render(<WaitlistForm />);
    fill();
    expect(await screen.findByRole('alert')).toHaveTextContent(/too many/i);
  });

  it('shows an error and leaves the form usable when the network fails', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    render(<WaitlistForm />);
    fill();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /ask for an invite/i })).toBeEnabled();
  });

  it('has a honeypot input that is hidden from assistive technology', () => {
    const { container } = render(<WaitlistForm />);
    const honeypot = container.querySelector('input[name="website"]');
    expect(honeypot).not.toBeNull();
    expect(honeypot).toHaveAttribute('tabindex', '-1');
    expect(honeypot!.closest('[aria-hidden="true"]')).not.toBeNull();
  });
});
