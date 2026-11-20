'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { Card } from '@/components/ui';
import {
  api,
  NEXT_READ_PROMPT_MIN,
  NEXT_READ_SETTINGS_KEY,
  type NextReadSettings,
} from '@/lib/api';

/** Turns the home page's to-read prompt back on after "Don't ask again", or off. */
export default function NextReadSettingsCard() {
  const { data, error, mutate } = useSWR<NextReadSettings>(NEXT_READ_SETTINGS_KEY, () =>
    api.nextReadSettings()
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function toggle(prompt: boolean) {
    setSaving(true);
    setSaveError(null);
    try {
      await mutate(await api.setNextReadPrompt(prompt), { revalidate: false });
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "That didn't save. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <h2 className="mb-1 font-display text-lg font-semibold text-text">Your to-read shelf</h2>
      <p className="mb-3 text-sm text-muted">
        When you ask for new books with {NEXT_READ_PROMPT_MIN} or more already saved, ShelfSprite
        can offer to pick your next read from the shelf instead.
      </p>
      {error && !data ? (
        <p className="text-sm text-danger">This setting didn&apos;t load. Refresh to try again.</p>
      ) : (
        <label className="flex min-h-11 items-center gap-3 text-sm text-text">
          <input
            type="checkbox"
            checked={data?.prompt ?? true}
            disabled={!data || saving}
            onChange={(e) => void toggle(e.target.checked)}
          />
          Offer to pick from my to-read shelf first
        </label>
      )}
      {saveError && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {saveError}
        </p>
      )}
    </Card>
  );
}
