import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTestDb } from '@/lib/server/__tests__/helpers/pglite';
import { _resetDebugCache } from '@/lib/server/config';
import { _setDbForTests, schema, type Db } from '@/lib/server/db';
import { SCREEN_DISABLED_MESSAGE } from '@/lib/server/screenSettings';
import { GET } from './route';

let db: Db;
let close: () => Promise<void>;
const active = () => GET(new Request('http://test/api/screen/enrich/active'));

beforeEach(async () => {
  ({ db, close } = await makeTestDb());
  _setDbForTests(db);
  _resetDebugCache();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  _setDbForTests(null);
  vi.restoreAllMocks();
  await close();
});

describe('GET /api/screen/enrich/active', () => {
  it('answers 403 while ScreenSprite is off', async () => {
    const response = await active();
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 403,
      body: { detail: SCREEN_DISABLED_MESSAGE },
    });
  });

  it("returns only the caller's active screen job", async () => {
    await db.insert(schema.userSettings).values({ userId: 'local', screenEnabled: true });
    expect(await (await active()).json()).toEqual({ job: null });
    await db.insert(schema.enrichJobs).values([
      { jobId: 'book', userId: 'local', status: 'running', progress: 0, total: 0 },
      {
        jobId: 'theirs',
        userId: 'other',
        kind: 'screen',
        status: 'running',
        progress: 0,
        total: 0,
      },
      { jobId: 'old', userId: 'local', kind: 'screen', status: 'done', progress: 3, total: 3 },
    ]);
    expect(await (await active()).json()).toEqual({ job: null });
    await db.insert(schema.enrichJobs).values({
      jobId: 'mine',
      userId: 'local',
      kind: 'screen',
      status: 'pending',
      progress: 0,
      total: 0,
    });
    expect(await (await active()).json()).toEqual({
      job: {
        job_id: 'mine',
        status: 'pending',
        progress: 0,
        total: 0,
        error: null,
        started_at: null,
        finished_at: null,
      },
    });
  });
});
