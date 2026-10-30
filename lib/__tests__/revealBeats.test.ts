import { buildBeats, readerLine, type Beat } from '../revealBeats';
import {
  ratingQuip,
  POLE_LINES,
  NEAR_CENTER_POLE_LINES,
  DEEP_WITHOUT_LOYALTY_LINE,
} from '../revealCopy';
import type { Stats, Trait, ArchetypeOut, ProfileHighlights, Book } from '../api';

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

const books: Book[] = [];

function kinds(beats: Beat[]) {
  return beats.map((b) => b.kind);
}

describe('buildBeats', () => {
  it('emits the nine-beat spine in order for a full library', () => {
    const beats = buildBeats({ stats, traits: [trait({})], archetype, highlights, books });
    const k = kinds(beats);
    expect(k[0]).toBe('cold-open');
    expect(k[1]).toBe('numbers');
    expect(k).toContain('reward-trait');
    expect(k).toContain('shelves');
    expect(k.filter((x) => x === 'axis')).toHaveLength(4);
    expect(k).toContain('finale');
    expect(k).toContain('summary');
    expect(k[k.length - 1]).toBe('handoff');
  });

  it('caps reward-trait beats at 5 for a full library', () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      trait({ id: i + 1, polarity: 'reward', inference_confidence: 1 - i * 0.05 })
    );
    const beats = buildBeats({ stats, traits: many, archetype, highlights, books });
    expect(kinds(beats).filter((x) => x === 'reward-trait')).toHaveLength(5);
  });

  it('caps reward-trait beats at 2 and drops axes for a thin library', () => {
    const many = Array.from({ length: 6 }, (_, i) => trait({ id: i + 1, polarity: 'reward' }));
    const beats = buildBeats({
      stats,
      traits: many,
      archetype,
      highlights: { ...highlights, thin: true },
      books,
    });
    expect(kinds(beats).filter((x) => x === 'reward-trait')).toHaveLength(2);
    expect(kinds(beats).filter((x) => x === 'axis')).toHaveLength(0);
    expect(kinds(beats)).toContain('finale');
  });

  it('groups aversions into a single beat', () => {
    const beats = buildBeats({
      stats,
      traits: [
        trait({ id: 1, polarity: 'reward' }),
        trait({ id: 2, polarity: 'aversion' }),
        trait({ id: 3, polarity: 'aversion' }),
      ],
      archetype,
      highlights,
      books,
    });
    expect(kinds(beats).filter((x) => x === 'aversions')).toHaveLength(1);
  });

  it('marks low-confidence reward traits', () => {
    const beats = buildBeats({
      stats,
      traits: [trait({ id: 1, inference_confidence: 0.2 })],
      archetype,
      highlights,
      books,
    });
    const rt = beats.find((b) => b.kind === 'reward-trait');
    expect(rt && rt.kind === 'reward-trait' && rt.lowConfidence).toBe(true);
  });

  it('builds the code letter-by-letter across axis beats', () => {
    const beats = buildBeats({ stats, traits: [trait({})], archetype, highlights, books });
    const axes = beats.filter((b) => b.kind === 'axis') as Extract<Beat, { kind: 'axis' }>[];
    expect(axes.map((a) => a.codeSoFar)).toEqual(['I', 'IC', 'ICD', 'ICDH']);
  });
});

function book(id: number, title: string, rating: number | null, over: Partial<Book> = {}): Book {
  return { id, title, effective_rating: rating, exclusive_shelf: 'read', ...over } as Book;
}

function rewardBeats(beats: Beat[]) {
  return beats.filter((b) => b.kind === 'reward-trait') as Extract<
    Beat,
    { kind: 'reward-trait' }
  >[];
}

function axisBeat(beats: Beat[], key: string) {
  const beat = beats.find((b) => b.kind === 'axis' && b.axisKey === key);
  if (!beat || beat.kind !== 'axis') throw new Error(`no ${key} axis`);
  return beat;
}

describe('ratingQuip', () => {
  it('reads an above-average rater as generous, not as a critic', () => {
    expect(ratingQuip(4.12)).toMatch(/You rate high/);
    expect(ratingQuip(4.0)).toMatch(/You rate high/);
  });

  it('keeps critic for averages clearly below the norm', () => {
    expect(ratingQuip(3.85)).toMatch(/where most readers do/);
    expect(ratingQuip(3.4)).toMatch(/critic/);
    expect(ratingQuip(2.9)).toMatch(/not an easy audience/);
    expect(ratingQuip(null)).toBe('');
  });
});

describe('reward contrast', () => {
  const books = [
    book(1, 'A', 5),
    book(2, 'B', 4.5),
    book(3, 'Lower', 4),
    book(4, 'Say Nothing', 5),
    book(5, 'Unrated', null),
  ];
  const relation = (contrasts: number[]) =>
    rewardBeats(
      buildBeats({
        stats,
        traits: [trait({ exhibits: [1, 2], contrasts })],
        archetype,
        highlights,
        books,
      })
    )[0].contrastRelation;

  it('compares the shown contrast with the evidence books', () => {
    expect(relation([3])).toBe('lower');
    expect(relation([4])).toBe('higher');
    expect(relation([5])).toBeNull();
  });
});

describe('repeated evidence', () => {
  it('drops a weaker trait that cites the same books as a stronger one', () => {
    const beats = buildBeats({
      stats,
      traits: [
        trait({ id: 1, exhibits: [1, 2, 3], inference_confidence: 0.9 }),
        trait({ id: 2, exhibits: [3, 2, 1], inference_confidence: 0.8 }),
        trait({ id: 3, exhibits: [4, 5], inference_confidence: 0.7 }),
      ],
      archetype,
      highlights,
      books,
    });
    expect(rewardBeats(beats).map((b) => b.trait.id)).toEqual([1, 3]);
  });
});

describe('aversion evidence', () => {
  it('reads as a sentence about the book, not a log line', () => {
    const beats = buildBeats({
      stats,
      traits: [
        trait({ id: 1, polarity: 'aversion', exhibits: [1] }),
        trait({ id: 2, polarity: 'aversion', exhibits: [2] }),
      ],
      archetype,
      highlights,
      books: [
        book(1, 'Dune', 2, { app_review: 'meh' }),
        book(2, 'Ulysses', null, { exclusive_shelf: 'did-not-finish' }),
      ],
    });
    const beat = beats.find((b) => b.kind === 'aversions');
    if (!beat || beat.kind !== 'aversions') throw new Error('no aversions beat');
    expect(beat.items.map((i) => i.evidence)).toEqual([
      'Case in point: \u201CDune\u201D, which you gave 2 stars.',
      'You never finished \u201CUlysses\u201D.',
    ]);
  });
});

describe('shelf and axis copy', () => {
  it('skips the novel-centric format line for a mostly nonfiction shelf', () => {
    const beats = buildBeats({
      stats,
      traits: [],
      archetype,
      highlights: { ...highlights, mostly_nonfiction: true },
      books,
    });
    const shelves = beats.find((b) => b.kind === 'shelves');
    expect(shelves && shelves.kind === 'shelves' && shelves.formatLine).toBeNull();
  });

  it('labels each axis for readers and keeps the scoring notes out', () => {
    const beats = buildBeats({ stats, traits: [], archetype, highlights, books });
    const lens = axisBeat(beats, 'lens');
    expect(lens.label).toBe('Why you read');
    expect(JSON.stringify(lens)).not.toContain('because');
  });

  it('claims author and series loyalty only when the shelf shows it', () => {
    const loyal = buildBeats({ stats, traits: [], archetype, highlights, books });
    expect(axisBeat(loyal, 'range').poleLine).toBe(POLE_LINES['range:D']);
    const noRepeats = buildBeats({
      stats,
      traits: [],
      archetype,
      highlights: {
        ...highlights,
        top_authors: [],
        format_mix: { ...highlights.format_mix, series: 0, dominant: 'novel' },
      },
      books,
    });
    expect(axisBeat(noRepeats, 'range').poleLine).toBe(DEEP_WITHOUT_LOYALTY_LINE);
  });

  it('softens a narrow lean and a broad lean beside a dominant genre', () => {
    const broad = { ...archetype, range: axis(-0.6, 'B') };
    const narrow = buildBeats({
      stats,
      traits: [],
      archetype: { ...archetype, range: axis(-0.1, 'B') },
      highlights,
      books,
    });
    expect(axisBeat(narrow, 'range').poleLine).toBe(NEAR_CENTER_POLE_LINES['range:B']);
    const dominant = buildBeats({
      stats,
      traits: [],
      archetype: broad,
      highlights: { ...highlights, top_genres: [{ subject: 'Fantasy', share: 0.7 }] },
      books,
    });
    expect(axisBeat(dominant, 'range').poleLine).toBe(NEAR_CENTER_POLE_LINES['range:B']);
  });
});

describe('readerLine', () => {
  it('shows the reveal line, or the reader’s own words once edited', () => {
    expect(readerLine(trait({ claim: 'c', reveal_line: 'You do a thing.' }))).toBe(
      'You do a thing.'
    );
    expect(
      readerLine(trait({ claim: 'I like it dark', reveal_line: 'old', status: 'edited' }))
    ).toBe('I like it dark');
  });
});
