import { describe, expect, it } from 'vitest';
import type { Candidate } from '../catalog';
import { MATCH_FLOOR, matchItems, type MatchOptions } from '../bulkMatch';
import { coldStartProgress, COLD_START_LOVED, COLD_START_RATED } from '../coldStart';
import { COLD_START_LOVED as REC_LOVED, COLD_START_RATED as REC_RATED } from '../recSignal';

function cand(title: string, author: string | null, over: Partial<Candidate> = {}): Candidate {
  return {
    source: 'openlibrary',
    resolved_id: `/works/${title.replace(/\W+/g, '')}`,
    title,
    author,
    subjects: [],
    cover_url: `https://covers.test/${encodeURIComponent(title)}.jpg`,
    year: 2001,
    language: 'en',
    raw: {},
    ...over,
  };
}

/** A fake catalog: query text -> ranked hits, recording every query it was asked. */
function fakeCatalog(table: Record<string, Candidate[]>) {
  const asked: string[] = [];
  const search = async (query: string) => {
    asked.push(query);
    return table[query] ?? [];
  };
  return { search, asked };
}

const base = (search: MatchOptions['search']): MatchOptions => ({
  mode: 'best',
  search,
  library: [],
});

describe('matchItems — best mode (pasted lists)', () => {
  it('returns the top hit with the rest as alternatives', async () => {
    const { search, asked } = fakeCatalog({
      Circe: [
        cand('Circe', 'Madeline Miller'),
        cand('Circe: A Study Guide', 'Course Hero'),
        cand('Circe', 'Unknown'),
      ],
    });
    const [r] = await matchItems([{ title: 'Circe', author: null }], base(search));
    expect(asked).toEqual(['Circe']);
    expect(r).toMatchObject({
      index: 0,
      status: 'matched',
      best: { title: 'Circe', author: 'Madeline Miller', year: 2001, in_library: false },
    });
    if (r.status !== 'matched') throw new Error('expected a match');
    expect(r.alternatives.map((a) => a.author)).toEqual(['Course Hero', 'Unknown']);
  });

  it('searches title and author together and prefers the hit by that author', async () => {
    const { search, asked } = fakeCatalog({
      'Dune Frank Herbert': [cand('Dune', 'Tim O. Sullivan'), cand('Dune', 'Frank Herbert')],
    });
    const [r] = await matchItems([{ title: 'Dune', author: 'Frank Herbert' }], base(search));
    expect(asked).toEqual(['Dune Frank Herbert']);
    expect(r.status === 'matched' && r.best.author).toBe('Frank Herbert');
  });

  it(`reports no match when nothing clears the floor (${MATCH_FLOOR})`, async () => {
    // A bare author name: the catalog answers with that author's books, none titled so.
    const { search } = fakeCatalog({
      'Andy Weir': [cand('The Martian', 'Andy Weir'), cand('Artemis', 'Andy Weir')],
    });
    const [r] = await matchItems([{ title: 'Andy Weir', author: null }], base(search));
    expect(r).toEqual({ index: 0, status: 'unmatched' });
  });

  it('reports no match for an empty answer and for a lookup that throws', async () => {
    const search = async (q: string) => {
      if (q === 'boom') throw new Error('catalog down');
      return [];
    };
    const results = await matchItems(
      [
        { title: 'nothing', author: null },
        { title: 'boom', author: null },
      ],
      base(search)
    );
    expect(results).toEqual([
      { index: 0, status: 'unmatched' },
      { index: 1, status: 'unmatched' },
    ]);
  });

  it('flags hits already in the library by same-work identity', async () => {
    const { search } = fakeCatalog({
      Beloved: [cand('Beloved', 'Toni Morrison'), cand('Beloved: A Novel', 'Toni Morrison')],
      Sula: [cand('Sula', 'Toni Morrison')],
    });
    const results = await matchItems(
      [
        { title: 'Beloved', author: null },
        { title: 'Sula', author: null },
      ],
      { ...base(search), library: [{ title: 'Beloved', author: 'Toni Morrison' }] }
    );
    expect(results.map((r) => r.status === 'matched' && r.best.in_library)).toEqual([true, false]);
    const first = results[0];
    if (first.status !== 'matched') throw new Error('expected a match');
    // "Beloved: A Novel" is the bare title plus a subtitle: the same work.
    expect(first.alternatives[0].in_library).toBe(true);
  });
});

describe('matchItems — strict mode (quick-rate picks)', () => {
  it('accepts only the named title by the named author, with no alternatives', async () => {
    const { search } = fakeCatalog({
      'Rebecca Daphne du Maurier': [
        cand('Rebecca: A Study Guide', 'Gale'),
        cand('Rebecca', 'Daphne du Maurier'),
      ],
      'Dracula Bram Stoker': [cand('Dracula: Summary and Analysis', 'Bram Stoker Notes')],
    });
    const results = await matchItems(
      [
        { title: 'Rebecca', author: 'Daphne du Maurier' },
        { title: 'Dracula', author: 'Bram Stoker' },
      ],
      { ...base(search), mode: 'strict' }
    );
    expect(results[0]).toMatchObject({
      status: 'matched',
      best: { title: 'Rebecca', author: 'Daphne du Maurier' },
      alternatives: [],
    });
    expect(results[1]).toEqual({ index: 1, status: 'unmatched' });
  });
});

describe('matchItems — time budget and concurrency', () => {
  it('starts no lookup after the budget and leaves the rest pending', async () => {
    let clock = 0;
    const asked: string[] = [];
    const search = async (q: string) => {
      asked.push(q);
      clock += 400; // each lookup "takes" 400 ms of the fake clock
      return [cand(q, 'Some Author')];
    };
    const items = Array.from({ length: 6 }, (_, i) => ({ title: `Title ${i}`, author: null }));
    const results = await matchItems(items, {
      ...base(search),
      budgetMs: 1000,
      concurrency: 1,
      now: () => clock,
    });
    // Lookups start at 0, 400 and 800 ms; the fourth would start at 1200, past the budget.
    expect(asked).toEqual(['Title 0', 'Title 1', 'Title 2']);
    expect(results.map((r) => r.status)).toEqual([
      'matched',
      'matched',
      'matched',
      'pending',
      'pending',
      'pending',
    ]);
    expect(results.map((r) => r.index)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('never runs more lookups at once than the concurrency limit, and keeps input order', async () => {
    let inFlight = 0;
    let peak = 0;
    const search = async (q: string) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, q.endsWith('0') ? 15 : 1));
      inFlight--;
      return [cand(q, 'A. Writer')];
    };
    const items = Array.from({ length: 9 }, (_, i) => ({ title: `Book ${i}`, author: null }));
    const results = await matchItems(items, { ...base(search), concurrency: 3 });
    expect(peak).toBe(3);
    expect(results.map((r) => r.status === 'matched' && r.best.title)).toEqual(
      items.map((i) => i.title)
    );
  });
});

describe('coldStartProgress', () => {
  it('is the recommender threshold', () => {
    expect([COLD_START_RATED, COLD_START_LOVED]).toEqual([REC_RATED, REC_LOVED]);
  });

  it('counts rated and loved books and ignores the 0 and null sentinels', () => {
    expect(coldStartProgress([5, 4, 3.5, 0, null, undefined, 4.5])).toEqual({
      rated: 4,
      loved: 3,
      ratedNeeded: COLD_START_RATED - 4,
      lovedNeeded: COLD_START_LOVED - 3,
      done: false,
    });
  });

  it('is done once both thresholds are met', () => {
    const ratings = [...Array(8).fill(4), ...Array(4).fill(2)];
    expect(coldStartProgress(ratings)).toMatchObject({
      ratedNeeded: 0,
      lovedNeeded: 0,
      done: true,
    });
  });
});
