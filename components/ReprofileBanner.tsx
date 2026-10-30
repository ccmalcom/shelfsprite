'use client';

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import useSWR, { mutate as globalMutate } from 'swr';
import {
  api,
  PROFILE_STATUS_KEY,
  TRAITS_KEY,
  ARCHETYPE_KEY,
  type ProfileStatus,
  type ProfileChangeSummary,
} from '@/lib/api';
import { Spinner } from '@/components/ui';

/** Changed books and titles it takes before home asks for an update; /profile asks at one. */
export const REPROFILE_NUDGE_MIN = 5;

/**
 * Whether the update nudge belongs on this page. The profile page always offers it (home's
 * "update it on your profile page" sends readers there). Home asks only once the changes add up,
 * or when a full rebuild is pending. Everywhere else, the swipe deck included, it stays out of
 * the way: one "Already read" mid-deck is not worth an interruption.
 */
export function showReprofileNudge(status: ProfileStatus | undefined, pathname: string | null) {
  if (!status?.dirty) return false;
  if (pathname === '/profile' || pathname === '/screen/profile') return true;
  if (pathname === '/' || pathname === '/screen') {
    const changes = (status.changed_books ?? 0) + (status.changed_titles ?? 0);
    return changes >= REPROFILE_NUDGE_MIN || status.rebuild_reason != null;
  }
  return false;
}

export default function ReprofileBanner() {
  const pathname = usePathname();
  const { data: status } = useSWR<ProfileStatus>(PROFILE_STATUS_KEY, () => api.profileStatus());
  const { mutate } = useSWR<ProfileStatus>(PROFILE_STATUS_KEY);

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ProfileChangeSummary | null>(null);

  // A finished update's summary stays wherever the reader is; only the nudge is page-bound.
  if (!summary && !(running || showReprofileNudge(status, pathname))) return null;

  async function handleReprofile() {
    setRunning(true);
    setError(null);
    try {
      const result = await api.updateProfile();
      setSummary(result.changes);
      // This banner is mounted app-wide, so /profile and TasteHero are usually UNMOUNTED
      // when this runs and a bare mutate(key) has no subscriber to revalidate -- arriving
      // at /profile would then render the pre-refresh traits out of SWR's cache. Hand
      // mutate the fetch itself (the SetupWizard pattern) so the cache holds fresh data
      // either way, with no skeleton flash on the mounted path.
      //
      // The archetype needs it too: /api/profile/archetype derives is_stale from
      // derived_at < last_profiled_at, and a successful rebuild stamps last_profiled_at,
      // so every cached `is_stale: false` is wrong the moment this resolves.
      //
      // Kept off the success path: a failed re-read leaves stale UI, but the refresh
      // itself succeeded and must not be reported as an error.
      await Promise.all([
        mutate(),
        globalMutate(TRAITS_KEY, api.profile(), { revalidate: false }),
        globalMutate(ARCHETYPE_KEY, api.getArchetype(), { revalidate: false }),
      ]).catch(() => {});
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
      <div role="status" aria-live="polite" className="border-b border-accent/30 bg-accent/10">
        <div className="mx-auto flex max-w-4xl flex-wrap items-start justify-between gap-2 px-4 py-2.5">
          <div className="space-y-1 text-sm text-text">
            <p className="font-semibold">
              {nothingChanged
                ? 'Profile refreshed \u2014 no changes.'
                : `Profile refreshed \u2014 ${summary.added.length} new, ${summary.dropped.length} dropped, ${summary.reworded.length} reworded, ${summary.unchanged} unchanged.`}
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
          <span className="font-semibold">Your taste has new evidence. </span> Some ratings and
          edits aren&apos;t in your profile yet. Update your profile to include them. This takes a
          moment and uses your Claude key.
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
