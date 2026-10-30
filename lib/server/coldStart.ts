/**
 * The cold-start threshold: below it the recommender cannot infer authors and subjects from
 * the library and takes the broader cold-start path (recSignal.isColdStart). Kept
 * dependency-free so onboarding screens can show progress toward it without pulling server
 * code into the browser bundle. recSignal.ts re-exports these; change them here.
 */

/** Effective rating at or above which a book counts as "loved". */
export const LOVED_MIN = 4;
export const COLD_START_LOVED = 8;
export const COLD_START_RATED = 12;

export interface ColdStartProgress {
  rated: number;
  loved: number;
  /** Rated books still needed, never below 0. */
  ratedNeeded: number;
  /** Loved books still needed, never below 0. */
  lovedNeeded: number;
  /** Past the threshold: isColdStart would say false for this library. */
  done: boolean;
}

/** Progress toward the threshold over effective ratings (null or 0 means unrated). */
export function coldStartProgress(
  ratings: ReadonlyArray<number | null | undefined>
): ColdStartProgress {
  let rated = 0;
  let loved = 0;
  for (const r of ratings) {
    if (r == null || r <= 0) continue;
    rated++;
    if (r >= LOVED_MIN) loved++;
  }
  const ratedNeeded = Math.max(0, COLD_START_RATED - rated);
  const lovedNeeded = Math.max(0, COLD_START_LOVED - loved);
  return { rated, loved, ratedNeeded, lovedNeeded, done: ratedNeeded === 0 && lovedNeeded === 0 };
}
