import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTestDb } from '@/lib/server/__tests__/helpers/pglite';
import { _resetDebugCache } from '@/lib/server/config';
import { _setDbForTests, type Db } from '@/lib/server/db';
import { enrichJobs } from '@/lib/server/schema';

const { runClaimedChunkMock, runClaimedScreenChunkMock } = vi.hoisted(() => ({
  runClaimedChunkMock: vi.fn(),
  runClaimedScreenChunkMock: vi.fn(),
}));

vi.mock('@/lib/server/enrichmentJobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/enrichmentJobs')>()),
  runClaimedChunk: runClaimedChunkMock,
  runClaimedScreenChunk: runClaimedScreenChunkMock,
}));

import { POST } from './route';

let db: Db;
let close: () => Promise<void>;

const done = { outcome: 'done', progressBefore: 0, progressAfter: 1, remaining: 0, rearmed: false };

function tick(jobId: string): Promise<Response> {
  return POST(
    new Request('http://test/api/enrich/tick', {
      method: 'POST',
      headers: { authorization: 'Bearer test-cron-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ job_id: jobId }),
    })
  );
}

beforeEach(async () => {
  ({ db, close } = await makeTestDb());
  _setDbForTests(db);
  _resetDebugCache();
  vi.stubEnv('CRON_SECRET', 'test-cron-secret');
  runClaimedChunkMock.mockReset().mockResolvedValue(done);
  runClaimedScreenChunkMock.mockReset().mockResolvedValue(done);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  _setDbForTests(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await close();
});

describe('POST /api/enrich/tick dispatches on kind', () => {
  it('runs the screen chunk for a screen job and never the book chunk', async () => {
    await db.insert(enrichJobs).values({
      jobId: 'screen-1',
      userId: 'owner',
      kind: 'screen',
      status: 'pending',
      progress: 0,
      total: 0,
    });
    const response = await tick('screen-1');
    expect(await response.json()).toEqual({ claimed: true, outcome: 'done' });
    expect(runClaimedChunkMock).not.toHaveBeenCalled();
    expect(runClaimedScreenChunkMock.mock.calls).toEqual([
      [
        expect.anything(),
        expect.objectContaining({ jobId: 'screen-1', kind: 'screen', userId: 'owner' }),
        expect.objectContaining({ runBatch: expect.any(Function), dispatch: expect.any(Function) }),
      ],
    ]);
  });

  it('runs the book chunk for a book job and never the screen chunk', async () => {
    await db.insert(enrichJobs).values({
      jobId: 'book-1',
      userId: 'owner',
      status: 'pending',
      progress: 0,
      total: 0,
    });
    await tick('book-1');
    expect(runClaimedScreenChunkMock).not.toHaveBeenCalled();
    expect(runClaimedChunkMock).toHaveBeenCalledTimes(1);
  });
});
