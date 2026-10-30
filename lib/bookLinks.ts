export interface BookLinkInput {
  title: string;
  author: string | null;
  isbn13: string | null;
}

export interface BookLink {
  label: string;
  href: string;
  /** True when the link credits ShelfSprite's Bookshop.org affiliate account. */
  affiliate?: boolean;
}

/** The disclosure shown wherever an affiliate link is. */
export const AFFILIATE_DISCLOSURE =
  'ShelfSprite earns a small commission on Bookshop.org purchases.';

/**
 * The Bookshop.org affiliate ID, inlined at build time from NEXT_PUBLIC_BOOKSHOP_AFFILIATE_ID so
 * no ID lives in the repo. It goes into a URL path, so anything but a plain token is ignored and
 * the links go out unattributed.
 */
export function bookshopAffiliateId(
  raw: string | undefined = process.env.NEXT_PUBLIC_BOOKSHOP_AFFILIATE_ID
): string | null {
  const id = raw?.trim();
  return id && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
}

export function bookLinks(
  book: BookLinkInput,
  affiliateId: string | null = bookshopAffiliateId()
): BookLink[] {
  const { title, author, isbn13 } = book;
  const query = encodeURIComponent(isbn13 ?? `${title} ${author ?? ''}`);
  const titleAuthorQuery = encodeURIComponent(`${title} ${author ?? ''}`);

  const amazon: BookLink = {
    label: 'Amazon',
    href: isbn13
      ? `https://www.amazon.com/s?k=${encodeURIComponent(isbn13)}&i=stripbooks`
      : `https://www.amazon.com/s?k=${titleAuthorQuery}&i=stripbooks`,
  };

  // Bookshop credits an affiliate through its /a/{id}/{isbn} book links. A search page carries
  // no affiliate, so a book without an ISBN gets a plain search link.
  const bookshop: BookLink = isbn13
    ? affiliateId
      ? {
          label: 'Bookshop.org',
          href: `https://bookshop.org/a/${affiliateId}/${isbn13}`,
          affiliate: true,
        }
      : { label: 'Bookshop.org', href: `https://bookshop.org/book/${isbn13}` }
    : { label: 'Bookshop.org', href: `https://bookshop.org/search?keywords=${titleAuthorQuery}` };

  // WorldCat finds copies at libraries near the reader without knowing their library, which a
  // Libby deep link would need.
  const worldcat: BookLink = {
    label: 'Library',
    href: `https://search.worldcat.org/search?q=${query}`,
  };

  return [amazon, bookshop, worldcat];
}
