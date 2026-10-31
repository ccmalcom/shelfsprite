'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import {
  api,
  catalogYearLabel,
  type AddBookRequest,
  type Book,
  type CatalogResult,
  type Shelf,
} from '@/lib/api';
import { sameWork } from '@/lib/server/dedup';
import { Badge, Button, StarRating, useToast } from '@/components/ui';
import BookCover from '@/components/BookCover';
import CatalogInlineSearch from '@/components/onboarding/CatalogInlineSearch';
import ColdStartMeter from '@/components/onboarding/ColdStartMeter';

/** A catalog record on the review screen; `in_library` is known only for matched hits. */
export type ReviewBook = CatalogResult & { in_library?: boolean };

export interface ReviewRow {
  key: string;
  /** What the reader pasted, or the curated pick this came from. */
  source: string;
  /** The catalog search "Not this book" starts from: the parsed title and author, not the raw line. */
  query: string;
  book: ReviewBook;
  alternatives: ReviewBook[];
  /** 0 is unrated. */
  rating: number;
}

export interface UnmatchedLine {
  key: string;
  text: string;
  /** The catalog search "Search" starts from. */
  query: string;
}

/** The POST /books body for a confirmed row: the same fields AddBookModal sends. */
export function addRequestFor(row: ReviewRow, shelf: Shelf = 'read'): AddBookRequest {
  const b = row.book;
  return {
    title: b.title,
    author: b.author,
    year: b.year,
    isbn13: b.isbn13,
    shelf,
    rating: row.rating > 0 ? row.rating : undefined,
    cover_url: b.cover_url,
    subjects: b.subjects,
    description: b.description,
    catalog_source: b.source,
    catalog_id: b.catalog_id,
  };
}

/** The shelves a reviewed list can go to, in AddBookModal's order and wording. */
export const BULK_SHELF_OPTIONS: { value: Shelf; label: string }[] = [
  { value: 'read', label: 'Read' },
  { value: 'currently-reading', label: 'Reading' },
  { value: 'to-read', label: 'To read' },
  { value: 'did-not-finish', label: 'DNF' },
];

type Flag = 'in-library' | 'listed-twice' | null;

function flagsFor(rows: ReviewRow[]): Flag[] {
  return rows.map((row, i) => {
    if (row.book.in_library) return 'in-library';
    const earlier = rows
      .slice(0, i)
      .some(
        (r) =>
          !r.book.in_library &&
          sameWork(r.book.title, r.book.author, row.book.title, row.book.author)
      );
    return earlier ? 'listed-twice' : null;
  });
}

/**
 * The one review screen both no-export flows land on (a pasted list, the quick-rate grid).
 * Each matched book shows its cover, title, author and year with an optional half-star
 * rating, a "Not this book" control that swaps in an alternative or a fresh search, and a
 * remove button. Unmatched lines can be searched by hand or dropped. Confirming sends the
 * remaining books to POST /books/bulk, the manual-add path; books already in the library
 * are flagged here and never sent.
 */
export default function BulkReview({
  initialRows,
  initialUnmatched = [],
  baselineRatings,
  note,
  chooseShelf = false,
  onAdded,
  onBack,
  backLabel = 'Back',
}: {
  initialRows: ReviewRow[];
  initialUnmatched?: UnmatchedLine[];
  /**
   * Ratings already in the library, counted toward the cold-start meter. Leave it out to hide
   * the meter (the library's paste dialog, where the library's own ratings are not loaded).
   */
  baselineRatings?: ReadonlyArray<number | null | undefined>;
  note?: string;
  /**
   * Offer a shelf for the whole list. A pasted list can be a reading history or a wish list;
   * quick-rate picks are books the reader has rated, so they always go to Read.
   */
  chooseShelf?: boolean;
  onAdded: (books: Book[]) => void;
  onBack?: () => void;
  backLabel?: string;
}) {
  const toast = useToast();
  const [rows, setRows] = useState<ReviewRow[]>(initialRows);
  const [unmatched, setUnmatched] = useState<UnmatchedLine[]>(initialUnmatched);
  const [swapping, setSwapping] = useState<string | null>(null);
  const [searching, setSearching] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [shelf, setShelf] = useState<Shelf>('read');

  const flags = flagsFor(rows);
  const addable = rows.filter((_, i) => flags[i] === null);
  const ratings = baselineRatings ? [...baselineRatings, ...addable.map((r) => r.rating)] : null;

  function update(key: string, fn: (row: ReviewRow) => ReviewRow) {
    setRows((prev) => prev.map((r) => (r.key === key ? fn(r) : r)));
  }

  function swapTo(key: string, pick: ReviewBook) {
    update(key, (row) => ({
      ...row,
      book: pick,
      alternatives: [row.book, ...row.alternatives.filter((a) => a !== pick)],
    }));
    setSwapping(null);
  }

  function resolveUnmatched(line: UnmatchedLine, pick: CatalogResult) {
    setUnmatched((prev) => prev.filter((u) => u.key !== line.key));
    setRows((prev) => [
      ...prev,
      {
        key: line.key,
        source: line.text,
        query: line.query,
        book: pick,
        alternatives: [],
        rating: 0,
      },
    ]);
    setSearching(null);
  }

  async function handleConfirm() {
    if (addable.length === 0) return;
    setSaving(true);
    try {
      const result = await api.addBooks(addable.map((row) => addRequestFor(row, shelf)));
      const added = result.added.length;
      const parts = [`Added ${added} book${added === 1 ? '' : 's'}.`];
      if (result.duplicates.length > 0) {
        const d = result.duplicates.length;
        parts.push(`${d} ${d === 1 ? 'was' : 'were'} already in your library.`);
      }
      if (added > 0) toast.success(parts.join(' '));
      else toast.info(parts.join(' '));
      if (result.errors.length > 0) {
        toast.error(
          `${result.errors.length} could not be added: ${result.errors.map((e) => e.title).join(', ')}.`
        );
      }
      onAdded(result.added);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Those books did not save. Try again.');
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      {ratings && <ColdStartMeter ratings={ratings} />}

      {note && <p className="text-xs text-faint">{note}</p>}

      {chooseShelf && (
        <div>
          <span id="bulk-shelf-label" className="mb-2 block text-xs font-medium text-muted">
            Add these to
          </span>
          <div
            role="radiogroup"
            aria-labelledby="bulk-shelf-label"
            className="flex flex-wrap gap-1 rounded-lg border border-border bg-elevated p-1"
          >
            {BULK_SHELF_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={shelf === o.value}
                onClick={() => setShelf(o.value)}
                className={[
                  'flex-1 rounded-md px-2 py-1.5 text-sm font-medium transition',
                  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                  shelf === o.value ? 'bg-surface text-text shadow' : 'text-muted hover:text-text',
                ].join(' ')}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {rows.length > 0 ? (
        <ul className="space-y-2" aria-label="Books to add">
          {rows.map((row, i) => {
            const flag = flags[i];
            const b = row.book;
            return (
              <li key={row.key} className="rounded-lg border border-border bg-base p-2.5">
                <div className="flex items-start gap-3">
                  <BookCover book={b} className="h-16 w-11" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-text">{b.title}</p>
                    <p className="truncate text-xs text-faint">
                      {b.author ?? 'Unknown author'}
                      {catalogYearLabel(b)}
                    </p>
                    {row.source.trim().toLowerCase() !== b.title.trim().toLowerCase() && (
                      <p className="truncate text-xs text-faint">From your list: {row.source}</p>
                    )}
                    {flag === 'in-library' && (
                      <Badge variant="warning" className="mt-1">
                        Already in your library
                      </Badge>
                    )}
                    {flag === 'listed-twice' && (
                      <Badge variant="warning" className="mt-1">
                        Listed twice
                      </Badge>
                    )}
                    {flag === null && (
                      <div className="mt-1.5 flex items-center gap-2">
                        <StarRating
                          value={row.rating}
                          onChange={(rating) => update(row.key, (r) => ({ ...r, rating }))}
                          allowHalf
                          size={20}
                          label={`Your rating for ${b.title}`}
                        />
                        {row.rating > 0 && (
                          <button
                            type="button"
                            onClick={() => update(row.key, (r) => ({ ...r, rating: 0 }))}
                            className="rounded text-xs text-faint hover:text-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                          >
                            Clear
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <button
                      type="button"
                      onClick={() => setRows((prev) => prev.filter((r) => r.key !== row.key))}
                      aria-label={`Remove ${b.title}`}
                      className="rounded p-1 text-faint transition hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                      <X className="h-4 w-4" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      aria-expanded={swapping === row.key}
                      onClick={() => setSwapping((k) => (k === row.key ? null : row.key))}
                      className="rounded px-1 text-xs text-muted underline-offset-2 hover:text-text hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                    >
                      Not this book
                    </button>
                  </div>
                </div>

                {swapping === row.key && (
                  <div className="mt-3 space-y-3 border-t border-border pt-3">
                    {row.alternatives.length > 0 && (
                      <div>
                        <p className="mb-1 text-xs font-medium text-muted">Other matches</p>
                        <ul className="space-y-1">
                          {row.alternatives.map((alt, ai) => (
                            <li key={`${alt.source}-${alt.catalog_id ?? ai}`}>
                              <button
                                type="button"
                                onClick={() => swapTo(row.key, alt)}
                                className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition hover:bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                              >
                                <BookCover book={alt} className="h-12 w-8" />
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-sm text-text">
                                    {alt.title}
                                  </span>
                                  <span className="block truncate text-xs text-faint">
                                    {alt.author ?? 'Unknown author'}
                                    {catalogYearLabel(alt)}
                                  </span>
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <CatalogInlineSearch
                      initialQuery={row.query}
                      label={`Search for a different book than ${b.title}`}
                      onPick={(hit) => swapTo(row.key, hit)}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="rounded-xl border border-dashed border-border bg-elevated/40 p-6 text-center text-sm text-muted">
          No books to add yet.
        </p>
      )}

      {unmatched.length > 0 && (
        <section aria-labelledby="unmatched-heading" className="space-y-2">
          <h3 id="unmatched-heading" className="text-sm font-semibold text-text">
            No match found ({unmatched.length})
          </h3>
          <p className="text-xs text-faint">
            Search for these yourself, or drop them. Dropped lines are not added.
          </p>
          <ul className="space-y-2">
            {unmatched.map((line) => (
              <li key={line.key} className="rounded-lg border border-border bg-base p-2.5">
                <div className="flex items-center gap-2">
                  <p className="min-w-0 flex-1 truncate text-sm text-muted">{line.text}</p>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-expanded={searching === line.key}
                    onClick={() => setSearching((k) => (k === line.key ? null : line.key))}
                  >
                    Search
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Drop ${line.text}`}
                    onClick={() => setUnmatched((prev) => prev.filter((u) => u.key !== line.key))}
                  >
                    Drop
                  </Button>
                </div>
                {searching === line.key && (
                  <div className="mt-3 border-t border-border pt-3">
                    <CatalogInlineSearch
                      initialQuery={line.query}
                      label={`Search the catalog for ${line.text}`}
                      onPick={(hit) => resolveUnmatched(line, hit)}
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {onBack && (
          <Button variant="ghost" onClick={onBack} disabled={saving}>
            {backLabel}
          </Button>
        )}
        <Button
          onClick={() => void handleConfirm()}
          loading={saving}
          disabled={saving || addable.length === 0}
        >
          {addable.length === 0
            ? 'Nothing to add'
            : `Add ${addable.length} book${addable.length === 1 ? '' : 's'}`}
        </Button>
      </div>
    </div>
  );
}
