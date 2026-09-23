import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db';
import { titleEnrichment, titles } from '../schema';
import {
  mergeTvmaze,
  persistTitleResolution,
  type ScreenCandidate,
  type TitleResolution,
} from '../screenEnrichment';
import { makeTestDb } from './helpers/pglite';

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await makeTestDb());
});

afterEach(async () => {
  await close();
});

async function addTitle(
  values: Partial<typeof titles.$inferInsert> & { title: string }
): Promise<number> {
  const [row] = await db
    .insert(titles)
    .values({ userId: 'user-a', mediaType: 'movie', status: 'watched', year: 2000, ...values })
    .returning({ id: titles.id });
  return row.id;
}

const movie = (qid: string, overrides: Partial<ScreenCandidate> = {}): ScreenCandidate => ({
  ...mergeTvmaze({ id: 1, name: 'x' }, null),
  media_type: 'movie',
  title: `Film ${qid}`,
  year: 2000,
  wikidata_qid: qid,
  tvmaze_id: null,
  description: 'A film.',
  description_source: 'wikipedia',
  description_url: 'https://en.wikipedia.org/wiki/X',
  genres: ['drama film'],
  sitelinks: 12,
  ...overrides,
});

const resolved = (
  candidate: ScreenCandidate,
  label: 'HIGH' | 'MEDIUM' | 'LOW' = 'HIGH'
): TitleResolution => ({
  kind: 'resolved',
  label,
  method: label === 'LOW' ? 'wikidata:ambiguous' : 'wikidata:exact',
  candidate,
  raw: { stage: 'A' },
});

async function titleRow(id: number) {
  return (await db.select().from(titles).where(eq(titles.id, id)))[0];
}

async function enrichmentRow(id: number) {
  return (await db.select().from(titleEnrichment).where(eq(titleEnrichment.titleId, id)))[0];
}

describe('persistTitleResolution', () => {
  it('sets the movie identity and metadata for HIGH, and never touches feedback_updated_at', async () => {
    const id = await addTitle({ title: 'Heat' });
    await persistTitleResolution(db, id, resolved(movie('Q1')));
    expect(await titleRow(id)).toMatchObject({
      mediaType: 'movie',
      wikidataQid: 'Q1',
      tvmazeId: null,
      feedbackUpdatedAt: null,
    });
    expect(await enrichmentRow(id)).toMatchObject({
      wikidataQid: 'Q1',
      confidenceLabel: 'HIGH',
      resolutionConfidence: 0.95,
      matchMethod: 'wikidata:exact',
      identitySource: 'auto',
      duplicateOfTitleId: null,
      genres: ['drama film'],
      sitelinks: 12,
      descriptionSource: 'wikipedia',
    });
  });

  it('sets identity for MEDIUM too', async () => {
    const id = await addTitle({ title: 'Heat' });
    await persistTitleResolution(db, id, resolved(movie('Q1'), 'MEDIUM'));
    expect((await titleRow(id)).wikidataQid).toBe('Q1');
    expect((await enrichmentRow(id)).resolutionConfidence).toBe(0.7);
  });

  it('keeps a LOW pick out of titles, storing it only on the enrichment row', async () => {
    const id = await addTitle({ title: 'Heat' });
    await persistTitleResolution(db, id, resolved(movie('Q1'), 'LOW'));
    expect((await titleRow(id)).wikidataQid).toBeNull();
    expect(await enrichmentRow(id)).toMatchObject({ wikidataQid: 'Q1', confidenceLabel: 'LOW' });
  });

  it('converts a Letterboxd TV entry that resolved to a crosswalked series', async () => {
    const id = await addTitle({ title: 'Tiger King' });
    await persistTitleResolution(
      db,
      id,
      resolved(movie('Q800', { media_type: 'tv', tvmaze_id: 46519 }))
    );
    expect(await titleRow(id)).toMatchObject({
      mediaType: 'tv',
      tvmazeId: 46519,
      wikidataQid: 'Q800',
    });
  });

  it('keeps a TV special a movie', async () => {
    const id = await addTitle({ title: 'Frosty Returns' });
    await persistTitleResolution(db, id, resolved(movie('Q900')));
    expect((await titleRow(id)).mediaType).toBe('movie');
  });

  it('records a movie clash as duplicate_of_title_id instead of violating the unique index', async () => {
    const holder = await addTitle({ title: 'Heat', wikidataQid: 'Q1' });
    const id = await addTitle({ title: 'Heat (1995)' });
    await persistTitleResolution(db, id, resolved(movie('Q1')));
    expect((await titleRow(id)).wikidataQid).toBeNull();
    expect((await enrichmentRow(id)).duplicateOfTitleId).toBe(holder);
  });

  it('records a TV clash when a manually added show already holds the TVmaze id', async () => {
    const holder = await addTitle({ title: 'Tiger King', mediaType: 'tv', tvmazeId: 46519 });
    const id = await addTitle({ title: 'Tiger King' });
    await persistTitleResolution(
      db,
      id,
      resolved(movie('Q800', { media_type: 'tv', tvmaze_id: 46519 }))
    );
    expect(await titleRow(id)).toMatchObject({ mediaType: 'movie', tvmazeId: null });
    expect((await enrichmentRow(id)).duplicateOfTitleId).toBe(holder);
  });

  it('only clashes within the same user', async () => {
    await db.insert(titles).values({
      userId: 'user-b',
      mediaType: 'movie',
      status: 'watched',
      title: 'Heat',
      wikidataQid: 'Q1',
    });
    const id = await addTitle({ title: 'Heat' });
    await persistTitleResolution(db, id, resolved(movie('Q1')));
    expect((await titleRow(id)).wikidataQid).toBe('Q1');
  });

  it('persists a definite no-match in the book unresolved shape and clears an old auto identity', async () => {
    const id = await addTitle({ title: 'Heat', wikidataQid: 'Q1' });
    await persistTitleResolution(db, id, { kind: 'unresolved', raw: { stage: 'B' } });
    expect((await titleRow(id)).wikidataQid).toBeNull();
    expect(await enrichmentRow(id)).toMatchObject({
      confidenceLabel: 'LOW',
      resolutionConfidence: 0,
      matchMethod: 'unresolved',
      wikidataQid: null,
      description: null,
    });
  });

  it('never overwrites a manual or corrected identity with an automatic one', async () => {
    const id = await addTitle({ title: 'Heat', wikidataQid: 'Q5' });
    await db.insert(titleEnrichment).values({
      titleId: id,
      wikidataQid: 'Q5',
      resolutionConfidence: 1,
      confidenceLabel: 'CORRECTED',
      matchMethod: 'user_correction',
      identitySource: 'corrected',
      resolvedAt: '2026-09-20 00:00:00',
    });
    await persistTitleResolution(db, id, resolved(movie('Q6')));
    await persistTitleResolution(db, id, { kind: 'unresolved', raw: {} });
    expect((await titleRow(id)).wikidataQid).toBe('Q5');
    expect(await enrichmentRow(id)).toMatchObject({
      wikidataQid: 'Q5',
      confidenceLabel: 'CORRECTED',
      identitySource: 'corrected',
    });
  });

  it('refreshes metadata for a fixed identity and keeps its label and source', async () => {
    const id = await addTitle({ title: 'Heat', wikidataQid: 'Q5' });
    await db.insert(titleEnrichment).values({
      titleId: id,
      wikidataQid: 'Q5',
      resolutionConfidence: 0.95,
      confidenceLabel: 'HIGH',
      matchMethod: 'manual',
      identitySource: 'manual',
      resolvedAt: '2026-09-20 00:00:00',
    });
    await persistTitleResolution(db, id, {
      kind: 'refreshed',
      candidate: movie('Q5', { genres: ['crime film'] }),
    });
    const row = await enrichmentRow(id);
    expect(row).toMatchObject({
      genres: ['crime film'],
      confidenceLabel: 'HIGH',
      identitySource: 'manual',
      matchMethod: 'manual',
    });
    expect(row.resolvedAt > '2026-09-20 00:00:00').toBe(true);
  });

  it('only advances resolved_at for a refresh whose source item vanished', async () => {
    const id = await addTitle({ title: 'Show', mediaType: 'tv', tvmazeId: 9 });
    await db.insert(titleEnrichment).values({
      titleId: id,
      tvmazeId: 9,
      description: 'kept',
      resolutionConfidence: 0.95,
      confidenceLabel: 'HIGH',
      identitySource: 'manual',
      resolvedAt: '2026-09-20 00:00:00',
    });
    await persistTitleResolution(db, id, { kind: 'refreshed', candidate: null });
    const row = await enrichmentRow(id);
    expect(row.description).toBe('kept');
    expect(row.resolvedAt > '2026-09-20 00:00:00').toBe(true);
  });

  it('skips a title that was deleted after its batch was read', async () => {
    await expect(persistTitleResolution(db, 999, resolved(movie('Q1')))).resolves.toBeUndefined();
    expect(await db.select().from(titleEnrichment)).toEqual([]);
  });

  it('refuses to persist a deferred resolution', async () => {
    const id = await addTitle({ title: 'Heat' });
    await expect(
      persistTitleResolution(db, id, { kind: 'deferred', reason: 'HTTP 503' })
    ).rejects.toThrow(/deferred/);
  });
});
