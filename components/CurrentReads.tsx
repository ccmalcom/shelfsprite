'use client';
import { useState } from 'react';
import Link from 'next/link';
import useSWR, { mutate } from 'swr';
import { api, type Book, PROFILE_STATUS_KEY, GOALS_KEY } from '@/lib/api';
import { Button } from '@/components/ui';
import BookCover from '@/components/BookCover';
import BookEditModal from '@/components/BookEditModal';

export default function CurrentReads() {
  const {
    data: books,
    isLoading,
    error,
    mutate: refresh,
  } = useSWR<Book[]>('books-currently-reading', () =>
    api.books({ shelf: 'currently-reading', limit: 500 })
  );
  const [busyId, setBusyId] = useState<number | null>(null);
  const [reviewing, setReviewing] = useState<Book | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  async function finish(book: Book) {
    setBusyId(book.id);
    setActionError(null);
    try {
      const updated = await api.setBookShelf(book.id, 'read');
      setReviewing({ ...book, ...updated, exclusive_shelf: 'read' });
      await refresh((curr) => curr?.filter((b) => b.id !== book.id), { revalidate: false });
      await Promise.all(
        ['books-read', 'stats', PROFILE_STATUS_KEY, GOALS_KEY].map((key) =>
          mutate(key, undefined, { revalidate: true })
        )
      );
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not finish that book. Try again.');
    } finally {
      setBusyId(null);
    }
  }
  return (
    <section className="mt-7" aria-labelledby="current-reads-title">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 id="current-reads-title" className="font-display text-2xl font-semibold">
          Currently reading
        </h2>
        <Link
          href="/library?tab=currently-reading"
          className="py-2 text-sm text-muted hover:text-text"
        >
          View shelf →
        </Link>
      </div>
      {actionError && (
        <p role="alert" className="mb-3 text-sm text-danger">
          {actionError}
        </p>
      )}
      {isLoading ? (
        <div
          className="h-32 rounded-xl bg-surface motion-safe:animate-pulse"
          role="status"
          aria-label="Loading current reads"
        />
      ) : error ? (
        <p className="text-sm text-muted">
          Your current reads didn’t load.{' '}
          <button type="button" className="underline" onClick={() => void refresh()}>
            Retry
          </button>
        </p>
      ) : books?.length ? (
        <div className="grid gap-4 md:grid-cols-2">
          {books.slice(0, 2).map((book) => (
            <article
              key={book.id}
              className="flex gap-4 rounded-xl border border-border bg-surface p-4"
            >
              <BookCover book={book} className="h-24 w-16" />
              <div className="min-w-0 flex-1">
                <h3 className="font-display text-lg font-semibold leading-snug">{book.title}</h3>
                <p className="mt-1 text-xs text-muted">{book.author ?? 'Unknown author'}</p>
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-3 min-h-10"
                  disabled={busyId !== null}
                  loading={busyId === book.id}
                  onClick={() => void finish(book)}
                >
                  Mark finished
                </Button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-border p-5">
          <p className="text-sm text-muted">
            Nothing in progress. Choose a book from your to-read shelf to start your next chapter.
          </p>
          <Link
            href="/library?tab=to-read"
            className="mt-3 inline-block text-sm underline underline-offset-4"
          >
            Choose a book →
          </Link>
        </div>
      )}
      {reviewing && (
        <BookEditModal
          book={reviewing}
          listKey="books-read"
          onClose={() => {
            setReviewing(null);
            void refresh();
          }}
        />
      )}
    </section>
  );
}
