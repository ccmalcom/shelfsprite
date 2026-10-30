/**
 * Catalog records sometimes carry a publisher, imprint or content-mill brand in the
 * author field: QA saw "The Enchanted Tea House" served "by Blockbuster Story" while
 * the cover names Carter Vane. Such an author is UNRESOLVED, not an author. The
 * recommender drops candidates carrying one, and enrichment refuses to call a match
 * HIGH or MEDIUM on the strength of one.
 *
 * The heuristic is deliberately conservative, because a false positive deletes a
 * real writer from every recommendation. Real people are named Press, House and
 * Story (Silas House is a working novelist), so a trailing word only counts on its
 * own when it cannot be a surname ("Publishing", "LLC", "Editions"). A word that can
 * be a surname ("Press", "House", "Story") needs a second piece of evidence: the
 * string equals the record's publisher, opens with "The", or another of its words is
 * itself a brand word ("Blockbuster", "University"). "Mary Press" therefore survives
 * and "Golden Press" does not. A trailing word must be a whole word: "Storey" and
 * "Pressman" are never matched.
 *
 * A pseudonym that looks like a person ("Carter Vane") is out of reach of any string
 * test; the author cap in recFilters.applyAuthorCaps is what limits a run of them.
 *
 * Dependency-free so either side of the app could import it.
 */

/** A trailing word that no real person carries as a surname. */
const CORPORATE_SUFFIXES = new Set([
  'publishing',
  'publishers',
  'publisher',
  'publications',
  'publication',
  'books',
  'media',
  'studios',
  'stories',
  'classics',
  'editions',
  'productions',
  'entertainment',
  'imprint',
  'llc',
  'inc',
  'incorporated',
  'ltd',
  'limited',
  'corp',
  'corporation',
  'gmbh',
  'plc',
]);

/** A trailing word that IS a plausible surname, so it needs corroboration. */
const AMBIGUOUS_SUFFIXES = new Set([
  'press',
  'house',
  'story',
  'studio',
  'company',
  'co',
  'group',
  'library',
]);

/** Words that mark a brand when they appear anywhere else in the string. */
const BRAND_WORDS = new Set([
  'blockbuster',
  'bestseller',
  'bestsellers',
  'bestselling',
  'kindle',
  'digital',
  'independent',
  'indie',
  'university',
  'global',
  'international',
  'golden',
  'penguin',
  'reads',
  'tales',
  'fiction',
  'novels',
  'kids',
]);

/** Exact names seen in the wild that the suffix rules would otherwise need luck for. */
const KNOWN_BRAND_AUTHORS = new Set(['blockbuster story']);

/** Legal-form tails dropped before comparing an author with a publisher. */
const LEGAL_TAILS = new Set([
  'llc',
  'inc',
  'incorporated',
  'ltd',
  'limited',
  'corp',
  'co',
  'gmbh',
  'plc',
]);

function tokens(s: string | null | undefined): string[] {
  return (s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}&]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

function withoutLegalTail(ts: string[]): string[] {
  const out = [...ts];
  while (out.length > 1 && LEGAL_TAILS.has(out[out.length - 1])) out.pop();
  return out;
}

function sameName(a: string[], b: string[]): boolean {
  const x = withoutLegalTail(a);
  const y = withoutLegalTail(b);
  return x.length > 0 && x.join(' ') === y.join(' ');
}

/**
 * True when `author` reads as a publisher, imprint or brand rather than a person.
 * `publishers` are the record's own publisher strings, when the catalog gave any.
 */
export function isPublisherLikeAuthor(
  author: string | null | undefined,
  publishers: readonly string[] = []
): boolean {
  const ts = tokens(author);
  if (!ts.length) return false;
  if (KNOWN_BRAND_AUTHORS.has(ts.join(' '))) return true;

  const last = ts[ts.length - 1];
  if (CORPORATE_SUFFIXES.has(last)) return true;

  const matchesPublisher = publishers.some((p) => sameName(ts, tokens(p)));
  const brandWordElsewhere = ts
    .slice(0, -1)
    .some((t) => BRAND_WORDS.has(t) || CORPORATE_SUFFIXES.has(t) || AMBIGUOUS_SUFFIXES.has(t));

  if (AMBIGUOUS_SUFFIXES.has(last)) {
    return matchesPublisher || ts[0] === 'the' || brandWordElsewhere;
  }
  // Author equal to the publisher with no suffix at all: most often a self-published
  // writer ("Andy Weir" / "Andy Weir"), so it needs a brand word or a lone token.
  if (matchesPublisher) {
    return ts.length === 1 || brandWordElsewhere || BRAND_WORDS.has(last);
  }
  return false;
}

/**
 * The publisher strings a catalog record carries, read from its raw payload:
 * Google's `volumeInfo.publisher`, an Open Library search doc's `publisher` list, or
 * an Open Library ISBN record's `publishers[].name`. Anything else yields [].
 */
export function candidatePublishers(raw: unknown): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'string' && v.trim()) out.push(v.trim());
  };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, any>;
  push(r.volumeInfo?.publisher);
  if (Array.isArray(r.publisher)) r.publisher.forEach(push);
  else push(r.publisher);
  const record = r.record;
  if (record && Array.isArray(record.publishers)) {
    for (const p of record.publishers) push(typeof p === 'string' ? p : p?.name);
  }
  return out;
}

/** The author a catalog record names, including an Open Library ISBN record's list. */
export function candidateAuthor(c: { author?: string | null; raw?: unknown }): string | null {
  if (c.author) return c.author;
  const record = (c.raw as Record<string, any> | null | undefined)?.record;
  const first = Array.isArray(record?.authors) ? record.authors[0] : null;
  const name = typeof first === 'string' ? first : first?.name;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

/** A catalog candidate whose author is a publisher or brand: unresolved authorship. */
export function hasPublisherAuthor(c: { author?: string | null; raw?: unknown }): boolean {
  return isPublisherLikeAuthor(candidateAuthor(c), candidatePublishers(c.raw));
}
