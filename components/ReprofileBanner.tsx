'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { api, PROFILE_STATUS_KEY, type ProfileStatus, type ProfileChangeSummary } from '@/lib/api';
import { Spinner } from '@/components/ui';

export default function ReprofileBanner() {
  const { data: status } = useSWR<ProfileStatus>(PROFILE_STATUS_KEY, () => api.profileStatus());
  const { mutate } = useSWR<ProfileStatus>(PROFILE_STATUS_KEY);

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ProfileChangeSummary | null>(null);

  if (!status?.dirty && !summary) return null;

  async function handleReprofile() {
    setRunning(true);
    setError(null);
    try {
      const result = await api.updateProfile();
      setSummary(result.changes);
      await mutate();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "The update didn't finish. Your current profile still stands; try again."
      );
    } finally {
      setRunning(false);
    }
  }

  if (summary) {
    const nothingChanged =
      summary.added.length === 0 && summary.dropped.length === 0 && summary.reworded.length === 0;

    return (
      <div className="border-b border-accent/30 bg-accent/10">
        <div className="mx-auto flex max-w-4xl flex-wrap items-start justify-between gap-2 px-4 py-2.5">
          <div className="space-y-1 text-sm text-text">
            <p className="font-semibold">
              {nothingChanged
                ? 'Profile refreshed — no changes.'
                : `Profile refreshed — ${summary.added.length} new, ${summary.dropped.length} dropped, ${summary.reworded.length} reworded, ${summary.unchanged} unchanged.`}
            </p>
            {nothingChanged ? (
              <p className="text-xs text-muted">
                Your taste traits already reflected everything in your library.
              </p>
            ) : (
              <ul className="space-y-0.5 text-xs">
                {summary.added.map((claim) => (
                  <li key={`a-${claim}`} className="text-success">
                    <span aria-hidden="true">+ </span>
                    {claim}
                  </li>
                ))}
                {summary.dropped.map((claim) => (
                  <li key={`d-${claim}`} className="text-danger">
                    <span aria-hidden="true">− </span>
                    {claim}
                  </li>
                ))}
                {summary.reworded.map((r) => (
                  <li key={`r-${r.from}`} className="text-muted">
                    <span aria-hidden="true">~ </span>
                    <span className="line-through">{r.from}</span>
                    <span aria-hidden="true"> → </span>
                    <span className="text-text">{r.to}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button
            type="button"
            onClick={() => setSummary(null)}
            className="rounded-md px-2 py-1 font-mono text-xs text-muted transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="border-b border-warning/30 bg-warning/10">
      <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-2 px-4 py-2.5">
        <p className="text-sm text-warning">
          <span className="font-semibold">Your taste has new evidence. </span> Ratings and edits
          since the last build aren&apos;t in your profile yet. Re-profile to fold them in: one
          Claude call, when you choose.
          {error && <span className="ml-2 text-danger">{error}</span>}
        </p>
        <button
          type="button"
          onClick={handleReprofile}
          disabled={running}
          className={[
            'inline-flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-sm font-semibold text-base transition-all',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning focus-visible:ring-offset-2 focus-visible:ring-offset-base',
            running
              ? 'cursor-not-allowed bg-warning opacity-70'
              : 'bg-warning hover:opacity-90 active:scale-95',
          ].join(' ')}
        >
          {running && <Spinner size="sm" />}
          {running ? 'Updating\u2026' : 'Update profile'}
        </button>
      </div>
    </div>
  );
}
