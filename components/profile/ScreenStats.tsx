'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import type { TitleOut } from '@/lib/api';
import { TITLE_STATUSES, TITLE_STATUS_LABELS } from '@/lib/screen';
import { screenStats, type PersonStat } from '@/lib/screenStats';
import { Card } from '@/components/ui';
import { GenreSection, RatingSection } from '@/components/profile/StatSections';

function Tally({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <div className="font-display text-3xl font-semibold text-text">{value}</div>
      <div className="mt-0.5 text-xs text-faint">{label}</div>
    </div>
  );
}

function LibrarySection({ stats }: { stats: ReturnType<typeof screenStats> }) {
  return (
    <section className="space-y-4">
      <h2 className="font-display text-lg font-semibold text-text">Your screen library</h2>
      <Card>
        <div className="flex flex-wrap items-end gap-x-10 gap-y-4">
          <Tally value={stats.films} label={stats.films === 1 ? 'film' : 'films'} />
          <Tally value={stats.shows} label={stats.shows === 1 ? 'show' : 'shows'} />
        </div>
        <dl className="mt-5 flex flex-wrap gap-x-6 gap-y-2 border-t border-border pt-4 text-sm">
          {TITLE_STATUSES.map((s) => (
            <div key={s} className="flex items-baseline gap-1.5">
              <dt className="text-muted">{TITLE_STATUS_LABELS[s]}</dt>
              <dd className="font-mono text-text">{stats.byStatus[s]}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </section>
  );
}

function PeopleList({
  heading,
  people,
  empty,
}: {
  heading: string;
  people: PersonStat[];
  empty: string;
}) {
  return (
    <Card>
      <h3 className="text-sm font-semibold text-text">{heading}</h3>
      {people.length === 0 ? (
        <p className="mt-3 text-sm text-faint">{empty}</p>
      ) : (
        <ol className="mt-3 space-y-2">
          {people.map((p) => (
            <li key={p.name} className="flex items-baseline gap-3 text-sm">
              <span className="min-w-0 flex-1 truncate text-muted" title={p.name}>
                {p.name}
              </span>
              <span className="shrink-0 font-mono text-xs text-faint">
                {p.count} · <span className="text-accent">{'\u2605'}</span> {p.mean.toFixed(1)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

function PeopleSection({
  directors,
  creators,
}: {
  directors: PersonStat[];
  creators: PersonStat[];
}) {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="font-display text-lg font-semibold text-text">Directors & creators</h2>
        <p className="mt-0.5 text-xs text-faint">
          The people behind at least two of your rated titles, with your average rating.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <PeopleList heading="Directors" people={directors} empty="No director repeats yet." />
        <PeopleList heading="TV creators" people={creators} empty="No creator repeats yet." />
      </div>
    </section>
  );
}

/** The screen profile's stats, in place of the book ones (the books profile keeps its own). */
export function ScreenStats({ titles }: { titles: readonly TitleOut[] }) {
  const stats = useMemo(() => screenStats(titles), [titles]);

  if (stats.films + stats.shows === 0) {
    return (
      <p className="py-10 text-center text-faint">
        No films or shows yet.{' '}
        <Link href="/settings#screen" className="underline underline-offset-4 hover:text-muted">
          Import from Letterboxd
        </Link>{' '}
        to see your screen stats.
      </p>
    );
  }

  return (
    <>
      <LibrarySection stats={stats} />
      <RatingSection
        byStar={stats.byStar}
        rated={stats.rated}
        meanRating={stats.meanRating}
        noun="title"
      />
      <GenreSection
        subjects={stats.genres}
        description="Genres from catalog data across your rated films and shows."
        emptyText="No genre data yet."
      />
      <PeopleSection directors={stats.directors} creators={stats.creators} />
    </>
  );
}
