import { getDb } from '@/lib/server/db';
import { isValidCronSecret, rearmAfterResponse } from '@/lib/server/enrichmentDispatch';
import { repairActiveJobs } from '@/lib/server/enrichmentJobs';
import { ApiError, withApi } from '@/lib/server/http';
import { pruneScreenCache } from '@/lib/server/screenCatalog';

export const GET = withApi(
  '/api/enrich/janitor',
  async (request) => {
    if (!isValidCronSecret(request)) throw new ApiError(401, 'Unauthorized');

    const db = getDb();
    const summary = await repairActiveJobs(db, new Date(), (jobId) => {
      rearmAfterResponse(request, jobId);
    });
    // Spec §4.2: screen cache retention rides the daily janitor. Its result goes to the log so
    // the response body (the job-repair summary) keeps its shape; a failure never fails repair.
    try {
      console.log('screen cache prune', await pruneScreenCache(db));
    } catch (error) {
      console.error('Screen cache prune failed', error);
    }
    return Response.json(summary);
  },
  { requireAuth: false }
);
