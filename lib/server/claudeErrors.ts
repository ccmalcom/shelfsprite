/**
 * Anthropic error types and utilities.
 * Error messages are byte-exact copies from Python (mylibrary/directive.py,
 * mylibrary/reveal.py, mylibrary/archetype.py) for parity when translating
 * RuntimeError → 400 responses in Tasks 6, 7, 8.
 */

export const DISTILL_NO_KEY_MESSAGE =
  'No Anthropic API key configured. Add your key in Settings (or set ' +
  'ANTHROPIC_API_KEY) before using the custom-instructions assistant.';

export const REVEAL_NO_KEY_MESSAGE =
  'No Anthropic API key configured. Add your key in Settings (or set ' +
  'ANTHROPIC_API_KEY) before viewing the reveal.';

export const ARCHETYPE_NO_KEY_MESSAGE =
  'No Anthropic API key configured. Add one at /settings or set ANTHROPIC_API_KEY.';

export const PROFILE_NO_KEY_MESSAGE =
  'No Anthropic API key configured. Add your key in Settings (or set ' +
  'ANTHROPIC_API_KEY) before running the taste-profile step.';

export const NO_RATED_BOOKS_MESSAGE = 'No rated books found. Run ingest (and enrich) first.';

/** recommend._client's RuntimeError, surfaced by api.py as a 400. */
export const RECOMMEND_NO_KEY_MESSAGE =
  'No Anthropic API key configured. Add your key in Settings (or set ' +
  'ANTHROPIC_API_KEY) before running recommend.';

export const NO_LOVED_BOOKS_MESSAGE =
  'No loved books found (need books rated >= 4). Run ingest + enrich ' +
  '(and ideally profile) first.';

export const NO_PROFILE_MESSAGE =
  "No taste profile found. Run 'profile' (or POST /profile) before " +
  'generating recommendations.';

/** recommend_similar's metadata gate, surfaced by api.py as a 400. */
export const SIMILAR_NOT_ENOUGH_METADATA_MESSAGE =
  'Not enough metadata on this book to find similar reads. Enrich it first.';

/** discover()'s empty-query guard, surfaced by api.py as a 400. */
export const DISCOVER_EMPTY_QUERY_MESSAGE = 'Enter something to search for.';

/** The screen-variant profile guard (spec 2026-09-22 §5.2): either medium counts. */
export const NO_RATED_EVIDENCE_MESSAGE = 'No rated books or titles found. Rate something first.';

/**
 * A profile, archetype or reveal run whose screen_toggled_at changed mid-run (spec §5.7)
 * writes nothing and answers 409 with this message.
 */
export const PROFILE_RUN_SUPERSEDED_MESSAGE =
  'ScreenSprite was turned on or off while this was running, so nothing was saved. ' +
  'Run it again.';
