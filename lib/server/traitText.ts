/**
 * Reader-facing trait text. Claude cites evidence through a trait's `exhibits`/`contrasts`
 * ids, but sometimes repeats those ids inside the claim itself ("... at their core (1138,
 * 1140) are rated 5 and 4.5"). Readers never see ids, so they are stripped before storing
 * and again when serializing (for rows stored before this guard existed).
 *
 * Dependency-free on purpose, like rating.ts: it is pure string work.
 */

// A parenthesised group holding only integers, optionally labelled: "(1138)", "(1138, 1140)",
// "(ids 12 and 15)", "(#12; #15)". A bare four-digit year looks the same, so a group is stripped
// only when every number in it is a known book id or the group says outright that it lists ids.
const ID_GROUP =
  /\s*\(\s*((?:(?:book\s+)?ids?|books?)\s*:?\s*)?(#?\d+(?:\s*(?:,|;|&|and)\s*#?\d+)*)\s*\)/gi;

/** Removes parenthesised book-id lists from `text`; `knownIds` decides which groups are ids. */
export function stripIdCitations(text: string, knownIds: Iterable<number>): string {
  const known = new Set(knownIds);
  const out = text.replace(ID_GROUP, (group, label: string | undefined, list: string) => {
    const nums = (list.match(/\d+/g) ?? []).map(Number);
    const labelled = label !== undefined && label.trim() !== '';
    return labelled || nums.every((n) => known.has(n)) ? '' : group;
  });
  // A stripped group can leave "word ." or a doubled space behind.
  return out === text
    ? text
    : out
        .replace(/\s+([.,;:!?])/g, '$1')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

// Prompt rules shared by the full and incremental builds, book and screen variants. Each is one
// rule line in the prompts' indented list style.

/** Claims are shown to readers verbatim (stripIdCitations is only the fallback). */
export const CLAIM_TEXT_RULE =
  '  - Readers see each claim exactly as written: name books and titles by title or ' +
  'description, never by id, and keep ids out of the claim text (they belong only in the id ' +
  'fields).\n';

/** Two traits on the same books read as a repeat when shown one after the other. */
export const DISTINCT_EVIDENCE_RULE =
  '  - Give each trait its own evidence: do not cite the same set of exhibits for two traits. ' +
  'If two traits would rest on the same books, merge them into one.\n';

/** The incremental build keeps current traits, including ones a reader's rewrite superseded. */
export const LOCKED_TRAITS_RULE =
  '  - Traits the user confirmed or rewrote in their own words are authoritative: drop any ' +
  'current trait that restates or contradicts one of them.\n';
