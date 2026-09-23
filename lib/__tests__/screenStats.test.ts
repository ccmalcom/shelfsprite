import { genreLabel, round2HalfEven, screenStats } from '@/lib/screenStats';
import { round2 } from '@/lib/server/serialize';
import { makeTitle } from '@/lib/__tests__/fixtures/screenFixtures';
import type { TitleOut } from '@/lib/api';

function withEnrichment(
  over: Partial<TitleOut>,
  enr: Partial<NonNullable<TitleOut['enrichment']>>
) {
  const base = makeTitle(over);
  return { ...base, enrichment: { ...base.enrichment!, ...enr } };
}

describe('genreLabel', () => {
  it('strips the Wikidata medium suffix and capitalizes', () => {
    expect(genreLabel('science fiction film')).toBe('Science fiction');
    expect(genreLabel('crime television series')).toBe('Crime');
    expect(genreLabel('drama television program')).toBe('Drama');
    expect(genreLabel('Drama')).toBe('Drama');
  });

  it('merges the TVmaze hyphenated spelling with the Wikidata one', () => {
    const s = screenStats([
      withEnrichment({ id: 1, rating: 5 }, { genres: ['science fiction film'] }),
      withEnrichment({ id: 2, rating: 4, media_type: 'tv' }, { genres: ['Science-Fiction'] }),
    ]);
    expect(s.genres.overall).toEqual([{ subject: 'Science fiction', count: 2 }]);
  });

  it('keeps a genre whose whole name is the suffix-bearing phrase', () => {
    expect(genreLabel('film noir')).toBe('Film noir');
    expect(genreLabel('  ')).toBe('');
  });
});

describe('screenStats', () => {
  it('counts films, shows and statuses', () => {
    const s = screenStats([
      makeTitle({ id: 1 }),
      makeTitle({ id: 2, media_type: 'tv', status: 'watching', rating: null }),
      makeTitle({ id: 3, status: 'want', rating: null }),
      makeTitle({ id: 4, media_type: 'tv', status: 'dropped', rating: null }),
    ]);
    expect(s.films).toBe(2);
    expect(s.shows).toBe(2);
    expect(s.byStatus).toEqual({ watched: 1, watching: 1, want: 1, dropped: 1 });
  });

  it('builds the rating distribution and mean from rated titles only', () => {
    const s = screenStats([
      makeTitle({ id: 1, rating: 4 }),
      makeTitle({ id: 2, rating: 4.5 }),
      makeTitle({ id: 3, rating: 3 }),
      makeTitle({ id: 4, rating: null }),
    ]);
    expect(s.rated).toBe(3);
    expect(s.byStar).toEqual({ '4': 1, '4.5': 1, '3': 1 });
    expect(s.meanRating).toBe(3.83);
  });

  it('rounds the mean half-to-even, as the book stats do', () => {
    const ratings = [4, 4, 4, 4.5];
    const s = screenStats(ratings.map((rating, i) => makeTitle({ id: i + 1, rating })));
    expect(s.meanRating).toBe(4.12);
  });

  it('has a null mean with nothing rated', () => {
    expect(screenStats([makeTitle({ rating: null })]).meanRating).toBeNull();
  });

  it('skips possible duplicates everywhere', () => {
    const dup = withEnrichment({ id: 2, rating: 5 }, { duplicate_of_title_id: 1 });
    const s = screenStats([makeTitle({ id: 1, rating: 4 }), dup]);
    expect(s.films).toBe(1);
    expect(s.rated).toBe(1);
    expect(s.genres.overall).toEqual([{ subject: 'Crime', count: 1 }]);
  });

  it('merges Wikidata and TVmaze genre spellings and splits them by tier', () => {
    const s = screenStats([
      withEnrichment({ id: 1, rating: 5 }, { genres: ['drama film', 'crime film'] }),
      withEnrichment({ id: 2, rating: 4, media_type: 'tv' }, { genres: ['Drama'] }),
      withEnrichment({ id: 3, rating: 5 }, { genres: ['drama film', 'Drama'] }),
      withEnrichment({ id: 4, rating: null }, { genres: ['horror film'] }),
    ]);
    expect(s.genres.overall).toEqual([
      { subject: 'Drama', count: 3 },
      { subject: 'Crime', count: 1 },
    ]);
    expect(s.genres.by_tier['5']).toEqual([
      { subject: 'Drama', count: 2 },
      { subject: 'Crime', count: 1 },
    ]);
    expect(s.genres.by_tier['4']).toEqual([{ subject: 'Drama', count: 1 }]);
  });

  it('lists directors from rated films and creators from rated shows, twice or more', () => {
    const s = screenStats([
      withEnrichment({ id: 1, rating: 5 }, { directors: ['Michael Mann'] }),
      withEnrichment({ id: 2, rating: 4 }, { directors: ['Michael Mann'] }),
      withEnrichment({ id: 3, rating: 3 }, { directors: ['Once Only'] }),
      withEnrichment({ id: 4, rating: null }, { directors: ['Once Only'] }),
      withEnrichment(
        { id: 5, rating: 4.5, media_type: 'tv' },
        { directors: [], creators: ['David Simon'] }
      ),
      withEnrichment(
        { id: 6, rating: 3.5, media_type: 'tv' },
        { directors: ['Michael Mann'], creators: ['David Simon'] }
      ),
    ]);
    expect(s.directors).toEqual([{ name: 'Michael Mann', count: 2, mean: 4.5 }]);
    expect(s.creators).toEqual([{ name: 'David Simon', count: 2, mean: 4 }]);
  });

  it('handles titles with no enrichment', () => {
    const s = screenStats([makeTitle({ enrichment: null })]);
    expect(s.films).toBe(1);
    expect(s.genres.overall).toEqual([]);
  });
});

describe('round2HalfEven', () => {
  it('agrees with the server round2 on every mean a rating library can produce', () => {
    // Means of n ratings on the 0.5 grid are k / (2n); cover every one up to n = 40,
    // which includes all the exact ties (odd eighths).
    for (let n = 1; n <= 40; n++) {
      for (let k = n; k <= 10 * n; k++) {
        const x = k / (2 * n);
        expect([x, round2HalfEven(x)]).toEqual([x, round2(x)]);
      }
    }
  });
});
