import { describe, it, expect } from 'vitest';
import { exportJsonText } from '../export';
import type { schema } from '../db';

describe('JSON export of title-targeted signals (spec §3.6 / §5.9)', () => {
  it('includes target_title_id on every exported signal', () => {
    const signal = {
      id: 1,
      userId: 'local',
      direction: 'more',
      targetKind: 'title',
      targetBookId: null,
      targetTitleId: 7,
      snapshot: null,
      createdAt: '2026-07-01 12:00:00',
    } as typeof schema.tasteSignal.$inferSelect;
    // Wave 4 moves title-targeted signals out of the top-level taste_signals and writes the
    // screen section only when the fourth argument is non-null, so pass an empty one.
    const text = exportJsonText([], [signal], new Date('2026-09-22T00:00:00Z'), {
      titles: [],
      recommendations: [],
    });
    const parsed = JSON.parse(text);
    expect(parsed.taste_signals).toEqual([]);
    expect(parsed.screen.taste_signals[0]).toMatchObject({
      target_kind: 'title',
      target_title_id: 7,
    });
  });
});
