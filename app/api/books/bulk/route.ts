import { z } from 'zod';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb } from '@/lib/server/db';
import { addBooks, BULK_ADD_MAX } from '@/lib/server/addBook';

// Each entry is validated by addBooks with POST /api/books's own schema and messages, so a
// bad entry is reported against its index instead of failing the whole request.
const Body = z.object({
  books: z.array(z.unknown()).min(1).max(BULK_ADD_MAX),
});

/**
 * Add the books a reader confirmed on the onboarding review screen. Every book goes through
 * the single-add path (lib/server/addBook.ts), so it is stored exactly as a manual add:
 * same validation, same `MANUAL` enrichment row, same date handling. A book already in the
 * library (or listed twice) is reported in `duplicates` and never inserted.
 */
export const POST = withApi('/api/books/bulk', async (req, ctx) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError(
      422,
      `validation error: ${parsed.error.issues[0]?.message ?? 'invalid body'}`
    );
  }
  const outcome = await addBooks(getDb(), ctx.user.userId, parsed.data.books);
  ctx.timer.mark('db');
  return Response.json(outcome);
});
