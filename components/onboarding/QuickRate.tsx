'use client';

import { useEffect, useRef, useState } from 'react';
import type { Book, BookMatchResult, CatalogMatch } from '@/lib/api';
import {
  QUICK_RATE_GENRES,
  QUICK_RATE_MAX_GENRES,
  QUICK_RATE_MIN_GENRES,
  quickRatePicks,
} from '@/lib/quickRatePicks';
import { matchInBatches } from '@/lib/matchBatches';
import { Button, StarRating } from '@/components/ui';
import BookCover from '@/components/BookCover';
import BulkReview, { type ReviewRow } from '@/components/onboarding/BulkReview';
import ColdStartMeter from '@/components/onboarding/ColdStartMeter';

interface Tile {
  key: string;
  source: string;
  book: CatalogMatch;
  rating: number;
}

type Stage = 'genres' | 'grid' | 'review';

/**
 * The quick-rate grid: pick two or three genres, then tap stars on the well-known titles
 * you have read. Titles come from the static list in lib/quickRatePicks.ts and are shown
 * only once they resolve to a catalog record (POST /books/match, strict mode). Rated tiles
 * go to the shared review screen and are added through the manual-add path.
 */
export default function QuickRate({
  onAdded,
  onCancel,
  baselineRatings = [],
  cancelLabel = 'Cancel',
}: {
  onAdded: (books: Book[]) => void;
  onCancel: () => void;
  baselineRatings?: ReadonlyArray<number | null | undefined>;
  cancelLabel?: string;
}) {
  const [stage, setStage] = useState<Stage>('genres');
  const [genres, setGenres] = useState<string[]>([]);
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [loading, setLoading] = useState<{ done: number; total: number } | null>(null);
  const run = useRef(0);

  useEffect(() => {
    const ref = run;
    return () => {
      ref.current += 1;
    };
  }, []);

  function toggleGenre(id: string) {
    setGenres((prev) =>
      prev.includes(id)
        ? prev.filter((g) => g !== id)
        : prev.length >= QUICK_RATE_MAX_GENRES
          ? prev
          : [...prev, id]
    );
  }

  async function loadGrid() {
    const picks = quickRatePicks(genres);
    const id = ++run.current;
    setTiles([]);
    setLoading({ done: 0, total: picks.length });
    setStage('grid');
    const toTiles = (results: (BookMatchResult | undefined)[]) => {
      const out: Tile[] = [];
      for (const [i, r] of results.entries()) {
        // Only resolved catalog records are shown; a book already shelved is left out.
        if (r?.status !== 'matched' || r.best.in_library) continue;
        out.push({
          key: `pick-${i}`,
          source: `${picks[i].title} by ${picks[i].author}`,
          book: r.best,
          rating: 0,
        });
      }
      return out;
    };
    await matchInBatches(picks, 'strict', {
      isCancelled: () => id !== run.current,
      onProgress: (results) => {
        if (id !== run.current) return;
        const fresh = toTiles(results);
        // Keep ratings already given while later batches arrive.
        setTiles((prev) =>
          fresh.map((t) => ({ ...t, rating: prev.find((p) => p.key === t.key)?.rating ?? 0 }))
        );
        setLoading({ done: results.filter(Boolean).length, total: picks.length });
      },
    });
    if (id === run.current) setLoading(null);
  }

  function rate(key: string, rating: number) {
    setTiles((prev) => prev.map((t) => (t.key === key ? { ...t, rating } : t)));
  }

  const rated = tiles.filter((t) => t.rating > 0);

  if (stage === 'review') {
    const rows: ReviewRow[] = rated.map((t) => ({
      key: t.key,
      source: t.book.title,
      query: [t.book.title, t.book.author].filter(Boolean).join(' '),
      book: t.book,
      alternatives: [],
      rating: t.rating,
    }));
    return (
      <BulkReview
        initialRows={rows}
        baselineRatings={baselineRatings}
        onAdded={onAdded}
        onBack={() => setStage('grid')}
        backLabel="Back to the grid"
      />
    );
  }

  if (stage === 'genres') {
    const ready = genres.length >= QUICK_RATE_MIN_GENRES;
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted">
          Pick {QUICK_RATE_MIN_GENRES} or {QUICK_RATE_MAX_GENRES} genres you read. We will show you
          well-known books from them to rate.
        </p>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Genres">
          {QUICK_RATE_GENRES.map((g) => {
            const on = genres.includes(g.id);
            const full = !on && genres.length >= QUICK_RATE_MAX_GENRES;
            return (
              <button
                key={g.id}
                type="button"
                aria-pressed={on}
                disabled={full}
                onClick={() => toggleGenre(g.id)}
                className={[
                  'rounded-full border px-3 py-1.5 text-sm transition',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
                  on
                    ? 'border-accent bg-accent-quiet text-accent'
                    : 'border-border text-muted hover:border-muted hover:text-text',
                  full ? 'cursor-not-allowed opacity-50' : '',
                ].join(' ')}
              >
                {g.label}
              </button>
            );
          })}
        </div>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button onClick={() => void loadGrid()} disabled={!ready}>
            {ready ? 'Show me books' : `Pick ${QUICK_RATE_MIN_GENRES - genres.length} more`}
          </Button>
        </div>
      </div>
    );
  }

  const pending = loading ? loading.total - loading.done : 0;
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        Tap the stars on the books you have read. Skip the rest. Half stars work too.
      </p>
      <ColdStartMeter ratings={[...baselineRatings, ...tiles.map((t) => t.rating)]} />

      {loading && (
        <p className="text-xs text-faint" aria-live="polite">
          Finding books in the catalogs. {loading.done} of {loading.total} checked.
        </p>
      )}

      {!loading && tiles.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border bg-elevated/40 p-6 text-center text-sm text-muted">
          We could not reach the catalogs just now. Try again in a minute, or add books another way.
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3" aria-label="Books to rate">
          {tiles.map((t) => (
            <li
              key={t.key}
              className={[
                'flex flex-col rounded-lg border bg-base p-2',
                t.rating > 0 ? 'border-accent/60' : 'border-border',
              ].join(' ')}
            >
              <BookCover book={t.book} className="mb-2 aspect-[2/3] w-full" />
              <p className="line-clamp-2 text-sm font-medium leading-snug text-text">
                {t.book.title}
              </p>
              <p className="mb-1.5 truncate text-xs text-faint">
                {t.book.author ?? 'Unknown author'}
              </p>
              <div className="mt-auto flex items-center gap-1.5">
                <StarRating
                  value={t.rating}
                  onChange={(r) => rate(t.key, r)}
                  allowHalf
                  size={16}
                  label={`Your rating for ${t.book.title}`}
                />
                {t.rating > 0 && (
                  <button
                    type="button"
                    onClick={() => rate(t.key, 0)}
                    aria-label={`Clear rating for ${t.book.title}`}
                    className="rounded text-xs text-faint hover:text-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                  >
                    Clear
                  </button>
                )}
              </div>
            </li>
          ))}
          {Array.from({ length: Math.min(pending, 6) }, (_, i) => (
            <li
              key={`placeholder-${i}`}
              aria-hidden="true"
              className="h-56 rounded-lg border border-border bg-elevated/40 motion-safe:animate-pulse"
            />
          ))}
        </ul>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
        <Button
          variant="ghost"
          onClick={() => {
            run.current += 1;
            setLoading(null);
            setStage('genres');
          }}
        >
          Change genres
        </Button>
        <Button onClick={() => setStage('review')} disabled={rated.length === 0}>
          {rated.length === 0
            ? 'Rate a book to continue'
            : `Review ${rated.length} rated book${rated.length === 1 ? '' : 's'}`}
        </Button>
      </div>
    </div>
  );
}
