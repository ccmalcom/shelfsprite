import { describe, it, expect } from 'vitest';
import { diffProposedClaims, snapshotProposedClaims, type ProposedClaim } from './profileDiff';
import { makeTestDb } from '@/lib/server/__tests__/helpers/pglite';
import { setupTestEnv } from '@/lib/server/__tests__/helpers/testEnv';
import * as schema from './schema';

setupTestEnv();

const reward = (claim: string): ProposedClaim => ({ claim, polarity: 'reward' });
const aversion = (claim: string): ProposedClaim => ({ claim, polarity: 'aversion' });

describe('diffProposedClaims', () => {
  it('reports no changes when the claim sets match', () => {
    const traits = [reward('Rewards dense prose'), aversion('Avoids military SF')];
    expect(diffProposedClaims(traits, traits)).toEqual({
      added: [],
      dropped: [],
      reworded: [],
      unchanged: 2,
    });
  });

  it('treats claims as unchanged despite case and whitespace differences', () => {
    const before = [reward('Rewards  dense prose')];
    const after = [reward('rewards dense prose')];
    const out = diffProposedClaims(before, after);
    expect(out.unchanged).toBe(1);
    expect(out.added).toEqual([]);
    expect(out.dropped).toEqual([]);
  });

  it('lists a purely added claim', () => {
    const before = [reward('Rewards dense prose')];
    const after = [reward('Rewards dense prose'), reward('Rewards novellas')];
    const out = diffProposedClaims(before, after);
    expect(out.added).toEqual(['Rewards novellas']);
    expect(out.dropped).toEqual([]);
    expect(out.reworded).toEqual([]);
    expect(out.unchanged).toBe(1);
  });

  it('lists a purely dropped claim', () => {
    const before = [reward('Rewards dense prose'), reward('Rewards novellas')];
    const after = [reward('Rewards dense prose')];
    const out = diffProposedClaims(before, after);
    expect(out.added).toEqual([]);
    expect(out.dropped).toEqual(['Rewards novellas']);
    expect(out.unchanged).toBe(1);
  });

  it('pairs a suffix extension as a reword rather than a drop plus an add', () => {
    const before = [aversion('Avoids military SF')];
    const after = [aversion("Avoids military SF unless it's satirical")];
    const out = diffProposedClaims(before, after);
    expect(out.reworded).toEqual([
      { from: 'Avoids military SF', to: "Avoids military SF unless it's satirical" },
    ]);
    expect(out.added).toEqual([]);
    expect(out.dropped).toEqual([]);
  });

  it('pairs a mid-sentence rewrite that clears the ratio threshold', () => {
    const before = [reward('Rewards morally grey protagonists')];
    const after = [reward('Rewards morally ambiguous protagonists')];
    const out = diffProposedClaims(before, after);
    expect(out.reworded).toEqual([
      { from: 'Rewards morally grey protagonists', to: 'Rewards morally ambiguous protagonists' },
    ]);
  });

  it('does NOT pair two genuinely different claims below the threshold', () => {
    const before = [aversion('Avoids series fiction')];
    const after = [aversion('Avoids second-person narration')];
    const out = diffProposedClaims(before, after);
    expect(out.reworded).toEqual([]);
    expect(out.dropped).toEqual(['Avoids series fiction']);
    expect(out.added).toEqual(['Avoids second-person narration']);
  });

  it('does NOT pair a polarity flip, even though it clears the threshold', () => {
    const before = [reward('Rewards military SF')];
    const after = [aversion('Avoids military SF')];
    const out = diffProposedClaims(before, after);
    expect(out.reworded).toEqual([]);
    expect(out.dropped).toEqual(['Rewards military SF']);
    expect(out.added).toEqual(['Avoids military SF']);
  });

  it('pairs each claim at most once, taking the best score first', () => {
    const before = [reward('Rewards dense allusive prose')];
    const after = [
      reward('Rewards dense allusive prose in translation'),
      reward('Rewards dense, allusive prose'),
    ];
    const out = diffProposedClaims(before, after);
    // The whole-word extension scores 1.0, so it wins the single `before` claim.
    expect(out.reworded).toEqual([
      { from: 'Rewards dense allusive prose', to: 'Rewards dense allusive prose in translation' },
    ]);
    expect(out.added).toEqual(['Rewards dense, allusive prose']);
    expect(out.dropped).toEqual([]);
  });

  it('handles a first build, where everything is added', () => {
    const out = diffProposedClaims([], [reward('Rewards dense prose')]);
    expect(out.added).toEqual(['Rewards dense prose']);
    expect(out.dropped).toEqual([]);
    expect(out.reworded).toEqual([]);
    expect(out.unchanged).toBe(0);
  });

  it('collapses duplicate claims within a snapshot', () => {
    const before = [reward('Rewards dense prose'), reward('Rewards dense prose')];
    const after = [reward('Rewards dense prose')];
    const out = diffProposedClaims(before, after);
    expect(out.unchanged).toBe(1);
    expect(out.dropped).toEqual([]);
  });
});

describe('snapshotProposedClaims', () => {
  it('filters to the given user and status = proposed only', async () => {
    const { db, close } = await makeTestDb();
    try {
      await db.insert(schema.tasteTraits).values([
        {
          userId: 'local',
          status: 'proposed',
          claim: 'A',
          polarity: 'reward',
          inferenceConfidence: 0.8,
        },
        {
          userId: 'local',
          status: 'confirmed',
          claim: 'B',
          polarity: 'reward',
          inferenceConfidence: 0.8,
        },
        {
          userId: 'local',
          status: 'rejected',
          claim: 'C',
          polarity: 'reward',
          inferenceConfidence: 0.8,
        },
        {
          userId: 'other-user',
          status: 'proposed',
          claim: 'D',
          polarity: 'reward',
          inferenceConfidence: 0.8,
        },
      ]);

      const out = await snapshotProposedClaims(db, 'local');
      expect(out).toEqual([{ claim: 'A', polarity: 'reward' }]);
      expect(out).toHaveLength(1);
    } finally {
      await close();
    }
  });
});
