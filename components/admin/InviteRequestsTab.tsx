'use client';

import { useState } from 'react';
import useSWR from 'swr';
import {
  listAdminInviteRequests,
  approveInviteRequest,
  declineInviteRequest,
  type AdminInviteRequest,
} from '@/lib/api';
import { Badge, Button, Card, Field, Spinner, useToast } from '@/components/ui';

const STATUS_VARIANT: Record<string, 'default' | 'success' | 'danger' | 'warning'> = {
  pending: 'warning',
  approved: 'success',
  declined: 'danger',
};

const selectClasses =
  'rounded-lg border border-border bg-base px-2 py-1 text-xs text-text focus:border-accent focus:outline-none';

/**
 * Waitlist triage. Volume is expected to be small, so the list is unpaginated — Pagination.tsx is
 * only worth wiring in if the route ever paginates server-side. No count badge on the tab button
 * either: no other admin tab carries one, and a lone counter is an inconsistency this change does
 * not need.
 */
export function InviteRequestsTab() {
  const [status, setStatus] = useState('pending');
  const { data, isLoading, mutate } = useSWR(['admin-invite-requests', status] as const, () =>
    listAdminInviteRequests(status || undefined)
  );

  function applyUpdated(updated: AdminInviteRequest) {
    // If the row no longer matches the active filter, drop it and revalidate; otherwise splice it
    // back in place without a refetch.
    const stillMatches = !status || updated.status === status;
    void mutate(
      (current) =>
        current
          ? stillMatches
            ? current.map((r) => (r.id === updated.id ? updated : r))
            : current.filter((r) => r.id !== updated.id)
          : current,
      { revalidate: !stillMatches }
    );
  }

  return (
    <Card className="p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5">
        <div>
          <h2 className="font-display text-lg font-semibold text-text">Invite requests</h2>
          {data ? (
            <p className="text-xs text-faint">
              {data.length} request{data.length !== 1 ? 's' : ''}
            </p>
          ) : null}
        </div>
        <Field label="Filter by status">
          {(p) => (
            <select
              {...p}
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className={selectClasses}
            >
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="declined">Declined</option>
              <option value="">All</option>
            </select>
          )}
        </Field>
      </div>

      {isLoading ? (
        <div className="flex justify-center p-8">
          <Spinner label="Loading invite requests" />
        </div>
      ) : !data || data.length === 0 ? (
        <p className="p-5 text-sm text-faint">No invite requests yet.</p>
      ) : (
        <div className="mt-4 divide-y divide-border">
          {data.map((row) => (
            <RequestRow key={row.id} row={row} onUpdated={applyUpdated} />
          ))}
        </div>
      )}
    </Card>
  );
}

function RequestRow({
  row,
  onUpdated,
}: {
  row: AdminInviteRequest;
  onUpdated: (updated: AdminInviteRequest) => void;
}) {
  const [busy, setBusy] = useState<'approve' | 'decline' | null>(null);
  const toast = useToast();

  async function run(action: 'approve' | 'decline') {
    setBusy(action);
    try {
      const updated =
        action === 'approve'
          ? await approveInviteRequest(row.id)
          : await declineInviteRequest(row.id);
      onUpdated(updated);
      toast.success(action === 'approve' ? `Invite sent to ${row.email}.` : 'Request declined.');
    } catch (err) {
      // The row keeps showing its persisted status when the request fails.
      toast.error(err instanceof Error ? err.message : 'Could not update the request.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 px-5 py-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-text">{row.email}</p>
        <p className="font-mono text-xs text-faint">
          {new Date(row.created_at).toLocaleDateString()}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Badge variant={STATUS_VARIANT[row.status] ?? 'default'}>{row.status}</Badge>
        {row.status === 'pending' ? (
          <>
            <Button
              size="sm"
              loading={busy === 'approve'}
              disabled={busy !== null}
              onClick={() => void run('approve')}
            >
              Approve
            </Button>
            <Button
              variant="ghost"
              size="sm"
              loading={busy === 'decline'}
              disabled={busy !== null}
              onClick={() => void run('decline')}
            >
              Decline
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}
