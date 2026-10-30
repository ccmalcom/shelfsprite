import { describe, it, expect } from 'vitest';
import { plausibleYear, rankSearchResults, type Candidate } from '../catalog';

/**
 * Unit tests for the add-book search order, on hand-built pools shaped like the ones QA
 * saw: free-text search for "Beloved" put an "Unknown author" entry and a study guide
 * above Toni Morrison's novel.
 */

function cand(over: Partial<Candidate>): Candidate {
  return {
    source: 'googlebooks',
    resolved_id: null,
    title: null,
    author: null,
    subjects: [],
    cover_url: 'https://covers.test/x.jpg',
    year: 2004,
    isbn13: null,
    language: 'en',
    raw: {},
    ...over,
  };
}

const morrison = cand({ title: 'Beloved', author: 'Toni Morrison', year: 2004 });
const unknown = cand({ title: 'Beloved', author: null, year: 2021, isbn13: '9780000000001' });
const unknownNamed = cand({ title: 'Beloved', author: 'Unknown', year: 2022 });
const studyGuide = cand({
  title: 'Beloved: A Study Guide',
  author: 'Gale, Cengage Learning',
  year: 2023,
});
const sparkNotes = cand({ title: 'Beloved (SparkNotes Literature Guide)', author: 'SparkNotes' });
const summary = cand({ title: 'Summary & Analysis of Beloved', author: 'ZIP Reads' });
const boxSet = cand({ title: 'Beloved Box Set: Books 1-3', author: 'Toni Morrison', year: 2024 });
const spanish = cand({ title: 'Beloved', author: 'Toni Morrison', language: 'es', year: 2025 });

describe('rankSearchResults', () => {
  it('ranks the real Beloved first, above an unknown-author entry and study aids', () => {
    const got = rankSearchResults('beloved', [
      unknown,
      studyGuide,
      sparkNotes,
      summary,
      unknownNamed,
      boxSet,
      spanish,
      morrison,
    ]);
    expect(got[0]).toBe(morrison);
  });

  it('puts study guides, summaries and box sets below every clean exact match', () => {
    const got = rankSearchResults('beloved', [studyGuide, sparkNotes, summary, boxSet, morrison]);
    expect(got.slice(1)).toEqual(expect.arrayContaining([studyGuide, sparkNotes, summary, boxSet]));
    expect(got[0]).toBe(morrison);
  });

  it('demotes a foreign edition for an English query', () => {
    const got = rankSearchResults('beloved', [spanish, morrison]);
    expect(got.map((c) => c.language)).toEqual(['en', 'es']);
  });

  it('treats an Open Library work as English when any edition is English', () => {
    const olWork = cand({
      source: 'openlibrary',
      title: 'Beloved',
      author: 'Toni Morrison',
      // normLang keeps only the first listed language, which can be any edition's.
      language: 'fr',
      raw: { language: ['fre', 'eng', 'spa'] },
    });
    const got = rankSearchResults('beloved', [unknown, olWork]);
    expect(got[0]).toBe(olWork);
  });

  it('still prefers the exact title over a merely related one', () => {
    const related = cand({ title: 'Beloved Strangers', author: 'Maria Chaudhuri', year: 2014 });
    const got = rankSearchResults('beloved', [related, morrison]);
    expect(got[0]).toBe(morrison);
  });

  it('keeps a flawed exact match above an unrelated title', () => {
    const unrelated = cand({ title: 'Song of Solomon', author: 'Toni Morrison' });
    const got = rankSearchResults('beloved', [unrelated, unknown]);
    expect(got[0]).toBe(unknown);
  });

  it('does not demote what the query asks for', () => {
    const got = rankSearchResults('beloved study guide', [morrison, studyGuide]);
    expect(got[0]).toBe(studyGuide);
  });

  it('ranks the book above records that append its author to the title', () => {
    const appended = cand({ title: 'Middlemarch George Eliot', author: 'George Eliot' });
    const byLine = cand({ title: 'Middlemarch, by George Eliot', author: 'George Eliot' });
    const notes = cand({ title: 'Middlemarch, George Eliot', author: 'John Peck' });
    const book = cand({ title: 'Middlemarch', author: 'George Eliot', year: 1994 });
    const got = rankSearchResults('middlemarch george eliot', [appended, byLine, notes, book]);
    expect(got[0]).toBe(book);
    // Without the author in the query the book already won; it still does.
    expect(rankSearchResults('middlemarch', [appended, notes, book])[0]).toBe(book);
  });

  it('leaves a title that only ends in an author name alone', () => {
    const film = cand({ title: 'Becoming Jane Austen', author: 'Jon Spence' });
    const pride = cand({ title: 'Pride and Prejudice', author: 'Jane Austen' });
    const got = rankSearchResults('becoming jane austen', [pride, film]);
    expect(got[0]).toBe(film);
  });

  it('breaks ties on a plausible year only, so a bogus future year cannot win', () => {
    const bogus = cand({ title: 'Beloved', author: 'Toni Morrison', year: 3020 });
    const got = rankSearchResults('beloved', [bogus, morrison]);
    expect(got[0]).toBe(morrison);
  });
});

describe('plausibleYear', () => {
  const now = new Date('2026-10-30T12:00:00Z');

  it('keeps years from printing through next year', () => {
    expect(plausibleYear(1450, now)).toBe(1450);
    expect(plausibleYear(1987, now)).toBe(1987);
    expect(plausibleYear(2027, now)).toBe(2027);
  });

  it('rejects years before printing, after next year, and non-years', () => {
    expect(plausibleYear(1449, now)).toBeNull();
    expect(plausibleYear(2028, now)).toBeNull();
    expect(plausibleYear(0, now)).toBeNull();
    expect(plausibleYear(null, now)).toBeNull();
    expect(plausibleYear(1987.5, now)).toBeNull();
  });
});
