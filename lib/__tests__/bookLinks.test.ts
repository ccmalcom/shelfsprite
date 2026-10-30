import { bookLinks, bookshopAffiliateId } from '../bookLinks';

const withIsbn = { title: 'Dune', author: 'Frank Herbert', isbn13: '9780441013593' };
const noIsbn = { title: 'Dune', author: 'Frank Herbert', isbn13: null };

describe('bookLinks', () => {
  it('returns three links', () => {
    expect(bookLinks(withIsbn)).toHaveLength(3);
  });

  it('uses ISBN in Amazon URL when present', () => {
    const links = bookLinks(withIsbn);
    const amazon = links.find((l) => l.label === 'Amazon')!;
    expect(amazon.href).toContain('9780441013593');
    expect(amazon.href).toContain('amazon.com');
  });

  it('falls back to title+author search on Amazon when no ISBN', () => {
    const links = bookLinks(noIsbn);
    const amazon = links.find((l) => l.label === 'Amazon')!;
    expect(amazon.href).toContain('Dune');
    expect(amazon.href).toContain('Frank');
  });

  it('uses ISBN direct URL on Bookshop when present', () => {
    const links = bookLinks(withIsbn, null);
    const shop = links.find((l) => l.label === 'Bookshop.org')!;
    expect(shop.href).toBe('https://bookshop.org/book/9780441013593');
  });

  it('uses search URL on Bookshop when no ISBN', () => {
    const links = bookLinks(noIsbn);
    const shop = links.find((l) => l.label === 'Bookshop.org')!;
    expect(shop.href).toContain('bookshop.org/search');
  });

  it('includes WorldCat link', () => {
    const links = bookLinks(withIsbn);
    const lib = links.find((l) => l.label === 'Library')!;
    expect(lib.href).toContain('worldcat.org');
    expect(lib.href).toContain('9780441013593');
  });

  it('credits the affiliate on a Bookshop ISBN link and marks it', () => {
    const shop = bookLinks(withIsbn, '12345').find((l) => l.label === 'Bookshop.org')!;
    expect(shop).toEqual({
      label: 'Bookshop.org',
      href: 'https://bookshop.org/a/12345/9780441013593',
      affiliate: true,
    });
  });

  it('leaves a Bookshop search and every other link unmarked', () => {
    const links = bookLinks(noIsbn, '12345');
    expect(links.find((l) => l.label === 'Bookshop.org')!.href).toContain('bookshop.org/search');
    expect(links.some((l) => l.affiliate)).toBe(false);
  });
});

describe('bookshopAffiliateId', () => {
  it('reads a plain token and trims it', () => {
    expect(bookshopAffiliateId(' 12345 ')).toBe('12345');
  });

  it('ignores an unset, empty or path-breaking value', () => {
    expect(bookshopAffiliateId(undefined)).toBeNull();
    expect(bookshopAffiliateId('')).toBeNull();
    expect(bookshopAffiliateId('12/../evil')).toBeNull();
    expect(bookshopAffiliateId('a b')).toBeNull();
  });
});
