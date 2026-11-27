'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { mutate } from 'swr';
import PageHeading from '@/components/PageHeading';
import BookCover from '@/components/BookCover';
import ShelfSprite from '@/components/ShelfSprite';
import { Button, Spinner } from '@/components/ui';
import { api, type NextReadResult } from '@/lib/api';

/**
 * "Pick my next read": the top few books from the reader's own to-read shelf, each with a
 * reason. Reached from the home page's prompt and links and from the to-read shelf. Nothing is
 * saved; "Start reading" moves the book to Currently reading.
 */
export default function NextReadPage() {
  const [result, setResult] = useState<NextReadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [started, setStarted] = useState<Set<number>>(new Set());
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Each run is a paid Claude call: React's dev double-mount must not fire a second one.
  const ranOnce = useRef(false);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    setActionError(null);
    try {
      setResult(await api.nextRead(3));
      setStarted(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The picks hit a snag. Try again in a moment.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (ranOnce.current) return;
    ranOnce.current = true;
    void run();
  }, [run]);

  async function startReading(bookId: number) {
    setBusyId(bookId);
    setActionError(null);
    try {
      await api.setBookShelf(bookId, 'currently-reading');
      setStarted((prev) => new Set([...prev, bookId]));
      await Promise.all(
        ['books-to-read', 'books-currently-reading', 'stats'].map((key) =>
          mutate(key, undefined, { revalidate: true })
        )
      );
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Couldn't move that book. Try again.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="editorial-page fade-in">
      <PageHeading
        eyebrow="From your to-read shelf"
        title="Your next read"
        description="The books you already saved, weighed against what you love. No new books added."
      />

      {loading ? (
        <div className="flex items-center justify-center py-20" role="status">
          <div className="space-y-3 text-center">
            <Spinner size="lg" />
            <p className="text-sm text-muted">Reading your to-read shelf…</p>
          </div>
        </div>
      ) : error ? (
        <div className="space-y-4 py-12 text-center">
          <p role="alert" className="text-danger">
            {error}
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <Button variant="secondary" onClick={() => void run()}>
              Try again
            </Button>
            <Link
              href="/library?tab=to-read"
              className="self-center text-sm text-muted underline underline-offset-4"
            >
              Back to your shelf
            </Link>
          </div>
        </div>
      ) : result && result.picks.length === 0 ? (
        <div className="space-y-4 py-16 text-center">
          <ShelfSprite variant="sleep" sizes="128px" className="mx-auto h-32 w-32" />
          <p className="text-muted">No clear pick this time. Try again in a moment.</p>
          <Button variant="secondary" onClick={() => void run()}>
            Try again
          </Button>
        </div>
      ) : result ? (
        <>
          {actionError && (
            <p role="alert" className="mb-3 text-sm text-danger">
              {actionError}
            </p>
          )}
          <ol className="space-y-4">
            {result.picks.map((pick) => {
              const isStarted = started.has(pick.book.id);
              return (
                <li
                  key={pick.book.id}
                  className="flex gap-4 rounded-xl border border-border bg-surface p-4 sm:p-5"
                >
                  <BookCover book={pick.book} className="h-28 w-18 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-xs uppercase tracking-widest text-faint">
                      {pick.rank === 1 ? 'Read this next' : `Then #${pick.rank}`}
                    </p>
                    <h2 className="mt-1 font-display text-lg font-semibold leading-snug">
                      {pick.book.title}
                    </h2>
                    <p className="text-sm text-muted">{pick.book.author ?? 'Unknown author'}</p>
                    {pick.rationale && (
                      <p className="mt-2 text-sm leading-relaxed text-text">{pick.rationale}</p>
                    )}
                    <div className="mt-3">
                      {isStarted ? (
                        <p className="text-sm text-success" role="status">
                          On your Currently reading shelf.
                        </p>
                      ) : (
                        <Button
                          size="sm"
                          variant={pick.rank === 1 ? 'primary' : 'secondary'}
                          loading={busyId === pick.book.id}
                          disabled={busyId !== null}
                          onClick={() => void startReading(pick.book.id)}
                        >
                          Start reading
                        </Button>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
          {result.considered < result.to_read_count && (
            <p className="mt-4 text-xs text-faint">
              Weighed your {result.considered} most recently saved books of {result.to_read_count}.
            </p>
          )}
          <div className="mt-6 flex flex-wrap items-center gap-4">
            <Button variant="ghost" size="sm" onClick={() => void run()}>
              Pick again
            </Button>
            <Link href="/library?tab=to-read" className="text-sm text-muted hover:text-text">
              See the whole shelf →
            </Link>
          </div>
        </>
      ) : null}
    </div>
  );
}
