import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test, expect } from 'vitest';
import { makeTestDb } from './helpers/pglite';
import { setupTestEnv } from './helpers/testEnv';
import { fakeClaude } from './helpers/fakeClaude';
import { seedScreenLibrary } from './helpers/screenRecFixtures';
import {
  REC_SEEDS,
  replayPort,
  runRecommendSet,
  type CandidateSummary,
  type RecObserved,
  type RecordedPort,
} from './fixtures/screen/recommend-set';
import { schema } from '../db';
import { POPULARITY_MIN_SITELINKS } from '../screenSparql';
import { runScreenRecommend } from '../screenRecommendRun';
import { normalizeTitleKey } from '../titles';

const fixture = JSON.parse(
  readFileSync(path.join(__dirname, 'fixtures', 'screen', 'recommend-port.json'), 'utf8')
) as { observed: RecObserved; recorded: RecordedPort };

const OPEN = { remainingMs: () => 600_000 };
const OWNED_QIDS = ['Q134773', 'Q171048'];
const OWNED_KEYS = [normalizeTitleKey('Arrival', 2016), normalizeTitleKey('Severance', 2022)];

async function replayed(): Promise<RecObserved> {
  const { db, close } = await makeTestDb();
  try {
    await seedScreenLibrary(db);
    return await runRecommendSet(db, replayPort(fixture.recorded), OPEN);
  } finally {
    await close();
  }
}

function all(o: RecObserved): CandidateSummary[] {
  return [...o.both, ...o.movie, ...o.tv];
}

describe('screen Stage 1 against recorded catalog answers', () => {
  test('replays to exactly what the live run observed', async () => {
    expect(await replayed()).toEqual(fixture.observed);
  });

  test('every filter surfaces candidates, within the cap', () => {
    for (const list of Object.values(fixture.observed)) {
      expect(list.length).toBeGreaterThan(0);
      expect(list.length).toBeLessThanOrEqual(60);
    }
  });

  test('the media filter holds', () => {
    expect(fixture.observed.movie.every((c) => c.media_type === 'movie')).toBe(true);
    expect(fixture.observed.tv.every((c) => c.media_type === 'tv')).toBe(true);
  });

  test('owned titles never come back, by QID, TVmaze id, or title and year', () => {
    for (const c of all(fixture.observed)) {
      expect(OWNED_QIDS).not.toContain(c.qid);
      expect(c.tvmaze_id).not.toBe(44778);
      expect(OWNED_KEYS).not.toContain(normalizeTitleKey(c.title, c.year));
    }
  });

  test('every TV candidate cross-walks to TVmaze', () => {
    for (const c of all(fixture.observed).filter((c) => c.media_type === 'tv')) {
      expect(typeof c.tvmaze_id).toBe('number');
    }
  });

  test('every candidate clears the popularity floor', () => {
    for (const c of all(fixture.observed)) {
      expect(c.sitelinks).toBeGreaterThanOrEqual(POPULARITY_MIN_SITELINKS);
    }
  });

  test('the adaptation bridge finds a screen adaptation of a loved book', () => {
    expect(
      fixture.observed.both.some(
        (c) => c.retrieval_pool === 'adaptation' || c.retrieval_pool === 'multiple'
      )
    ).toBe(true);
  });
});

describe('runScreenRecommend over the recorded catalog', () => {
  setupTestEnv();

  test('persists a run whose rows are all real retrieved candidates', async () => {
    const { db, close } = await makeTestDb();
    try {
      await seedScreenLibrary(db);
      const client = fakeClaude([
        {
          content: [
            {
              type: 'tool_use',
              name: 'propose_screen_comparables',
              input: { comparables: REC_SEEDS },
            },
          ],
          usage: { input_tokens: 10, output_tokens: 10 },
        },
        {
          content: [
            {
              type: 'tool_use',
              name: 'rank_screen_recommendations',
              input: {
                recommendations: [0, 1, 2].map((i) => ({
                  candidate_index: i,
                  score: 1 - i / 10,
                  rationale: `pick ${i}`,
                  grounded_trait_ids: [1],
                  grounded_book_ids: [1],
                  grounded_title_ids: [],
                })),
              },
            },
          ],
          usage: { input_tokens: 10, output_tokens: 10 },
        },
      ] as never);
      const out = await runScreenRecommend(
        db,
        client,
        'local',
        { mediaFilter: 'both' },
        {
          nowMs: () => 1_000_000,
          abortAfter: () => new AbortController().signal,
          catalog: () => replayPort(fixture.recorded),
        }
      );
      expect(out.run_id).toEqual(expect.any(String));
      const rows = await db.select().from(schema.titleRecommendations);
      expect(rows.length).toBe(Math.min(3, fixture.observed.both.length));
      const known = new Set(fixture.observed.both.map((c) => c.qid));
      for (const r of rows) expect(known.has(r.wikidataQid)).toBe(true);
    } finally {
      await close();
    }
  });
});
