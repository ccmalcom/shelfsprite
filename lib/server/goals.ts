/**
 * Reading goals: the goal vocabulary, the counting rules, and the year card's
 * statistics. Progress is ALWAYS derived by recounting persisted rows -- there is
 * no stored counter and there must never be one (see the design spec, §3).
 *
 * Everything except loadReadRows is pure and takes rows, so the rules are testable
 * without a database.
 */
import { and, asc, eq } from 'drizzle-orm';
import { schema, type Db } from './db';
import { subjectHits } from './recFilters';
import { pyTitle, todayIsoDate } from './serialize';

export const GOAL_KINDS = ['books', 'genre', 'new_authors', 'pages'] as const;
export type GoalKind = (typeof GOAL_KINDS)[number];

/** Cap mirrors app/api/profile/highlights/route.ts -- only a book's first 8 subjects count. */
const SUBJECTS_PER_BOOK = 8;
const TOP_N = 5;
const SUGGESTION_LIMIT = 30;

/** One read-shelf book of one user, plus its enrichment subjects. */
export interface GoalRow {
  book: { author: string | null; dateRead: string | null; pageCount: number | null };
  subjects: string[] | null;
}

export interface GoalDef {
  year: number;
  kind: GoalKind;
  subject: string | null;
  target: number;
}

export interface GoalCount {
  progress: number;
  unknown: number;
}

export interface GoalOut {
  id: number;
  year: number;
  kind: GoalKind;
  subject: string | null;
  target: number;
  progress: number;
  unknown: number;
  done: boolean;
}

export interface YearStats {
  books: number;
  pages: number;
  unknown_pages: number;
  authors: number;
  new_authors: number;
  undated: number;
  top_genres: { subject: string; count: number }[];
  top_authors: { author: string; count: number }[];
}

export function currentYear(): number {
  return Number(todayIsoDate().slice(0, 4));
}

/** ISO date strings compare lexicographically, which is why these are plain string tests. */
function inYear(dateRead: string | null, year: number): boolean {
  return dateRead !== null && dateRead.slice(0, 4) === String(year);
}

function beforeYear(dateRead: string | null, year: number): boolean {
  return dateRead !== null && dateRead < `${year}-01-01`;
}

/** Authors with at least one read book dated before `year`. */
function priorAuthors(rows: GoalRow[], year: number): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    if (beforeYear(r.book.dateRead, year) && r.book.author) out.add(r.book.author);
  }
  return out;
}

function countNewAuthors(rows: GoalRow[], year: number): number {
  const prior = priorAuthors(rows, year);
  const fresh = new Set<string>();
  for (const r of rows) {
    if (!inYear(r.book.dateRead, year)) continue;
    const a = r.book.author;
    if (!a || prior.has(a)) continue;
    fresh.add(a);
  }
  return fresh.size;
}

/**
 * Subject -> number of books. Each subject counts once per book, and only a book's
 * first 8 subjects are considered. Insertion order is preserved, so the stable sort
 * in the callers breaks ties by first-seen -- matching the highlights route.
 */
function subjectCounts(rows: GoalRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const seen = new Set<string>();
    for (const raw of (r.subjects ?? []).slice(0, SUBJECTS_PER_BOOK)) {
      const subject = pyTitle(String(raw).trim());
      if (!subject || seen.has(subject)) continue;
      seen.add(subject);
      counts.set(subject, (counts.get(subject) ?? 0) + 1);
    }
  }
  return counts;
}

export function countForGoal(rows: GoalRow[], goal: GoalDef): GoalCount {
  const inPeriod = rows.filter((r) => inYear(r.book.dateRead, goal.year));

  switch (goal.kind) {
    case 'books':
      return { progress: inPeriod.length, unknown: 0 };

    case 'genre': {
      const term = (goal.subject ?? '').toLowerCase();
      if (!term) return { progress: 0, unknown: 0 };
      const n = inPeriod.filter((r) =>
        (r.subjects ?? []).some((s) => subjectHits(term, String(s).toLowerCase()))
      ).length;
      return { progress: n, unknown: 0 };
    }

    case 'new_authors':
      return { progress: countNewAuthors(rows, goal.year), unknown: 0 };

    case 'pages': {
      let pages = 0;
      let unknown = 0;
      for (const r of inPeriod) {
        if (r.book.pageCount === null) unknown += 1;
        else pages += r.book.pageCount;
      }
      return { progress: pages, unknown };
    }
  }
}

export function goalOut(row: typeof schema.readingGoals.$inferSelect, count: GoalCount): GoalOut {
  return {
    id: row.id,
    year: row.year,
    kind: row.kind as GoalKind,
    subject: row.subject,
    target: row.target,
    progress: count.progress,
    unknown: count.unknown,
    done: count.progress >= row.target,
  };
}

/** Goal-creation suggestions: the user's own subject vocabulary, every year included. */
export function topSubjects(rows: GoalRow[], limit = SUGGESTION_LIMIT): string[] {
  return [...subjectCounts(rows).entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([subject]) => subject);
}

export function yearStats(rows: GoalRow[], year: number): YearStats {
  const inPeriod = rows.filter((r) => inYear(r.book.dateRead, year));

  let pages = 0;
  let unknownPages = 0;
  const authorCounts = new Map<string, number>();
  for (const r of inPeriod) {
    if (r.book.pageCount === null) unknownPages += 1;
    else pages += r.book.pageCount;
    const a = r.book.author;
    if (a) authorCounts.set(a, (authorCounts.get(a) ?? 0) + 1);
  }

  return {
    books: inPeriod.length,
    pages,
    unknown_pages: unknownPages,
    authors: authorCounts.size,
    new_authors: countNewAuthors(rows, year),
    // Not year-scoped on purpose: an undated book has no year to be scoped to.
    undated: rows.filter((r) => r.book.dateRead === null).length,
    top_genres: [...subjectCounts(inPeriod).entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_N)
      .map(([subject, count]) => ({ subject, count })),
    top_authors: [...authorCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_N)
      .map(([author, count]) => ({ author, count })),
  };
}

/** The one db-touching export: every read-shelf book of one user, with its subjects. */
export async function loadReadRows(db: Db, userId: string): Promise<GoalRow[]> {
  const rows = await db
    .select({ book: schema.books, enrichment: schema.enrichment })
    .from(schema.books)
    .leftJoin(schema.enrichment, eq(schema.enrichment.bookId, schema.books.id))
    .where(and(eq(schema.books.userId, userId), eq(schema.books.exclusiveShelf, 'read')))
    .orderBy(asc(schema.books.id));

  return rows.map((r) => ({
    book: { author: r.book.author, dateRead: r.book.dateRead, pageCount: r.book.pageCount },
    subjects: (r.enrichment?.subjects ?? null) as string[] | null,
  }));
}
