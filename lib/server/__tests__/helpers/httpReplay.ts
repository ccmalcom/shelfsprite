import { vi } from 'vitest';
import { replayKey } from './replayKey';

export { replayKey };

export interface ReplayEntry {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * Thrown when a test hits a URL with no matching fixture entry. A distinctive
 * (not plain Error) class + `.name` so getJson's retry loop (catalog.ts) can tell
 * "the test harness has no fixture for this URL" apart from a genuine network
 * failure and propagate it immediately instead of retrying it into a silently
 * degraded `null`. catalog.ts duck-types on `.name` rather than importing this
 * class — production code must not depend on a test helper.
 */
export class HttpReplayMissError extends Error {
  constructor(url: string) {
    super(`httpReplay: no fixture for ${url}`);
    this.name = 'HttpReplayMissError';
  }
}

/**
 * Replace global fetch with a fixture-driven stub. Any URL not present in the
 * map throws — a test must never reach the real network. onCall fires per
 * attempted fetch so tests can assert cache hits and retry counts. A request with a body is
 * keyed by `replayKey` (method, URL and body); a GET by its bare URL.
 */
export function installHttpReplay(
  fixtures: Record<string, ReplayEntry>,
  onCall?: (url: string) => void
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    // GET keys stay the bare URL, so every existing fixture still matches.
    const key = replayKey(url, init);
    onCall?.(key);
    const entry = fixtures[key];
    if (!entry) throw new HttpReplayMissError(key);
    return new Response(entry.body === undefined ? null : JSON.stringify(entry.body), {
      status: entry.status,
      headers: { 'content-type': 'application/json', ...(entry.headers ?? {}) },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}
