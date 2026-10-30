import { api, type BookMatchMode, type BookMatchResult } from '@/lib/api';

/** Lines per POST /books/match request. The server takes up to 25 and budgets its time. */
export const MATCH_BATCH_SIZE = 10;

export interface MatchItemInput {
  title: string;
  author: string | null;
}

type Matcher = typeof api.matchBooks;

/**
 * Match every item in small sequential batches, reporting progress after each. A `pending`
 * result (the server ran out of time) goes back to the front of the queue; a batch that
 * settles nothing, or a request that fails, marks its items unmatched so the loop always
 * ends. Results are returned in input order with `index` set to the input position.
 */
export async function matchInBatches(
  items: MatchItemInput[],
  mode: BookMatchMode,
  opts: {
    batchSize?: number;
    onProgress?: (results: (BookMatchResult | undefined)[]) => void;
    match?: Matcher;
    isCancelled?: () => boolean;
  } = {}
): Promise<BookMatchResult[]> {
  const batchSize = opts.batchSize ?? MATCH_BATCH_SIZE;
  const match = opts.match ?? api.matchBooks;
  const results: (BookMatchResult | undefined)[] = items.map(() => undefined);
  let queue = items.map((_, i) => i);

  while (queue.length > 0) {
    if (opts.isCancelled?.()) break;
    const batch = queue.slice(0, batchSize);
    queue = queue.slice(batchSize);
    let settled = 0;
    let retry: number[] = [];
    try {
      const { results: got } = await match(
        batch.map((i) => ({ title: items[i].title, author: items[i].author })),
        mode
      );
      for (const [pos, r] of got.entries()) {
        const index = batch[pos];
        if (index === undefined) continue;
        if (r.status === 'pending') {
          retry.push(index);
        } else {
          results[index] = { ...r, index };
          settled++;
        }
      }
      // Anything the response left out counts as pending too.
      retry = batch.filter((i) => results[i] === undefined);
    } catch {
      retry = [];
      for (const index of batch) results[index] = { index, status: 'unmatched' };
    }
    if (retry.length > 0) {
      if (settled === 0) {
        for (const index of retry) results[index] = { index, status: 'unmatched' };
      } else {
        queue = [...retry, ...queue];
      }
    }
    opts.onProgress?.([...results]);
  }
  return results.map((r, index) => r ?? { index, status: 'unmatched' });
}
