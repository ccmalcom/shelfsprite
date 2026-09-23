/**
 * Fixture key for a replayed HTTP request. A GET is keyed by its bare URL (exactly as
 * installHttpReplay always did); a request with a body is keyed by method, URL and
 * body, so two SPARQL POSTs to the same endpoint replay different fixtures.
 *
 * Deliberately free of vitest imports: scripts/record-screen-fixtures.ts uses it
 * outside the test runner to write fixtures under the same keys.
 */
export function replayKey(url: string, init?: { method?: string; body?: unknown }): string {
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method === 'GET' || init?.body === undefined || init.body === null) return url;
  return `${method} ${url}\n${String(init.body)}`;
}
