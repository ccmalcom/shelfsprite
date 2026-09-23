import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db';
import { catalogCache } from '../schema';
import {
  SCREEN_CACHE_MAX_AGE_DAYS,
  SCREEN_CACHE_MAX_ROWS,
  pruneScreenCache,
} from '../screenCatalog';
import { makeTestDb } from './helpers/pglite';

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await makeTestDb());
});

afterEach(async () => {
  await close();
});

async function put(key: string, source: string, ageDays: number): Promise<void> {
  await db.execute(sql`
    insert into catalog_cache (cache_key, source, payload, fetched_at)
    values (${key}, ${source}, '{}'::jsonb, now() - make_interval(days => ${ageDays}))
  `);
}

async function keys(): Promise<string[]> {
  const rows = await db.select({ key: catalogCache.cacheKey }).from(catalogCache);
  return rows.map((row) => row.key).sort();
}

describe('pruneScreenCache', () => {
  it('uses the spec bounds by default', () => {
    expect([SCREEN_CACHE_MAX_AGE_DAYS, SCREEN_CACHE_MAX_ROWS]).toEqual([90, 50_000]);
  });

  it('drops screen rows older than the age bound and keeps book rows of any age', async () => {
    await put('screen-old', 'screen:wikidata', 91);
    await put('screen-new', 'screen:tvmaze', 89);
    await put('book-old', 'openlibrary', 400);
    expect(await pruneScreenCache(db)).toEqual({ expired: 1, overflow: 0 });
    expect(await keys()).toEqual(['book-old', 'screen-new']);
  });

  it('keeps only the newest screen rows beyond the count bound', async () => {
    for (const [key, age] of [
      ['s1', 1],
      ['s2', 2],
      ['s3', 3],
      ['s4', 4],
    ] as const) {
      await put(key, 'screen:wdqs', age);
    }
    await put('book', 'googlebooks', 10);
    expect(await pruneScreenCache(db, { maxRows: 2 })).toEqual({ expired: 0, overflow: 2 });
    expect(await keys()).toEqual(['book', 's1', 's2']);
  });

  it('is a no-op on an empty cache', async () => {
    expect(await pruneScreenCache(db)).toEqual({ expired: 0, overflow: 0 });
  });
});
