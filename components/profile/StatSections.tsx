'use client';

import { useState } from 'react';
import type { SubjectBreakdown } from '@/lib/api';
import { Card } from '@/components/ui';

function stars(star: number): string {
  return '\u2605'.repeat(Math.floor(star)) + (star % 1 ? '\u00bd' : '');
}

// ─── Rating distribution ──────────────────────────────────────────────────────

export function RatingSection({
  byStar,
  rated,
  meanRating,
  noun,
}: {
  byStar: Record<string, number>;
  rated: number;
  meanRating: number | null;
  /** Singular: "book", "title". */
  noun: string;
}) {
  const buckets = Array.from(
    new Set([
      5,
      4,
      3,
      2,
      1,
      ...Object.keys(byStar)
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 0),
    ])
  ).sort((a, b) => b - a);

  return (
    <section className="space-y-4">
      <div>
        <h2 className="font-display text-lg font-semibold text-text">Rating distribution</h2>
        <p className="mt-0.5 text-xs text-faint">
          {rated} rated {noun}
          {rated !== 1 ? 's' : ''}{' '}
          {meanRating != null ? `\u00b7 mean ${meanRating.toFixed(2)}` : ''}
        </p>
      </div>
      <Card>
        <div className="space-y-3">
          {buckets.map((star) => {
            const count = byStar[String(star)] ?? 0;
            const pct = rated > 0 ? (count / rated) * 100 : 0;
            return (
              <div key={star} className="flex items-center gap-3">
                <span className="w-14 shrink-0 text-right font-mono text-sm text-accent">
                  {stars(star)}
                </span>
                <div className="flex-1 overflow-hidden rounded-full bg-elevated h-2.5">
                  <div
                    className="h-2.5 rounded-full bg-accent transition-all duration-500"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="w-16 shrink-0 text-right font-mono text-sm text-muted">
                  {count} <span className="text-faint text-xs">({pct.toFixed(0)}%)</span>
                </span>
              </div>
            );
          })}
        </div>
      </Card>
    </section>
  );
}

// ─── Genre breakdown ──────────────────────────────────────────────────────────

export function GenreSection({
  subjects,
  description,
  emptyText,
}: {
  subjects: SubjectBreakdown;
  description: string;
  emptyText: string;
}) {
  const [tier, setTier] = useState<string>('all');
  // Re-sort client-side: `by_tier` is a plain object, so V8 emits the
  // integer-like keys ("3", "4", "5") ascending ahead of the half-star string
  // keys ("3.5", "4.5"), discarding the producer's descending sort.
  const tierKeys = Object.keys(subjects.by_tier).sort((a, b) => Number(b) - Number(a));

  const items = tier === 'all' ? subjects.overall : (subjects.by_tier[tier] ?? []);
  const maxCount = items[0]?.count ?? 1;

  const filterBtnClass = (active: boolean) =>
    [
      'rounded-md px-2.5 py-1 text-xs transition',
      'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
      active ? 'bg-elevated text-text' : 'text-muted hover:text-text',
    ].join(' ');

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-semibold text-text">Genre breakdown</h2>
          <p className="mt-0.5 text-xs text-faint">{description}</p>
        </div>
        <div className="flex flex-wrap gap-1 rounded-lg border border-border bg-elevated p-1">
          <button onClick={() => setTier('all')} className={filterBtnClass(tier === 'all')}>
            All
          </button>
          {tierKeys.map((k) => (
            <button
              key={k}
              onClick={() => setTier(k)}
              className={filterBtnClass(tier === k)}
              aria-label={`${k} star${k === '1' ? '' : 's'}`}
            >
              {stars(Number(k))}
            </button>
          ))}
        </div>
      </div>

      {items.length === 0 ? (
        <p className="py-10 text-center text-faint">{emptyText}</p>
      ) : (
        <Card>
          <div className="space-y-2.5">
            {items.map(({ subject, count }) => {
              const pct = (count / maxCount) * 100;
              return (
                <div key={subject} className="flex items-center gap-3">
                  <span
                    className="w-24 sm:w-40 shrink-0 truncate text-sm text-muted"
                    title={subject}
                  >
                    {subject}
                  </span>
                  <div className="flex-1 overflow-hidden rounded-full bg-elevated h-2">
                    <div
                      className="h-2 rounded-full bg-accent transition-all duration-500"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="w-6 shrink-0 text-right font-mono text-xs text-faint">
                    {count}
                  </span>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </section>
  );
}
