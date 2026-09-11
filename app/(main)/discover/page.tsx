'use client';

import PageHeading from '@/components/PageHeading';

import { useState } from 'react';
import { BookOpen, Plus, Check, Search, Sparkles } from 'lucide-react';
import { Spinner, useToast } from '@/components/ui';
import { api, type DiscoverBook } from '@/lib/api';
import ShelfSprite from '@/components/ShelfSprite';

export default function DiscoverPage() {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [interpretation, setInterpretation] = useState<string | null>(null);
  const [results, setResults] = useState<DiscoverBook[] | null>(null);
  const [added, setAdded] = useState<Set<number>>(new Set());
  const [addingRank, setAddingRank] = useState<number | null>(null);

  async function runSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.discover(q);
      setInterpretation(res.interpretation || null);
      setResults(res.recommendations);
      setAdded(new Set());
    } catch {
      setError('Discovery tripped - your request is fine, try running it again.');
      setResults(null);
      setInterpretation(null);
    } finally {
      setLoading(false);
    }
  }

  async function handleAdd(rec: DiscoverBook) {
    setAddingRank(rec.rank);
    try {
      await api.addBook({
        title: rec.title,
        author: rec.author,
        year: rec.year,
        isbn13: rec.isbn13,
        shelf: 'to-read',
        cover_url: rec.cover_url,
        subjects: rec.subjects,
        description: rec.description,
        catalog_source: rec.catalog_source,
        catalog_id: rec.catalog_id,
      });
      setAdded((prev) => new Set([...prev, rec.rank]));
      toast.success(`Added ${rec.title} to your to-read shelf.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That didn't save. Try again.");
    } finally {
      setAddingRank(null);
    }
  }

  return (
    <div className="editorial-page fade-in space-y-6">
      <PageHeading
        eyebrow="Follow your curiosity"
        title="Discover"
        description="A mood, a favorite book, a world you want to get lost in. Start anywhere."
      >
        <ShelfSprite
          variant="discover"
          priority
          sizes="96px"
          className="hidden h-24 w-24 shrink-0 sm:block"
        />
      </PageHeading>

      <form onSubmit={runSearch} className="flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint"
            aria-hidden="true"
          />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              'Ask for anything - "like Piranesi", "a thriller my book club won\'t hate"...'
            }
            aria-label="Describe the book you want"
            className={[
              'w-full min-w-0 rounded-xl border border-border-strong bg-surface py-4 pl-9 pr-4 text-sm text-text',
              'placeholder:text-faint focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
            ].join(' ')}
          />
        </div>
        <button
          type="submit"
          disabled={loading || !query.trim()}
          className={[
            'inline-flex items-center gap-1.5 justify-center rounded-xl bg-accent px-6 py-4 text-sm font-semibold text-base',
            'transition hover:opacity-90 disabled:opacity-50',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
          ].join(' ')}
        >
          <Sparkles className="h-4 w-4" aria-hidden="true" />
          Search
        </button>
      </form>

      {!loading && !results && !error && (
        <div className="border-b border-border pb-8">
          <p className="eyebrow mb-3">A few places to begin</p>
          <div className="flex flex-wrap gap-2">
            {[
              'Something like Piranesi',
              'A quiet story about starting over',
              'Science fiction with complicated characters',
            ].map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => setQuery(example)}
                className="rounded-lg border border-border bg-surface px-4 py-3 text-left text-sm text-muted hover:border-border-strong hover:text-text"
              >
                {example}
              </button>
            ))}
          </div>
          <p className="mt-4 text-xs text-muted">
            Every result comes from a real book catalog, with a reason to read it.
          </p>
        </div>
      )}

      {loading && (
        <div className="flex flex-col items-center gap-3 py-12">
          <Spinner size="lg" />
          <p className="text-sm text-muted">Reading the request… searching the shelves…</p>
        </div>
      )}

      {!loading && error && <p className="py-8 text-center text-sm text-danger">{error}</p>}

      {!loading && !error && interpretation && (
        <p className="text-sm text-muted">
          <span className="text-faint">Looking for:</span> {interpretation}
        </p>
      )}

      {!loading && !error && results && results.length === 0 && (
        <p className="py-8 text-center text-sm text-faint">
          The catalog came up dry on that one. Try fewer constraints, or a different comparison
          book.
        </p>
      )}

      {!loading && !error && results && results.length > 0 && (
        <div className="space-y-4">
          <p className="font-mono text-xs uppercase tracking-widest text-faint">
            Closest matches on the live catalog
          </p>
          <ul className="divide-y divide-border border-t border-border">
            {results.map((rec) => {
              const isAdded = added.has(rec.rank);
              return (
                <li key={rec.rank} className="flex gap-4 py-6 sm:gap-6">
                  <div className="relative h-24 w-16 shrink-0 overflow-hidden rounded-md bg-elevated">
                    {rec.cover_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={rec.cover_url}
                        alt={`Cover of ${rec.title}`}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center text-faint">
                        <BookOpen className="h-6 w-6" />
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-text">{rec.title}</p>
                    <p className="truncate text-xs text-muted">{rec.author ?? 'Unknown author'}</p>
                    {rec.rationale && (
                      <p className="mt-1 text-xs leading-relaxed text-muted">{rec.rationale}</p>
                    )}
                    <button
                      type="button"
                      disabled={isAdded || addingRank === rec.rank}
                      onClick={() => handleAdd(rec)}
                      className={[
                        'mt-2 inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition',
                        isAdded
                          ? 'border-success/40 bg-success/10 text-success'
                          : 'border-border text-muted hover:border-muted hover:text-text',
                        'disabled:opacity-60',
                      ].join(' ')}
                    >
                      {isAdded ? (
                        <>
                          <Check className="h-3 w-3" /> On to-read
                        </>
                      ) : (
                        <>
                          <Plus className="h-3 w-3" />
                          {addingRank === rec.rank ? 'Adding...' : 'Add to to-read'}
                        </>
                      )}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
