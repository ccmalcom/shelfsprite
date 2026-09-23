import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../db';
import { titleEnrichment, titles } from '../schema';
import { makeTestDb } from './helpers/pglite';

const { resolveMovies, refreshMovies, resolveTv } = vi.hoisted(() => ({
  resolveMovies: vi.fn(),
  refreshMovies: vi.fn(),
  resolveTv: vi.fn(),
}));

vi.mock('../screenEnrichment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../screenEnrichment')>()),
  resolveMovies,
  refreshMovies,
  resolveTv,
}));

import { screenEnrichmentRunner } from '../enrichmentJobs';

let db: Db;
let close: () => Promise<void>;
const deadline = { remainingMs: () => 60_000 };

beforeEach(async () => {
  ({ db, close } = await makeTestDb());
  resolveMovies.mockReset();
  refreshMovies.mockReset();
  resolveTv.mockReset();
});

afterEach(async () => {
  await close();
});

describe('screenEnrichmentRunner', () => {
  it('routes auto movies, fixed movies and shows to their resolvers and persists only definite results', async () => {
    const [auto, fixed, show, other] = await db
      .insert(titles)
      .values([
        { userId: 'user-a', mediaType: 'movie', title: 'Heat', year: 1995, status: 'watched' },
        {
          userId: 'user-a',
          mediaType: 'movie',
          title: 'Alien',
          year: 1979,
          status: 'watched',
          wikidataQid: 'Q5',
        },
        {
          userId: 'user-a',
          mediaType: 'tv',
          title: 'Severance',
          year: 2022,
          status: 'watching',
          tvmazeId: 44933,
        },
        { userId: 'user-b', mediaType: 'movie', title: 'Theirs', year: 2000, status: 'watched' },
      ])
      .returning({ id: titles.id });
    await db.insert(titleEnrichment).values({
      titleId: fixed.id,
      wikidataQid: 'Q5',
      resolutionConfidence: 1,
      confidenceLabel: 'CORRECTED',
      identitySource: 'corrected',
    });
    resolveMovies.mockResolvedValue(new Map([[auto.id, { kind: 'unresolved', raw: {} }]]));
    refreshMovies.mockResolvedValue(
      new Map([[fixed.id, { kind: 'deferred', reason: 'HTTP 503' }]])
    );
    resolveTv.mockResolvedValue(new Map([[show.id, { kind: 'refreshed', candidate: null }]]));

    await screenEnrichmentRunner('user-a')(
      db,
      [auto.id, fixed.id, show.id, other.id],
      { force: true, limit: null },
      deadline
    );

    expect(resolveMovies.mock.calls[0][1]).toEqual([{ id: auto.id, title: 'Heat', year: 1995 }]);
    expect(refreshMovies.mock.calls[0][1]).toEqual([{ id: fixed.id, wikidataQid: 'Q5' }]);
    expect(resolveTv.mock.calls[0][1]).toEqual([{ id: show.id, tvmazeId: 44933 }]);
    const rows = await db.select().from(titleEnrichment);
    const byTitle = new Map(rows.map((row) => [row.titleId, row]));
    expect(byTitle.get(auto.id)?.matchMethod).toBe('unresolved');
    expect(byTitle.get(fixed.id)?.confidenceLabel).toBe('CORRECTED'); // deferred: untouched
    expect(byTitle.get(show.id)?.matchMethod).toBe('refresh');
    expect(byTitle.has(other.id)).toBe(false); // another user's id is never read
    const [otherRow] = await db.select().from(titles).where(eq(titles.id, other.id));
    expect(otherRow.wikidataQid).toBeNull();
  });
});
