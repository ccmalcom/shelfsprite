import { and, eq, isNull } from 'drizzle-orm';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { catalogDescription } from '@/lib/server/catalog';
import { parseIdParam } from '@/lib/server/serialize';

/**
 * Lazily backfill one book's description.
 *
 * A to-read book is unrated, and enrichmentJobs.candidateRows filters unrated books
 * out of every run, so nothing in the background ever fills these in. Adds made
 * before POST /books started persisting `description` therefore have a permanently
 * empty blurb. The detail modal asks here when it has no description to show; the
 * work is one cached catalog read against a match we already resolved, so it costs
 * nothing on the second open.
 *
 * Never an error path: a book with no catalog match, or a catalog with no blurb,
 * answers 200 with a null description.
 */
export const GET = withApi('/api/books/[id]/description', async (_req, ctx) => {
  const bookId = parseIdParam(ctx.params.id);
  const db = getDb();
  const rows = await db
    .select({ book: schema.books, enrichment: schema.enrichment })
    .from(schema.books)
    .leftJoin(schema.enrichment, eq(schema.enrichment.bookId, schema.books.id))
    .where(and(eq(schema.books.id, bookId), eq(schema.books.userId, ctx.user.userId)));
  const row = rows[0];
  if (!row) throw new ApiError(404, `Book ${bookId} not found.`);
  ctx.timer.mark('db');

  const existing = row.enrichment;
  if (existing?.description) return Response.json({ description: existing.description });
  if (!existing) return Response.json({ description: null });

  const description = await catalogDescription(db, existing.resolvedSource, existing.resolvedId);
  ctx.timer.mark('catalog');
  if (!description) return Response.json({ description: null });

  // Scoped to the still-empty row: a concurrent enrichment or user correction that
  // landed a description while we were fetching must win over this backfill.
  await db
    .update(schema.enrichment)
    .set({ description })
    .where(and(eq(schema.enrichment.bookId, bookId), isNull(schema.enrichment.description)));
  return Response.json({ description });
});
