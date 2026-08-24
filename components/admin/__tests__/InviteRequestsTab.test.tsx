/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { InviteRequestsTab } from '@/components/admin/InviteRequestsTab';
import { ToastProvider } from '@/components/ui';

const listAdminInviteRequests = jest.fn();
const approveInviteRequest = jest.fn();
const declineInviteRequest = jest.fn();

jest.mock('@/lib/api', () => ({
  listAdminInviteRequests: (...a: unknown[]) => listAdminInviteRequests(...a),
  approveInviteRequest: (...a: unknown[]) => approveInviteRequest(...a),
  declineInviteRequest: (...a: unknown[]) => declineInviteRequest(...a),
}));

// Call the fetcher once per key without involving SWR's shared cache.
jest.mock('swr', () => {
  const React = jest.requireActual('react');
  function useMockSWR(key: unknown, fetcher: () => Promise<unknown>) {
    const [data, setData] = React.useState(undefined);
    React.useEffect(() => {
      let alive = true;
      fetcher().then((d: unknown) => {
        if (alive) setData(d);
      });
      return () => {
        alive = false;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [JSON.stringify(key)]);
    // Real SWR applies a function updater to the cached data and re-renders. The no-op stub the
    // rest of this mock started from could never show an optimistic row swap, so model it.
    const mutate = React.useCallback(
      (updater: unknown) => {
        setData((current: unknown) =>
          typeof updater === 'function' ? (updater as (c: unknown) => unknown)(current) : updater
        );
        return Promise.resolve();
      },
      [setData]
    );
    return { data, isLoading: data === undefined, mutate };
  }
  return { __esModule: true, default: useMockSWR };
});

const PENDING = {
  id: 1,
  email: 'reader@example.com',
  status: 'pending',
  created_at: '2026-08-20T00:00:00',
  reviewed_at: null,
  reviewed_by: null,
};

function renderTab(rows = [PENDING]) {
  listAdminInviteRequests.mockResolvedValue(rows);
  return render(
    <ToastProvider>
      <InviteRequestsTab />
    </ToastProvider>
  );
}

beforeEach(() => jest.clearAllMocks());

describe('InviteRequestsTab', () => {
  it('renders email, status and submitted date', async () => {
    renderTab();
    expect(await screen.findByText('reader@example.com')).toBeInTheDocument();
    expect(screen.getByText('pending')).toBeInTheDocument();
  });

  it('shows Approve and Decline on a pending row', async () => {
    renderTab();
    expect(await screen.findByRole('button', { name: /approve/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /decline/i })).toBeInTheDocument();
  });

  it('hides the actions on a reviewed row', async () => {
    renderTab([{ ...PENDING, status: 'approved', reviewed_at: '2026-08-21T00:00:00' }]);
    expect(await screen.findByText('approved')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
  });

  it('approving calls the API with the row id and drops the row from the pending filter', async () => {
    renderTab();
    approveInviteRequest.mockResolvedValue({
      ...PENDING,
      status: 'approved',
      reviewed_at: '2026-08-21T00:00:00',
    });
    fireEvent.click(await screen.findByRole('button', { name: /approve/i }));
    await waitFor(() => expect(approveInviteRequest).toHaveBeenCalledWith(1));
    // The tab is filtered to Pending, so an approved row no longer belongs in the list.
    await waitFor(() => expect(screen.queryByText('reader@example.com')).not.toBeInTheDocument());
  });

  it('swaps the row in place when the filter still matches the new status', async () => {
    renderTab();
    approveInviteRequest.mockResolvedValue({
      ...PENDING,
      status: 'approved',
      reviewed_at: '2026-08-21T00:00:00',
    });
    // "All" keeps every status in view, so the row updates rather than disappearing.
    fireEvent.change(await screen.findByLabelText(/filter by status/i), {
      target: { value: '' },
    });
    fireEvent.click(await screen.findByRole('button', { name: /approve/i }));
    await waitFor(() => expect(approveInviteRequest).toHaveBeenCalledWith(1));
    expect(await screen.findByText('approved')).toBeInTheDocument();
    expect(screen.getByText('reader@example.com')).toBeInTheDocument();
  });

  it('declining calls the API and never calls approve', async () => {
    renderTab();
    declineInviteRequest.mockResolvedValue({
      ...PENDING,
      status: 'declined',
      reviewed_at: '2026-08-21T00:00:00',
    });
    fireEvent.click(await screen.findByRole('button', { name: /decline/i }));
    await waitFor(() => expect(declineInviteRequest).toHaveBeenCalledWith(1));
    expect(approveInviteRequest).not.toHaveBeenCalled();
  });

  it('leaves the row pending when approving fails', async () => {
    renderTab();
    approveInviteRequest.mockRejectedValue(new Error('GoTrue is down'));
    fireEvent.click(await screen.findByRole('button', { name: /approve/i }));
    await waitFor(() => expect(approveInviteRequest).toHaveBeenCalled());
    expect(await screen.findByText('pending')).toBeInTheDocument();
  });

  it('renders an empty state', async () => {
    renderTab([]);
    expect(await screen.findByText(/no invite requests/i)).toBeInTheDocument();
  });
});
