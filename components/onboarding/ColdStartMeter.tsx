'use client';

import {
  COLD_START_LOVED,
  COLD_START_RATED,
  LOVED_MIN,
  coldStartProgress,
} from '@/lib/server/coldStart';

/**
 * Progress toward the cold-start threshold (lib/server/coldStart.ts): below it the first
 * recommendations come from the broader cold-start path. Counts the ratings it is given.
 */
export default function ColdStartMeter({
  ratings,
}: {
  ratings: ReadonlyArray<number | null | undefined>;
}) {
  const p = coldStartProgress(ratings);
  const ratedPct = Math.min(100, Math.round((p.rated / COLD_START_RATED) * 100));
  const lovedPct = Math.min(100, Math.round((p.loved / COLD_START_LOVED) * 100));
  const status = p.done
    ? 'That is enough for sharp first picks. Add more whenever you like.'
    : `For the sharpest first picks, rate ${COLD_START_RATED} books and give ${COLD_START_LOVED} of them ${LOVED_MIN} stars or more.`;

  return (
    <div className="space-y-2 rounded-xl border border-border bg-elevated/60 p-3">
      <p className="text-xs text-muted" aria-live="polite">
        {status}
      </p>
      <Bar label="Rated" value={p.rated} target={COLD_START_RATED} pct={ratedPct} />
      <Bar
        label={`Loved (${LOVED_MIN} stars or more)`}
        value={p.loved}
        target={COLD_START_LOVED}
        pct={lovedPct}
      />
    </div>
  );
}

function Bar({
  label,
  value,
  target,
  pct,
}: {
  label: string;
  value: number;
  target: number;
  pct: number;
}) {
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs text-faint">
        <span>{label}</span>
        <span className="font-mono">
          {Math.min(value, target)} of {target}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={target}
        aria-valuenow={Math.min(value, target)}
        className="h-1.5 w-full overflow-hidden rounded-full bg-surface"
      >
        <div
          className={[
            'h-full rounded-full transition-all duration-300',
            pct >= 100 ? 'bg-success' : 'bg-accent',
          ].join(' ')}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
