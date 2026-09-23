'use client';

import { useState } from 'react';
import { screenApi, type ScreenCandidate, type TitleOut, type TitleStatus } from '@/lib/api';
import { Button, Modal, StarRating, useToast } from '@/components/ui';
import CatalogSearch from '@/components/screen/CatalogSearch';
import TitleTile from '@/components/screen/TitleTile';
import {
  errorMessage,
  FUTURE_WATCH_DATE_MESSAGE,
  hasWatchDate,
  mediaLabel,
  titleLabel,
  TITLE_STATUSES,
  TITLE_STATUS_LABELS,
  todayIso,
} from '@/lib/screen';
import { invalidateTitleEdits } from '@/lib/screenCache';

const LABEL_ID = 'add-title-heading';

/**
 * Manual add (spec §3.5, decision 16): search, pick, then status and an optional rating. A
 * review needs a rating unless the title was dropped, as for books; the route enforces the same
 * rule and its message wins if the two ever disagree.
 */
export default function AddTitleModal({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (title: TitleOut) => void;
}) {
  const toast = useToast();
  const [picked, setPicked] = useState<ScreenCandidate | null>(null);
  const [status, setStatus] = useState<TitleStatus>('watched');
  const [rating, setRating] = useState(0);
  const [review, setReview] = useState('');
  const [watchedOn, setWatchedOn] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (!picked) return;
    const text = review.trim();
    if (text && rating === 0 && status !== 'dropped') {
      setError('A review needs a rating. Rate it, or leave the review empty.');
      return;
    }
    const watched = hasWatchDate(status) && watchedOn !== '' ? watchedOn : null;
    if (watched && watched > todayIso()) {
      setError(FUTURE_WATCH_DATE_MESSAGE);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const title = await screenApi.addTitle({
        candidate: picked,
        status,
        rating: rating === 0 ? null : rating,
        review: text || null,
        last_watched_on: watched,
      });
      await invalidateTitleEdits();
      toast.success(`Added "${title.title}".`);
      onAdded(title);
    } catch (e) {
      setError(errorMessage(e, 'That did not save. Try again.'));
      setSaving(false);
    }
  }

  return (
    <Modal
      labelId={LABEL_ID}
      onClose={onClose}
      confirmClose={() => picked === null}
      className="relative flex max-h-[85vh] w-full max-w-lg flex-col rounded-2xl border border-border bg-surface shadow-xl"
    >
      <div className="overflow-y-auto p-4 sm:p-6">
        <h2 id={LABEL_ID} className="mb-4 font-display text-xl font-semibold text-text">
          Add a film or show
        </h2>

        {picked === null ? (
          <>
            <CatalogSearch
              pickLabel="Add"
              onPick={(c) => {
                setPicked(c);
                setError(null);
              }}
            />
            <div className="mt-4 flex justify-end">
              <Button variant="ghost" size="sm" onClick={onClose}>
                Cancel
              </Button>
            </div>
          </>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <TitleTile
                title={picked.title}
                year={picked.year}
                mediaType={picked.media_type}
                imageUrl={picked.image_url}
                className="w-12 shrink-0"
                sizes="48px"
              />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-text">{titleLabel(picked.title, picked.year)}</p>
                <p className="text-xs text-faint">{mediaLabel(picked.media_type)}</p>
              </div>
              <Button variant="ghost" size="sm" disabled={saving} onClick={() => setPicked(null)}>
                Change
              </Button>
            </div>

            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">Status</span>
              <select
                aria-label="Status"
                value={status}
                onChange={(e) => setStatus(e.target.value as TitleStatus)}
                className="w-full rounded-lg border border-border bg-elevated px-3 py-2 text-sm text-text"
              >
                {TITLE_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {TITLE_STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </label>

            {hasWatchDate(status) && (
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted">
                  Date watched (optional)
                </span>
                <input
                  type="date"
                  aria-label="Date watched (optional)"
                  value={watchedOn}
                  max={todayIso()}
                  onChange={(e) => setWatchedOn(e.target.value)}
                  className="rounded-lg border border-border bg-elevated px-3 py-2 text-sm text-text focus:outline-none focus-visible:ring-1 focus-visible:ring-accent [color-scheme:dark]"
                />
              </label>
            )}

            <div>
              <p className="mb-1 text-xs font-medium text-muted">Rating (optional)</p>
              <StarRating value={rating} onChange={setRating} allowHalf label="Rating" />
            </div>

            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">Review (optional)</span>
              <textarea
                aria-label="Review (optional)"
                value={review}
                onChange={(e) => setReview(e.target.value)}
                rows={3}
                className="w-full rounded-lg border border-border bg-elevated px-3 py-2 text-sm text-text focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              />
            </label>

            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" disabled={saving} onClick={onClose}>
                Cancel
              </Button>
              <Button size="sm" loading={saving} onClick={() => void add()}>
                Add to library
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
