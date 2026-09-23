import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { POST as importRoute } from '../../../app/api/screen/import/route';
import { GET as getScreen, PUT as putScreen } from '../../../app/api/settings/screen/route';
import { _setDbForTests, schema, type Db } from '../db';
import { _setDispatchForTests } from '../enrichmentDispatch';
import { letterboxdZip } from './fixtures/letterboxd';
import { makeTestDb } from './helpers/pglite';
import { freezeInsideRateWindow } from './helpers/rateWindow';

let db: Db;
let close: () => Promise<void>;
let scheduled: number;
beforeEach(async () => {
  ({ db, close } = await makeTestDb());
  _setDbForTests(db);
  scheduled = 0;
  _setDispatchForTests({ schedule: () => void (scheduled += 1) });
  vi.stubEnv('CRON_SECRET', 'test-cron-secret');
});
afterEach(async () => {
  _setDispatchForTests(null);
  vi.unstubAllEnvs();
  _setDbForTests(null);
  await close();
});

function upload(filename: string, contents: BlobPart): Request {
  const form = new FormData();
  form.set('file', new File([contents], filename, { type: 'application/zip' }));
  return new Request('http://test/api/screen/import', { method: 'POST', body: form });
}

function put(body: unknown): Request {
  return new Request('http://test/api/settings/screen', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/screen/import', () => {
  test('imports the synthetic export, enables screen, and reports counts', async () => {
    const res = await importRoute(upload('letterboxd-export.ZIP', letterboxdZip()));
    expect(res.status).toBe(200);
    const first = await res.json();
    expect(first).toEqual({
      inserted: 6,
      updated: 0,
      unchanged: 0,
      job: expect.objectContaining({ status: 'pending', progress: 0, total: 0 }),
    });
    const state = await (await getScreen(new Request('http://test/api/settings/screen'))).json();
    expect(state).toEqual({ enabled: true, toggled_at: expect.any(String), title_count: 6 });
    const again = await importRoute(upload('letterboxd-export.zip', letterboxdZip()));
    const second = await again.json();
    expect(second).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 6,
      job: expect.objectContaining({ status: 'pending', progress: 0, total: 0 }),
    });
    expect(second.job.job_id).toBe(first.job.job_id); // the active screen job is reused
    expect(scheduled).toBe(1);
    const jobs = await db.select().from(schema.enrichJobs);
    expect(jobs.map((j) => [j.kind, j.userId])).toEqual([['screen', 'local']]);
  });

  test('rejects a missing file, a non-zip name, an oversize body, and a non-Letterboxd zip', async () => {
    const missing = await importRoute(
      new Request('http://test/api/screen/import', { method: 'POST', body: new FormData() })
    );
    expect({ status: missing.status, body: await missing.json() }).toEqual({
      status: 422,
      body: {
        detail: [{ type: 'missing', loc: ['body', 'file'], msg: 'Field required', input: null }],
      },
    });
    const wrongName = await importRoute(upload('export.csv', 'x'));
    expect({ status: wrongName.status, body: await wrongName.json() }).toEqual({
      status: 422,
      body: { detail: 'Uploaded file must be a .zip' },
    });
    const oversize = await importRoute(
      new Request('http://test/api/screen/import', {
        method: 'POST',
        headers: { 'content-length': String(10 * 1024 * 1024 + 1) },
        body: new FormData(),
      })
    );
    expect({ status: oversize.status, body: await oversize.json() }).toEqual({
      status: 413,
      body: { detail: 'Uploaded ZIP exceeds the 10 MiB limit.' },
    });
    const other = await importRoute(upload('photos.zip', letterboxdZip({ 'a.jpg': 'x' })));
    expect(other.status).toBe(422);
    expect(await db.select().from(schema.titles)).toEqual([]);
    const state = await (await getScreen(new Request('http://test/api/settings/screen'))).json();
    expect(state.enabled).toBe(false); // a failed import never enables screen
    expect(await db.select().from(schema.enrichJobs)).toEqual([]); // a failed import queues nothing
  });

  test('is rate limited per user', async () => {
    freezeInsideRateWindow();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push((await importRoute(upload('e.zip', letterboxdZip()))).status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });

  test("never touches another user's titles", async () => {
    await db.insert(schema.titles).values({
      userId: 'other',
      mediaType: 'movie',
      title: 'The Lantern Keeper',
      year: 2019,
      status: 'want',
      letterboxdUri: 'https://boxd.it/aaa1',
    });
    await importRoute(upload('e.zip', letterboxdZip()));
    const other = await db.select().from(schema.titles).where(eq(schema.titles.userId, 'other'));
    expect(other.map((r) => [r.status, r.letterboxdRating])).toEqual([['want', null]]);
  });
});

describe('GET/PUT /api/settings/screen', () => {
  test('defaults to off and toggles with a stamped time', async () => {
    const initial = await getScreen(new Request('http://test/api/settings/screen'));
    expect(await initial.json()).toEqual({ enabled: false, toggled_at: null, title_count: 0 });
    const on = await putScreen(put({ enabled: true }));
    expect(on.status).toBe(200);
    const onBody = await on.json();
    expect(onBody).toEqual({
      enabled: true,
      toggled_at: expect.stringMatching(/T/),
      title_count: 0,
    });
    const off = await (await putScreen(put({ enabled: false }))).json();
    expect(off.enabled).toBe(false);
    const [meta] = await db
      .select()
      .from(schema.profileMeta)
      .where(eq(schema.profileMeta.userId, 'local'));
    expect(meta.rebuildReason).not.toBeNull();
  });

  test('rejects a body without a boolean enabled', async () => {
    for (const body of [{}, { enabled: 'yes' }, { enabled: true, extra: 1 }]) {
      const res = await putScreen(put(body));
      expect({ status: res.status, body: await res.json() }).toEqual({
        status: 422,
        body: { detail: 'enabled must be true or false.' },
      });
    }
  });

  test("reports only the caller's state", async () => {
    await db.insert(schema.userSettings).values({ userId: 'other', screenEnabled: true });
    await db
      .insert(schema.titles)
      .values({ userId: 'other', mediaType: 'movie', title: 'X', status: 'want' });
    const res = await getScreen(new Request('http://test/api/settings/screen'));
    expect(await res.json()).toEqual({ enabled: false, toggled_at: null, title_count: 0 });
  });
});
