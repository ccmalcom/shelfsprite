import { getDb } from '@/lib/server/db';
import { withApi } from '@/lib/server/http';
import { missingImportFileResponse, readZipUpload } from '@/lib/server/import-upload';
import { importLetterboxdFilms } from '@/lib/server/importTitles';
import { readLetterboxdZip } from '@/lib/server/letterboxd';
import { checkRateLimit, RATE_LIMITS, rateLimitExceededResponse } from '@/lib/server/ratelimit';

export const runtime = 'nodejs';

/**
 * Letterboxd export import (spec §3.4). The first successful import turns ScreenSprite on in the
 * same transaction (spec §3.1). Wave 5 starts a screen enrichment job here and adds `job`.
 */
export const POST = withApi('/api/screen/import', async (req, ctx) => {
  try {
    const db = getDb();
    const rateLimit = await checkRateLimit(db, {
      key: `screenImport:${ctx.user.userId}`,
      ...RATE_LIMITS.screenImport,
    });
    if (!rateLimit.allowed) {
      return rateLimitExceededResponse(
        RATE_LIMITS.screenImport.limit,
        RATE_LIMITS.screenImport.windowSeconds
      );
    }
    const { bytes } = await readZipUpload(req);
    const { films } = readLetterboxdZip(bytes);
    const counts = await importLetterboxdFilms(db, ctx.user.userId, films);
    ctx.timer.mark('db');
    return Response.json(counts);
  } catch (error) {
    const missing = missingImportFileResponse(error);
    if (missing) return missing;
    throw error;
  }
});
