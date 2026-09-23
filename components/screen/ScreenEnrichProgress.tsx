'use client';

import { useEffect, useRef } from 'react';
import useSWR from 'swr';
import { api, type EnrichJobOut } from '@/lib/api';

const POLL_MS = 2_000;

function isFinal(job: EnrichJobOut | undefined): boolean {
  return job?.status === 'done' || job?.status === 'error';
}

/**
 * The screen job's progress (spec §7.4). Polls the shared job-status route until the job
 * finishes. Progress is the server's recount of persisted rows (CLAUDE.md), so a reload
 * resumes at the right number.
 */
export default function ScreenEnrichProgress({
  jobId,
  onFinished,
}: {
  jobId: string;
  onFinished: (job: EnrichJobOut) => void;
}) {
  const { data: job, error } = useSWR<EnrichJobOut>(
    ['enrich-status', jobId],
    () => api.enrichStatus(jobId),
    { refreshInterval: (latest) => (isFinal(latest) ? 0 : POLL_MS) }
  );
  const reported = useRef<string | null>(null);

  useEffect(() => {
    if (job && isFinal(job) && reported.current !== job.job_id) {
      reported.current = job.job_id;
      onFinished(job);
    }
  }, [job, onFinished]);

  if (error && !job) {
    return (
      <p className="text-sm text-muted">
        Progress did not load. Matching keeps running; reload to check again.
      </p>
    );
  }

  const total = job?.total ?? 0;
  const progress = job?.progress ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((progress / total) * 100)) : 0;
  const line = !job
    ? 'Checking progress\u2026'
    : job.status === 'done'
      ? `Done. Matched ${progress} of ${total}.`
      : job.status === 'error'
        ? `Matching stopped (${job.error ?? 'unknown error'}). Retry enrichment to pick up where it left off.`
        : total === 0
          ? 'Getting ready to match your titles\u2026'
          : `Matched ${progress} of ${total}\u2026`;

  return (
    <div className="space-y-2">
      <div
        role="progressbar"
        aria-label="Matching your films and shows"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="h-2 overflow-hidden rounded-full bg-elevated"
      >
        <div
          className={[
            'h-2 rounded-full transition-all',
            job?.status === 'error' ? 'bg-danger' : 'bg-accent',
          ].join(' ')}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p aria-live="polite" className="text-xs text-muted">
        {line}
      </p>
    </div>
  );
}
