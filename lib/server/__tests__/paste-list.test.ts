import { describe, expect, it } from 'vitest';
import {
  authorEchoes,
  isNoiseLine,
  parsePastedList,
  PASTE_MAX_ITEMS,
  splitTitleAuthor,
} from '../pasteList';

const pairs = (text: string) =>
  parsePastedList(text).items.map((i) => [i.title, i.author] as [string, string | null]);

describe('parsePastedList — plain lists', () => {
  it('reads one title per line and skips blank lines', () => {
    expect(pairs('Dune\n\n  Circe  \n\r\nGilead\r\n')).toEqual([
      ['Dune', null],
      ['Circe', null],
      ['Gilead', null],
    ]);
  });

  it('strips bullets, numbering and checkboxes', () => {
    expect(
      pairs(
        [
          '- Dune',
          '* Circe',
          '• Gilead',
          '1. Beloved',
          '12) Piranesi',
          '(3) Hamnet',
          '#4 Educated',
          '[x] Pachinko',
          '- [ ] Normal People',
        ].join('\n')
      ).map(([t]) => t)
    ).toEqual([
      'Dune',
      'Circe',
      'Gilead',
      'Beloved',
      'Piranesi',
      'Hamnet',
      'Educated',
      'Pachinko',
      'Normal People',
    ]);
  });

  it('splits "Title by Author" and "Title - Author"', () => {
    expect(
      pairs(
        [
          'Project Hail Mary by Andy Weir',
          'Circe - Madeline Miller',
          'The Remains of the Day – Kazuo Ishiguro',
          'Gilead, by Marilynne Robinson',
        ].join('\n')
      )
    ).toEqual([
      ['Project Hail Mary', 'Andy Weir'],
      ['Circe', 'Madeline Miller'],
      ['The Remains of the Day', 'Kazuo Ishiguro'],
      ['Gilead', 'Marilynne Robinson'],
    ]);
  });

  it('keeps "by" and dashes that belong to the title', () => {
    expect(splitTitleAuthor('Stand by Me')).toEqual({ title: 'Stand by Me', author: null });
    expect(splitTitleAuthor('Spider-Man - Stan Lee')).toEqual({
      title: 'Spider-Man',
      author: 'Stan Lee',
    });
    expect(splitTitleAuthor('Death by Black Hole by Neil deGrasse Tyson')).toEqual({
      title: 'Death by Black Hole',
      author: 'Neil deGrasse Tyson',
    });
  });

  it('drops format tags and a trailing year so the author still splits off', () => {
    expect(
      pairs(
        [
          'The Martian (Kindle Edition) by Andy Weir',
          'Circe [Audiobook]',
          'Beloved by Toni Morrison (1987)',
          'Dune by Frank Herbert · Audiobook',
        ].join('\n')
      )
    ).toEqual([
      ['The Martian', 'Andy Weir'],
      ['Circe', null],
      ['Beloved', 'Toni Morrison'],
      ['Dune', 'Frank Herbert'],
    ]);
  });

  it('keeps the first named author when several are listed', () => {
    expect(pairs('Good Omens by Terry Pratchett, Neil Gaiman')).toEqual([
      ['Good Omens', 'Terry Pratchett'],
    ]);
  });

  it('skips exact repeats and counts them as skipped', () => {
    const parsed = parsePastedList('Dune\ndune\nDune by Frank Herbert');
    expect(parsed.items.map((i) => [i.title, i.author])).toEqual([
      ['Dune', null],
      ['Dune', 'Frank Herbert'],
    ]);
    expect(parsed.skipped).toBe(1);
  });

  it('records the source line number and raw text', () => {
    const parsed = parsePastedList('\n\n- Circe by Madeline Miller');
    expect(parsed.items[0]).toEqual({
      line: 3,
      raw: '- Circe by Madeline Miller',
      title: 'Circe',
      author: 'Madeline Miller',
    });
  });

  it(`caps at ${PASTE_MAX_ITEMS} titles and counts the rest`, () => {
    const text = Array.from({ length: 230 }, (_, i) => `Book number ${i + 1}`).join('\n');
    const parsed = parsePastedList(text);
    expect(parsed.items).toHaveLength(PASTE_MAX_ITEMS);
    expect(parsed.truncated).toBe(30);
    expect(parsed.items.at(-1)?.title).toBe('Book number 200');
  });
});

describe('parsePastedList — copied library pages', () => {
  it('reads a Kindle library page, skipping its buttons and dates', () => {
    const kindle = [
      'Your Books',
      'Sort by: Recent',
      'Project Hail Mary',
      'Weir, Andy',
      'Acquired on March 3, 2024',
      'Read more',
      'Deliver or Remove from Device',
      'Circe',
      'Acquired on January 14, 2023',
      'Sample',
      '45%',
      'Location 1234 of 5678',
      'Kindle Edition',
      '$9.99',
    ].join('\n');
    const parsed = parsePastedList(kindle);
    // "Weir, Andy" reads like a title here; authorEchoes drops it once matching shows it
    // names the author of the line above.
    expect(parsed.items.map((i) => i.title)).toEqual(['Project Hail Mary', 'Weir, Andy', 'Circe']);
    expect(parsed.skipped).toBe(11);
  });

  it('reads an Audible library page and attaches "By:" lines as authors', () => {
    const audible = [
      'Library',
      'Project Hail Mary',
      'By: Andy Weir',
      'Narrated by: Ray Porter',
      'Length: 16 hrs and 10 mins',
      '10h 23m left',
      'Release date: 05-04-21',
      'Listen now',
      'The Hobbit',
      'Written by: J. R. R. Tolkien',
      'Narrated by: Andy Serkis',
      'Unabridged',
      '4.8 out of 5 stars',
      '(12,345)',
      'Finished',
      'Rate and review',
    ].join('\n');
    expect(pairs(audible)).toEqual([
      ['Project Hail Mary', 'Andy Weir'],
      ['The Hobbit', 'J. R. R. Tolkien'],
    ]);
  });

  it('reads a Libby shelf', () => {
    const libby = [
      'Loans',
      'Pachinko',
      'Min Jin Lee',
      'eBook',
      'Due in 13 days',
      'Expires 11/12/2026',
      'Renew',
      'Return early',
      'The Night Circus',
      'Erin Morgenstern',
      'Audiobook',
      'Borrowed Oct 3, 2026',
    ].join('\n');
    expect(parsePastedList(libby).items.map((i) => i.title)).toEqual([
      'Pachinko',
      'Min Jin Lee',
      'The Night Circus',
      'Erin Morgenstern',
    ]);
  });

  it('does not attach a "By:" line to a title that already has an author', () => {
    expect(pairs('Dune by Frank Herbert\nBy: Somebody Else')).toEqual([['Dune', 'Frank Herbert']]);
  });

  it('keeps titles that start with "By" when there is no colon', () => {
    expect(pairs('By Night in Chile')).toEqual([['By Night in Chile', null]]);
  });
});

describe('isNoiseLine', () => {
  it.each([
    'Read more',
    'READ MORE…',
    'Sample',
    'Buy now with 1-Click',
    'March 3, 2024',
    '3/15/2022',
    '2024-03-03',
    'Purchased on Feb 2, 2021',
    '$12.99',
    'Price: £4.99',
    '9,99 €',
    '1 hr 2 min',
    'Page 123 of 300',
    '45% complete',
    '4.5 out of 5 stars',
    '1,234 ratings',
    'Book 3 of 5',
    '---',
    'x'.repeat(201),
  ])('treats %j as noise', (line) => {
    expect(isNoiseLine(line)).toBe(true);
  });

  it.each(['Dune', 'The 7 1/2 Deaths of Evelyn Hardcastle', 'Fahrenheit 451', 'Hamnet', 'It'])(
    'keeps %j',
    (line) => {
      expect(isNoiseLine(line)).toBe(false);
    }
  );
});

describe('authorEchoes', () => {
  it('drops an unmatched bare-name line that repeats the author of the title above it', () => {
    const items = [
      { title: 'Project Hail Mary', author: null },
      { title: 'Andy Weir', author: null },
      { title: 'Circe', author: null },
      { title: 'Somebody Else', author: null },
    ];
    const echoes = authorEchoes(
      items,
      ['Andy Weir', null, 'Madeline Miller', null],
      new Set([1, 3])
    );
    expect([...echoes]).toEqual([1]);
  });

  it("recognizes Kindle's surname-first form", () => {
    const items = [
      { title: 'Project Hail Mary', author: null },
      { title: 'Weir, Andy', author: null },
    ];
    expect([...authorEchoes(items, ['Andy Weir', null], new Set([1]))]).toEqual([1]);
  });

  it('ignores accents and punctuation, and never drops a matched line', () => {
    const items = [
      { title: 'Jane Eyre', author: null },
      { title: 'Charlotte Bronte', author: null },
      { title: 'Rebecca', author: null },
      { title: 'Daphne du Maurier', author: null },
    ];
    expect([
      ...authorEchoes(
        items,
        ['Charlotte Brontë', null, 'Daphne du Maurier', 'Daphne du Maurier'],
        new Set([1])
      ),
    ]).toEqual([1]);
  });
});
