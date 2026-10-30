/**
 * Card-facing cleanup of the catalog fields a recommendation carries. Catalog data is
 * stored raw, because retrieval and the reranker want everything the catalog said; the
 * swipe card wants a reader's view of it. recOut applies these at serialization, so
 * every card path and every stored row gets the same treatment.
 *
 * Dependency-free on purpose: pure string work, unit-tested in rec-display.test.ts.
 */

// ── Chips ─────────────────────────────────────────────────────────────────────

/** Most chips the wire ever carries; the card shows fewer. */
export const MAX_CHIPS = 6;

const NYT_LABEL = 'NYT bestseller';

/**
 * Open Library subjects mix genres with Library of Congress topical headings
 * ("Suicide victims", "Deckard, Rick (Fictitious character) -- Fiction"), list tags
 * ("nyt:hardcover-fiction=2020-10-18") and catalog noise. A heading out of context reads
 * as a claim about the book, sometimes an upsetting one, so chips come from this positive
 * genre list only: a subject that names none of these produces no chip.
 *
 * Patterns run against the lowercased subject, in order. `fiction` marks a pattern that
 * only counts when the subject is about fiction ("Fiction, crime", not "Criminal courts").
 */
const GENRES: Array<{ re: RegExp; label: string; fiction?: true }> = [
  { re: /\bscience fiction\b|\bsci-fi\b/, label: 'Science fiction' },
  { re: /\bspace opera\b/, label: 'Space opera' },
  { re: /\bcyberpunk\b/, label: 'Cyberpunk' },
  { re: /\bdystopia/, label: 'Dystopian' },
  { re: /\bfantasy\b/, label: 'Fantasy' },
  { re: /\bhorror\b/, label: 'Horror' },
  { re: /\bghost stories\b/, label: 'Ghost stories' },
  { re: /\bgothic\b/, label: 'Gothic' },
  { re: /\bmystery\b|\bdetective\b/, label: 'Mystery' },
  { re: /\bthrillers?\b|\bsuspense\b/, label: 'Thriller' },
  { re: /\bcrime\b/, label: 'Crime fiction', fiction: true },
  { re: /\btrue crime\b/, label: 'True crime' },
  { re: /\bromance\b|\blove stories\b/, label: 'Romance' },
  { re: /\bhistorical\b/, label: 'Historical fiction', fiction: true },
  { re: /\bliterary\b/, label: 'Literary fiction', fiction: true },
  { re: /\bclassics?\b|\bclassic literature\b/, label: 'Classics' },
  { re: /\byoung adult\b/, label: 'Young adult' },
  { re: /\bcoming of age\b|\bbildungsroman\b/, label: 'Coming of age' },
  { re: /\bmagical realism\b/, label: 'Magical realism' },
  { re: /\bmytholog/, label: 'Mythology' },
  { re: /\bfairy tales\b|\bfolklore\b/, label: 'Folklore' },
  { re: /\badventure\b/, label: 'Adventure' },
  { re: /\bwesterns?\b/, label: 'Western', fiction: true },
  { re: /\bwar\b/, label: 'War fiction', fiction: true },
  { re: /\bhumou?r\b|\bhumorous\b/, label: 'Humor' },
  { re: /\bsatire\b/, label: 'Satire' },
  { re: /\bshort stories\b/, label: 'Short stories' },
  { re: /\bgraphic novels?\b|\bcomics\b/, label: 'Graphic novels' },
  { re: /\bpoetry\b/, label: 'Poetry' },
  { re: /^drama$|\bplays\b/, label: 'Drama' },
  { re: /\bautobiograph|\bbiograph/, label: 'Biography' },
  { re: /\bmemoirs?\b/, label: 'Memoir' },
  { re: /\bessays\b/, label: 'Essays' },
  { re: /^history$|^history \/|^history, /, label: 'History' },
  { re: /^philosophy\b/, label: 'Philosophy' },
  { re: /^psychology\b/, label: 'Psychology' },
  { re: /^science$|^science \//, label: 'Science' },
  { re: /^travel\b/, label: 'Travel' },
];

/**
 * Subjects that are never chips, whatever genre word they contain: LC subdivisions
 * (" -- "), qualifiers and named people or works (parentheses), tag syntax (":" "=" "_"
 * "["), and scholarly or curricular headings ("Science fiction, history and criticism").
 */
const NOT_A_CHIP = /\s--\s|[()[\]:=_]|criticism|study and teaching|reading level|victims/;

/** The readable chips for a recommendation's raw catalog subjects, best first. */
export function cardChips(subjects: readonly unknown[] | null | undefined): string[] {
  const genres: string[] = [];
  let nyt = false;
  for (const raw of subjects ?? []) {
    if (typeof raw !== 'string') continue;
    const s = raw.trim().toLowerCase();
    // nyt:<list-name>=<list date> is Open Library's record of a week on a New York Times
    // bestseller list. The list and date mean nothing on a card; the fact does.
    if (s.startsWith('nyt:') || s === 'new york times bestseller') {
      nyt = true;
      continue;
    }
    if (!s || NOT_A_CHIP.test(s)) continue;
    const fiction = /\bfiction\b|\bnovels?\b/.test(s);
    for (const g of GENRES) {
      if (g.fiction && !fiction) continue;
      if (g.re.test(s) && !genres.includes(g.label)) genres.push(g.label);
    }
  }
  // Genres first: the bestseller flag is the least informative chip a card can show.
  if (nyt) genres.push(NYT_LABEL);
  return genres.slice(0, MAX_CHIPS);
}

// ── Description ───────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code =
        name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/**
 * A catalog blurb as plain text. Google Books descriptions carry HTML (<p>, <b>, <br>);
 * Open Library's are markdown, often with a "----------" rule followed by edition
 * cross-references and a list of "[1]: https://..." link definitions. The card renders
 * the result as a React text node, so this only has to read well: it never produces
 * markup and its output is never injected as HTML.
 */
export function plainDescription(text: string | null | undefined): string | null {
  if (!text) return null;
  let s = text.replace(/\r\n?/g, '\n');

  // HTML: block breaks become paragraph breaks, every other tag goes.
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/?(?:p|div|li|ul|ol|h\d)\b[^>]*>/gi, '\n\n');
  s = s.replace(/<[^>]*>/g, '');
  s = decodeEntities(s);

  // Markdown. Everything after a horizontal rule is Open Library's edition metadata
  // ("Contained in:", "See also:"), not the description.
  s = s.split(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/m)[0];
  s = s
    .replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, '') // [1]: https://... link definitions
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [text](url)
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1') // [text][1]
    .replace(/\(\s*source\s*\)/gi, '') // "([source][1])" once the link is gone
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // headings
    .replace(/^\s{0,3}>\s?/gm, '') // blockquotes
    .replace(/^\s*[-*+]\s+/gm, '') // bullet markers
    .replace(/(\*\*|__)(.+?)\1/g, '$2') // bold
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2') // *italic*
    .replace(/(^|[^\w])_(?!\s)([^_\n]+?)_(?!\w)/g, '$1$2') // _italic_
    .replace(/`([^`]+)`/g, '$1');

  // The card shows one paragraph: fold every run of whitespace.
  s = s.replace(/\s+/g, ' ').trim();
  return s || null;
}

// ── Year ──────────────────────────────────────────────────────────────────────

/** Movable type; anything earlier is a catalog error for the books this app recommends. */
export const EARLIEST_YEAR = 1450;

/** A year a book could have been published in, as of `now`. */
export function plausibleYear(year: unknown, now: Date = new Date()): year is number {
  return (
    typeof year === 'number' &&
    Number.isInteger(year) &&
    year >= EARLIEST_YEAR &&
    // Next year allows announced titles, which catalogs list ahead of release.
    year <= now.getUTCFullYear() + 1
  );
}

const FIRST_PUBLISHED = /\b(?:first|originally) published in (\d{4})\b/i;

/**
 * The year a card shows. A blurb that states the first publication year beats the
 * catalog's year: Open Library's first_publish_year is the earliest year on ANY
 * edition, so one mis-dated edition record can drag a classic centuries early (a QA
 * deck dated Tess of the d'Urbervilles, 1891, as 1707), and Google's year is the
 * edition's own. An implausible year is dropped rather than shown.
 */
export function cardYear(
  year: number | null | undefined,
  description?: string | null,
  now: Date = new Date()
): number | null {
  const stated = description ? FIRST_PUBLISHED.exec(description) : null;
  if (stated) {
    const n = parseInt(stated[1], 10);
    if (plausibleYear(n, now)) return n;
  }
  return plausibleYear(year, now) ? year : null;
}
