import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db';
import { _setScreenCatalogHooksForTests, deadlineIn } from '../screenCatalog';
import {
  REPLAY_SHOWS,
  runReplaySet,
  type ReplayObserved,
  type ResolutionSummary,
} from './fixtures/screen/replay-set';
import { installHttpReplay, type ReplayEntry } from './helpers/httpReplay';
import { makeTestDb } from './helpers/pglite';

const fixture = JSON.parse(
  readFileSync(path.join(__dirname, 'fixtures', 'screen', 'resolve-films.json'), 'utf8')
) as {
  recorded_at: string;
  note: string;
  observed: ReplayObserved;
  fixtures: Record<string, ReplayEntry>;
};

let db: Db;
let close: () => Promise<void>;
let restore: () => void;
let observed: ReplayObserved;

beforeAll(async () => {
  ({ db, close } = await makeTestDb());
  _setScreenCatalogHooksForTests({ sleep: async () => undefined });
  restore = installHttpReplay(fixture.fixtures);
  observed = await runReplaySet(db, deadlineIn(600_000));
});

afterAll(async () => {
  restore();
  _setScreenCatalogHooksForTests(null);
  await close();
});

function film(id: number): ResolutionSummary {
  const found = observed.films.find((s) => s.id === id);
  if (!found) throw new Error(`no summary for film ${id}`);
  return found;
}

describe('screen resolution against recorded catalog answers', () => {
  it('replays to exactly what the live run observed', () => {
    expect(observed).toEqual(fixture.observed);
  });

  it('defers nothing: every recorded answer is definite', () => {
    expect([...observed.films, ...observed.shows].filter((s) => s.kind === 'deferred')).toEqual([]);
  });

  it('resolves Forrest Gump through its mul-only label', () => {
    expect(film(1)).toMatchObject({
      kind: 'resolved',
      label: 'HIGH',
      qid: 'Q134773',
      media_type: 'movie',
    });
  });

  it('resolves Toy Story', () => {
    expect(film(2)).toMatchObject({ kind: 'resolved', label: 'HIGH', qid: 'Q171048' });
  });

  it('never labels a title without a year HIGH', () => {
    expect(film(12).label).not.toBe('HIGH');
  });

  it('leaves a title that exists nowhere unresolved', () => {
    expect(film(13).kind).toBe('unresolved');
  });

  it('converts a miniseries logged as a film to a show with a TVmaze id', () => {
    expect(film(11)).toMatchObject({ kind: 'resolved', media_type: 'tv' });
    expect(typeof film(11).tvmaze_id).toBe('number');
  });

  it('refreshes shows by TVmaze id and crosswalks them to Wikidata', () => {
    expect(observed.shows.map((s) => [s.id, s.kind, s.tvmaze_id])).toEqual(
      REPLAY_SHOWS.map((s) => [s.id, 'refreshed', s.tvmazeId])
    );
    for (const show of observed.shows) expect(show.qid).toMatch(/^Q\d+$/);
  });

  it('ranks the queried year first in a movie search', () => {
    expect(observed.movieSearch?.[0]).toMatchObject({ year: 2024 });
  });

  it('finds shows by name', () => {
    expect(observed.showSearch?.[0]?.title).toMatch(/Severance/);
    expect(typeof observed.showSearch?.[0]?.tvmaze_id).toBe('number');
  });
});
