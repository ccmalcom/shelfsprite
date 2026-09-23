import { buildBeats, titlesSettled, type Beat } from '../revealBeats';
import type { ArchetypeOut, Book, ProfileHighlights, Stats, TitleOut, Trait } from '../api';
import { makeTitle } from './fixtures/screenFixtures';

function trait(over: Partial<Trait>): Trait {
  return {
    id: 1,
    claim: 'c',
    reveal_line: 'You do a thing.',
    polarity: 'reward',
    exhibits: [],
    contrasts: [],
    inference_confidence: 0.8,
    status: 'proposed',
    user_weight: 1,
    user_note: null,
    created_at: '',
    ...over,
  };
}

function axis(score: number, letter: string) {
  return { score, letter, rationale: 'because' };
}

const archetype: ArchetypeOut = {
  code: 'ICDH',
  name: 'The Devoted Fan',
  tagline: 'I live in this world now.',
  hook: 'reread the whole series to get ready for the new one',
  lens: axis(-0.6, 'I'),
  engine: axis(0.7, 'C'),
  range: axis(0.5, 'D'),
  resonance: axis(-0.4, 'H'),
  derived_at: '',
  is_stale: false,
};

const highlights: ProfileHighlights = {
  thin: false,
  n_authors: 40,
  top_genres: [
    { subject: 'Fantasy', share: 0.5 },
    { subject: 'Sci-Fi', share: 0.3 },
  ],
  top_authors: ['Le Guin', 'Mitchell', 'Chekhov'],
  format_mix: {
    novel: 3,
    novella: 1,
    collection: 0,
    series: 6,
    dominant: 'series',
    low_confidence: false,
  },
  era_split: { pre_2000: 10, post_2000: 30 },
};

const stats: Stats = {
  total: 120,
  rated: 100,
  unrated: 20,
  shelves: {},
  mean_rating: 4.3,
  by_star: { '5': 40, '4': 30, '3': 20, '2': 7, '1': 3 },
};

const books = [{ id: 1, title: 'The Dispossessed' } as Book];
const titles: TitleOut[] = [
  makeTitle({ id: 11, title: 'Heat', year: 1995 }),
  makeTitle({ id: 12, title: 'Severance', year: 2022, media_type: 'tv', status: 'dropped' }),
];

function rewardBeat(beats: Beat[]) {
  const beat = beats.find((b) => b.kind === 'reward-trait');
  if (!beat || beat.kind !== 'reward-trait') throw new Error('no reward beat');
  return beat;
}

describe('buildBeats with title evidence', () => {
  const cited = trait({ exhibits: [1], exhibit_title_ids: [11, 12] });

  it('adds cited titles after the books, marked film or TV', () => {
    const beats = buildBeats({ stats, traits: [cited], archetype, highlights, books, titles });
    expect(rewardBeat(beats).exhibitTitles).toEqual([
      'The Dispossessed',
      'Heat (film)',
      'Severance (TV)',
    ]);
  });

  it('is unchanged without titles', () => {
    const beats = buildBeats({ stats, traits: [cited], archetype, highlights, books });
    expect(rewardBeat(beats).exhibitTitles).toEqual(['The Dispossessed']);
  });

  it('reads an aversion with only title evidence from the title', () => {
    const aversion = trait({ id: 2, polarity: 'aversion', exhibits: [], exhibit_title_ids: [12] });
    const beats = buildBeats({ stats, traits: [aversion], archetype, highlights, books, titles });
    const beat = beats.find((b) => b.kind === 'aversions');
    if (!beat || beat.kind !== 'aversions') throw new Error('no aversions beat');
    expect(beat.items[0].evidence).toBe('You never finished Severance (TV). We noticed.');
  });
});

describe('titlesSettled', () => {
  it.each([
    [
      { screenEnabled: undefined, settingsFailed: false, titlesLoaded: false, titlesFailed: false },
      false,
    ],
    [
      { screenEnabled: undefined, settingsFailed: true, titlesLoaded: false, titlesFailed: false },
      true,
    ],
    [
      { screenEnabled: false, settingsFailed: false, titlesLoaded: false, titlesFailed: false },
      true,
    ],
    [
      { screenEnabled: true, settingsFailed: false, titlesLoaded: false, titlesFailed: false },
      false,
    ],
    [{ screenEnabled: true, settingsFailed: false, titlesLoaded: true, titlesFailed: false }, true],
    [{ screenEnabled: true, settingsFailed: false, titlesLoaded: false, titlesFailed: true }, true],
  ])('%o -> %s', (input, expected) => {
    expect(titlesSettled(input)).toBe(expected);
  });
});
