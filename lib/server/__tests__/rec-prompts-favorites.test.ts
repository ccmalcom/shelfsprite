import { describe, test, expect } from 'vitest';
import { buildSeedPrompt, userSteeringBlock } from '../recPrompts';
import type { RecSignal } from '../recSignal';

const signal = (constraints: Record<string, unknown>): RecSignal =>
  ({
    library_keys: new Set(),
    library_isbns: new Set(),
    library_languages: new Set(),
    library_authors: new Set(),
    library_titles: [],
    library_series: new Map(),
    loved: [],
    rated_count: 0,
    top_subjects: [],
    top_authors: [],
    traits: [],
    more_like: [],
    less_like: [],
    reject_reason_counts: new Map(),
    rejected_with_notes: [],
    directive_text: null,
    directive_constraints: constraints,
  }) as unknown as RecSignal;

const favorites = {
  prefer_authors: ['Ursula K. Le Guin', 'Gene Wolfe'],
  prefer_subjects: ['space opera', 'translated fiction'],
};

describe('userSteeringBlock', () => {
  test('is byte-identical to today when there are no favorites', () => {
    expect(userSteeringBlock(signal({}))).toBe(
      userSteeringBlock(signal({ exclude_authors: ['john ringo'] }))
    );
    expect(userSteeringBlock(signal({}))).not.toContain('FAVORITE');
  });

  test('renders both blocks with pyJsonDumps and names them in the weighting clause', () => {
    const out = userSteeringBlock(signal(favorites));
    expect(out).toContain(
      'FAVORITE AUTHORS (the reader explicitly marked these as favorites; treat a ' +
        'candidate written by one of them as a strong positive signal):\n' +
        '["Ursula K. Le Guin", "Gene Wolfe"]'
    );
    expect(out).toContain(
      'FAVORITE SUBJECTS (the reader explicitly marked these as favorites; treat a ' +
        'candidate carrying one of them as a strong positive signal):\n' +
        '["space opera", "translated fiction"]'
    );
    expect(out).toContain('reward candidates by a favorite author');
  });

  test('emits only the populated family', () => {
    const out = userSteeringBlock(signal({ prefer_subjects: ['space opera'] }));
    expect(out).toContain('FAVORITE SUBJECTS');
    expect(out).not.toContain('FAVORITE AUTHORS');
  });

  test('places favorites after LESS LIKE and before CUSTOM INSTRUCTIONS', () => {
    const s = signal(favorites);
    s.less_like.push('A Bad Book by Someone');
    s.directive_text = 'No grimdark.';
    const out = userSteeringBlock(s);
    expect(out.indexOf('LESS LIKE')).toBeLessThan(out.indexOf('FAVORITE AUTHORS'));
    expect(out.indexOf('FAVORITE SUBJECTS')).toBeLessThan(out.indexOf('CUSTOM INSTRUCTIONS'));
  });
});

describe('buildSeedPrompt', () => {
  test('is unchanged when there are no favorites', () => {
    const task = buildSeedPrompt(signal({}), 8)[1].text;
    expect(task).not.toContain('marked as favorites');
  });

  test('adds a bias clause per populated family', () => {
    const task = buildSeedPrompt(signal(favorites), 8)[1].text;
    expect(task).toContain(
      ' Favor queries that would surface books by these authors the reader has ' +
        'marked as favorites: ["Ursula K. Le Guin", "Gene Wolfe"].'
    );
    expect(task).toContain(
      ' Favor queries covering these subjects the reader has marked as favorites: ' +
        '["space opera", "translated fiction"].'
    );
  });
});
