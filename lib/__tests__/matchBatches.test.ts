import { matchInBatches } from '../matchBatches';
import type { BookMatchResult } from '../api';
import { QUICK_RATE_GENRES, QUICK_RATE_MAX_TILES, quickRatePicks } from '../quickRatePicks';

jest.mock('../api', () => ({ api: { matchBooks: jest.fn() } }));

const items = Array.from({ length: 7 }, (_, i) => ({ title: `Book ${i}`, author: null }));

const matched = (index: number, title: string): BookMatchResult => ({
  index,
  status: 'matched',
  best: {
    source: 'openlibrary',
    catalog_id: title,
    title,
    author: null,
    year: null,
    isbn13: null,
    cover_url: null,
    subjects: null,
    description: null,
    in_library: false,
  },
  alternatives: [],
});

describe('matchInBatches', () => {
  it('sends batches in order and maps batch positions back to input indices', async () => {
    const calls: string[][] = [];
    const match = jest.fn(async (batch: { title: string }[]) => {
      calls.push(batch.map((b) => b.title));
      return { results: batch.map((b, i) => matched(i, b.title)) };
    });
    const progress: number[] = [];
    const results = await matchInBatches(items, 'best', {
      batchSize: 3,
      match,
      onProgress: (r) => progress.push(r.filter(Boolean).length),
    });
    expect(calls).toEqual([
      ['Book 0', 'Book 1', 'Book 2'],
      ['Book 3', 'Book 4', 'Book 5'],
      ['Book 6'],
    ]);
    expect(progress).toEqual([3, 6, 7]);
    expect(results.map((r) => r.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(results.map((r) => r.status === 'matched' && r.best.title)).toEqual(
      items.map((i) => i.title)
    );
  });

  it('sends pending lines again, ahead of the rest of the queue', async () => {
    const calls: string[][] = [];
    let first = true;
    const match = jest.fn(async (batch: { title: string }[]) => {
      calls.push(batch.map((b) => b.title));
      const results = batch.map((b, i): BookMatchResult =>
        first && i > 0 ? { index: i, status: 'pending' } : matched(i, b.title)
      );
      first = false;
      return { results };
    });
    const results = await matchInBatches(items.slice(0, 4), 'best', { batchSize: 3, match });
    expect(calls).toEqual([
      ['Book 0', 'Book 1', 'Book 2'],
      ['Book 1', 'Book 2', 'Book 3'],
    ]);
    expect(results.every((r) => r.status === 'matched')).toBe(true);
  });

  it('gives up on a batch that settles nothing, and on a failed request, so it always ends', async () => {
    const match = jest.fn(async (batch: { title: string }[]) => {
      if (batch[0].title === 'Book 3') throw new Error('429');
      return { results: batch.map((_, i): BookMatchResult => ({ index: i, status: 'pending' })) };
    });
    const results = await matchInBatches(items.slice(0, 5), 'strict', { batchSize: 3, match });
    expect(match).toHaveBeenCalledTimes(2);
    expect(match.mock.calls.map((c) => c[1])).toEqual(['strict', 'strict']);
    expect(results.map((r) => r.status)).toEqual(Array(5).fill('unmatched'));
  });

  it('sends only title and author', async () => {
    const match = jest.fn(async (batch: unknown[]) => ({
      results: batch.map((_, i): BookMatchResult => ({ index: i, status: 'unmatched' })),
    }));
    await matchInBatches(
      [{ title: 'Circe', author: 'Madeline Miller', line: 4, raw: 'x' }] as never,
      'best',
      {
        match,
      }
    );
    expect(match).toHaveBeenCalledWith([{ title: 'Circe', author: 'Madeline Miller' }], 'best');
  });
});

describe('quickRatePicks', () => {
  it('interleaves the chosen genres so each is near the top', () => {
    const picks = quickRatePicks(['scifi', 'romance']);
    expect(picks.slice(0, 4).map((p) => p.title)).toEqual([
      'Dune',
      'Pride and Prejudice',
      'The Left Hand of Darkness',
      'Persuasion',
    ]);
  });

  it('caps the grid and never repeats a title', () => {
    const picks = quickRatePicks(['literary', 'mystery', 'horror']);
    expect(picks).toHaveLength(QUICK_RATE_MAX_TILES);
    expect(new Set(picks.map((p) => `${p.title}|${p.author}`)).size).toBe(picks.length);
  });

  it('gives two genres a grid of 30 to 40 titles', () => {
    for (const a of QUICK_RATE_GENRES) {
      for (const b of QUICK_RATE_GENRES) {
        if (a.id === b.id) continue;
        const n = quickRatePicks([a.id, b.id]).length;
        expect(n).toBeGreaterThanOrEqual(30);
        expect(n).toBeLessThanOrEqual(40);
      }
    }
  });

  it('lists every pick with a title and an author, once per genre', () => {
    for (const g of QUICK_RATE_GENRES) {
      expect(g.picks.every((p) => p.title.trim() && p.author.trim())).toBe(true);
      expect(new Set(g.picks.map((p) => p.title)).size).toBe(g.picks.length);
    }
  });

  it('ignores an unknown genre id', () => {
    expect(quickRatePicks(['nope'])).toEqual([]);
  });
});
