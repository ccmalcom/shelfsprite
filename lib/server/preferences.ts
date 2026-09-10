/**
 * Reading side of the reader's explicit favorites. `cleanDirectiveConstraints` in
 * directive.ts is the only writer; this is the only reader, so the recommender never
 * re-derives the stored shape.
 */
import { surname } from './dedup';
import type { PoolPreferences } from './recAssemble';

/** Type-only import above, so there is no runtime cycle with recAssemble. */
function stringList(v: unknown): string[] {
  return (Array.isArray(v) ? v : []).map((x) => String(x).trim()).filter((s) => s !== '');
}

export function readPreferences(
  constraints: Record<string, unknown> | null | undefined
): PoolPreferences {
  return {
    prefer_subjects: stringList(constraints?.prefer_subjects),
    prefer_authors: stringList(constraints?.prefer_authors),
  };
}

/**
 * surname()-normalized, the same keying applyAuthorCaps uses for libraryAuthors, so
 * the two sets compose without a second normalization pass. surname() already
 * lowercases (via normalizeTitle), which is where the case-preserving stored form
 * gets folded for comparison.
 *
 * SURNAME COLLISIONS ARE ACCEPTED, NOT FIXED: "Ursula K. Le Guin" reduces to `guin`,
 * so favoriting her exempts anyone sharing that surname. Same fidelity libraryAuthors
 * has always had; the failure mode is a mildly worse candidate, not a wrong one.
 */
export function preferredAuthorSurnames(authors: string[]): Set<string> {
  const out = new Set<string>();
  for (const a of authors) {
    const key = surname(a);
    if (key) out.add(key);
  }
  return out;
}
