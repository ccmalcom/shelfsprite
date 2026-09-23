import { mutate } from 'swr';
import {
  ApiRequestError,
  ARCHETYPE_KEY,
  PROFILE_STATUS_KEY,
  REVEAL_TITLES_KEY,
  SCREEN_ACTIVE_JOB_KEY,
  SCREEN_RECS_KEY,
  SCREEN_SETTINGS_KEY,
  SCREEN_TITLES_KEY,
  TRAITS_KEY,
} from '@/lib/api';

/**
 * Everything that depends on the screen library or the opt-in (spec §7.7). 'profile' is the
 * swipe page's trait key; the reveal keys are RevealSequence's. The settings key is left out on
 * purpose: callers write the fresh settings they just received instead of blanking them, which
 * would flash the nav switch and the gate.
 */
export const SCREEN_STATE_KEYS: readonly string[] = [
  SCREEN_TITLES_KEY,
  SCREEN_RECS_KEY,
  SCREEN_ACTIVE_JOB_KEY,
  TRAITS_KEY,
  'profile',
  ARCHETYPE_KEY,
  PROFILE_STATUS_KEY,
  'reveal-stats',
  'reveal-traits',
  'reveal-highlights',
  'reveal-books',
  REVEAL_TITLES_KEY,
];

/**
 * After disabling ScreenSprite or deleting its library. Three-argument form: most of these
 * pages are not mounted, and a bare mutate(key) would leave their stale data cached
 * (docs/frontend.md).
 */
export async function invalidateScreenState(): Promise<void> {
  await Promise.all(SCREEN_STATE_KEYS.map((key) => mutate(key, undefined, { revalidate: true })));
}

/**
 * After a title rating, review, favorite, exclusion, correction or removal: the shared profile
 * is dirty now (spec §7.7). Titles and status are subscribed wherever this runs (the page and
 * the app-wide banner), so the bare form revalidates them; the reveal list is not mounted.
 */
export async function invalidateTitleEdits(): Promise<void> {
  await Promise.all([
    mutate(SCREEN_TITLES_KEY),
    mutate(PROFILE_STATUS_KEY),
    mutate(REVEAL_TITLES_KEY, undefined, { revalidate: true }),
  ]);
}

/**
 * SWR onError for screen reads. A 403 means ScreenSprite was turned off (perhaps in another
 * tab): re-read the settings, which the always-mounted NavBar subscribes to, so ScreenGate
 * redirects without a reload.
 */
export function handleScreenError(e: unknown): void {
  if (e instanceof ApiRequestError && e.status === 403) void mutate(SCREEN_SETTINGS_KEY);
}
