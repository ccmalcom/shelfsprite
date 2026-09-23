import type { SubjectBreakdown, SubjectCount, TitleOut, TitleStatus } from '@/lib/api';

const TOP_GENRES = 15;
const TOP_TIER_GENRES = 12;
const TOP_PEOPLE = 8;
/** One film by a director is every director in a small library, so a person needs two. */
const MIN_PERSON_TITLES = 2;

// Wikidata labels carry the medium ("drama film", "crime television series"); TVmaze says
// "Drama". Stripping the medium lets both spellings land on one bar.
const MEDIUM_SUFFIX = / (film|films|television series|television program|television programme)$/i;

export interface PersonStat {
  name: string;
  count: number;
  mean: number;
}

export interface ScreenStats {
  films: number;
  shows: number;
  byStatus: Record<TitleStatus, number>;
  rated: number;
  /** Rounded half-to-even at two digits, like the book stats' `mean_rating`. */
  meanRating: number | null;
  /** Keyed like the book stats: "4" for whole stars, "4.5" for halves. */
  byStar: Record<string, number>;
  genres: SubjectBreakdown;
  directors: PersonStat[];
  creators: PersonStat[];
}

/** Display form of a catalog genre, for grouping; the stored value is never rewritten. */
export function genreLabel(raw: string): string {
  const trimmed = raw.trim().replace(MEDIUM_SUFFIX, '');
  return trimmed ? trimmed[0].toUpperCase() + trimmed.slice(1) : '';
}

/**
 * Half-to-even rounding at two digits, so a screen mean reads like the book one, which the
 * server rounds with `round2` (lib/server/serialize.ts). Copied rather than imported to keep
 * server code out of the client bundle; see that file for why the tie test is exact.
 */
export function round2HalfEven(x: number): number {
  const tie = x * 2 ** 3;
  if (Number.isInteger(tie) && tie % 2 !== 0) {
    const floored = Math.floor(x * 100);
    return (floored % 2 === 0 ? floored : floored + 1) / 100;
  }
  return Number(x.toFixed(2));
}

function mostCommon(counts: Map<string, SubjectCount>, n: number): SubjectCount[] {
  return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, n);
}

function topPeople(ratings: Map<string, number[]>): PersonStat[] {
  return [...ratings.entries()]
    .filter(([, rs]) => rs.length >= MIN_PERSON_TITLES)
    .map(([name, rs]) => ({
      name,
      count: rs.length,
      mean: rs.reduce((a, b) => a + b, 0) / rs.length,
    }))
    .sort((a, b) => b.count - a.count || b.mean - a.mean || a.name.localeCompare(b.name))
    .slice(0, TOP_PEOPLE);
}

function addPeople(into: Map<string, number[]>, names: string[], rating: number): void {
  for (const name of new Set(names)) {
    const rs = into.get(name) ?? [];
    rs.push(rating);
    into.set(name, rs);
  }
}

/** Library stats for the screen profile, derived from the title list the client already has. */
export function screenStats(titles: readonly TitleOut[]): ScreenStats {
  const byStatus: Record<TitleStatus, number> = { watched: 0, watching: 0, want: 0, dropped: 0 };
  const byStar: Record<string, number> = {};
  const overall = new Map<string, SubjectCount>();
  const byTier = new Map<string, Map<string, SubjectCount>>();
  const directors = new Map<string, number[]>();
  const creators = new Map<string, number[]>();
  let films = 0;
  let shows = 0;
  let ratingSum = 0;
  let rated = 0;

  for (const t of titles) {
    // A possible duplicate is the same film twice; counting it would double its weight.
    if (t.enrichment?.duplicate_of_title_id != null) continue;
    if (t.media_type === 'tv') shows++;
    else films++;
    byStatus[t.status]++;
    if (t.rating === null) continue;

    rated++;
    ratingSum += t.rating;
    const tier = String(t.rating);
    byStar[tier] = (byStar[tier] ?? 0) + 1;

    const e = t.enrichment;
    if (!e) continue;
    const tierCounts = byTier.get(tier) ?? new Map<string, SubjectCount>();
    byTier.set(tier, tierCounts);
    const seen = new Set<string>();
    for (const raw of e.genres) {
      const label = genreLabel(raw);
      // TVmaze writes "Science-Fiction" where Wikidata writes "science fiction film".
      const key = label.toLowerCase().replace(/-/g, ' ');
      if (!label || seen.has(key)) continue;
      seen.add(key);
      for (const counts of [overall, tierCounts]) {
        const c = counts.get(key) ?? { subject: label, count: 0 };
        c.count++;
        counts.set(key, c);
      }
    }
    if (t.media_type === 'tv') addPeople(creators, e.creators, t.rating);
    else addPeople(directors, e.directors, t.rating);
  }

  const by_tier: Record<string, SubjectCount[]> = {};
  for (const tier of [...byTier.keys()].sort((a, b) => Number(b) - Number(a))) {
    const top = mostCommon(byTier.get(tier)!, TOP_TIER_GENRES);
    if (top.length > 0) by_tier[tier] = top;
  }

  return {
    films,
    shows,
    byStatus,
    rated,
    meanRating: rated > 0 ? round2HalfEven(ratingSum / rated) : null,
    byStar,
    genres: { overall: mostCommon(overall, TOP_GENRES), by_tier },
    directors: topPeople(directors),
    creators: topPeople(creators),
  };
}
