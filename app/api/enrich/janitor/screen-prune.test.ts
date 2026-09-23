import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTestDb } from '@/lib/server/__tests__/helpers/pglite';
import { _resetDebugCache } from '@/lib/server/config';
import { _setDbForTests, type Db } from '@/lib/server/db';
import { catalogCache } from '@/lib/server/schema';
import { GET } from './route';

let db: Db;
let close: () => Promise<void>;
const janitor = () =>
  GET(
    new Request('http://test/api/enrich/janitor', {
      headers: { authorization: 'Bearer test-cron-secret' },
    })
  );

beforeEach(async () => {
  ({ db, close } = await makeTestDb());
  _setDbForTests(db);
  _resetDebugCache();
  vi.stubEnv('CRON_SECRET', 'test-cron-secret');
});

afterEach(async () => {
  _setDbForTests(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await close();
});

describe('GET /api/enrich/janitor screen cache retention', () => {
  it('prunes expired screen rows, keeps book rows, and leaves the body unchanged', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    await db.execute(sql`
      insert into catalog_cache (cache_key, source, payload, fetched_at) values
        ('screen-old', 'screen:wikipedia', '{}'::jsonb, now() - interval '120 days'),
        ('book-old', 'openlibrary', '{}'::jsonb, now() - interval '120 days')
    `);
    const response = await janitor();
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 200,
      body: { examined: 0, rearmed: 0, failed: 0, dispatchFailed: 0 },
    });
    const rows = await db.select({ key: catalogCache.cacheKey }).from(catalogCache);
    expect(rows.map((r) => r.key)).toEqual(['book-old']);
    expect(logs).toHaveBeenCalledWith('screen cache prune', { expired: 1, overflow: 0 });
  });

  it('still answers 200 when the prune fails', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(db, 'execute').mockRejectedValue(new Error('prune boom'));
    const response = await janitor();
    expect(response.status).toBe(200);
    expect(errors).toHaveBeenCalledWith('Screen cache prune failed', expect.any(Error));
  });
});
