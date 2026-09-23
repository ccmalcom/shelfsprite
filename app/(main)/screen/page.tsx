'use client';

import { useState } from 'react';
import Link from 'next/link';
import useSWR, { mutate } from 'swr';
import PageHeading from '@/components/PageHeading';
import { Button, Spinner, useToast } from '@/components/ui';
import BookDetailModal from '@/components/BookDetailModal';
import RejectReasonPicker from '@/components/RejectReasonPicker';
import TitleDetailModal from '@/components/screen/TitleDetailModal';
import TitleRecCard from '@/components/screen/TitleRecCard';
import {
  api,
  BOOKS_ALL_KEY,
  PROFILE_STATUS_KEY,
  screenApi,
  SCREEN_RECS_KEY,
  SCREEN_REJECT_REASONS,
  SCREEN_TITLES_KEY,
  TRAITS_KEY,
  type Book,
  type ProfileStatus,
  type ScreenMediaFilter,
  type TitleOut,
  type TitleRec,
  type Trait,
} from '@/lib/api';
import { errorMessage } from '@/lib/screen';
import { handleScreenError } from '@/lib/screenCache';

const FILTERS: { value: ScreenMediaFilter; label: string }[] = [
  { value: 'both', label: 'Both' },
  { value: 'movie', label: 'Movies' },
  { value: 'tv', label: 'TV' },
];

/** For you (spec §7.2): run screen recommendations and act on them. */
export default function ScreenForYouPage() {
  const toast = useToast();
  const [filter, setFilter] = useState<ScreenMediaFilter>('both');
  const [running, setRunning] = useState(false);
  const [emptyRun, setEmptyRun] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [rejectingId, setRejectingId] = useState<number | null>(null);
  const [openTitle, setOpenTitle] = useState<TitleOut | null>(null);
  const [openBook, setOpenBook] = useState<Book | null>(null);

  const {
    data: profileStatus,
    error: profileError,
    mutate: retryProfile,
  } = useSWR<ProfileStatus>(PROFILE_STATUS_KEY, () => api.profileStatus());
  const {
    data: recs,
    error: recsError,
    mutate: mutateRecs,
  } = useSWR<TitleRec[]>(SCREEN_RECS_KEY, () => screenApi.recommendations(), {
    onError: handleScreenError,
  });
  const { data: traits } = useSWR<Trait[]>(TRAITS_KEY, () => api.profile());
  const { data: titles } = useSWR<TitleOut[]>(SCREEN_TITLES_KEY, () => screenApi.titles(), {
    onError: handleScreenError,
  });
  const needsBooks = (recs ?? []).some((r) => r.grounded_book_ids.length > 0);
  const { data: books } = useSWR<Book[]>(needsBooks ? BOOKS_ALL_KEY : null, () =>
    api.books({ limit: 500 })
  );

  // Home's gate and messages (app/(main)/page.tsx), pointed at the screen profile (spec §6.2).
  const noProfile = profileStatus != null && profileStatus.last_profiled_at === null;
  const isDirty = profileStatus?.dirty ?? false;
  const blocked = !profileStatus || noProfile || isDirty;
  const blockMsg = noProfile
    ? 'No taste profile yet. Build one on your profile page first.'
    : isDirty
      ? 'Your library changed since the last profile build. Update it on your profile page.'
      : null;

  const traitMap = new Map((traits ?? []).map((t) => [t.id, t]));
  const titleMap = new Map((titles ?? []).map((t) => [t.id, t]));
  const bookMap = new Map((books ?? []).map((b) => [b.id, b]));
  // Chips resolve against these lists; rendering before they load would call live evidence
  // "no longer in your library" for a moment.
  const evidenceReady =
    traits !== undefined && titles !== undefined && (!needsBooks || books !== undefined);
  const sorted = [...(recs ?? [])].sort((a, b) => a.rank - b.rank);

  async function run() {
    setRunning(true);
    setEmptyRun(false);
    try {
      const result = await screenApi.recommend(filter);
      if (!result.run_id || result.served === 0) {
        // Nothing persisted, so the list below is still the previous run (issue #64).
        setEmptyRun(true);
        return;
      }
      await mutateRecs();
    } catch (e) {
      toast.error(errorMessage(e, 'Recommendations hit a snag. Try again in a moment.'));
    } finally {
      setRunning(false);
    }
  }

  async function decide(rec: TitleRec, status: 'accepted' | 'already_watched') {
    setBusyId(rec.id);
    try {
      const result = await screenApi.recFeedback(rec.id, { status });
      // Every decision stamps rec feedback server-side (spec §6.7), which can dirty the profile.
      await Promise.all([mutateRecs(), mutate(SCREEN_TITLES_KEY), mutate(PROFILE_STATUS_KEY)]);
      if (status === 'already_watched' && result.title) {
        setOpenTitle(result.title);
      } else {
        toast.success(`"${rec.title}" is on your watchlist.`);
      }
    } catch (e) {
      toast.error(errorMessage(e, 'That did not save. Try again.'));
    } finally {
      setBusyId(null);
    }
  }

  async function reject(recId: number, reasons: string[]) {
    setRejectingId(null);
    setBusyId(recId);
    try {
      // The route refuses an empty list, so no reasons means no field.
      await screenApi.recFeedback(
        recId,
        reasons.length > 0
          ? { status: 'rejected', reject_reasons: reasons }
          : { status: 'rejected' }
      );
      await Promise.all([mutateRecs(), mutate(PROFILE_STATUS_KEY)]);
    } catch (e) {
      toast.error(errorMessage(e, 'That did not save. Try again.'));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="editorial-page fade-in space-y-8">
      <PageHeading
        eyebrow="For you"
        title="Your ScreenSprite picks"
        description="Films and shows chosen from your whole taste profile, books included, each with its reason. A run takes a minute or two."
      />

      <section aria-label="Run recommendations" className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <div
            role="group"
            aria-label="What to recommend"
            className="inline-flex rounded-lg border border-border bg-elevated p-0.5"
          >
            {FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                aria-pressed={filter === f.value}
                onClick={() => setFilter(f.value)}
                className={[
                  'rounded-md px-3 py-1.5 text-xs font-semibold transition-colors',
                  filter === f.value
                    ? 'bg-surface text-text shadow-sm'
                    : 'text-muted hover:text-text',
                ].join(' ')}
              >
                {f.label}
              </button>
            ))}
          </div>
          <Button
            size="lg"
            loading={running}
            disabled={running || blocked}
            onClick={() => void run()}
          >
            {running ? 'Choosing carefully\u2026' : 'Find something to watch'}
          </Button>
        </div>
        {blockMsg && (
          <p className="text-sm text-muted">
            {blockMsg}{' '}
            <Link href="/screen/profile" className="underline underline-offset-4">
              Go to profile
            </Link>
          </p>
        )}
        {profileError ? (
          <p className="text-sm text-danger">
            Your profile status did not load.{' '}
            <button type="button" className="underline" onClick={() => void retryProfile()}>
              Retry
            </button>
          </p>
        ) : (
          !profileStatus && (
            <p className="text-sm text-muted" role="status">
              {'Checking your taste profile\u2026'}
            </p>
          )
        )}
        {emptyRun && (
          <p
            role="status"
            className="rounded-lg border border-border bg-surface p-3 text-sm text-muted"
          >
            {`Nothing new this time. Try another filter, or run it again later.${sorted.length > 0 ? ' The picks below are from an earlier run.' : ''}`}
          </p>
        )}
      </section>

      {recsError && !recs ? (
        <p role="alert" className="text-sm text-danger">
          {errorMessage(recsError, 'Your picks did not load.')}{' '}
          <button type="button" className="underline" onClick={() => void mutateRecs()}>
            Retry
          </button>
        </p>
      ) : recs === undefined || (sorted.length > 0 && !evidenceReady) ? (
        <div className="flex justify-center py-16">
          <Spinner size="lg" label="Loading your picks" />
        </div>
      ) : sorted.length === 0 ? (
        <p className="py-10 text-center text-sm text-faint">
          No picks yet. Choose Both, Movies or TV and run it.
        </p>
      ) : (
        <section aria-label="Your picks" className="space-y-4">
          {emptyRun && <p className="eyebrow">From an earlier run</p>}
          {sorted.map((rec) => (
            <TitleRecCard
              key={rec.id}
              rec={rec}
              traits={traitMap}
              titles={titleMap}
              books={bookMap}
              busy={busyId === rec.id}
              onAccept={() => void decide(rec, 'accepted')}
              onWatched={() => void decide(rec, 'already_watched')}
              onReject={() => setRejectingId(rec.id)}
              onOpenTitle={setOpenTitle}
              onOpenBook={setOpenBook}
            />
          ))}
        </section>
      )}

      {rejectingId !== null && (
        <RejectReasonPicker
          labelId="screen-reject-title"
          heading="What missed?"
          hint="Optional. Every reason sharpens the next run."
          reasons={SCREEN_REJECT_REASONS}
          skipLabel="Skip this one"
          onSubmit={(reasons) => void reject(rejectingId, reasons)}
          onCancel={() => setRejectingId(null)}
        />
      )}
      {openTitle && (
        <TitleDetailModal
          title={titleMap.get(openTitle.id) ?? openTitle}
          duplicateOf={null}
          onClose={() => setOpenTitle(null)}
        />
      )}
      {openBook && <BookDetailModal book={openBook} readOnly onClose={() => setOpenBook(null)} />}
    </div>
  );
}
