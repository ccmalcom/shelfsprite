/** Cap per favorites family. Bounds the stored JSON blob and the retrieval budget.
 *  Mirrored — deliberately duplicated, never imported — as MAX_PREFER_ENTRIES in
 *  lib/api.ts, because a client component must not import from lib/server/**. */
export const MAX_PREFER_ENTRIES = 10;

/**
 * Normalize one favorites list.
 *
 * DELIBERATE DIVERGENCE from the adjacent exclude_authors, which lowercases:
 * `lowercase` is true for prefer_subjects and FALSE for prefer_authors. Lowercasing
 * is harmless for an invisible filter but wrong for a field the reader types and
 * then reads back on their own profile page, so prefer_authors preserves case and
 * every comparison lowercases at the point of use instead.
 */
function normalizePreferList(raw: unknown, lowercase: boolean): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of Array.isArray(raw) ? raw : []) {
    const collapsed = String(x).trim().replace(/\s+/g, ' ');
    if (!collapsed) continue;
    const value = lowercase ? collapsed.toLowerCase() : collapsed;
    const fold = value.toLowerCase();
    if (seen.has(fold)) continue;
    seen.add(fold);
    out.push(value);
  }
  return out;
}

/**
 * A hard filter outranks a soft boost: an entry present in both families is dropped
 * from the preference. Keeping both would boost a candidate into the pool and then
 * delete it from the pool. Conflicts are dropped BEFORE the cap so the reader does
 * not lose slots to entries that were never going to survive.
 */
function dropExcluded(values: string[], excluded: unknown): string[] {
  const blocked = new Set(
    (Array.isArray(excluded) ? excluded : []).map((e) => String(e).trim().toLowerCase())
  );
  return values.filter((v) => !blocked.has(v.toLowerCase())).slice(0, MAX_PREFER_ENTRIES);
}

/** Port of directive._clean_directive_constraints — keep only supported,
 *  catalog-filterable constraints; normalize types. */
export function cleanDirectiveConstraints(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;

  const langs = (Array.isArray(r.languages) ? r.languages : [])
    .filter((x) => String(x).trim())
    .map((x) => String(x).trim().toLowerCase().slice(0, 2));
  if (langs.length) out.languages = langs;

  for (const key of ['min_year', 'max_year'] as const) {
    const val = r[key];
    if (typeof val === 'boolean') continue;
    if (typeof val === 'number' && Number.isInteger(val)) out[key] = val;
    else if (typeof val === 'string' && /^\d+$/.test(val.trim()))
      out[key] = parseInt(val.trim(), 10);
  }

  const excl = (Array.isArray(r.exclude_subjects) ? r.exclude_subjects : [])
    .filter((x) => String(x).trim())
    .map((x) => String(x).trim().toLowerCase());
  if (excl.length) out.exclude_subjects = excl;

  const authors = (Array.isArray(r.exclude_authors) ? r.exclude_authors : [])
    .filter((x) => String(x).trim())
    .map((x) => String(x).trim().toLowerCase());
  if (authors.length) out.exclude_authors = authors;

  // Compared against the CLEANED excludes above, so the conflict check runs on the
  // normalized set rather than on whatever the caller sent.
  const preferSubjects = dropExcluded(
    normalizePreferList(r.prefer_subjects, true),
    out.exclude_subjects
  );
  if (preferSubjects.length) out.prefer_subjects = preferSubjects;

  const preferAuthors = dropExcluded(
    normalizePreferList(r.prefer_authors, false),
    out.exclude_authors
  );
  if (preferAuthors.length) out.prefer_authors = preferAuthors;

  return out;
}
