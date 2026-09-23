'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import useSWR, { mutate } from 'swr';
import { Button, Card, useToast } from '@/components/ui';
import LetterboxdImportModal from '@/components/screen/LetterboxdImportModal';
import ScreenEnrichProgress from '@/components/screen/ScreenEnrichProgress';
import {
  PROFILE_STATUS_KEY,
  screenApi,
  SCREEN_ACTIVE_JOB_KEY,
  SCREEN_TITLES_KEY,
  type EnrichJobOut,
  type ScreenImportResult,
  type ScreenOptOutPreview,
} from '@/lib/api';
import { errorMessage, traitsWarning } from '@/lib/screen';
import { invalidateScreenState } from '@/lib/screenCache';
import { useScreenSettings } from '@/lib/useScreenSettings';

/** "ScreenSprite — movies & TV" (spec §7.4), mounted at /settings#screen. */
export default function ScreenSettingsCard() {
  const toast = useToast();
  const { settings, error, mutate: mutateSettings } = useScreenSettings();
  const enabled = settings?.enabled ?? false;
  const { data: active } = useSWR<{ job: EnrichJobOut | null }>(
    enabled ? SCREEN_ACTIVE_JOB_KEY : null,
    () => screenApi.activeJob()
  );
  const [jobId, setJobId] = useState<string | null>(null);
  // A job this page started, else the one the server says is running (after a reload).
  const trackedJobId = jobId ?? active?.job?.job_id ?? null;
  const [importOpen, setImportOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<ScreenOptOutPreview | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const finished = useCallback((job: EnrichJobOut) => {
    // Keep showing the final line even when the job was recovered rather than started here.
    setJobId(job.job_id);
    void mutate(SCREEN_TITLES_KEY, undefined, { revalidate: true });
    void mutate(SCREEN_ACTIVE_JOB_KEY, undefined, { revalidate: true });
    // Newly resolved titles are profile evidence: the profile may be dirty now.
    void mutate(PROFILE_STATUS_KEY);
  }, []);

  async function turnOn() {
    setBusy(true);
    setActionError(null);
    try {
      const next = await screenApi.setEnabled(true);
      await mutateSettings(next, { revalidate: false });
      await mutate(PROFILE_STATUS_KEY);
      toast.success('ScreenSprite is on.');
    } catch (e) {
      setActionError(errorMessage(e, 'ScreenSprite did not turn on. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  async function askToTurnOff() {
    setBusy(true);
    setActionError(null);
    try {
      setPreview(await screenApi.optOutPreview());
    } catch (e) {
      setActionError(errorMessage(e, 'Could not check what turning off would remove. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    setActionError(null);
    try {
      const { traits_removed: removed = 0, ...next } = await screenApi.setEnabled(false);
      await mutateSettings(next, { revalidate: false });
      await invalidateScreenState();
      setPreview(null);
      setJobId(null);
      toast.success(
        removed > 0
          ? `ScreenSprite is off. ${removed} ${removed === 1 ? 'trait' : 'traits'} removed.`
          : 'ScreenSprite is off.'
      );
    } catch (e) {
      setActionError(errorMessage(e, 'ScreenSprite did not turn off. Nothing changed.'));
    } finally {
      setBusy(false);
    }
  }

  async function imported(result: ScreenImportResult) {
    setImportOpen(false);
    setJobId(result.job.job_id);
    toast.success(
      `Imported ${result.inserted} new and ${result.updated} updated. Matching them to the catalog now.`
    );
    await Promise.all([
      mutateSettings(),
      mutate(SCREEN_TITLES_KEY, undefined, { revalidate: true }),
      mutate(PROFILE_STATUS_KEY),
    ]);
  }

  async function retry() {
    setBusy(true);
    setActionError(null);
    try {
      const started = await screenApi.startEnrich();
      setJobId(started.job_id);
    } catch (e) {
      setActionError(errorMessage(e, 'Enrichment did not restart. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="mb-1 font-display text-lg font-semibold text-text">
        {'ScreenSprite \u2014 movies & TV'}
      </h2>

      {settings === undefined ? (
        error ? (
          <p className="text-sm text-danger">
            ScreenSprite settings did not load.{' '}
            <button type="button" className="underline" onClick={() => void mutateSettings()}>
              Retry
            </button>
          </p>
        ) : (
          <p className="text-sm text-faint">{'Loading\u2026'}</p>
        )
      ) : enabled ? (
        <div className="space-y-4">
          <p className="text-sm text-muted">
            {`${settings.title_count} ${settings.title_count === 1 ? 'film or show' : 'films and shows'} in your library. They share one taste profile with your books.`}
          </p>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/screen"
              className="inline-flex items-center justify-center rounded-lg bg-accent px-4 py-2 text-sm font-medium text-[color:var(--bg)] hover:bg-accent-hover"
            >
              Open ScreenSprite
            </Link>
            <Button variant="secondary" onClick={() => setImportOpen(true)}>
              Import from Letterboxd
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => void retry()}>
              Retry enrichment
            </Button>
          </div>
          {preview ? (
            <div className="space-y-3 rounded-lg border border-danger/30 bg-danger/5 p-4">
              <p className="text-sm font-medium text-text">Turn off ScreenSprite?</p>
              <p className="text-sm text-muted">{traitsWarning(preview)}</p>
              <p className="text-xs text-faint">
                Your films and shows stay in your library, and your profile will need a full
                rebuild. You can turn ScreenSprite back on anytime.
              </p>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setPreview(null)}>
                  Keep it on
                </Button>
                <Button variant="danger" size="sm" loading={busy} onClick={() => void turnOff()}>
                  Turn off ScreenSprite
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="ghost" disabled={busy} onClick={() => void askToTurnOff()}>
              Turn off ScreenSprite
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-muted">
            ScreenSprite adds movies and TV to ShelfSprite. Your films and shows join your books in
            one taste profile, and you get film and TV picks with a reason for each.
          </p>
          <p className="text-xs text-faint">
            From Letterboxd: Settings, then Data, then Export your data. Upload the ZIP as it is.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setImportOpen(true)}>Import from Letterboxd</Button>
            <Button variant="secondary" loading={busy} onClick={() => void turnOn()}>
              Turn on without importing
            </Button>
          </div>
        </div>
      )}

      {trackedJobId && (
        <div className="mt-4">
          <ScreenEnrichProgress jobId={trackedJobId} onFinished={finished} />
        </div>
      )}
      {actionError && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {actionError}
        </p>
      )}
      {importOpen && (
        <LetterboxdImportModal
          onClose={() => setImportOpen(false)}
          onImported={(r) => void imported(r)}
        />
      )}
    </Card>
  );
}
