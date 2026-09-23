import { describe, test, expect } from 'vitest';
import {
  buildScreenRerankPrompt,
  buildScreenSeedPrompt,
  SCREEN_RANK_TOOL,
  SCREEN_SEED_TOOL,
  validEvidenceIds,
} from '../screenRecPrompts';
import type { ScreenPoolCandidate } from '../screenAssemble';
import type { ScreenSignal } from '../screenSignal';
import { pyFloat } from '../serialize';
import { candidate } from './helpers/screenRecFixtures';

function signal(over: Partial<ScreenSignal> = {}): ScreenSignal {
  return {
    traits: [
      {
        id: 7,
        claim: 'Rewards slow burns',
        polarity: 'reward',
        confidence: pyFloat(0.8),
        user_weight: pyFloat(1),
        status: 'proposed',
      },
    ],
    loved_books: Array.from({ length: 25 }, (_, i) => ({
      id: i + 1,
      title: `Book ${i + 1}`,
      author: 'A. Writer',
      additional_authors: [],
      rating: 5,
      read_year: 2024,
    })),
    loved_titles: [
      {
        id: 40,
        type: 'tv',
        title: 'Severance',
        year: 2022,
        rating: 4,
        genres: ['drama'],
        people: ['Dan Erickson'],
        wikidata_qid: 'Q1',
        watched_year: 2025,
      },
    ],
    favorite_books: [{ id: 99, title: 'Fav Book', author: 'B. Writer' }],
    favorite_titles: [],
    top_genres: [],
    top_people: [],
    original_languages: [],
    owned_qids: new Set(),
    owned_tvmaze_ids: new Set(),
    owned_keys: new Set(),
    owned_list: ['Severance (2022)', 'Arrival (2016)'],
    rejected_list: ['Heat (1995)'],
    rejected_with_notes: [{ title: 'Heat', year: 1995, type: 'movie', note: 'Too long' }],
    more_like_titles: ['Severance (2022)'],
    less_like_titles: [],
    reject_reason_counts: new Map([['too_long', 2]]),
    directive_text: 'No horror, please.',
    directive_constraints: {},
    ...over,
  };
}

function pc(qid: string, over: Partial<ScreenPoolCandidate> = {}): ScreenPoolCandidate {
  return {
    ...candidate({ title: `Film ${qid}`, wikidata_qid: qid, year: 2015 }),
    retrieval_pool: 'metadata',
    seed_reason: '',
    adaptation: null,
    ...over,
  };
}

describe('tools', () => {
  test('the seed tool asks for comparable titles with a type and a year, never themes', () => {
    expect(SCREEN_SEED_TOOL.name).toBe('propose_screen_comparables');
    const item = SCREEN_SEED_TOOL.input_schema.properties.comparables.items;
    expect(item.required).toEqual(['title', 'media_type', 'year', 'reason']);
    expect(item.properties.media_type.enum).toEqual(['movie', 'tv']);
    expect(item.properties.year.type).toBe('integer');
  });

  test('the rank tool cites trait, book and title ids', () => {
    expect(SCREEN_RANK_TOOL.name).toBe('rank_screen_recommendations');
    expect(SCREEN_RANK_TOOL.input_schema.properties.recommendations.items.required).toEqual([
      'candidate_index',
      'score',
      'rationale',
      'grounded_trait_ids',
      'grounded_book_ids',
      'grounded_title_ids',
    ]);
  });
});

describe('buildScreenSeedPrompt', () => {
  test('caches the profile block and carries the owned and rejected lists', () => {
    const [profile, task] = buildScreenSeedPrompt(signal(), 'both', 20);
    expect(profile.cache_control).toEqual({ type: 'ephemeral' });
    expect(profile.text).toContain('TASTE TRAITS (JSON):\n');
    expect(profile.text).toContain('"id": 20');
    expect(profile.text).not.toContain('"id": 21'); // loved books sampled to 20
    expect(profile.text).toContain('LOVED FILMS AND SHOWS (JSON):\n');
    expect(profile.text).toContain('FAVORITES (JSON):\n');
    expect(task.text).toContain('Propose 20 specific films and TV series (a mix of both)');
    expect(task.text).toContain(
      "ALREADY IN THE VIEWER'S LIBRARY (never propose these): Severance (2022); Arrival (2016)"
    );
    expect(task.text).toContain('PREVIOUSLY REJECTED (never propose these): Heat (1995)');
    expect(task.text).toContain('No horror, please.');
    expect(task.text).toContain('["Severance (2022)"]');
  });

  test('the media filter narrows the request; an empty library emits no owned block', () => {
    expect(buildScreenSeedPrompt(signal(), 'tv', 20)[1].text).toContain(
      'TV series only (no films)'
    );
    expect(buildScreenSeedPrompt(signal(), 'movie', 20)[1].text).toContain(
      'films only (no TV series)'
    );
    const bare = buildScreenSeedPrompt(
      signal({ owned_list: [], rejected_list: [], favorite_books: [] }),
      'both',
      20
    );
    expect(bare[1].text).not.toContain('ALREADY IN');
    expect(bare[0].text).not.toContain('FAVORITES');
  });
});

describe('buildScreenRerankPrompt / validEvidenceIds', () => {
  const adaptation = {
    book_id: 23,
    book_title: 'Book 23',
    source_qid: 'Q70',
    via: 'work' as const,
  };
  const cands = [
    pc('Q1', {
      genres: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      directors: ['X', 'Y', 'Z', 'W'],
      original_language: 'English',
    }),
    pc('Q2', {
      media_type: 'tv',
      tvmaze_id: 5,
      creators: ['C'],
      retrieval_pool: 'adaptation',
      adaptation,
    }),
  ];

  test('candidates carry type, trimmed metadata, and adaptation_of only for the bridge', () => {
    const [profile, task] = buildScreenRerankPrompt(cands, signal(), 10);
    expect(task.text).toContain('Rank the best 10 candidates for this viewer');
    expect(task.text).toContain(
      '{"idx": 0, "type": "movie", "title": "Film Q1", "year": 2015, "genres": ["a", "b", "c", "d", "e", "f"], "people": ["X", "Y", "Z"], "original_language": "English"}'
    );
    expect(task.text).toContain('"adaptation_of": {"book_id": 23, "title": "Book 23"}');
    expect(task.text.match(/adaptation_of/g)).toHaveLength(1);
    expect(profile.text).toContain('REJECTED RECOMMENDATIONS WITH NOTES (JSON):');
    expect(profile.text).toContain('FREQUENT REJECT REASONS: too_long: 2 times');
    expect(profile.text).toContain("CUSTOM INSTRUCTIONS (the viewer's own standing guidance");
  });

  test('citable ids are exactly the ones the prompt carried', () => {
    const ids = validEvidenceIds(signal(), cands);
    expect([...ids.traitIds]).toEqual([7]);
    expect(ids.bookIds.has(20)).toBe(true);
    expect(ids.bookIds.has(21)).toBe(false); // outside the 20-book sample
    expect(ids.bookIds.has(23)).toBe(true); // named by adaptation_of
    expect(ids.bookIds.has(99)).toBe(true); // favorite
    expect([...ids.titleIds]).toEqual([40]);
  });
});
