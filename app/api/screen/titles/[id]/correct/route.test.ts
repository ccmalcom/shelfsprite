import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTestDb } from '@/lib/server/__tests__/helpers/pglite';
import { _resetDebugCache } from '@/lib/server/config';
import { _setDbForTests, schema, type Db } from '@/lib/server/db';
import { persistTitleResolution, type ScreenCandidate } from '@/lib/server/screenEnrichment';
import { SCREEN_DISABLED_MESSAGE } from '@/lib/server/screenSettings';
import { POST } from './route';

let db: Db;
let close: () => Promise<void>;

function candidate(overrides: Partial<ScreenCandidate> = {}): ScreenCandidate {
  return {
    media_type: 'movie',
    title: 'Solaris',
    year: 1972,
    wikidata_qid: 'Q10',
    tvmaze_id: null,
    image_url: null,
    description: 'The right film.',
    description_source: 'wikipedia',
    description_url: 'https://en.wikipedia.org/wiki/Solaris_(1972_film)',
    wikipedia_page: 'Solaris (1972 film)',
    genres: ['science fiction film'],
    directors: ['A Director'],
    creators: [],
    writers: [],
    countries: [],
    original_language: 'ru',
    based_on: [{ qid: 'Q11', title: 'Solaris', author: 'A Novelist' }],
    main_subjects: [],
    series: [],
    production_companies: [],
    sitelinks: 50,
    ...overrides,
  };
}

function correct(id: number | string, body: unknown): Promise<Response> {
  return POST(
    new Request(`http://test/api/screen/titles/${id}/correct`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: { id: String(id) } }
  );
}

async function addTitle(values: Partial<typeof schema.titles.$inferInsert> = {}): Promise<number> {
  const [row] = await db
    .insert(schema.titles)
    .values({
      userId: 'local',
      mediaType: 'movie',
      title: 'Solaris',
      year: 1972,
      status: 'watched',
      ...values,
    })
    .returning({ id: schema.titles.id });
  return row.id;
}

async function lowEnrichment(
  titleId: number,
  extra: Partial<typeof schema.titleEnrichment.$inferInsert> = {}
) {
  await db.insert(schema.titleEnrichment).values({
    titleId,
    wikidataQid: 'Q99',
    description: 'The wrong film.',
    resolutionConfidence: 0.3,
    confidenceLabel: 'LOW',
    matchMethod: 'wikidata:ambiguous',
    identitySource: 'auto',
    ...extra,
  });
}

beforeEach(async () => {
  ({ db, close } = await makeTestDb());
  _setDbForTests(db);
  _resetDebugCache();
  await db.insert(schema.userSettings).values({ userId: 'local', screenEnabled: true });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  _setDbForTests(null);
  vi.restoreAllMocks();
  await close();
});

describe('POST /api/screen/titles/[id]/correct', () => {
  it('re-points a LOW title at the pick and stamps enrichment_corrected_at', async () => {
    const id = await addTitle({ appRating: 4 });
    await lowEnrichment(id);
    const response = await correct(id, { candidate: candidate() });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      id,
      title: 'Solaris',
      rating: 4,
      wikidata_qid: 'Q10',
      enrichment: {
        confidence_label: 'CORRECTED',
        resolution_confidence: 1,
        match_method: 'user_correction',
        identity_source: 'corrected',
        description: 'The right film.',
      },
    });
    const [meta] = await db
      .select()
      .from(schema.profileMeta)
      .where(eq(schema.profileMeta.userId, 'local'));
    expect(meta.enrichmentCorrectedAt).not.toBeNull();
  });

  it('corrects a title that has no enrichment row yet', async () => {
    const id = await addTitle();
    expect((await correct(id, { candidate: candidate() })).status).toBe(200);
    const rows = await db.select().from(schema.titleEnrichment);
    expect(rows.map((r) => [r.titleId, r.confidenceLabel])).toEqual([[id, 'CORRECTED']]);
  });

  it('turns a mis-typed movie into a show, and clears a duplicate marker', async () => {
    const id = await addTitle({ title: 'Chernobyl', year: 2019 });
    await lowEnrichment(id, { duplicateOfTitleId: 12345 });
    const pick = candidate({
      media_type: 'tv',
      title: 'Chernobyl',
      year: 2019,
      wikidata_qid: 'Q20',
      tvmaze_id: 39749,
      description_source: 'tvmaze',
      description_url: 'https://www.tvmaze.com/shows/39749/chernobyl',
    });
    const body = await (await correct(id, { candidate: pick })).json();
    expect([body.media_type, body.tvmaze_id, body.wikidata_qid]).toEqual(['tv', 39749, 'Q20']);
    expect(body.enrichment.duplicate_of_title_id).toBeNull();
  });

  it('answers 409 when another of my titles already holds the pick, but not for its own identity', async () => {
    await addTitle({ title: 'Solaris (the other one)', wikidataQid: 'Q10' });
    const id = await addTitle({ year: 2002 });
    const clash = await correct(id, { candidate: candidate() });
    expect({ status: clash.status, body: await clash.json() }).toEqual({
      status: 409,
      body: {
        detail: 'That pick is already in your ScreenSprite library as "Solaris (the other one)".',
      },
    });
    const own = await addTitle({ title: 'Stalker', year: 1979, wikidataQid: 'Q30' });
    expect((await correct(own, { candidate: candidate({ wikidata_qid: 'Q30' }) })).status).toBe(
      200
    );
  });

  it("answers 404 for another user's title and writes nothing", async () => {
    const theirs = await addTitle({ userId: 'other' });
    const response = await correct(theirs, { candidate: candidate() });
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 404,
      body: { detail: `Title ${theirs} not found.` },
    });
    const [row] = await db.select().from(schema.titles).where(eq(schema.titles.id, theirs));
    expect(row.wikidataQid).toBeNull();
    expect(await db.select().from(schema.titleEnrichment)).toEqual([]);
    expect(await db.select().from(schema.profileMeta)).toEqual([]);
  });

  it('rejects a bad id, a pick without its identity, and a disabled account', async () => {
    const id = await addTitle();
    expect((await correct('abc', { candidate: candidate() })).status).toBe(422);
    const noQid = await correct(id, { candidate: candidate({ wikidata_qid: null }) });
    expect({ status: noQid.status, body: await noQid.json() }).toEqual({
      status: 422,
      body: { detail: 'A movie needs its Wikidata id. Pick it from the search results.' },
    });
    await db.update(schema.userSettings).set({ screenEnabled: false });
    const off = await correct(id, { candidate: candidate() });
    expect({ status: off.status, body: await off.json() }).toEqual({
      status: 403,
      body: { detail: SCREEN_DISABLED_MESSAGE },
    });
  });

  it('survives a later background resolution of the same title', async () => {
    const id = await addTitle();
    await lowEnrichment(id);
    await correct(id, { candidate: candidate() });
    await persistTitleResolution(db, id, {
      kind: 'resolved',
      label: 'HIGH',
      method: 'wikidata:exact',
      candidate: candidate({ wikidata_qid: 'Q99', description: 'The wrong film.' }),
      raw: {},
    });
    const [title] = await db.select().from(schema.titles).where(eq(schema.titles.id, id));
    const [enr] = await db
      .select()
      .from(schema.titleEnrichment)
      .where(eq(schema.titleEnrichment.titleId, id));
    expect([title.wikidataQid, enr.confidenceLabel, enr.description]).toEqual([
      'Q10',
      'CORRECTED',
      'The right film.',
    ]);
  });
});
