/**
 * @jest-environment jsdom
 */
import { NAV_ROUTES, SCREEN_NAV_ROUTES, navRoutesFor, sectionFor } from '@/lib/nav';

describe('navigation route table', () => {
  it('gives every route exactly one label', () => {
    const byHref = new Map<string, string>();
    for (const r of NAV_ROUTES) {
      expect(byHref.has(r.href)).toBe(false);
      byHref.set(r.href, r.label);
    }
  });

  it('includes Discover', () => {
    expect(NAV_ROUTES.some((r) => r.href === '/discover')).toBe(true);
  });

  it('marks Discover as reachable from the mobile bottom nav', () => {
    expect(NAV_ROUTES.find((r) => r.href === '/discover')!.primary).toBe(true);
  });

  it('keeps the bottom nav within the five-item thumb budget', () => {
    expect(NAV_ROUTES.filter((r) => r.primary)).toHaveLength(5);
  });

  it('gives every route an icon', () => {
    for (const r of NAV_ROUTES) expect(typeof r.Icon).not.toBe('undefined');
  });
});

describe('sectionFor', () => {
  it.each([
    ['/screen', 'screen'],
    ['/screen/library', 'screen'],
    ['/screen/profile', 'screen'],
    ['/', 'books'],
    ['/library', 'books'],
    ['/profile', 'books'],
    ['/screenings', 'books'],
    ['/settings', 'books'],
  ])('%s is the %s section', (path, section) => {
    expect(sectionFor(path)).toBe(section);
  });

  it('treats an unknown pathname as books', () => {
    expect(sectionFor(null)).toBe('books');
  });
});

describe('screen route table', () => {
  it('lists For you, Library and Profile under /screen', () => {
    expect(SCREEN_NAV_ROUTES.filter((r) => r.primary).map((r) => [r.href, r.label])).toEqual([
      ['/screen', 'For you'],
      ['/screen/library', 'Library'],
      ['/screen/profile', 'Profile'],
    ]);
  });

  it('the screen bottom nav stays within the thumb budget', () => {
    expect(SCREEN_NAV_ROUTES.filter((r) => r.primary).length).toBeLessThanOrEqual(5);
  });

  it('gives every screen route one label and an icon', () => {
    const hrefs = SCREEN_NAV_ROUTES.map((r) => r.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const r of SCREEN_NAV_ROUTES) expect(typeof r.Icon).not.toBe('undefined');
  });

  it('picks the table by section', () => {
    expect(navRoutesFor('books')).toBe(NAV_ROUTES);
    expect(navRoutesFor('screen')).toBe(SCREEN_NAV_ROUTES);
  });
});
