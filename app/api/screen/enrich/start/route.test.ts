import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTestDb } from '@/lib/server/__tests__/helpers/pglite';
import { _resetDebugCache } from '@/lib/server/config';
import { _setDbForTests, schema, type Db } from '@/lib/server/db';
import { _setDispatchForTests } from '@/lib/server/enrichmentDispatch';
import { SCREEN_DISABLED_MESSAGE } from '@/lib/server/screenSettings';

const { runClaimedScreenChunkMock } = vi.hoisted(() => ({ runClaimedScreenChunkMock: vi.fn() }));

vi.mock('@/lib/server/enrichmentJobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/enrichmentJobs')>()),
  runClaimedScreenChunk: runClaimedScreenChunkMock,
}));

import { POST } from './route';

let db: Db;
let close: () => Promise<void>;

function start(body: string | undefined = '{}'): Promise<Response> {
  return POST(
    new Request('http://test/api/screen/enrich/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
  );
}

async function enableScreen(userId = 'local') {
  await db.insert(schema.userSettings).values({ userId, screenEnabled: true });
}

beforeEach(async () => {
  ({ db, close } = await makeTestDb());
  _setDbForTests(db);
  _resetDebugCache();
  _setDispatchForTests({ schedule: () => undefined });
  vi.stubEnv('CRON_SECRET', 'test-cron-secret');
  runClaimedScreenChunkMock.mockReset().mockResolvedValue({
    outcome: 'continued',
    progressBefore: 0,
    progressAfter: 1,
    remaining: 1,
    rearmed: true,
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  _setDbForTests(null);
  _setDispatchForTests(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await close();
});

describe('POST /api/screen/enrich/start', () => {
  it('answers 403 and creates nothing while ScreenSprite is off', async () => {
    const response = await start();
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 403,
      body: { detail: SCREEN_DISABLED_MESSAGE },
    });
    expect(await db.select().from(schema.enrichJobs)).toEqual([]);
  });

  it('rejects a body that is not JSON or has the wrong types', async () => {
    await enableScreen();
    expect((await start('nope')).status).toBe(422);
    expect((await start(JSON.stringify({ force: 'yes' }))).status).toBe(422);
    expect(runClaimedScreenChunkMock).not.toHaveBeenCalled();
  });

  it('creates a screen job, runs one chunk inline and returns the job', async () => {
    await enableScreen();
    const response = await start(JSON.stringify({ force: true }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: 'running', progress: 0, total: 0, error: null });
    const [row] = await db.select().from(schema.enrichJobs);
    expect([row.jobId, row.kind, row.userId, row.force]).toEqual([
      body.job_id,
      'screen',
      'local',
      true,
    ]);
    expect(runClaimedScreenChunkMock).toHaveBeenCalledTimes(1);
  });

  it('is not blocked by an active book job', async () => {
    await enableScreen();
    await db.insert(schema.enrichJobs).values({
      jobId: 'book',
      userId: 'local',
      status: 'running',
      progress: 0,
      total: 0,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const body = await (await start()).json();
    expect(body.job_id).not.toBe('book');
    expect(runClaimedScreenChunkMock).toHaveBeenCalledTimes(1);
  });

  it('is rate limited per user with the normal detail shape', async () => {
    await enableScreen();
    const statuses: number[] = [];
    let last: Response | null = null;
    for (let i = 0; i < 6; i += 1) {
      last = await start();
      statuses.push(last.status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    expect(await last!.json()).toEqual({
      detail: 'Too many enrichment starts. Try again in a minute.',
    });
  });

  it("leaves another user's screen job alone", async () => {
    await enableScreen();
    await db.insert(schema.enrichJobs).values({
      jobId: 'theirs',
      userId: 'other',
      kind: 'screen',
      status: 'pending',
      progress: 0,
      total: 0,
    });
    await start();
    const [theirs] = await db
      .select()
      .from(schema.enrichJobs)
      .where(eq(schema.enrichJobs.jobId, 'theirs'));
    expect([theirs.status, theirs.attempts]).toEqual(['pending', 0]);
  });
});
