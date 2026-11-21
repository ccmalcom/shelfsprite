/**
 * "Pick my next read" (POST /api/next-read): rank the reader's own to-read shelf against
 * their taste and explain the top picks. Ephemeral like /similar and /discover: nothing is
 * persisted, and no catalog request is made, because every candidate is a book the reader
 * already saved. Claude ranks the list; it cannot add to it (indices are validated here).
 *
 * No profile gate: unlike POST /recommend this does not refuse a stale profile, because the
 * shelf is already chosen and loved books alone are enough evidence to order it. It does need
 * some evidence, though (a loved book or a trait), or the ranking would be a guess.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { trackedToolCall } from './anthropic';
import { bookOut } from './books';
import { toolInput, type ClaudeClient } from './claude';
import { RECOMMEND_NO_KEY_MESSAGE } from './claudeErrors';
import { schema, type Db } from './db';
import { ApiError } from './errors';
import {
  NEXT_READ_MAX_TOKENS,
  NEXT_READ_SYSTEM,
  NEXT_READ_TOOL,
  buildNextReadPrompt,
  type NextReadCandidate,
} from './nextReadPrompts';
import { rankModel } from './recPrompts';
import { buildSignal } from './recSignal';
import { round2 } from './serialize';

/** The newest-saved books past this count are left out of the prompt (and said so). */
export const NEXT_READ_MAX_CANDIDATES = 150;

export const NEXT_READ_EMPTY_MESSAGE = 'Your to-read shelf is empty. Save a few books to it first.';

export const NEXT_READ_NO_EVIDENCE_MESSAGE =
  "Rate a few books you've read first, so there's something to weigh your to-read shelf against.";

export async function runNextRead(
  db: Db,
  client: ClaudeClient | null,
  userId: string,
  n: number
): Promise<Record<string, unknown>> {
  const rows = await db
    .select({ b: schema.books, enr: schema.enrichment })
    .from(schema.books)
    // enrichment.book_id is UNIQUE, so the join is 1:1.
    .leftJoin(schema.enrichment, eq(schema.enrichment.bookId, schema.books.id))
    .where(and(eq(schema.books.userId, userId), eq(schema.books.exclusiveShelf, 'to-read')))
    .orderBy(sql`${schema.books.dateAdded} desc nulls last`, desc(schema.books.id));

  if (rows.length === 0) throw new ApiError(400, NEXT_READ_EMPTY_MESSAGE);

  const signal = await buildSignal(db, userId);
  if (signal.loved.length === 0 && signal.traits.length === 0) {
    throw new ApiError(400, NEXT_READ_NO_EVIDENCE_MESSAGE);
  }
  if (!client) throw new ApiError(400, RECOMMEND_NO_KEY_MESSAGE);

  const shelf = rows.slice(0, NEXT_READ_MAX_CANDIDATES);
  const candidates: NextReadCandidate[] = shelf.map(({ b, enr }) => ({
    title: b.title,
    author: b.author,
    year: b.yearPublished,
    subjects: ((enr?.subjects as string[] | null) ?? []) as string[],
    series: enr?.series ?? null,
    description: enr?.description ?? null,
    page_count: b.pageCount,
    date_added: b.dateAdded,
  }));
  const want = Math.min(n, shelf.length);
  const model = rankModel();

  const message = await trackedToolCall(
    client,
    db,
    { userId, operation: 'next_read_rank' },
    {
      model,
      max_tokens: NEXT_READ_MAX_TOKENS,
      system: NEXT_READ_SYSTEM,
      tools: [NEXT_READ_TOOL],
      tool_choice: { type: 'tool', name: NEXT_READ_TOOL.name },
      messages: [{ role: 'user', content: buildNextReadPrompt(candidates, signal, want) }],
    }
  );

  const input = toolInput(message as any, NEXT_READ_TOOL.name);
  const raw = (input?.picks as Array<Record<string, unknown>> | undefined) ?? [];

  const picks: Array<{ idx: number; score: number; rationale: string }> = [];
  const seen = new Set<number>();
  for (const r of raw) {
    const idx = r.candidate_index;
    // Anything not on the shelf, or cited twice, is dropped: Claude cannot add a book.
    if (
      typeof idx !== 'number' ||
      !Number.isInteger(idx) ||
      idx < 0 ||
      idx >= shelf.length ||
      seen.has(idx)
    ) {
      continue;
    }
    seen.add(idx);
    const score = Number(r.score ?? 0);
    picks.push({
      idx,
      score: Number.isFinite(score) ? score : 0,
      rationale: String(r.rationale ?? '').trim(),
    });
  }
  // Stable: equal scores keep Claude's own best-first order.
  picks.sort((a, b) => b.score - a.score);

  const out = picks.slice(0, want).map((p, i) => ({
    rank: i + 1,
    score: round2(p.score),
    rationale: p.rationale,
    book: bookOut(shelf[p.idx].b, shelf[p.idx].enr),
  }));

  return {
    count: out.length,
    to_read_count: rows.length,
    considered: shelf.length,
    model,
    picks: out,
  };
}
