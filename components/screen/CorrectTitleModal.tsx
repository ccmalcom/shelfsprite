'use client';

import { useState } from 'react';
import { screenApi, type ScreenCandidate, type TitleOut } from '@/lib/api';
import { Button, Modal, useToast } from '@/components/ui';
import CatalogSearch from '@/components/screen/CatalogSearch';
import { errorMessage, titleLabel } from '@/lib/screen';
import { invalidateTitleEdits } from '@/lib/screenCache';

const LABEL_ID = 'correct-title-heading';

/**
 * LOW-confidence correction (spec §4.4): the reader picks the right catalog entry. Rating,
 * review and status are untouched; the route marks the match 'corrected', so a later forced
 * enrichment run never re-resolves it.
 */
export default function CorrectTitleModal({
  title,
  onClose,
  onCorrected,
}: {
  title: TitleOut;
  onClose: () => void;
  onCorrected: (title: TitleOut) => void;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(candidate: ScreenCandidate) {
    setSaving(true);
    setError(null);
    try {
      const fixed = await screenApi.correctTitle(title.id, candidate);
      await invalidateTitleEdits();
      toast.success(`Matched to ${titleLabel(candidate.title, candidate.year)}.`);
      onCorrected(fixed);
    } catch (e) {
      setError(errorMessage(e, 'The match did not change. Try again.'));
      setSaving(false);
    }
  }

  return (
    <Modal
      labelId={LABEL_ID}
      onClose={onClose}
      className="relative flex max-h-[85vh] w-full max-w-lg flex-col rounded-2xl border border-border bg-surface shadow-xl"
    >
      <div className="overflow-y-auto p-4 sm:p-6">
        <h2 id={LABEL_ID} className="mb-1 font-display text-xl font-semibold text-text">
          Fix the match
        </h2>
        <p className="mb-4 text-sm text-muted">
          {`Find the right ${title.media_type === 'tv' ? 'show' : 'film'} for ${titleLabel(title.title, title.year)}. Your rating, review and status stay as they are.`}
        </p>
        <CatalogSearch
          initialQuery={title.year === null ? title.title : `${title.title} ${title.year}`}
          initialType={title.media_type}
          pickLabel="This one"
          busy={saving}
          onPick={(c) => void pick(c)}
        />
        {error && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end">
          <Button variant="ghost" size="sm" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}
