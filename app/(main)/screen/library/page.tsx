'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import useSWR from 'swr';
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

const TYPE_FILTERS: { value: TypeFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'movie', label: 'Films' },
  { value: 'tv', label: 'TV' },
];

// The status shelves, in the book library's order: done, in progress, planned, abandoned.
// `short` is what narrow screens show, as on the book shelves: four full labels with their
// counts overflow a phone, and "Watchlist" is the word the accept toast already uses.
const SHELVES: { id: TitleStatus; short: string }[] = [
  { id: 'watched', short: 'Watched' },
  { id: 'watching', short: 'Watching' },
  { id: 'want', short: 'Watchlist' },
  { id: 'dropped', short: 'Dropped' },
];

function isShelf(value: string | null): value is TitleStatus {
  return (TITLE_STATUSES as readonly (string | null)[]).includes(value);
}

function matchesSearch(t: TitleOut, needle: string): boolean {
  if (needle === '') return true;
  const people = [...(t.enrichment?.directors ?? []), ...(t.enrichment?.creators ?? [])];
  return [t.title, ...people].some((s) => s.toLowerCase().includes(needle));
}

const HEADING = (
  <div>
    <p className="eyebrow mb-2">Your collection</p>
    <h1 className="font-display text-3xl font-bold tracking-tight text-text sm:text-4xl">
      My library
    </h1>
  </div>
);

function tileLabel(t: TitleOut): string {
  return needsCorrection(t)
    ? `${titleLabel(t.title, t.year)}, check the match`
    : titleLabel(t.title, t.year);
}

/**
 * The screen library (spec §7.3), laid out like the book library: one shelf per status, with
 * the shelf in `?tab=` so the watchlist has a URL. Filtering and sorting stay in the browser.
 */
function ScreenLibraryInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const rawTab = searchParams.get('tab');
  const shelf: TitleStatus = isShelf(rawTab) ? rawTab : 'watched';

  const {
    data: titles,
    error,
    isLoading,
    mutate,
  } = useSWR<TitleOut[]>(SCREEN_TITLES_KEY, () => screenApi.titles(), {
    onError: handleScreenError,
  });
  const [type, setType] = useState<TypeFilter>('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useStickySort<TitleSort>('screen-library-sort', 'recent', TITLE_SORTS);
  const [openId, setOpenId] = useState<number | null>(null);
  const [correctingId, setCorrectingId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);

  function setShelf(next: TitleStatus) {
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', next);
    router.replace(`/screen/library?${params.toString()}`);
  }

  const all = titles ?? [];
  const byId = new Map(all.map((t) => [t.id, t]));
  const onShelf = all.filter((t) => t.status === shelf);
  const needle = search.trim().toLowerCase();
  const visible = sortTitles(
    onShelf.filter((t) => (type === 'all' || t.media_type === type) && matchesSearch(t, needle)),
    sort
  );
  const open = openId === null ? null : (byId.get(openId) ?? null);
  const correcting = correctingId === null ? null : (byId.get(correctingId) ?? null);
  const lowTitles = all.filter(needsCorrection);
  const duplicateOf = (t: TitleOut) => {
    const id = t.enrichment?.duplicate_of_title_id;
    return id == null ? null : (byId.get(id) ?? null);
  };

  return (
    <div className="library-page fade-in space-y-3">
      <div className="flex items-center justify-between gap-3">
        {HEADING}
        <Button onClick={() => setAdding(true)}>+ Add a title</Button>
      </div>

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
          {/* Same strip as the book shelves, and it scrolls locally on phones the same way. */}
          <nav
            className="library-shelves flex gap-1 border-b border-border"
            aria-label="Library shelves"
          >
            {SHELVES.map((s) => {
              const count = all.filter((t) => t.status === s.id).length;
              const active = shelf === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setShelf(s.id)}
                  aria-current={active ? 'true' : undefined}
                  className={[
                    'flex shrink-0 items-center justify-center gap-2 whitespace-nowrap',
                    'border-b-2 px-3 py-3 text-sm font-medium transition',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-elevated',
                    active
                      ? 'border-accent text-text'
                      : 'border-transparent text-muted hover:text-text',
                  ].join(' ')}
                >
                  {/* Only one of these is in the layout (and the a11y tree) at a time. */}
                  <span className="md:hidden">{s.short}</span>
                  <span className="hidden md:inline">{TITLE_STATUS_LABELS[s.id]}</span>
                  {count > 0 && (
                    <span
                      className={[
                        'rounded-full px-1.5 py-0.5 font-mono text-xs',
                        active ? 'bg-elevated text-muted' : 'bg-surface text-faint',
                      ].join(' ')}
                    >
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          {lowTitles.length > 0 && (
            <details className="text-sm text-muted">
              <summary className="cursor-pointer py-2">
                {`Library care · ${lowTitles.length} match ${lowTitles.length === 1 ? 'check' : 'checks'}`}
              </summary>
              <Button variant="ghost" size="sm" onClick={() => setCorrectingId(lowTitles[0]!.id)}>
                {lowTitles.length === 1
                  ? '1 title needs a match check'
                  : `${lowTitles.length} titles need a match check`}
              </Button>
            </details>
          )}

          <div className="flex flex-wrap items-center gap-3">
            {/* An expression container: a bare-attribute escape ships literally (docs/conventions.md). */}
            <input
              type="search"
              placeholder={'Search title or director…'}
              aria-label="Search this shelf by title or director"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className={[
                'min-w-[12rem] flex-1 rounded-lg border border-border bg-elevated px-3 py-2',
                'text-sm text-text placeholder-faint',
                'focus:border-accent focus:outline-none focus-visible:ring-1 focus-visible:ring-accent',
              ].join(' ')}
            />
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
              aria-label="Sort by"
              value={sort}
              onChange={(e) => setSort(e.target.value as TitleSort)}
              className={[
                'rounded-lg border border-border bg-elevated px-3 py-2',
                'text-sm text-muted focus:border-accent focus:outline-none focus-visible:ring-1 focus-visible:ring-accent',
              ].join(' ')}
            >
              {TITLE_SORTS.map((s) => (
                <option key={s} value={s}>
                  {TITLE_SORT_LABELS[s]}
                </option>
              ))}
            </select>
          </div>

          {onShelf.length === 0 ? (
            <p className="py-10 text-center text-sm text-faint">Nothing on this shelf yet.</p>
          ) : visible.length === 0 ? (
            <p className="py-10 text-center text-sm text-faint">Nothing matches these filters.</p>
          ) : (
            <ul
              aria-label="Titles"
              className="grid grid-cols-2 gap-4 pt-3 sm:grid-cols-3 lg:grid-cols-5"
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
                      // The page is as wide as the book library: 1104 px of content at most.
                      sizes="(min-width: 1024px) 210px, 45vw"
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
                        t.rating === null ? null : `${t.rating}★`,
                      ]
                        .filter((x): x is string => x !== null)
                        .join(' · ')}
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
        <AddTitleModal
          onClose={() => setAdding(false)}
          onAdded={(t) => {
            setAdding(false);
            setShelf(t.status);
          }}
        />
      )}
    </div>
  );
}

// useSearchParams needs a Suspense boundary, as on the book library.
export default function ScreenLibraryPage() {
  return (
    <Suspense
      fallback={
        <div className="library-page fade-in space-y-3">
          {HEADING}
          <div className="flex justify-center py-16">
            <Spinner size="lg" label="Loading your screen library" />
          </div>
        </div>
      }
    >
      <ScreenLibraryInner />
    </Suspense>
  );
}
