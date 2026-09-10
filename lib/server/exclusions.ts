/**
 * What a hard exclusion actually matches -- and therefore what a favorite conflicts
 * with. The single definition of both rules.
 *
 * This module exists because the rules were written out three times (the recommender's
 * filter, the directive's conflict check, the editor's warning) and the copies drifted:
 * the filter matched authors by SURNAME while the conflict checks compared the full
 * typed string, so `exclude_authors: ['sanderson']` and `prefer_authors: ['Brandon
 * Sanderson']` coexisted happily -- the favorite drove retrieval, reached the reranker,
 * and then every candidate it produced was deleted by the filter. Subjects drifted the
 * same way: exclusions match a whole word INSIDE a subject, so `exclude_subjects:
 * ['opera']` silently emptied `prefer_subjects: ['space opera']`.
 *
 * A conflict predicate must therefore answer exactly the question the filter answers --
 * "would this value be thrown away downstream?" -- and never approximate it.
 *
 * Dependency-free apart from dedup.ts (which is itself dependency-free), because
 * components/FavoritesFields.tsx imports it: anything reaching db.ts, drizzle or Zod
 * from here ships in the browser bundle.
 */
import { surname } from './dedup';

/**
 * Python's `re.escape` escapes every character outside [A-Za-z0-9_]; this escapes
 * only JS regex metacharacters. The two produce equivalent patterns -- Python's extra
 * escapes (space, '-', '#') are semantic no-ops -- and this form stays valid under a
 * future /u flag, which blanket backslash-escaping would not.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * recommend._subject_hits: true when `term` appears as a whole word inside `subject`
 * (both already lowercased). Whole-word so excluding 'war' does not trip 'warmth'.
 *
 * DEVIATION: Python's `\b` is Unicode-aware for str patterns; JS's is ASCII-only.
 * Both operands here are lowercased English subject headings, where the two agree.
 */
export function subjectHits(term: string, subject: string): boolean {
  return new RegExp(`\\b${escapeRegExp(term)}\\b`).test(subject);
}

/** Trim + lowercase every entry, dropping blanks. Mirrors how cleanDirectiveConstraints
 *  stores exclude_subjects / exclude_authors, so an uncleaned caller gets the same
 *  answer as a cleaned one. */
function foldList(raw: unknown): string[] {
  return (Array.isArray(raw) ? raw : []).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
}

/**
 * Would `author` be removed by these exclusions? Mirrors applyDirectiveConstraints,
 * which tests the CANDIDATE'S SURNAME against the exclusion set.
 *
 * The inherited Python quirk rides along on purpose: an exclusion stored as a full name
 * ('john ringo') matches no surname and so filters nothing, and this returns false for
 * it. That is the right answer -- a favorite must not be dropped for an exclusion that
 * was never going to fire.
 */
export function authorExcluded(author: string, excludeAuthors: unknown): boolean {
  const blocked = new Set(foldList(excludeAuthors));
  if (!blocked.size) return false;
  return blocked.has(surname(author).toLowerCase());
}

/** Would `subject` be removed by these exclusions? Mirrors applyDirectiveConstraints,
 *  which drops a candidate when any exclusion term hits any of its subjects. */
export function subjectExcluded(subject: string, excludeSubjects: unknown): boolean {
  const terms = foldList(excludeSubjects);
  if (!terms.length) return false;
  const folded = subject.trim().toLowerCase();
  return terms.some((term) => subjectHits(term, folded));
}
