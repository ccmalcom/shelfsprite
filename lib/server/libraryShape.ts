/**
 * Reader-facing facts about a library's shape, shared by the profile highlights, the subject
 * breakdown and the archetype copy, so the reveal never says two contradictory things (an
 * "authors you follow" archetype beside "no repeat authors").
 *
 * Catalog subjects are a mix of Google Books categories ("Fiction", "Biography & Autobiography")
 * and Library of Congress headings from Open Library ("New York (N.Y.), Fiction", "Young men",
 * "Children of clergy"). Only the genre-like ones are worth showing a reader.
 */

/** Labels too broad to call a genre: every novel is "Fiction". Compared lowercased. */
const UMBRELLA_LABELS = new Set([
  'fiction',
  'nonfiction',
  'non-fiction',
  'general',
  'literature',
  'novel',
  'novels',
  'fiction in english',
  'english fiction',
  'american fiction',
  'american literature',
  'english literature',
  'literary collections',
  'large type books',
  'accessible book',
  'protected daisy',
  'in library',
  'lending library',
]);

/** People and demographic headings ("Young men", "Children of clergy") describe characters. */
const PEOPLE_HEADING =
  /\b(men|women|boys|girls|children(?!')|teenagers?|families|clergy|brothers|sisters|fathers|mothers|sons|daughters|friends|people|persons)\b/;

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .split(':')[0]
    .replace(/^(the|a|an)\s+/, '')
    .trim();
}

/**
 * The genre a raw catalog subject names, or null when it is not a genre: an umbrella label, an
 * LC heading with qualifiers, a people heading, or the book's own title. "Fiction, fantasy, epic"
 * becomes "fantasy". Callers apply their own casing (pyTitle).
 */
export function genreLabel(raw: string, bookTitle?: string | null): string | null {
  let s = raw.trim();
  // Open Library's "Fiction, <genre>, <subgenre>" form: the second segment is the genre.
  const fictionForm = /^fiction\s*,\s*([^,]+)/i.exec(s);
  if (fictionForm) s = fictionForm[1].trim();
  const lower = s.toLowerCase();
  if (!lower || UMBRELLA_LABELS.has(lower)) return null;
  // LC headings carry places, dates and subdivisions: "New York (N.Y.), Fiction".
  if (/[(),:]|--/.test(s)) return null;
  if (PEOPLE_HEADING.test(lower)) return null;
  if (bookTitle && lower === normalizeTitle(bookTitle)) return null;
  return s;
}

const NONFICTION_MARKERS = [
  'nonfiction',
  'non-fiction',
  'biography',
  'autobiography',
  'memoir',
  'history',
  'essays',
  'true crime',
  'science',
  'philosophy',
  'psychology',
  'self-help',
  'politic',
  'social science',
  'business',
  'economics',
  'religion',
  'journalism',
  'travel',
  'cooking',
];

/** 'fiction', 'nonfiction', or null when the subjects do not say. Fiction wins a mix. */
export function fictionKind(subjects: string[]): 'fiction' | 'nonfiction' | null {
  const lower = subjects.map((s) => s.toLowerCase());
  const fiction = lower.some(
    (s) =>
      (s.includes('fiction') && !s.includes('nonfiction') && !s.includes('non-fiction')) ||
      s.includes('novel') ||
      s.includes('fantasy') ||
      s.includes('short stories')
  );
  if (fiction) return 'fiction';
  if (lower.some((s) => NONFICTION_MARKERS.some((m) => s.includes(m)))) return 'nonfiction';
  return null;
}

export interface ShapeBook {
  author: string | null;
  subjects: string[] | null;
  /** Whether the catalog places the book in a series. */
  inSeries: boolean;
}

export interface LibraryShape {
  /** Some author has two or more rated books. */
  repeatAuthors: boolean;
  /** Series books are a real part of the shelf, not one stray volume. */
  readsSeries: boolean;
  /** At least half of the books the catalog could classify are nonfiction. */
  mostlyNonfiction: boolean;
}

/** Facts over the RATED books, the same population the highlights describe. */
export function libraryShape(rated: ShapeBook[]): LibraryShape {
  const perAuthor = new Map<string, number>();
  for (const b of rated) {
    if (b.author) perAuthor.set(b.author, (perAuthor.get(b.author) ?? 0) + 1);
  }
  const seriesBooks = rated.filter((b) => b.inSeries).length;
  let fiction = 0;
  let nonfiction = 0;
  for (const b of rated) {
    const kind = fictionKind(b.subjects ?? []);
    if (kind === 'fiction') fiction += 1;
    else if (kind === 'nonfiction') nonfiction += 1;
  }
  return {
    repeatAuthors: [...perAuthor.values()].some((n) => n >= 2),
    readsSeries: seriesBooks >= 2 && seriesBooks >= rated.length * 0.2,
    mostlyNonfiction: nonfiction > 0 && nonfiction >= fiction,
  };
}
