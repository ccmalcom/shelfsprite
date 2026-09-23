'use client';

import { useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { Plus } from 'lucide-react';
import PageHeading from '@/components/PageHeading';
import { Badge, Button, Spinner } from '@/components/ui';
import TitleTile from '@/components/screen/TitleTile';
import TitleDetailModal from '@/components/screen/TitleDetailModal';
import AddTitleModal from '@/components/screen/AddTitleModal';
import CorrectTitleModal from '@/components/screen/CorrectTitleModal';
import {
  screenApi,
  SCREEN_TITLES_KEY,
  type MediaType,
  type TitleOut,
  type TitleStatus,
} from '@/lib/api';
import { handleScreenError } from '@/lib/screenCache';
import {
  errorMessage,
  mediaLabel,
  needsCorrection,
  sortTitles,
  titleLabel,
  TITLE_SORTS,
  TITLE_SORT_LABELS,
  TITLE_STATUSES,
  TITLE_STATUS_LABELS,
  type TitleSort,
} from '@/lib/screen';
import { useStickySort } from '@/lib/useStickySort';

type TypeFilter = 'all' | MediaType;
type StatusFilter = 'all' | TitleStatus;

const TYPE_FILTERS: { value: TypeFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'movie', label: 'Films' },
  { value: 'tv', label: 'TV' },
];

const SELECT =
  'rounded-lg border border-border bg-elevated px-3 py-1.5 text-sm text-text focus:outline-none focus-visible:ring-1 focus-visible:ring-accent';

function tileLabel(t: TitleOut): string {
  return needsCorrection(t)
    ? `${titleLabel(t.title, t.year)}, check the match`
    : titleLabel(t.title, t.year);
}

/** The screen library (spec §7.3): one list, filtered and sorted in the browser. */
export default function ScreenLibraryPage() {
  const {
    data: titles,
    error,
    isLoading,
    mutate,
  } = useSWR<TitleOut[]>(SCREEN_TITLES_KEY, () => screenApi.titles(), {
    onError: handleScreenError,
  });
  const [type, setType] = useState<TypeFilter>('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [sort, setSort] = useStickySort<TitleSort>('screen-library-sort', 'recent', TITLE_SORTS);
  const [openId, setOpenId] = useState<number | null>(null);
  const [correctingId, setCorrectingId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);

  const all = titles ?? [];
  const byId = new Map(all.map((t) => [t.id, t]));
  const visible = sortTitles(
    all.filter(
      (t) => (type === 'all' || t.media_type === type) && (status === 'all' || t.status === status)
    ),
    sort
  );
  const open = openId === null ? null : (byId.get(openId) ?? null);
  const correcting = correctingId === null ? null : (byId.get(correctingId) ?? null);
  const lowCount = all.filter(needsCorrection).length;
  const duplicateOf = (t: TitleOut) => {
    const id = t.enrichment?.duplicate_of_title_id;
    return id == null ? null : (byId.get(id) ?? null);
  };

  return (
    <div className="editorial-page fade-in space-y-6">
      <PageHeading
        eyebrow="Library"
        title="Your ScreenSprite library"
        description="Every film and show you have logged. Rate them, fix a doubtful match, or add what Letterboxd missed."
      >
        <Button onClick={() => setAdding(true)}>
          <Plus size={16} aria-hidden="true" />
          Add a title
        </Button>
      </PageHeading>

      {error && !titles ? (
        <p role="alert" className="text-sm text-danger">
          {errorMessage(error, 'Your screen library did not load.')}{' '}
          <button type="button" className="underline" onClick={() => void mutate()}>
            Retry
          </button>
        </p>
      ) : isLoading && !titles ? (
        <div className="flex justify-center py-16">
          <Spinner size="lg" label="Loading your screen library" />
        </div>
      ) : all.length === 0 ? (
        <div className="rounded-2xl border border-border bg-surface p-8 text-center">
          <p className="font-display text-xl text-text">Nothing here yet.</p>
          <p className="mt-2 text-sm text-muted">
            Import your Letterboxd history, or add a film or show by hand.
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-3">
            <Link
              href="/settings#screen"
              className="inline-flex items-center justify-center rounded-lg bg-accent px-4 py-2 text-sm font-medium text-[color:var(--bg)] hover:bg-accent-hover"
            >
              Import from Letterboxd
            </Link>
            <Button variant="secondary" onClick={() => setAdding(true)}>
              Add a title
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <div
              role="group"
              aria-label="Type"
              className="inline-flex rounded-lg border border-border bg-elevated p-0.5"
            >
              {TYPE_FILTERS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  aria-pressed={type === f.value}
                  onClick={() => setType(f.value)}
                  className={[
                    'rounded-md px-3 py-1.5 text-xs font-semibold transition-colors',
                    type === f.value
                      ? 'bg-surface text-text shadow-sm'
                      : 'text-muted hover:text-text',
                  ].join(' ')}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <select
              aria-label="Status"
              value={status}
              onChange={(e) => setStatus(e.target.value as StatusFilter)}
              className={SELECT}
            >
              <option value="all">Any status</option>
              {TITLE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {TITLE_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
            <select
              aria-label="Sort by"
              value={sort}
              onChange={(e) => setSort(e.target.value as TitleSort)}
              className={SELECT}
            >
              {TITLE_SORTS.map((s) => (
                <option key={s} value={s}>
                  {TITLE_SORT_LABELS[s]}
                </option>
              ))}
            </select>
          </div>

          {lowCount > 0 && (
            <p className="text-xs text-muted">
              {`${lowCount} ${lowCount === 1 ? 'title needs' : 'titles need'} a second look. Open one marked "Check match" to fix it.`}
            </p>
          )}

          {visible.length === 0 ? (
            <p className="py-10 text-center text-sm text-faint">Nothing matches these filters.</p>
          ) : (
            <ul
              aria-label="Titles"
              className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5"
            >
              {visible.map((t, index) => (
                <li key={t.id}>
                  <button
                    type="button"
                    aria-label={tileLabel(t)}
                    onClick={() => setOpenId(t.id)}
                    className="block w-full rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <TitleTile
                      title={t.title}
                      year={t.year}
                      mediaType={t.media_type}
                      imageUrl={t.enrichment?.image_url ?? null}
                      sizes="(min-width: 1024px) 180px, 45vw"
                      // Up to five columns: any first-row poster can be the LCP element.
                      eager={index < 5}
                    />
                    <span className="mt-2 line-clamp-2 block text-sm font-medium text-text">
                      {t.title}
                    </span>
                    <span className="block font-mono text-xs text-faint">
                      {[
                        mediaLabel(t.media_type),
                        t.year === null ? null : String(t.year),
                        t.rating === null ? null : `${t.rating}\u2605`,
                      ]
                        .filter((x): x is string => x !== null)
                        .join(' \u00B7 ')}
                    </span>
                    {needsCorrection(t) && (
                      <Badge variant="warning" className="mt-1">
                        Check match
                      </Badge>
                    )}
                    {t.enrichment?.duplicate_of_title_id != null && (
                      <Badge variant="warning" className="mt-1">
                        Possible duplicate
                      </Badge>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {open && (
        <TitleDetailModal
          title={open}
          duplicateOf={duplicateOf(open)}
          onClose={() => setOpenId(null)}
          onCorrect={(t) => {
            setOpenId(null);
            setCorrectingId(t.id);
          }}
        />
      )}
      {correcting && (
        <CorrectTitleModal
          title={correcting}
          onClose={() => setCorrectingId(null)}
          onCorrected={() => setCorrectingId(null)}
        />
      )}
      {adding && (
        <AddTitleModal onClose={() => setAdding(false)} onAdded={() => setAdding(false)} />
      )}
    </div>
  );
}
