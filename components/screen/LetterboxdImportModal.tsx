'use client';

import { useState } from 'react';
import { screenApi, type ScreenImportResult } from '@/lib/api';
import { Button, Modal } from '@/components/ui';
import { errorMessage } from '@/lib/screen';

const LABEL_ID = 'letterboxd-import-title';

/**
 * Letterboxd ZIP upload (spec §3.4, §7.4). Closing mid-upload is allowed: the request keeps
 * going, onImported still fires, and the card picks the job up either way.
 */
export default function LetterboxdImportModal({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: (result: ScreenImportResult) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload() {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      onImported(await screenApi.importLetterboxd(file));
    } catch (e) {
      setError(errorMessage(e, 'The import did not finish. Nothing was changed.'));
      setUploading(false);
    }
  }

  return (
    <Modal
      labelId={LABEL_ID}
      onClose={onClose}
      confirmClose={() => !uploading}
      className="w-full max-w-md rounded-2xl border border-border bg-surface p-6 shadow-xl"
    >
      <h2 id={LABEL_ID} className="font-display text-xl font-semibold text-text">
        Import from Letterboxd
      </h2>
      <p className="mt-2 text-sm text-muted">
        Upload the ZIP from Letterboxd (Settings, then Data, then Export your data). ScreenSprite
        reads your watched films, ratings, reviews, watchlist and Favorite Films. It never
        overwrites a rating or review you made here, and importing turns ScreenSprite on.
      </p>
      <label className="mt-4 block">
        <span className="mb-1 block text-xs font-medium text-muted">Letterboxd export (.zip)</span>
        <input
          type="file"
          accept=".zip,application/zip"
          aria-label="Letterboxd export (.zip)"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setError(null);
          }}
          className="block w-full text-sm text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-elevated file:px-3 file:py-2 file:text-sm file:text-text"
        />
      </label>
      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={uploading} onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="sm"
          loading={uploading}
          disabled={!file || uploading}
          onClick={() => void upload()}
        >
          Import
        </Button>
      </div>
    </Modal>
  );
}
