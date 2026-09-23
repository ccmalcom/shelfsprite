import { getDb } from '@/lib/server/db';
import { ApiError, withApi } from '@/lib/server/http';
import { missingImportFileResponse, readZipUpload } from '@/lib/server/import-upload';
import { importLetterboxdFilms } from '@/lib/server/importTitles';
import { readLetterboxdZip } from '@/lib/server/letterboxd';
import { checkRateLimit, RATE_LIMITS } from '@/lib/server/ratelimit';
import { queueScreenEnrichment } from '@/lib/server/screenJobs';

export const runtime = 'nodejs';

/**
 * Letterboxd export import (spec §3.4). The first successful import turns ScreenSprite on in the
 * same transaction (spec §3.1). It then queues the screen enrichment job and returns it as `job`.
 */
export const POST = withApi('/api/screen/import', async (req, ctx) => {
  try {
    const db = getDb();
    const rateLimit = await checkRateLimit(db, {
      key: `screenImport:${ctx.user.userId}`,
      ...RATE_LIMITS.screenImport,
    });
    if (!rateLimit.allowed) {
      throw new ApiError(429, 'Too many imports. Try again in a minute.');
    }
    const { bytes } = await readZipUpload(req);
    const { films } = readLetterboxdZip(bytes);
    const counts = await importLetterboxdFilms(db, ctx.user.userId, films);
    // Spec §3.4 "After import": queue the screen job; its first chunk runs after the response
    // (design decision 11). An active screen job is reused and picks up the new titles itself.
    const job = await queueScreenEnrichment(db, req, ctx.user.userId);
    ctx.timer.mark('db');
    return Response.json({ ...counts, job });
  } catch (error) {
    const missing = missingImportFileResponse(error);
    if (missing) return missing;
    throw error;
  }
});
