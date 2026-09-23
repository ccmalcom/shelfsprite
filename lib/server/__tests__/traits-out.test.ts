import { describe, it, expect } from 'vitest';
import { traitOut, type TraitRow } from '../traits';

const base: TraitRow = {
  id: 1,
  userId: 'local',
  claim: 'A.',
  polarity: 'reward',
  exhibits: [1],
  contrasts: null,
  inferenceConfidence: 0.5,
  status: 'proposed',
  userNote: null,
  createdAt: '2026-07-01 12:00:00',
  userWeight: 1,
  verdictUpdatedAt: null,
  revealLine: null,
  exhibitTitleIds: null,
  contrastTitleIds: null,
};

describe('traitOut title evidence', () => {
  it('always emits title id arrays, empty when the column is null', () => {
    const out = traitOut(base);
    expect(out.exhibit_title_ids).toEqual([]);
    expect(out.contrast_title_ids).toEqual([]);
    const keys = Object.keys(out);
    expect(keys.indexOf('exhibit_title_ids')).toBe(keys.indexOf('contrasts') + 1);
  });

  it('passes stored title ids through', () => {
    const out = traitOut({ ...base, exhibitTitleIds: [7], contrastTitleIds: [9] });
    expect(out.exhibit_title_ids).toEqual([7]);
    expect(out.contrast_title_ids).toEqual([9]);
  });
});
