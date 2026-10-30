'use client';

import { useEffect, useRef, useState } from 'react';
import { api, catalogYearLabel, type CatalogResult } from '@/lib/api';
import BookCover from '@/components/BookCover';

type Outcome = { query: string; hits: CatalogResult[] } | { query: string; error: string };

/**
 * A small catalog search inside the review screen, for a line that matched the wrong book
 * or nothing. Same debounced GET /catalog/search as the add-a-book modal.
 */
export default function CatalogInlineSearch({
  initialQuery,
  label,
  onPick,
}: {
  initialQuery: string;
  /** Accessible name for the search box. */
  label: string;
  onPick: (hit: CatalogResult) => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const reqId = useRef(0);
  const trimmed = query.trim();
  const shouldSearch = trimmed.length >= 2;

  useEffect(() => {
    if (!shouldSearch) return;
    const id = ++reqId.current;
    const t = setTimeout(async () => {
      try {
        const hits = await api.catalogSearch(trimmed, 6);
        if (id === reqId.current) setOutcome({ query: trimmed, hits });
      } catch (e) {
        if (id === reqId.current) {
          setOutcome({ query: trimmed, error: e instanceof Error ? e.message : 'Search failed.' });
        }
      }
    }, 350);
    return () => clearTimeout(t);
  }, [shouldSearch, trimmed]);

  const current = shouldSearch && outcome?.query === trimmed ? outcome : null;
  const hits = current && 'hits' in current ? current.hits : [];
  const error = current && 'error' in current ? current.error : null;
  const searching = shouldSearch && current == null;

  return (
    <div className="space-y-2">
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label={label}
        placeholder="Search by title or author"
        className="w-full rounded-lg border border-border-strong bg-base px-3 py-2 text-sm text-text placeholder-faint focus:border-accent focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      />
      {searching && <p className="text-xs text-muted">Searching the catalogs.</p>}
      {error && <p className="text-xs text-danger">{error}</p>}
      {!searching && !error && shouldSearch && hits.length === 0 && (
        <p className="text-xs text-muted">No matches. Try a different spelling.</p>
      )}
      {hits.length > 0 && (
        <ul className="space-y-1">
          {hits.map((h, i) => (
            <li key={`${h.source}-${h.catalog_id ?? i}`}>
              <button
                type="button"
                onClick={() => onPick(h)}
                className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition hover:bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <BookCover book={h} className="h-12 w-8" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-text">{h.title}</span>
                  <span className="block truncate text-xs text-faint">
                    {h.author ?? 'Unknown author'}
                    {catalogYearLabel(h)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
