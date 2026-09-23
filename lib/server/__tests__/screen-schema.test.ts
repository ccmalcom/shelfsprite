import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { schema, type Db } from '../db';
import { makeTestDb } from './helpers/pglite';

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await makeTestDb());
});
afterEach(async () => {
  await close();
});

function errorText(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    parts.push(current.message);
    current = current.cause;
  }
  return parts.join(' | ');
}

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return errorText(error);
  }
  return 'accepted';
}

const base = {
  userId: 'local',
  mediaType: 'movie',
  title: 'The Lantern Keeper',
  status: 'watched',
} as const;

describe('titles', () => {
  test('ratings are numbers on the half grid and 0 is rejected', async () => {
    await db.insert(schema.titles).values({ ...base, letterboxdRating: 4.5, appRating: 0.5 });
    const [row] = await db.select().from(schema.titles);
    expect(row.letterboxdRating).toBe(4.5);
    expect(typeof row.letterboxdRating).toBe('number');
    expect(row.appRating).toBe(0.5);
    expect(
      await failure(db.insert(schema.titles).values({ ...base, letterboxdRating: 0 }))
    ).toContain('ck_titles_letterboxd_rating_half_step');
    expect(await failure(db.insert(schema.titles).values({ ...base, appRating: 0 }))).toContain(
      'ck_titles_app_rating_half_step'
    );
    expect(await failure(db.insert(schema.titles).values({ ...base, appRating: 4.3 }))).toContain(
      'ck_titles_app_rating_half_step'
    );
    expect(await failure(db.insert(schema.titles).values({ ...base, appRating: 5.5 }))).toContain(
      'ck_titles_app_rating_half_step'
    );
  });

  test('media type and status are closed vocabularies', async () => {
    expect(
      await failure(db.insert(schema.titles).values({ ...base, mediaType: 'book' }))
    ).toContain('ck_titles_media_type');
    expect(await failure(db.insert(schema.titles).values({ ...base, status: 'read' }))).toContain(
      'ck_titles_status'
    );
    for (const status of ['watched', 'watching', 'dropped', 'want']) {
      await db.insert(schema.titles).values({ ...base, status });
    }
    await db.insert(schema.titles).values({ ...base, mediaType: 'tv' });
  });

  test('identity columns are unique per user only when present', async () => {
    await db.insert(schema.titles).values([base, base]);
    await db
      .insert(schema.titles)
      .values({ ...base, wikidataQid: 'Q1', tvmazeId: 7, letterboxdUri: 'https://boxd.it/a' });
    await db.insert(schema.titles).values({
      ...base,
      userId: 'other',
      wikidataQid: 'Q1',
      tvmazeId: 7,
      letterboxdUri: 'https://boxd.it/a',
    });
    expect(
      await failure(db.insert(schema.titles).values({ ...base, wikidataQid: 'Q1' }))
    ).toContain('uq_titles_user_wikidata_qid');
    expect(await failure(db.insert(schema.titles).values({ ...base, tvmazeId: 7 }))).toContain(
      'uq_titles_user_tvmaze_id'
    );
    expect(
      await failure(
        db.insert(schema.titles).values({ ...base, letterboxdUri: 'https://boxd.it/a' })
      )
    ).toContain('uq_titles_user_letterboxd_uri');
  });

  test('booleans default false and created_at is stamped', async () => {
    const [row] = await db.insert(schema.titles).values(base).returning();
    expect(row.isFavorite).toBe(false);
    expect(row.excludeFromProfile).toBe(false);
    expect(row.createdAt).toEqual(expect.any(String));
    expect(row.updatedAt).toBeNull();
  });
});

describe('title_enrichment', () => {
  test('requires an existing title, one row per title, identity_source defaults to auto', async () => {
    expect(
      await failure(
        db.insert(schema.titleEnrichment).values({ titleId: 999, resolutionConfidence: 0 })
      )
    ).toContain('title_enrichment_title_id_fkey');
    const [title] = await db.insert(schema.titles).values(base).returning();
    const [enr] = await db
      .insert(schema.titleEnrichment)
      .values({ titleId: title.id, resolutionConfidence: 0.95, genres: ['drama film'] })
      .returning();
    expect(enr.identitySource).toBe('auto');
    expect(enr.genres).toEqual(['drama film']);
    expect(
      await failure(
        db.insert(schema.titleEnrichment).values({ titleId: title.id, resolutionConfidence: 0 })
      )
    ).toContain('ix_title_enrichment_title_id');
  });
});

describe('title_recommendations', () => {
  test('stores a served row with json evidence', async () => {
    const [row] = await db
      .insert(schema.titleRecommendations)
      .values({
        userId: 'local',
        runId: 'run-1',
        rank: 1,
        mediaType: 'movie',
        mediaFilter: 'both',
        title: 'Glass Orchard',
        score: 0.8,
        status: 'served',
        groundedTitleIds: [1, 2],
      })
      .returning();
    expect(row.groundedTitleIds).toEqual([1, 2]);
  });
});

describe('enrich_jobs.kind', () => {
  const job = (jobId: string, kind?: string, status = 'running') => ({
    jobId,
    userId: 'local',
    status,
    progress: 0,
    total: 0,
    ...(kind ? { kind } : {}),
  });

  test('defaults to books and allows one active job per (user, kind)', async () => {
    await db.insert(schema.enrichJobs).values(job('b1'));
    const [row] = await db
      .select()
      .from(schema.enrichJobs)
      .where(eq(schema.enrichJobs.jobId, 'b1'));
    expect(row.kind).toBe('books');
    await db.insert(schema.enrichJobs).values(job('s1', 'screen'));
    const second = await failure(db.insert(schema.enrichJobs).values(job('b2')));
    // enrichmentJobs.isActiveUserViolation matches this substring; the new name must keep it.
    expect(second).toContain('uq_enrich_jobs_active_user_kind');
    expect(second).toContain('uq_enrich_jobs_active_user');
    await db.insert(schema.enrichJobs).values(job('b3', 'books', 'done'));
    await db.insert(schema.enrichJobs).values({ ...job('b4'), userId: 'other' });
  });
});

describe('additive columns on existing tables', () => {
  test('default to off / null', async () => {
    const [settings] = await db.insert(schema.userSettings).values({ userId: 'local' }).returning();
    expect(settings.screenEnabled).toBe(false);
    expect(settings.screenToggledAt).toBeNull();
    const [trait] = await db
      .insert(schema.tasteTraits)
      .values({
        userId: 'local',
        claim: 'c',
        polarity: 'reward',
        inferenceConfidence: 1,
        status: 'proposed',
      })
      .returning();
    expect(trait.exhibitTitleIds).toBeNull();
    expect(trait.contrastTitleIds).toBeNull();
    const [signal] = await db
      .insert(schema.tasteSignal)
      .values({ userId: 'local', direction: 'more', targetKind: 'book' })
      .returning();
    expect(signal.targetTitleId).toBeNull();
  });
});
