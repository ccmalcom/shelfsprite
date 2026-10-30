/**
 * Tolerant parsing of a pasted list of book titles: notes, a Kindle or Audible library page,
 * a Libby shelf. One title per line, optionally "Title by Author", "Title - Author" or an
 * Audible-style "By: Author" line under the title. Everything else a copied library page
 * carries (buttons, dates, prices, durations, progress, formats) is skipped as noise.
 *
 * Keep this module dependency-free: the paste screen imports it to show the count before
 * anything is sent, and the bulk-match route trusts nothing it says (the route re-validates
 * every item it is given).
 */

/** The most titles one paste is matched against the catalog. */
export const PASTE_MAX_ITEMS = 200;
/** Longer than this is a paragraph or a blurb, not a title. */
const MAX_LINE_CHARS = 200;

export interface PastedTitle {
  /** 1-based line number in the pasted text, for the reader's reference. */
  line: number;
  /** The line as pasted, trimmed. */
  raw: string;
  title: string;
  author: string | null;
}

export interface ParsedPaste {
  items: PastedTitle[];
  /** Non-blank lines dropped as noise or repeats. */
  skipped: number;
  /** Titles past PASTE_MAX_ITEMS that were left out. */
  truncated: number;
}

// Whole-line UI labels from Kindle, Audible, Libby and store pages. Compared after
// lowercasing and stripping trailing punctuation.
const NOISE_LINES = new Set([
  'read more',
  'read less',
  'show more',
  'show less',
  'see more',
  'see all',
  'view all',
  'sample',
  'free sample',
  'read sample',
  'listen to sample',
  'buy now',
  'buy now with 1-click',
  'add to cart',
  'add to list',
  'add to wishlist',
  'add to wish list',
  'listen now',
  'read now',
  'play',
  'pause',
  'download',
  'downloaded',
  'remove from library',
  'remove from device',
  'mark as finished',
  'mark as read',
  'mark as unread',
  'finished',
  'in progress',
  'not started',
  'new',
  'rate and review',
  'write a review',
  'borrow',
  'borrowed',
  'return',
  'return early',
  'returned',
  'renew',
  'place hold',
  'cancel hold',
  'open book',
  'open audiobook',
  'read in kindle',
  'read in browser',
  'open in kindle app',
  'deliver or remove from device',
  'more actions',
  'actions',
  'options',
  'kindle edition',
  'kindle',
  'kindle unlimited',
  'prime reading',
  'paperback',
  'hardcover',
  'mass market paperback',
  'audiobook',
  'audible audiobook',
  'audio cd',
  'ebook',
  'e-book',
  'book',
  'books',
  'unabridged',
  'abridged',
  'free',
  'prime',
  'library',
  'my library',
  'your library',
  'your books',
  'my books',
  'your audiobooks',
  'my audiobooks',
  'your content',
  'content library',
  'title',
  'author',
  'titles',
  'authors',
  'shelf',
  'loans',
  'holds',
  'tags',
  'notes',
  'sort by',
  'filter',
  'date acquired',
  'date added',
  'date purchased',
  'recent',
  'all titles',
  'collections',
  'podcasts',
  'wish list',
  'wishlist',
]);

const MONTHS =
  '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

const NOISE_PATTERNS: RegExp[] = [
  // Dates, alone or labelled: "Acquired on March 3, 2024", "Purchase date: 01-02-23",
  // "Borrowed 3/15/2022", "2024-03-03", "Mar 3, 2024".
  new RegExp(
    `^(?:[a-z ]{0,30}(?:on|:)?\\s*)?(?:${MONTHS}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{2,4}|\\d{1,2}\\s+${MONTHS}\\.?,?\\s+\\d{2,4}|\\d{1,4}[/.-]\\d{1,2}[/.-]\\d{1,4})$`,
    'i'
  ),
  /^(?:acquired|purchased|purchase date|bought|borrowed|returned|released|release date|date added|added|downloaded|expires?|expired|due|last read|last listened|finished|started)\b.*\d/i,
  /^(?:due|expires?|returns?)\s+(?:in|on|today|tomorrow)\b/i,
  // Prices: "$9.99", "Price: £4.99", "List price $16.00", "9,99 €".
  /^(?:[a-z ]{0,20}:?\s*)?(?:[$£€¥]|usd|gbp|eur)\s*\d[\d.,]*(?:\s*(?:[a-z]{2,4}))?$/i,
  /^\d[\d.,]*\s*(?:[$£€¥]|usd|gbp|eur)$/i,
  // Durations and time left: "Length: 10 hrs and 23 mins", "10h 23m left", "1 hr 2 min".
  /^(?:length|time left|remaining|duration)\b/i,
  /^\d+\s*(?:h|hrs?|hours?)\s*(?:and\s*)?\d+\s*(?:m|mins?|minutes?)\b.*$/i,
  /^\d+\s*(?:h|hrs?|hours?|m|mins?|minutes?)\s+(?:left|remaining)$/i,
  // Progress: "45%", "45% complete", "Page 123 of 300", "Location 1234 of 5678".
  /^\d{1,3}\s*%.*$/,
  /^(?:page|location|loc\.?|chapter)\s+\d+/i,
  // Star ratings and counts: "4.5 out of 5 stars", "(1,234)", "1,234 ratings".
  /^\d(?:\.\d)?\s*out of\s*5(?:\s*stars?)?.*$/i,
  /^\(?[\d.,]+\)?(?:\s*(?:ratings?|reviews?|stars?))?$/i,
  // Narrators, series badges, editions and formats on their own line.
  /^(?:narrated by|narrator|read by|translated by|translator|illustrated by|series|release date|language|publisher|format|edition)\s*:/i,
  /^(?:book|volume|vol\.?|part)\s+\d+(?:\s+of\s+\d+)?$/i,
  // Page controls: "Sort by: Recent", "Filter: All", "View: Grid", "Showing 1-25 of 132".
  /^(?:sort(?:ed)?(?: by)?|filter(?:ed)?(?: by)?|view|show|showing)\s*:/i,
  /^showing\s+\d/i,
];

const LEADING_MARKERS = [
  // Checkboxes: "[ ]", "[x]", "☐", "☑", "✓".
  /^(?:\[[ xX✓]?\]|[☐☑☒✓✔])\s*/,
  // Bullets: -, *, +, •, ·, ◦, ▪, ‣, >, –, —
  /^[-*+•·◦▪‣>–—]+\s*/,
  // Numbering: "1.", "12)", "(3)", "#4", "4:"
  /^(?:\(\d{1,4}\)|#\d{1,4}|\d{1,4}[.):\]])\s*/,
];

// Format tags readers or stores append: "(Kindle Edition)", "[Audiobook]", "(Unabridged)".
const FORMAT_TAG =
  /\s*[([](?:[^)\]]*\b(?:kindle|edition|audiobook|audio book|unabridged|abridged|ebook|e-book|paperback|hardcover|audible)\b[^)\]]*)[)\]]\s*/gi;

/**
 * Lines that put the author under the title: Audible's "By: Andy Weir", "Author: ...".
 * The colon is required after a bare "By", since titles start with it too (By Night in Chile).
 */
const AUTHOR_LINE = /^(?:(?:by|authors?)\s*:|written by:?)\s*(.+)$/i;
/** Audible's "By:" sometimes lists several; keep the first named author. */
function firstAuthor(s: string): string {
  return s.split(/\s*(?:,|;|&| and )\s*/i)[0].trim();
}

function stripMarkers(line: string): string {
  let s = line.trim();
  for (let pass = 0; pass < 3; pass++) {
    const before = s;
    for (const re of LEADING_MARKERS) s = s.replace(re, '');
    s = s.trim();
    if (s === before) break;
  }
  return s;
}

function cleanTitle(s: string): string {
  return s
    .replace(FORMAT_TAG, ' ')
    .replace(
      /\s+[·|•]\s+(?:kindle|audiobook|audible|ebook|e-book|paperback|hardcover|unabridged|abridged)\b.*$/i,
      ''
    )
    .replace(/\s*[([]\d{4}[)\]]\s*$/, '')
    .replace(/^title\s*:\s*/i, '')
    .replace(/^["“]+|["”]+$/g, '')
    .replace(/[\s,;|·]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A plausible author name: one to five words, no digits, starting with a capital. */
function looksLikeAuthor(s: string): boolean {
  if (!s || /\d/.test(s) || s.length > 80) return false;
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 5) return false;
  if (!/^\p{Lu}/u.test(words[0])) return false;
  // A single bare word ("Me" in "Stand by Me") is more often the end of a title.
  return words.length > 1 || words[0].replace(/\./g, '').length >= 4;
}

/**
 * Split "Title by Author", "Title, by Author" or "Title - Author" (any dash with spaces
 * around it). The last separator wins, so a dash or "by" inside the title survives, and the
 * split only happens when the right side reads like a name.
 */
export function splitTitleAuthor(text: string): { title: string; author: string | null } {
  const separators = [/,?\s+by\s+/gi, /\s+[-–—]\s+/g];
  for (const sep of separators) {
    const matches = [...text.matchAll(sep)];
    const last = matches[matches.length - 1];
    if (!last || last.index === undefined || last.index === 0) continue;
    const title = cleanTitle(text.slice(0, last.index));
    const author = cleanTitle(text.slice(last.index + last[0].length));
    if (title && looksLikeAuthor(author)) return { title, author: firstAuthor(author) };
  }
  return { title: cleanTitle(text), author: null };
}

/** True for a line a copied library page carries that is not a title. */
export function isNoiseLine(line: string): boolean {
  const s = line.trim();
  if (s.length > MAX_LINE_CHARS) return true;
  // A title has at least two letters in some script.
  if ((s.match(/\p{L}/gu) ?? []).length < 2) return true;
  const bare = s.toLowerCase().replace(/[\s.:!…›»>]+$/u, '');
  if (NOISE_LINES.has(bare)) return true;
  return NOISE_PATTERNS.some((re) => re.test(s));
}

function key(title: string, author: string | null): string {
  return `${title.toLowerCase()}\u0000${(author ?? '').toLowerCase()}`;
}

/** Parse a pasted list into at most `max` title/author items. */
export function parsePastedList(text: string, max = PASTE_MAX_ITEMS): ParsedPaste {
  const items: PastedTitle[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  let truncated = 0;

  const lines = (text ?? '').split(/\r\n|\r|\n/);
  for (const [i, original] of lines.entries()) {
    const raw = original.trim();
    if (!raw) continue;
    const stripped = stripMarkers(raw);
    if (!stripped) {
      skipped++;
      continue;
    }

    // "By: Andy Weir" under a title names that title's author.
    const authorLine = stripped.match(AUTHOR_LINE);
    if (authorLine) {
      const prev = items[items.length - 1];
      const author = firstAuthor(cleanTitle(authorLine[1]));
      if (prev && !prev.author && looksLikeAuthor(author)) {
        seen.delete(key(prev.title, prev.author));
        prev.author = author;
        seen.add(key(prev.title, prev.author));
      } else {
        skipped++;
      }
      continue;
    }

    if (isNoiseLine(stripped)) {
      skipped++;
      continue;
    }

    const { title, author } = splitTitleAuthor(stripped);
    if (!title || isNoiseLine(title)) {
      skipped++;
      continue;
    }
    const k = key(title, author);
    if (seen.has(k)) {
      skipped++;
      continue;
    }
    if (items.length >= max) {
      truncated++;
      continue;
    }
    seen.add(k);
    items.push({ line: i + 1, raw, title, author });
  }
  return { items, skipped, truncated };
}

/** A name as a sorted token list, so Kindle's "Weir, Andy" equals "Andy Weir". */
function normName(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

/**
 * Kindle's library page puts the author on its own line under the title, as a bare name
 * that no parser can tell from a title. After matching, such a line comes back unmatched,
 * and it names the author of the title just above it. Returns the indices of those lines
 * so the review screen can drop them instead of asking the reader about them.
 */
export function authorEchoes(
  items: ReadonlyArray<Pick<PastedTitle, 'title' | 'author'>>,
  matchedAuthors: ReadonlyArray<string | null | undefined>,
  unmatched: ReadonlySet<number>
): Set<number> {
  const out = new Set<number>();
  for (let i = 1; i < items.length; i++) {
    if (!unmatched.has(i) || items[i].author) continue;
    const text = normName(items[i].title);
    if (!text) continue;
    const prevAuthors = [matchedAuthors[i - 1], items[i - 1].author].map(normName);
    if (prevAuthors.some((a) => a && a === text)) out.add(i);
  }
  return out;
}
