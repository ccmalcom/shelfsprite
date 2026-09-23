/**
 * Screen title matching (spec §4.3). Deliberately NOT the book helpers in dedup.ts:
 * normalizeTitle keeps only [a-z0-9 ], so two different non-Latin titles both
 * normalize to '' and ratio('', '') is 1.0 -- a manufactured HIGH. Screen titles keep
 * the full title (subtitles and parentheticals included), apply NFKC, lowercase, and
 * keep letters, combining marks and numbers in every script.
 *
 * Ported from the 2026-09-22 spike (resolve3.py#norm and #variants). One deliberate
 * difference: Python's \w drops combining marks (Devanagari vowel signs, for example),
 * so the port keeps \p{M} as part of a word instead of splitting on it.
 */
import { pyTitle } from './serialize';
import { ratio } from './similarity';

export function screenNormalize(title: string | null | undefined): string {
  if (!title) return '';
  return title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

/** ratio() over already-normalized titles. An empty side never matches. */
export function screenRatio(a: string, b: string): number {
  if (!a || !b) return 0;
  return ratio(a, b);
}

export function screenSimilarity(a: string, b: string): number {
  return screenRatio(screenNormalize(a), screenNormalize(b));
}

/** Python str.capitalize(): first character upper, the rest lower. */
function pyCapitalize(s: string): string {
  const chars = [...s];
  if (chars.length === 0) return s;
  return chars[0].toUpperCase() + chars.slice(1).join('').toLowerCase();
}

const TRAILING_PARENTHETICAL = /^(.*?)\s*\((.*)\)$/;

/**
 * The spike's Stage A variant set: as given, str.title(), str.capitalize(), lower,
 * upper, and for a trailing parenthetical such as "(First Sequence)", the base title
 * and "Base: Parenthetical". Insertion order, de-duplicated, blanks dropped.
 */
export function titleVariants(title: string): string[] {
  const out = new Set<string>([
    title,
    pyTitle(title),
    pyCapitalize(title),
    title.toLowerCase(),
    title.toUpperCase(),
  ]);
  const m = TRAILING_PARENTHETICAL.exec(title);
  if (m) {
    out.add(m[1]);
    out.add(`${m[1]}: ${m[2]}`);
  }
  return [...out].filter((v) => v.trim() !== '');
}
