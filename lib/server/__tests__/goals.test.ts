import { describe, it, expect } from 'vitest';
import { countForGoal, yearStats, topSubjects, type GoalRow } from '../goals';

function row(
  dateRead: string | null,
  opts: { author?: string | null; pages?: number | null; subjects?: string[] | null } = {}
): GoalRow {
  return {
    book: {
      author: opts.author === undefined ? 'Author A' : opts.author,
      dateRead,
      pageCount: opts.pages === undefined ? 300 : opts.pages,
    },
    subjects: opts.subjects === undefined ? ['Fiction'] : opts.subjects,
  };
}

const def = (over: Partial<Parameters<typeof countForGoal>[1]> = {}) => ({
  year: 2026,
  kind: 'books' as const,
  subject: null,
  target: 10,
  ...over,
});

describe('countForGoal — books', () => {
  it('counts only books dated inside the year', () => {
    const rows = [row('2026-01-01'), row('2026-12-31'), row('2025-12-31'), row('2027-01-01')];
    expect(countForGoal(rows, def())).toEqual({ progress: 2, unknown: 0 });
  });

  it('ignores a read book with no date', () => {
    expect(countForGoal([row(null), row('2026-05-05')], def())).toEqual({
      progress: 1,
      unknown: 0,
    });
  });
});

describe('countForGoal — genre', () => {
  const genre = def({ kind: 'genre', subject: 'History' });

  it('matches a subject case-insensitively', () => {
    const rows = [row('2026-03-01', { subjects: ['history'] })];
    expect(countForGoal(rows, genre).progress).toBe(1);
  });

  it('matches on a whole word inside a longer subject', () => {
    const rows = [row('2026-03-01', { subjects: ['Art history'] })];
    expect(countForGoal(rows, genre).progress).toBe(1);
  });

  it('does not match a substring that is not a whole word', () => {
    const rows = [row('2026-03-01', { subjects: ['Historiography'] })];
    expect(countForGoal(rows, genre).progress).toBe(0);
  });

  it('counts a book once even when several subjects match', () => {
    const rows = [row('2026-03-01', { subjects: ['History', 'Art history'] })];
    expect(countForGoal(rows, genre).progress).toBe(1);
  });

  it('skips books with no enrichment subjects', () => {
    const rows = [row('2026-03-01', { subjects: null }), row('2026-04-01', { subjects: [] })];
    expect(countForGoal(rows, genre).progress).toBe(0);
  });
});

describe('countForGoal — new_authors', () => {
  const na = def({ kind: 'new_authors' });

  it('counts an author never read before the year', () => {
    const rows = [row('2026-02-01', { author: 'Chiang' })];
    expect(countForGoal(rows, na).progress).toBe(1);
  });

  it('does not count an author first read in a prior year', () => {
    const rows = [
      row('2019-02-01', { author: 'Le Guin' }),
      row('2026-02-01', { author: 'Le Guin' }),
    ];
    expect(countForGoal(rows, na).progress).toBe(0);
  });

  it('counts two books by the same new author once', () => {
    const rows = [row('2026-02-01', { author: 'Chiang' }), row('2026-06-01', { author: 'Chiang' })];
    expect(countForGoal(rows, na).progress).toBe(1);
  });

  it('skips books with a null author', () => {
    expect(countForGoal([row('2026-02-01', { author: null })], na).progress).toBe(0);
  });
});

describe('countForGoal — pages', () => {
  it('sums page counts and reports unknowns separately', () => {
    const rows = [
      row('2026-01-01', { pages: 300 }),
      row('2026-02-01', { pages: 120 }),
      row('2026-03-01', { pages: null }),
      row('2025-01-01', { pages: 999 }),
    ];
    expect(countForGoal(rows, def({ kind: 'pages', target: 1000 }))).toEqual({
      progress: 420,
      unknown: 1,
    });
  });
});

describe('yearStats', () => {
  const rows = [
    row('2026-01-01', { author: 'Le Guin', pages: 300, subjects: ['Fiction', 'Science fiction'] }),
    row('2026-02-01', { author: 'Le Guin', pages: null, subjects: ['Fiction'] }),
    row('2026-03-01', { author: 'Chiang', pages: 250, subjects: ['Fiction'] }),
    row('2019-01-01', { author: 'Le Guin', pages: 400, subjects: ['Fiction'] }),
    row(null, { author: 'Nobody', pages: 100, subjects: ['History'] }),
  ];

  it('counts books, pages, unknown pages and authors for the year only', () => {
    const s = yearStats(rows, 2026);
    expect(s.books).toBe(3);
    expect(s.pages).toBe(550);
    expect(s.unknown_pages).toBe(1);
    expect(s.authors).toBe(2);
  });

  it('agrees with the new_authors goal kind on identical input', () => {
    expect(yearStats(rows, 2026).new_authors).toBe(
      countForGoal(rows, def({ kind: 'new_authors' })).progress
    );
  });

  it('counts each subject once per book, most common first', () => {
    expect(yearStats(rows, 2026).top_genres).toEqual([
      { subject: 'Fiction', count: 3 },
      { subject: 'Science Fiction', count: 1 },
    ]);
  });

  it('ranks authors by books read in the year', () => {
    expect(yearStats(rows, 2026).top_authors[0]).toEqual({ author: 'Le Guin', count: 2 });
  });

  it('counts undated read books from every year, ignoring the requested year', () => {
    expect(yearStats(rows, 2026).undated).toBe(1);
    expect(yearStats(rows, 2019).undated).toBe(1);
  });

  it('returns zeroed stats for a year with no dated reads', () => {
    const s = yearStats(rows, 2030);
    expect(s.books).toBe(0);
    expect(s.top_genres).toEqual([]);
    expect(s.top_authors).toEqual([]);
  });
});

describe('topSubjects', () => {
  it('ranks normalized subjects across every read book, not just one year', () => {
    const rows = [
      row('2026-01-01', { subjects: ['fiction'] }),
      row('2019-01-01', { subjects: ['FICTION', 'history'] }),
    ];
    expect(topSubjects(rows, 10)).toEqual(['Fiction', 'History']);
  });
});
