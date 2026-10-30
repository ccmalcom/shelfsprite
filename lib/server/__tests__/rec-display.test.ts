import { describe, expect, test } from 'vitest';
import { cardChips, cardYear, plainDescription, plausibleYear } from '../recDisplay';
import { recOut } from '../recs';

describe('cardChips', () => {
  test('turns nyt list tags into one readable label, after the genres', () => {
    expect(
      cardChips([
        'nyt:hardcover-fiction=2020-10-18',
        'nyt:combined-print-and-e-book-nonfiction=2022-07-17',
        'Fiction, literary',
      ])
    ).toEqual(['Literary fiction', 'NYT bestseller']);
  });

  test('drops Library of Congress headings and catalog noise', () => {
    expect(
      cardChips([
        'Suicide victims',
        'Adult child abuse victims',
        'Deckard, Rick (Fictitious character) -- Fiction',
        'Ethan Frome (Wharton, Edith)',
        'Science fiction, history and criticism',
        'collection:otherwise_tiptree_award=honor',
        'open_syllabus_project',
        'Reading Level-Grade 11',
        'Lesbians',
        'Murder',
        'Indiana',
        'World War, 1914-1918',
        '[document]',
      ])
    ).toEqual([]);
  });

  test('maps catalog genre spellings to one label each, in first-seen order', () => {
    expect(
      cardChips([
        'FICTION / Science Fiction / Space Opera',
        'Fiction, science fiction, hard science fiction',
        'Science fiction',
        'Fiction, Romance, Historical, Regency',
        'Classic Literature',
        'True Crime',
        42,
      ])
    ).toEqual([
      'Science fiction',
      'Space opera',
      'Romance',
      'Historical fiction',
      'Classics',
      'True crime',
    ]);
  });

  test('fiction-only genres need a fiction subject', () => {
    expect(cardChips(['Criminal courts', 'Historical'])).toEqual([]);
    expect(cardChips(['Fiction, crime'])).toEqual(['Crime fiction']);
  });

  test('tolerates null and caps the list', () => {
    expect(cardChips(null)).toEqual([]);
    expect(
      cardChips(['Fantasy', 'Horror', 'Mystery', 'Thriller', 'Romance', 'Gothic', 'Poetry'])
    ).toHaveLength(6);
  });
});

describe('plainDescription', () => {
  test('strips Open Library markdown and its trailing edition metadata', () => {
    const raw =
      'Set against the **bleak** winter landscape of _Starkfield_, Massachusetts, ' +
      '*Ethan Frome* is a [novel](https://example.org/x) of passion ([source][1])\r\n\r\n' +
      '----------\r\n**Contained in:**\r\n[Ethan Frome and Other Stories][2]\r\n\r\n' +
      '  [1]: https://example.org/source\r\n  [2]: https://openlibrary.org/works/OL1W';
    expect(plainDescription(raw)).toBe(
      'Set against the bleak winter landscape of Starkfield, Massachusetts, Ethan Frome is a novel of passion'
    );
  });

  test('strips HTML and decodes entities without producing markup', () => {
    expect(
      plainDescription(
        '<p><b>Tess</b> Durbeyfield &amp; her family.</p><p>A&nbsp;novel &#8212; 1891<br/>Penguin</p>'
      )
    ).toBe('Tess Durbeyfield & her family. A novel — 1891 Penguin');
    // Decoded text stays text: the card renders it as a text node, never as HTML.
    expect(plainDescription('a &lt;script&gt; tag')).toBe('a <script> tag');
  });

  test('keeps snake_case words and lone asterisks intact; empty becomes null', () => {
    expect(plainDescription('rated 5 * 3 stars, file_name here')).toBe(
      'rated 5 * 3 stars, file_name here'
    );
    expect(plainDescription('  <p></p> ')).toBeNull();
    expect(plainDescription(null)).toBeNull();
  });
});

describe('year', () => {
  const now = new Date('2026-10-30T00:00:00Z');

  test('plausibleYear spans printing to next year', () => {
    expect(plausibleYear(1450, now)).toBe(true);
    expect(plausibleYear(2027, now)).toBe(true);
    expect(plausibleYear(1449, now)).toBe(false);
    expect(plausibleYear(2028, now)).toBe(false);
    expect(plausibleYear(0, now)).toBe(false);
    expect(plausibleYear(1891.5, now)).toBe(false);
    expect(plausibleYear(null, now)).toBe(false);
  });

  test('a stated first-publication year beats a mis-dated catalog year', () => {
    expect(cardYear(1707, "Hardy's novel, first published in 1891, follows Tess.", now)).toBe(1891);
    expect(cardYear(1707, 'Originally published in 1891.', now)).toBe(1891);
  });

  test('falls back to the catalog year, and drops an implausible one', () => {
    expect(cardYear(2003, 'No dates here.', now)).toBe(2003);
    expect(cardYear(201, null, now)).toBeNull();
    expect(cardYear(9999, null, now)).toBeNull();
    expect(cardYear(1950, 'first published in 0012', now)).toBe(1950);
    expect(cardYear(null, undefined, now)).toBeNull();
  });
});

describe('recOut', () => {
  test('serializes the card view of the raw catalog fields', () => {
    const out = recOut({
      id: 1,
      userId: 'local',
      runId: 'abc',
      rank: 1,
      title: 'Ethan Frome',
      author: 'Edith Wharton',
      year: 1,
      isbn13: null,
      coverUrl: null,
      subjects: ['nyt:hardcover-fiction=2020-10-18', 'Suicide victims', 'Classics'],
      catalogSource: 'openlibrary',
      catalogId: '/works/OL1W',
      retrievalPool: 'metadata',
      seedReason: null,
      score: 0.9,
      rationale: null,
      groundedTraitIds: [],
      groundedBookIds: [],
      status: 'served',
      userNote: null,
      createdAt: '2026-10-30 00:00:00',
      description: '**A** novel.',
      rejectReasons: null,
    });
    expect(out.subjects).toEqual(['Classics', 'NYT bestseller']);
    expect(out.description).toBe('A novel.');
    expect(out.year).toBeNull();
  });
});
