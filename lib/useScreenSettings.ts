'use client';

import useSWR from 'swr';
import { screenApi, SCREEN_SETTINGS_KEY, type ScreenSettings } from '@/lib/api';

/**
 * The reader's ScreenSprite opt-in. `enabled` is false until the settings load, so nothing
 * screen-only flashes onto a book page for a reader who never turned it on.
 */
export function useScreenSettings() {
  const { data, error, isLoading, mutate } = useSWR<ScreenSettings>(SCREEN_SETTINGS_KEY, () =>
    screenApi.settings()
  );
  return { settings: data, enabled: data?.enabled ?? false, isLoading, error, mutate };
}
