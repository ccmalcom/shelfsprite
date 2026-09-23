import { describe, it, expect } from 'vitest';
import {
  buildScreenProfilePrompt,
  buildScreenUpdatePrompt,
  SCREEN_PROFILE_SYSTEM,
  SCREEN_PROFILE_TOOL,
  SCREEN_REVISE_SYSTEM,
  SCREEN_REVISE_TOOL,
  SCREEN_TRAIT_INPUT_SCHEMA,
} from '../screenProfilePrompts';
import { PROFILE_SYSTEM, PROFILE_TOOL, TRAIT_INPUT_SCHEMA } from '../profileBuild';
import { REVISE_SYSTEM } from '../profileUpdate';
import { pyFloat } from '../serialize';
import type { ScreenTierBuild } from '../screenTiers';
import type { Tiers } from '../profileTiers';

const KEYS = ['5', '4.5', '4', '3.5', '3', '<=2', 'dropped', 'rejected'];

function counts(over: Record<string, number> = {}): Map<string, number> {
  return new Map(KEYS.map((k) => [k, over[k] ?? 0]));
}

function build(): ScreenTierBuild {
  const movie: Tiers = new Map(KEYS.map((k) => [k, [] as Record<string, unknown>[]]));
  movie.get('5')!.push({ id: 7, type: 'movie', title: 'Arrival', year: 2016 });
  const tv: Tiers = new Map(KEYS.map((k) => [k, [] as Record<string, unknown>[]]));
  return {
    tiers: new Map([
      ['movie', movie],
      ['tv', tv],
    ]),
    sent: new Map([
      ['movie', counts({ '5': 1 })],
      ['tv', counts()],
    ]),
    total: new Map([
      ['movie', counts({ '5': 4 })],
      ['tv', counts()],
    ]),
  };
}

const bookTiers: Tiers = new Map([
  ['5', [{ id: 1, title: 'Dune' }]],
  ['4.5', []],
  ['4', []],
  ['3.5', []],
  ['3', []],
  ['<=2', []],
  ['dnf', []],
  ['rejected', []],
]);

describe('screen tools', () => {
  it('keep the book tool names but add the title evidence fields', () => {
    expect(SCREEN_PROFILE_TOOL.name).toBe('record_taste_traits');
    expect(SCREEN_REVISE_TOOL.name).toBe('revise_taste_traits');
    const item = SCREEN_TRAIT_INPUT_SCHEMA.properties.traits.items;
    expect(item.required).toEqual([
      'claim',
      'polarity',
      'exhibits',
      'contrasts',
      'exhibit_titles',
      'contrast_titles',
      'inference_confidence',
    ]);
    expect(Object.keys(item.properties)).toEqual(item.required);
    expect(SCREEN_PROFILE_TOOL.input_schema).toBe(SCREEN_TRAIT_INPUT_SCHEMA);
    expect(SCREEN_REVISE_TOOL.input_schema).toBe(SCREEN_TRAIT_INPUT_SCHEMA);
  });

  it('never alias or mutate the book definitions', () => {
    expect(SCREEN_PROFILE_SYSTEM).not.toBe(PROFILE_SYSTEM);
    expect(SCREEN_REVISE_SYSTEM).not.toBe(REVISE_SYSTEM);
    expect(SCREEN_TRAIT_INPUT_SCHEMA).not.toBe(TRAIT_INPUT_SCHEMA);
    expect(PROFILE_TOOL.input_schema).toBe(TRAIT_INPUT_SCHEMA);
    expect(Object.keys(TRAIT_INPUT_SCHEMA.properties.traits.items.properties)).toEqual([
      'claim',
      'polarity',
      'exhibits',
      'contrasts',
      'inference_confidence',
    ]);
  });
});

describe('buildScreenProfilePrompt', () => {
  it('appends SCREEN DATA after LIBRARY DATA and before the feedback block', () => {
    const prompt = buildScreenProfilePrompt(bookTiers, build(), {
      confirmed: ['Locked claim.'],
      edited: [],
      rejected: [],
      downweighted: [],
      more_like: [],
      less_like: [],
      favorites: [],
      directive_text: null,
      favorite_titles: ['Arrival (2016 film)'],
    });
    const lib = prompt.indexOf('LIBRARY DATA (JSON):\n{"5": [{"id": 1, "title": "Dune"}]');
    const screen = prompt.indexOf(
      '\n\nSCREEN DATA (JSON):\n{"movie": {"5": [{"id": 7, "type": "movie", "title": "Arrival", "year": 2016}]'
    );
    const feedback = prompt.indexOf('\n\n## User Feedback\n');
    expect(lib).toBeGreaterThan(0);
    expect(screen).toBeGreaterThan(lib);
    expect(feedback).toBeGreaterThan(screen);
    expect(prompt).toContain('favorite films and shows');
  });

  it('states book tier sizes, and screen tier sizes as sent and in total', () => {
    const prompt = buildScreenProfilePrompt(bookTiers, build(), null);
    expect(prompt).toContain(
      "Book tier sizes: {'5': 1, '4.5': 0, '4': 0, '3.5': 0, '3': 0, '<=2': 0, 'dnf': 0, 'rejected': 0}."
    );
    expect(prompt).toContain(
      "Screen tier sizes as sent: {'movie': {'5': 1, '4.5': 0, '4': 0, '3.5': 0, '3': 0, '<=2': 0, 'dropped': 0, 'rejected': 0}, 'tv': {"
    );
    expect(prompt).toContain(
      "Screen tier sizes in total, before the volume cap: {'movie': {'5': 4,"
    );
    expect(prompt).toContain('record_taste_traits');
    expect(prompt).not.toContain('## User Feedback');
  });
});

describe('buildScreenUpdatePrompt', () => {
  it('renders both changed-id lists as Python list reprs and both maps in insertion order', () => {
    const titlesMeta = new Map<string, Record<string, unknown>>([
      ['9', { id: 9, title: 'Tenet', rating: null, status: 'want' }],
      ['7', { id: 7, title: 'Arrival', rating: 5, status: 'watched' }],
    ]);
    const prompt = buildScreenUpdatePrompt(
      [
        {
          id: 1,
          claim: 'A.',
          polarity: 'reward',
          inference_confidence: pyFloat(1),
          exhibits: [1],
          contrasts: [],
          exhibit_titles: [7],
          contrast_titles: [],
        },
      ],
      new Map([['1', { id: 1, title: 'Dune' }]]),
      titlesMeta,
      [2, 3],
      [9, 7],
      null
    );
    expect(prompt).toContain('CHANGED BOOK IDS (the edits driving this update): [2, 3]\n');
    expect(prompt).toContain('CHANGED TITLE IDS (the edits driving this update): [9, 7]\n\n');
    expect(prompt).toContain('"inference_confidence": 1.0');
    expect(prompt).toContain('"exhibit_titles": [7], "contrast_titles": []');
    expect(prompt).toContain(
      'TITLES (id -> metadata; the only titles you may cite) (JSON):\n{"9": {"id": 9'
    );
    expect(prompt.indexOf('"9": {')).toBeLessThan(prompt.indexOf('"7": {'));
    expect(prompt).toContain('revise_taste_traits');
  });
});
