'use client';

import { useState } from 'react';
import { Button, Field, Modal, StarRating, Textarea } from '@/components/ui';

export interface AlreadyReadVerdict {
  /** 0 = unrated; otherwise 0.5-5. */
  rating: number;
  /** Trimmed; empty means no review. */
  review: string;
}

interface Props {
  title: string;
  author: string | null;
  /** Called only on "Mark as read". Nothing is saved before it fires. */
  onConfirm: (verdict: AlreadyReadVerdict) => void;
  /** Cancel, Escape or the backdrop: the card goes back on the deck, nothing recorded. */
  onCancel: () => void;
}

const labelClass =
  'mb-2 block font-mono text-xs font-semibold uppercase tracking-widest text-muted';

/**
 * The swipe deck's "Already read" step. It runs BEFORE the verdict is recorded, so the
 * reader can back out: the old flow saved the verdict (shelving the book as read) and
 * only then opened BookEditModal, whose Cancel could not undo it.
 */
export default function AlreadyReadModal({ title, author, onConfirm, onCancel }: Props) {
  const [rating, setRating] = useState(0);
  const [review, setReview] = useState('');

  const reviewText = review.trim();
  // Same rule as BookEditModal: a review needs a rating to anchor it.
  const reviewWithoutRating = reviewText !== '' && rating === 0;

  return (
    <Modal
      labelId="already-read-title"
      onClose={onCancel}
      confirmClose={() =>
        (rating === 0 && reviewText === '') || window.confirm('Discard your rating for this book?')
      }
      className="fade-in flex max-h-[90vh] w-full max-w-md flex-col overflow-y-auto rounded-2xl border border-border bg-surface p-6 shadow-2xl"
    >
      <div className="mb-4">
        <p className="mb-1 font-mono text-xs font-semibold uppercase tracking-widest text-accent">
          Already read
        </p>
        <h2 id="already-read-title" className="text-lg font-bold leading-tight text-text">
          {title}
        </h2>
        <p className="text-sm text-muted">{author ?? 'Unknown author'}</p>
      </div>

      <p className="mb-5 text-sm text-muted">
        It goes on your read shelf. A rating tells your profile how it landed.
      </p>

      <div className="mb-5">
        <div className="mb-2 flex items-center justify-between">
          <span className={labelClass}>Your rating</span>
          {rating > 0 && (
            <button
              type="button"
              onClick={() => setRating(0)}
              className="rounded text-xs text-faint hover:text-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
              Clear
            </button>
          )}
        </div>
        <StarRating value={rating} onChange={setRating} allowHalf size={30} label="Your rating" />
        {rating === 0 && <p className="mt-1 text-xs text-faint">Optional.</p>}
      </div>

      <div className="mb-5">
        <Field label="Review">
          {(p) => (
            <Textarea
              {...p}
              value={review}
              onChange={(e) => setReview(e.target.value)}
              rows={4}
              placeholder="What did you think? Your words feed the taste profile..."
              className="resize-y"
            />
          )}
        </Field>
        {reviewWithoutRating && (
          <p className="mt-1 text-xs text-warning">
            A review needs a rating to anchor it. Add stars first.
          </p>
        )}
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          onClick={() => onConfirm({ rating, review: reviewText })}
          disabled={reviewWithoutRating}
        >
          Mark as read
        </Button>
      </div>
    </Modal>
  );
}
