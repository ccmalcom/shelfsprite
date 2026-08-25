'use client';

import Link from 'next/link';
import useSWR from 'swr';
import { api, GOALS_KEY, type Goal, type GoalsResponse } from '@/lib/api';
import { Badge, Card } from '@/components/ui';

const KIND_LABEL: Record<Goal['kind'], string> = {
  books: 'Books read',
  genre: 'Genre',
  new_authors: 'New authors',
  pages: 'Pages read',
};

function goalLabel(g: Goal): string {
  return g.kind === 'genre' ? (g.subject ?? KIND_LABEL.genre) : KIND_LABEL[g.kind];
}

function Bar({ pct }: { pct: number }) {
  return (
    <div className="flex-1 overflow-hidden rounded-full bg-elevated h-2">
      <div
        className="h-2 rounded-full bg-accent transition-all"
        style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
      />
    </div>
  );
}

function Figure({ value, label }: { value: string; label: string }) {
  return (
    <div className="px-4 text-center">
      <p className="font-mono text-xl font-semibold text-text">{value}</p>
      <p className="mt-0.5 font-mono text-xs uppercase tracking-widest text-faint">{label}</p>
    </div>
  );
}

export default function YearCard() {
  const { data, isLoading, error } = useSWR<GoalsResponse>(GOALS_KEY, () => api.listGoals());

  if (isLoading) {
    return (
      <Card>
        <div className="h-24 rounded bg-elevated motion-safe:animate-pulse" />
      </Card>
    );
  }
  if (error) {
    return (
      <Card>
        <p className="text-sm text-danger">Your goals didn&apos;t load. Refresh to retry.</p>
      </Card>
    );
  }
  if (!data) return null;

  const { year, stats, goals } = data;
  const topGenreCount = stats.top_genres[0]?.count ?? 0;

  return (
    <Card>
      <p className="mb-4 font-mono text-xs font-medium uppercase tracking-widest text-muted">
        Your {year}
      </p>

      {stats.books === 0 ? (
        <p className="text-sm text-muted">Nothing dated in {year} yet.</p>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-y-4 sm:divide-x sm:divide-border">
            <Figure value={String(stats.books)} label="Books" />
            <Figure value={stats.pages.toLocaleString()} label="Pages" />
            <Figure
              value={`${stats.authors}${stats.new_authors > 0 ? ` (${stats.new_authors} new)` : ''}`}
              label="Authors"
            />
          </div>

          {stats.top_genres.length > 0 && (
            <div className="mt-6 space-y-2">
              <p className="font-mono text-xs uppercase tracking-widest text-faint">Top genres</p>
              {stats.top_genres.map((g) => (
                <div key={g.subject} className="flex items-center gap-3">
                  <span className="w-28 shrink-0 truncate text-sm text-muted">{g.subject}</span>
                  <Bar pct={topGenreCount > 0 ? (g.count / topGenreCount) * 100 : 0} />
                  <span className="w-8 text-right font-mono text-sm text-faint">{g.count}</span>
                </div>
              ))}
            </div>
          )}

          {stats.top_authors.length > 0 && (
            <p className="mt-4 text-sm text-muted">
              <span className="font-mono text-xs uppercase tracking-widest text-faint">
                Top authors{' '}
              </span>
              {stats.top_authors.map((a) => (
                <span key={a.author} className="ml-2">
                  <span>{a.author}</span> ({a.count})
                </span>
              ))}
            </p>
          )}
        </>
      )}

      {stats.undated > 0 && (
        <p className="mt-4 text-xs text-faint">
          {stats.undated} read {stats.undated === 1 ? 'book has' : 'books have'} no date and
          {stats.undated === 1 ? " isn't" : " aren't"} counted.
        </p>
      )}

      <div className="mt-6 border-t border-border pt-4">
        {goals.length === 0 ? (
          <p className="text-sm text-muted">
            No goals for {year}.{' '}
            <Link href="/settings" className="transition-colors hover:text-text">
              Set one in settings &rarr;
            </Link>
          </p>
        ) : (
          <div className="space-y-2">
            {goals.map((g) => (
              <div key={g.id}>
                <div className="flex items-center gap-3">
                  <span className="w-28 shrink-0 truncate text-sm text-muted">{goalLabel(g)}</span>
                  <Bar pct={g.target > 0 ? (g.progress / g.target) * 100 : 0} />
                  <span className="w-20 text-right font-mono text-sm text-faint">
                    {g.progress} / {g.target}
                  </span>
                  {g.done && <Badge variant="success">Done</Badge>}
                </div>
                {g.unknown > 0 && (
                  <p className="ml-[7.75rem] mt-1 text-xs text-faint">
                    {g.unknown} books have no page count.
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
