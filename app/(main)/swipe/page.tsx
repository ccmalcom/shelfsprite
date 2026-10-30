'use client';

import PageHeading from '@/components/PageHeading';

import { useState, useCallback, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import useSWR, { mutate } from 'swr';
import {
  api,
  type BookFeedbackRequest,
  type Recommendation,
  type Trait,
  REJECT_REASONS,
  rejectRecWithReasons,
  recordTasteSignal,
  PROFILE_STATUS_KEY,
} from '@/lib/api';
import { Button, Spinner, useToast } from '@/components/ui';
import SwipeCard from '@/components/SwipeCard';
import RejectReasonPicker from '@/components/RejectReasonPicker';
import AlreadyReadModal, { type AlreadyReadVerdict } from '@/components/AlreadyReadModal';
import { useFeedbackPrompt } from '@/hooks/useFeedbackPrompt';
import ShelfSprite from '@/components/ShelfSprite';

export default function SwipePage() {
  const router = useRouter();
  const toast = useToast();
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());
  // "Already read" asks for the rating BEFORE the verdict is saved, so Cancel undoes nothing.
  const [readPending, setReadPending] = useState<Recommendation | null>(null);
  const [pendingRejectId, setPendingRejectId] = useState<number | null>(null);
  const [rerolling, setRerolling] = useState(false);

  const {
    data: recs,
    isLoading: recsLoading,
    error: recsError,
    mutate: retryRecs,
  } = useSWR<Recommendation[]>('recommendations', () => api.recommendations());

  const { data: traits = [] } = useSWR<Trait[]>('profile', () => api.profile());

  // post-recs feedback prompt: fire when the user actions the last card this session
  const runId = recs?.[0]?.run_id;
  const { fire: fireRecsPrompt, modal: recsModal } = useFeedbackPrompt('post-recs', runId);

  const pending = (recs ?? [])
    .filter((r) => r.status === 'served' && !dismissed.has(r.id))
    .sort((a, b) => a.rank - b.rank);

  const total = (recs ?? []).filter((r) => r.status === 'served' || dismissed.has(r.id));

  // A rating or a taste signal can flip the profile to dirty, and the app-wide re-profile
  // banner then drops in above the deck and shoves the card down mid-swipe. Hold the
  // profile-status refresh until the batch is done, or until the reader leaves the deck.
  const statusStaleRef = useRef(false);
  const deckDoneRef = useRef(false);
  const flushStatus = useCallback(() => {
    if (!statusStaleRef.current) return;
    statusStaleRef.current = false;
    void mutate(PROFILE_STATUS_KEY);
  }, []);
  // A save that lands after the last card is gone refreshes right away.
  const refreshStatusLater = useCallback(() => {
    statusStaleRef.current = true;
    if (deckDoneRef.current) flushStatus();
  }, [flushStatus]);
  // Leaving mid-deck: the rest of the app should see the change.
  useEffect(() => flushStatus, [flushStatus]);

  useEffect(() => {
    deckDoneRef.current = pending.length === 0 && (recs ?? []).length > 0;
    if (deckDoneRef.current) flushStatus();
    if (dismissed.size > 0 && pending.length === 0 && recs && recs.length > 0) {
      // The hook itself waits for any open dialog to close before it shows.
      fireRecsPrompt();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending.length, dismissed.size]);

  const handleDecide = useCallback(
    async (recId: number, status: 'accepted' | 'rejected' | 'already_read') => {
      if (status === 'rejected') {
        setPendingRejectId(recId);
        return;
      }
      if (status === 'already_read') {
        setReadPending(recs?.find((r) => r.id === recId) ?? null);
        return;
      }
      setDismissed((prev) => new Set([...prev, recId]));
      try {
        await api.feedback(recId, { status });
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "That verdict didn't save. Try it again.");
        setDismissed((prev) => {
          const next = new Set(prev);
          next.delete(recId);
          return next;
        });
      }
    },
    [recs, toast]
  );

  const confirmAlreadyRead = useCallback(
    async (rec: Recommendation, verdict: AlreadyReadVerdict) => {
      setReadPending(null);
      setDismissed((prev) => new Set([...prev, rec.id]));
      let saved = false;
      try {
        const result = await api.feedback(rec.id, { status: 'already_read' });
        saved = true;
        if (result.book && verdict.rating > 0) {
          const req: BookFeedbackRequest = { rating: verdict.rating };
          if (verdict.review) req.review = verdict.review;
          await api.setBookFeedback(result.book.id, req);
        }
        refreshStatusLater();
      } catch (e) {
        if (saved) {
          // The book is shelved as read; only the rating missed. Keep the card dismissed.
          refreshStatusLater();
          toast.error(
            "It's on your read shelf, but the rating didn't save. Rate it from your library."
          );
          return;
        }
        toast.error(e instanceof Error ? e.message : "That verdict didn't save. Try it again.");
        setDismissed((prev) => {
          const next = new Set(prev);
          next.delete(rec.id);
          return next;
        });
      }
    },
    [refreshStatusLater, toast]
  );

  const handleTasteSignal = useCallback(
    async (rec: Recommendation, direction: 'more' | 'less') => {
      try {
        await recordTasteSignal({
          target_kind: 'rec',
          direction,
          snapshot: {
            title: rec.title,
            author: rec.author,
            subjects: rec.subjects,
            isbn13: rec.isbn13,
          },
        });
        refreshStatusLater();
      } catch (e) {
        console.error('taste signal failed', e);
      }
    },
    [refreshStatusLater]
  );

  const submitReject = useCallback(
    async (reasons: string[]) => {
      if (pendingRejectId === null) return;
      const recId = pendingRejectId;
      setPendingRejectId(null);
      setDismissed((prev) => new Set([...prev, recId]));
      try {
        await rejectRecWithReasons(recId, reasons);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed to save decision.');
        setDismissed((prev) => {
          const next = new Set(prev);
          next.delete(recId);
          return next;
        });
      }
    },
    [pendingRejectId, toast]
  );

  // #135: swap the rest of the deck for a fresh batch instead of swiping through it.
  // Unswiped picks are skipped by the new run but not recorded as rejections.
  async function handleReroll() {
    setRerolling(true);
    try {
      const run = await api.rerollRecommend(10);
      // Same guard as the home page (issue #64): a zero-served run leaves the old deck
      // as the latest run, so keep showing it rather than claiming a new batch.
      if (!run.run_id || run.served === 0) {
        toast.error(run.note ?? 'That reroll turned up no new picks. Try again in a moment.');
        return;
      }
      await mutate('recommendations');
      setDismissed(new Set());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'The reroll hit a snag. Try again in a moment.');
    } finally {
      setRerolling(false);
    }
  }

  // Error before loading: SWR's retry of a failed fetch reports isLoading again.
  if (recsError && !recs) {
    return (
      <div className="fade-in space-y-4 py-12 text-center">
        <p role="alert" className="text-danger">
          Your picks didn&apos;t load.
        </p>
        <Button variant="secondary" onClick={() => void retryRecs()}>
          Try again
        </Button>
      </div>
    );
  }

  if (recsLoading) {
    return (
      <div className="fade-in flex items-center justify-center py-24">
        <div className="text-center space-y-3">
          <Spinner size="lg" />
          <p className="text-muted text-sm">Fetching your picks…</p>
        </div>
      </div>
    );
  }

  if ((recs ?? []).length === 0) {
    return (
      <div className="fade-in py-20 text-center space-y-4">
        <ShelfSprite variant="sleep" sizes="144px" className="mx-auto h-36 w-36" />
        <h2 className="text-xl font-display font-semibold text-text">Nothing to swipe yet</h2>
        <p className="text-muted">Run a batch from the home page and come back.</p>
        <Button onClick={() => router.push('/')}>Back to home</Button>
      </div>
    );
  }

  if (pending.length === 0) {
    return (
      <>
        <div className="fade-in py-20 text-center space-y-4">
          <ShelfSprite variant="success" sizes="144px" className="mx-auto h-36 w-36" />
          <h2 className="text-xl font-display font-semibold text-text">That&apos;s the batch.</h2>
          <p className="text-muted">
            {/* The whole batch, not `total`: after a reload every card is already decided, so
                nothing is served or dismissed this session and `total` would read "All 0". A
                batch can also be shorter than ten (QA 2026-10-30), so the count is the run's. */}
            All {(recs ?? []).length} picks reviewed. Your verdicts are already sharpening the next
            run.
          </p>
          <Button onClick={() => router.push('/library?tab=to-read')}>
            See your to-read shelf
          </Button>
        </div>
        {recsModal}
      </>
    );
  }

  const visibleStack = pending.slice(0, 3);

  return (
    <>
      <div className="editorial-page fade-in">
        <PageHeading
          eyebrow="Picked for your shelves"
          title="Your next reads"
          description="Take your time with each book. Your choices help shape the next batch."
        />
        <div className="flex flex-col items-center gap-6">
          {/* Progress */}
          <p className="font-mono text-xs uppercase tracking-widest text-faint">
            {dismissed.size} / {total.length} reviewed
          </p>

          {/* Card stack */}
          <div className="relative h-[440px] sm:h-[560px] w-full max-w-sm">
            {visibleStack
              .slice()
              .reverse()
              .map((rec, idx) => {
                const isTop = idx === visibleStack.length - 1;
                return (
                  <SwipeCard
                    key={rec.id}
                    rec={rec}
                    traits={traits}
                    onDecide={handleDecide}
                    zIndex={idx + 1}
                    isTop={isTop}
                  />
                );
              })}
          </div>

          {/* Button controls */}
          <div className="flex gap-4 items-center">
            <button
              onClick={() => {
                const top = pending[0];
                if (top) void handleDecide(top.id, 'rejected');
              }}
              aria-label="Not interested"
              className={[
                'flex h-14 w-14 items-center justify-center rounded-full',
                'border-2 border-danger bg-surface text-danger shadow',
                'transition hover:bg-danger/10 active:scale-95',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger focus-visible:ring-offset-2 focus-visible:ring-offset-base',
              ].join(' ')}
            >
              <span className="text-xl font-bold" aria-hidden="true">
                X
              </span>
            </button>
            <button
              onClick={() => {
                const top = pending[0];
                if (top) void handleDecide(top.id, 'already_read');
              }}
              aria-label="Already read"
              className={[
                'flex h-12 w-12 items-center justify-center self-center rounded-full',
                'border-2 border-warning bg-surface text-warning shadow',
                'transition hover:bg-warning/10 active:scale-95',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning focus-visible:ring-offset-2 focus-visible:ring-offset-base',
              ].join(' ')}
            >
              <span className="text-base font-mono font-bold" aria-hidden="true">
                R
              </span>
            </button>
            <button
              onClick={() => {
                const top = pending[0];
                if (top) void handleDecide(top.id, 'accepted');
              }}
              aria-label="Add to to-read list"
              className={[
                'flex h-14 w-14 items-center justify-center rounded-full',
                'border-2 border-success bg-surface text-success shadow',
                'transition hover:bg-success/10 active:scale-95',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-success focus-visible:ring-offset-2 focus-visible:ring-offset-base',
              ].join(' ')}
            >
              <span className="text-xl font-bold" aria-hidden="true">
                +
              </span>
            </button>
          </div>

          <p className="font-mono text-xs text-faint">Drag left/right or use the buttons</p>

          {/* Taste signal row */}
          {pending[0] && (
            <div className="flex gap-3">
              <button
                onClick={() => {
                  const top = pending[0];
                  if (top) void handleTasteSignal(top, 'less');
                }}
                aria-label="Less like this"
                className={[
                  'rounded-full border border-border bg-surface px-4 py-1.5 text-xs font-medium text-muted',
                  'transition hover:border-danger/60 hover:text-danger active:scale-95',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-base',
                ].join(' ')}
              >
                Less like this
              </button>
              <button
                onClick={() => {
                  const top = pending[0];
                  if (top) void handleTasteSignal(top, 'more');
                }}
                aria-label="More like this"
                className={[
                  'rounded-full border border-border bg-surface px-4 py-1.5 text-xs font-medium text-muted',
                  'transition hover:border-success/60 hover:text-success active:scale-95',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-base',
                ].join(' ')}
              >
                More like this
              </button>
            </div>
          )}

          <Button variant="ghost" size="sm" loading={rerolling} onClick={handleReroll}>
            {rerolling ? 'Choosing fresh picks\u2026' : 'Reroll the rest of this batch'}
          </Button>
        </div>
      </div>
      {readPending && (
        <AlreadyReadModal
          title={readPending.title}
          author={readPending.author}
          onConfirm={(verdict) => void confirmAlreadyRead(readPending, verdict)}
          onCancel={() => setReadPending(null)}
        />
      )}
      {recsModal}
      {pendingRejectId !== null && (
        <RejectReasonPicker
          labelId="reject-reason-title"
          heading="What missed?"
          hint="Optional. Every reason makes the next batch smarter."
          reasons={REJECT_REASONS}
          skipLabel="Skip this book"
          onSubmit={(reasons) => void submitReject(reasons)}
          onCancel={() => setPendingRejectId(null)}
        />
      )}
    </>
  );
}
