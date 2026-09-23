'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import { screenApi, type TitleOut, type TitleStatus, type TitleUpdate } from '@/lib/api';
import { Badge, Button, Modal, StarRating, useToast } from '@/components/ui';
import TitleTile from '@/components/screen/TitleTile';
import { DescriptionSource } from '@/components/screen/Attribution';
import {
  errorMessage,
  mediaLabel,
  needsCorrection,
  titleLabel,
  TITLE_STATUSES,
  TITLE_STATUS_LABELS,
} from '@/lib/screen';
import { invalidateTitleEdits } from '@/lib/screenCache';

const LABEL_ID = 'title-detail-modal-title';

interface Props {
  title: TitleOut;
  /** The title this one may duplicate (enrichment.duplicate_of_title_id), when loaded. */
  duplicateOf: TitleOut | null;
  onClose: () => void;
  /** Offered only for LOW-confidence matches (spec §4.4, §7.3). */
  onCorrect?: (title: TitleOut) => void;
}

/**
 * One film or show (spec §7.3). Rating and review semantics are §3.2's: the fields shown are the
 * effective ones (in-app over Letterboxd), a save sends only what the reader touched, rating 0
 * clears only the in-app rating, and an emptied review clears only the in-app review.
 */
export default function TitleDetailModal({ title, duplicateOf, onClose, onCorrect }: Props) {
  const toast = useToast();
  const [status, setStatus] = useState<TitleStatus>(title.status);
  const [rating, setRating] = useState<number>(title.rating ?? 0);
  const [review, setReview] = useState<string>(title.review ?? '');
  const [favorite, setFavorite] = useState(title.is_favorite);
  const [exclude, setExclude] = useState(title.exclude_from_profile);
  const [saving, setSaving] = useState(false);
  const [removeArmed, setRemoveArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enr = title.enrichment;
  const isDuplicate = enr?.duplicate_of_title_id != null;
  const people = title.media_type === 'tv' ? (enr?.creators ?? []) : (enr?.directors ?? []);
  const meta = [
    mediaLabel(title.media_type),
    title.year === null ? null : String(title.year),
    people.slice(0, 2).join(', ') || null,
  ].filter((x): x is string => x !== null);

  function changes(): TitleUpdate {
    const body: TitleUpdate = {};
    if (status !== title.status) body.status = status;
    if (rating !== (title.rating ?? 0)) body.rating = rating;
    if (review.trim() !== (title.review ?? '').trim()) body.review = review.trim();
    if (favorite !== title.is_favorite) body.is_favorite = favorite;
    if (exclude !== title.exclude_from_profile) body.exclude_from_profile = exclude;
    return body;
  }

  async function save() {
    const body = changes();
    if (Object.keys(body).length === 0) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await screenApi.updateTitle(title.id, body);
      await invalidateTitleEdits();
      toast.success('Saved.');
      onClose();
    } catch (e) {
      setError(errorMessage(e, 'That did not save. Try again.'));
    } finally {
      setSaving(false);
    }
  }

  async function clearRating() {
    setSaving(true);
    setError(null);
    try {
      const updated = await screenApi.updateTitle(title.id, { rating: 0 });
      setRating(updated.rating ?? 0);
      await invalidateTitleEdits();
    } catch (e) {
      setError(errorMessage(e, 'The rating did not clear. Try again.'));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setSaving(true);
    setError(null);
    try {
      await screenApi.deleteTitle(title.id);
      await invalidateTitleEdits();
      toast.success(`Removed "${title.title}".`);
      onClose();
    } catch (e) {
      setError(errorMessage(e, 'That did not remove. Try again.'));
      setSaving(false);
    }
  }

  return (
    <Modal
      labelId={LABEL_ID}
      onClose={onClose}
      confirmClose={() => Object.keys(changes()).length === 0}
      className="relative flex max-h-[85vh] w-full max-w-lg flex-col rounded-2xl border border-border bg-surface shadow-xl"
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute right-4 top-4 rounded-full p-1 text-faint hover:bg-elevated hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        <X className="h-4 w-4" />
      </button>

      <div className="overflow-y-auto p-4 sm:p-6">
        <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
          <TitleTile
            title={title.title}
            year={title.year}
            mediaType={title.media_type}
            imageUrl={enr?.image_url ?? null}
            className="w-28 shrink-0"
            sizes="112px"
          />
          <div className="min-w-0 text-center sm:text-left">
            <h2 id={LABEL_ID} className="font-display text-xl font-semibold leading-snug text-text">
              {title.title}
            </h2>
            <p className="mt-1 font-mono text-xs text-faint">{meta.join(' \u00B7 ')}</p>
            {enr && enr.genres.length > 0 && (
              <div className="mt-2 flex flex-wrap justify-center gap-1 sm:justify-start">
                {enr.genres.slice(0, 4).map((g) => (
                  <Badge key={g}>{g}</Badge>
                ))}
              </div>
            )}
            {isDuplicate && (
              <Badge variant="warning" className="mt-2">
                {duplicateOf
                  ? `Possible duplicate of ${titleLabel(duplicateOf.title, duplicateOf.year)}`
                  : 'Possible duplicate'}
              </Badge>
            )}
          </div>
        </div>

        {needsCorrection(title) && onCorrect && (
          <div className="mt-4 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-text">
            <p>
              {`We are not sure we matched the right ${title.media_type === 'tv' ? 'show' : 'film'}.`}
            </p>
            <Button size="sm" variant="secondary" className="mt-2" onClick={() => onCorrect(title)}>
              Fix the match
            </Button>
          </div>
        )}

        <div className="mt-5 space-y-1">
          {enr?.description ? (
            <>
              <p className="text-sm leading-relaxed text-muted">{enr.description}</p>
              <DescriptionSource
                source={enr.description_source}
                url={enr.description_url}
                page={enr.wikipedia_page}
              />
            </>
          ) : (
            <p className="text-sm italic text-faint">No description on file for this one.</p>
          )}
        </div>

        <div className="mt-6 space-y-4 border-t border-border pt-5">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Status</span>
            <select
              aria-label="Status"
              value={status}
              onChange={(e) => setStatus(e.target.value as TitleStatus)}
              className="w-full rounded-lg border border-border bg-elevated px-3 py-2 text-sm text-text focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
              {TITLE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {TITLE_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </label>

          <div>
            <p className="mb-1 text-xs font-medium text-muted">Your rating</p>
            <div className="flex flex-wrap items-center gap-3">
              <StarRating value={rating} onChange={setRating} allowHalf label="Your rating" />
              {title.app_rating !== null && (
                <button
                  type="button"
                  onClick={() => void clearRating()}
                  disabled={saving}
                  className="text-xs text-muted underline underline-offset-4 hover:text-text disabled:opacity-50"
                >
                  {title.letterboxd_rating !== null
                    ? 'Use my Letterboxd rating'
                    : 'Clear my rating'}
                </button>
              )}
            </div>
          </div>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Your review</span>
            <textarea
              aria-label="Your review"
              value={review}
              onChange={(e) => setReview(e.target.value)}
              rows={3}
              className="w-full rounded-lg border border-border bg-elevated px-3 py-2 text-sm text-text focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            />
            {title.letterboxd_review !== null && (
              <span className="mt-1 block text-xs text-faint">
                Emptying this box brings back your Letterboxd review.
              </span>
            )}
          </label>

          <label className="flex items-center gap-2 text-sm text-text">
            <input
              type="checkbox"
              checked={favorite}
              onChange={(e) => setFavorite(e.target.checked)}
            />
            Favorite
          </label>
          <label className="flex items-start gap-2 text-sm text-text">
            <input
              type="checkbox"
              checked={exclude}
              onChange={(e) => setExclude(e.target.checked)}
              className="mt-1"
            />
            <span>
              Leave out of my taste profile
              <span className="block text-xs text-faint">
                For something you watched for someone else.
              </span>
            </span>
          </label>

          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            {removeArmed ? (
              <Button variant="danger" size="sm" loading={saving} onClick={() => void remove()}>
                {isDuplicate ? 'Confirm: remove this one' : 'Confirm remove'}
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                disabled={saving}
                onClick={() => setRemoveArmed(true)}
              >
                {isDuplicate ? 'Remove this one' : 'Remove from library'}
              </Button>
            )}
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" disabled={saving} onClick={onClose}>
                Cancel
              </Button>
              <Button size="sm" loading={saving} onClick={() => void save()}>
                Save
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
