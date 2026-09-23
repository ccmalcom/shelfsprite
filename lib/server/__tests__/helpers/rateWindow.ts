import { onTestFinished, vi } from 'vitest';

/**
 * Rate limits bucket by clock-aligned windows (lib/server/ratelimit.ts), so a burst that
 * straddles a window boundary resets its count and the expected 429 never comes. Freeze Date one
 * second into the current window for the rest of the test. Only Date is faked, so awaits, timers
 * and PGlite keep running; the real clock comes back when the test finishes.
 */
export function freezeInsideRateWindow(windowSeconds = 60): void {
  const now = Date.now();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now - (now % (windowSeconds * 1000)) + 1000);
  onTestFinished(() => {
    vi.useRealTimers();
  });
}
