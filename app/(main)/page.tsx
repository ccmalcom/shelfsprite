'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import useSWR, { mutate } from 'swr';
import {
  api,
  type Stats,
  type Book,
  type ProfileStatus,
  type ArchetypeOut,
  type UserProfile,
  PROFILE_STATUS_KEY,
  ARCHETYPE_KEY,
} from '@/lib/api';
import { Button, useToast } from '@/components/ui';
import ReaderSprite from '@/components/ReaderSprite';
import BookCover from '@/components/BookCover';
import CurrentReads from '@/components/CurrentReads';
import YearCard from '@/components/YearCard';

export default function HomePage() {
  const router = useRouter();
  const toast = useToast();
  const [running, setRunning] = useState(false);

  const {
    data: stats,
    isLoading: statsLoading,
    error: statsError,
  } = useSWR<Stats>('stats', () => api.stats());

  const {
    data: profileStatus,
    error: profileError,
    mutate: retryProfile,
  } = useSWR<ProfileStatus>(PROFILE_STATUS_KEY, () => api.profileStatus());

  const { data: userProfile } = useSWR<UserProfile>('user-profile', () => api.getProfile());
  const { data: archetype } = useSWR<ArchetypeOut | null>(ARCHETYPE_KEY, () => api.getArchetype());

  const noProfile = profileStatus != null && profileStatus.last_profiled_at === null;
  const isDirty = profileStatus?.dirty ?? false;
  const recBlocked = !profileStatus || noProfile || isDirty;

  const recBlockMsg = noProfile
    ? 'No taste profile yet. Build one on your profile page first.'
    : isDirty
      ? 'Your library changed since the last profile build. Update it on your profile page.'
      : null;

  const displayName = userProfile?.display_name ?? null;
  const {
    data: savedBooks,
    isLoading: savedLoading,
    error: savedError,
    mutate: retrySaved,
  } = useSWR<Book[]>('books-to-read', () => api.books({ shelf: 'to-read', limit: 500 }));
  const saved = savedBooks?.[0];

  async function handleRun() {
    setRunning(true);
    try {
      const run = await api.runRecommend(10);
      // A run can finish without persisting anything (empty retrieval pool, or a
      // rerank whose every citation was dropped). The swipe deck reads the LATEST
      // run that has rows, so redirecting here would show the previous, fully
      // swiped batch and claim the reader had seen it all already (issue #64).
      if (!run.run_id || run.served === 0) {
        toast.error(run.note ?? 'That run turned up no new picks. Try again in a moment.');
        setRunning(false);
        return;
      }
      // The deck's cached 'recommendations' key still holds the old batch, and
      // nothing on THIS page subscribes to it -- so a bare mutate(key) would find no
      // revalidator, return the stale value, and leave it in cache for /swipe to paint
      // before the refetch lands. Passing `undefined` as data clears the entry outright;
      // startRevalidate still runs afterwards and drops the dedupe markers.
      await mutate('recommendations', undefined, { revalidate: true });
      router.push('/swipe');
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : 'Recommendations hit a snag. Try again in a moment.'
      );
      setRunning(false);
    }
  }

  return (
    <div className="fade-in">
      <p className="eyebrow">Your reading room</p>
      <h1 className="mt-3 font-display text-3xl font-bold tracking-tight sm:text-4xl">
        {displayName ? `Welcome back, ${displayName}.` : 'Welcome back.'}
      </h1>
      <section className="home-hero" aria-labelledby="next-read-title">
        <div className="min-w-0">
          <p className="eyebrow">A little further into your next story</p>
          <h2
            id="next-read-title"
            className="mt-4 max-w-lg font-display text-[2.6rem] font-bold leading-[1.06] tracking-tight sm:text-6xl"
          >
            Find a book
            <br />
            that stays with you.
          </h2>
          <p className="mt-5 max-w-md text-sm leading-relaxed text-muted">
            Ten books chosen for your taste, with a reason for each. Takes 30–60 seconds.
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-4">
            <Button
              size="lg"
              loading={running}
              disabled={running || recBlocked}
              onClick={handleRun}
            >
              {running ? 'Choosing carefully…' : 'Find my next books'}
            </Button>
            <Link href="/discover" className="text-sm text-muted hover:text-text">
              Explore a mood →
            </Link>
          </div>
          {recBlockMsg && (
            <p className="mt-4 text-sm text-muted">
              {recBlockMsg}{' '}
              <Link href="/profile" className="underline underline-offset-4">
                Go to profile
              </Link>
            </p>
          )}
          {profileError ? (
            <p className="mt-4 text-sm text-danger">
              Your profile status didn’t load.{' '}
              <button type="button" className="underline" onClick={() => void retryProfile()}>
                Retry
              </button>
            </p>
          ) : (
            !profileStatus && (
              <p className="mt-4 text-sm text-muted" role="status">
                Checking your taste profile…
              </p>
            )
          )}
        </div>
        <div className="home-saved">
          {savedLoading ? (
            <div
              className="h-48 w-32 rounded bg-elevated motion-safe:animate-pulse"
              aria-label="Loading saved books"
            />
          ) : savedError ? (
            <p className="text-sm text-muted">
              Your saved shelf didn’t load.{' '}
              <button type="button" className="underline" onClick={() => void retrySaved()}>
                Retry
              </button>
            </p>
          ) : saved ? (
            <Link
              href="/library?tab=to-read"
              className="flex items-center gap-5 sm:flex-col sm:text-center"
            >
              <BookCover book={saved} className="h-24 w-16 sm:h-56 sm:w-36" />
              <div className="min-w-0">
                <p className="eyebrow">On your to-read shelf</p>
                <p className="mt-2 font-display text-lg font-semibold">{saved.title}</p>
                <p className="mt-1 text-xs text-muted">{saved.author ?? 'Unknown author'}</p>
              </div>
            </Link>
          ) : (
            <div>
              <p className="font-display text-xl">Room for a new favorite.</p>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                Save a book in your library to keep your next read close.
              </p>
              <Link
                href="/library?tab=to-read"
                className="mt-4 inline-block text-sm underline underline-offset-4"
              >
                Browse your shelves
              </Link>
            </div>
          )}
        </div>
      </section>
      <CurrentReads />
      <section className="mt-9 grid gap-5 lg:grid-cols-2" aria-label="Your reading life">
        <Link
          href="/profile"
          className="flex items-center gap-4 rounded-xl border border-border bg-surface p-5"
        >
          {archetype && <ReaderSprite code={archetype.code} size={72} className="shrink-0" />}
          <div className="min-w-0">
            <p className="eyebrow">Your reader type</p>
            <h2 className="mt-2 font-display text-xl font-semibold">
              {archetype?.name ?? 'Get to know your reading taste'}
            </h2>
            <p className="mt-2 text-sm text-muted">
              {archetype?.is_stale
                ? 'Your profile changed. Visit your profile to refresh your reader type.'
                : (archetype?.tagline ?? 'Your favorite books tell a story about you.')}
            </p>
            <p className="mt-3 text-xs text-muted">Explore your profile →</p>
          </div>
        </Link>
        <YearCard compact />
      </section>
      <div className="mt-8 border-t border-border pt-5 text-sm text-muted">
        {statsLoading ? (
          <p role="status">Loading library summary…</p>
        ) : statsError ? (
          <p>Your library summary didn’t load. Refresh to retry.</p>
        ) : stats ? (
          <Link href="/library">
            {stats.total} books in your library · {stats.rated} rated · View library →
          </Link>
        ) : null}
      </div>
    </div>
  );
}
