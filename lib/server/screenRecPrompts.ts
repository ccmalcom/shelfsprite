/**
 * Screen recommendation prompts (spec §6.3 seeds, §6.5 rerank). New prompts, not ports: no
 * Python parity applies. They follow recPrompts.ts's shape (a cached profile block, then the
 * task) and its voice rules, with film/TV wording.
 *
 * Seeds are comparable TITLES with a media type and a year -- never themes. The spike showed
 * theme seeds do not resolve usefully against Wikidata (spec §2.1 finding 7), and titles only
 * resolve reliably with a year.
 */
import type { PromptBlock } from './recPrompts';
import { LOVED_SAMPLE } from './recSignal';
import type { MediaFilter, ScreenPoolCandidate } from './screenAssemble';
import type { FavoriteBook, FavoriteTitle, ScreenSignal } from './screenSignal';
import { pyJsonDumps } from './serialize';

export const SCREEN_SEED_MAX_TOKENS = 2000;
/** Index decision 1: ask for 20 comparables. */
export const SCREEN_SEED_COUNT = 20;
export const SCREEN_RANK_MAX_TOKENS = 4000;
export const LOVED_TITLES_SAMPLE = 20;
export const FAVORITES_SAMPLE = 20;

export const SCREEN_SEED_TOOL = {
  name: 'propose_screen_comparables' as const,
  description:
    'Propose specific, real films and TV series this viewer is likely to love next. Each is ' +
    'looked up by exact title and year in a public catalog, so give the title as it is ' +
    'commonly known in English and the correct year.',
  input_schema: {
    type: 'object',
    properties: {
      comparables: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: {
              type: 'string',
              description:
                'The exact, commonly used English title, with no year or annotation in it.',
            },
            media_type: {
              type: 'string',
              enum: ['movie', 'tv'],
              description:
                "'movie' for a film (animated and documentary films included), 'tv' for a series.",
            },
            year: {
              type: 'integer',
              description: 'The film release year, or the series premiere year.',
            },
            reason: {
              type: 'string',
              description: 'Which trait, loved book or loved title this pick chases.',
            },
          },
          required: ['title', 'media_type', 'year', 'reason'],
        },
      },
    },
    required: ['comparables'],
  },
};

export const SCREEN_SEED_SYSTEM =
  'You suggest films and TV series for a viewer from their evidence-backed taste profile, ' +
  'which may be built from books, from films and shows, or from both. You name specific real ' +
  "titles with their years, never themes or search terms. You aim at the viewer's " +
  'distinguishing traits rather than generic popularity, and you never suggest something the ' +
  'viewer already has.';

export const SCREEN_RANK_TOOL = {
  name: 'rank_screen_recommendations' as const,
  description:
    "Rank the provided real catalog films and TV series by how well they fit this viewer's " +
    'taste profile, and explain each pick. Choose ONLY from the given candidates.',
  input_schema: {
    type: 'object',
    properties: {
      recommendations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            candidate_index: {
              type: 'integer',
              description: 'The `idx` of a provided candidate. Must exist.',
            },
            score: { type: 'number', description: "0..1 fit with the viewer's taste profile." },
            rationale: {
              type: 'string',
              description:
                '1-2 sentences in the voice of a friend who reads and watches a lot: what the film ' +
                'or show does, anchored to at most two things the viewer loved, by name, naming ' +
                'the mechanism of the fit. Plain punctuation, no em dashes.',
            },
            grounded_trait_ids: {
              type: 'array',
              items: { type: 'integer' },
              description: 'Trait ids (from the profile) this pick leans on.',
            },
            grounded_book_ids: {
              type: 'array',
              items: { type: 'integer' },
              description: 'Library book ids this candidate is most like.',
            },
            grounded_title_ids: {
              type: 'array',
              items: { type: 'integer' },
              description: 'Library film/show ids this candidate is most like.',
            },
          },
          required: [
            'candidate_index',
            'score',
            'rationale',
            'grounded_trait_ids',
            'grounded_book_ids',
            'grounded_title_ids',
          ],
        },
      },
    },
    required: ['recommendations'],
  },
};

export const SCREEN_RANK_SYSTEM =
  'You are a film and TV recommender. You rank a fixed list of real catalog films and series ' +
  "against a viewer's evidence-backed taste profile, which may be built from their reading, " +
  'their viewing, or both. You never invent titles; you only rank the candidates given. Every ' +
  'pick cites the trait ids, library book ids and library title ids it is grounded in, drawn ' +
  'only from the provided data. You prefer specific fit over popularity, and you respect ' +
  'aversion traits (penalize candidates that trip them).\n\n' +
  'Write each rationale like a friend who reads and watches a lot, in 1-2 sentences: lead with ' +
  'what the film or show does, then anchor it to at most two things the viewer loved (a book ' +
  'or a title) by name. Name the mechanism of the fit (pace, voice, structure, mood: whatever ' +
  'the trait actually is), never just shared genre. Say a pick is an adaptation only when its ' +
  'candidate carries an `adaptation_of` field, and then name that book. If the pick is a ' +
  'stretch, say so honestly and name what still connects. Use plain punctuation only: no em ' +
  'dashes. Never write "you\'ll love this", generic praise, or clinical trait language.';

export interface ScreenPromptEvidence {
  books: Array<{ id: number; title: string; author: string | null; rating: number }>;
  titles: Array<{
    id: number;
    type: string;
    title: string;
    year: number | null;
    rating: number;
    genres: string[];
    people: string[];
  }>;
  favorite_books: FavoriteBook[];
  favorite_titles: FavoriteTitle[];
}

/** The evidence the prompts carry. validEvidenceIds reads the SAME function, so citations are
 *  validated against exactly what was sent (spec §6.5). */
export function screenPromptEvidence(signal: ScreenSignal): ScreenPromptEvidence {
  return {
    books: signal.loved_books
      .slice(0, LOVED_SAMPLE)
      .map((b) => ({ id: b.id, title: b.title, author: b.author, rating: b.rating })),
    titles: signal.loved_titles.slice(0, LOVED_TITLES_SAMPLE).map((t) => ({
      id: t.id,
      type: t.type,
      title: t.title,
      year: t.year,
      rating: t.rating,
      genres: t.genres.slice(0, 6),
      people: t.people,
    })),
    favorite_books: signal.favorite_books.slice(0, FAVORITES_SAMPLE),
    favorite_titles: signal.favorite_titles.slice(0, FAVORITES_SAMPLE),
  };
}

export interface EvidenceIds {
  traitIds: Set<number>;
  bookIds: Set<number>;
  titleIds: Set<number>;
}

export function validEvidenceIds(
  signal: ScreenSignal,
  candidates: ScreenPoolCandidate[]
): EvidenceIds {
  const ev = screenPromptEvidence(signal);
  const bookIds = new Set<number>([...ev.books, ...ev.favorite_books].map((b) => b.id));
  for (const c of candidates) if (c.adaptation) bookIds.add(c.adaptation.book_id);
  return {
    traitIds: new Set(signal.traits.map((t) => t.id)),
    bookIds,
    titleIds: new Set<number>([...ev.titles, ...ev.favorite_titles].map((t) => t.id)),
  };
}

function screenTasteContext(signal: ScreenSignal): string {
  const ev = screenPromptEvidence(signal);
  let out =
    'TASTE TRAITS (JSON):\n' +
    pyJsonDumps(signal.traits) +
    '\n\nLOVED BOOKS (JSON):\n' +
    pyJsonDumps(ev.books) +
    '\n\nLOVED FILMS AND SHOWS (JSON):\n' +
    pyJsonDumps(ev.titles);
  if (ev.favorite_books.length || ev.favorite_titles.length) {
    out +=
      '\n\nFAVORITES (JSON):\n' +
      pyJsonDumps({ books: ev.favorite_books, films_and_shows: ev.favorite_titles });
  }
  return out;
}

const KIND_PHRASE: Record<MediaFilter, string> = {
  both: 'films and TV series (a mix of both)',
  movie: 'films only (no TV series)',
  tv: 'TV series only (no films)',
};

export function buildScreenSeedPrompt(
  signal: ScreenSignal,
  mediaFilter: MediaFilter,
  n: number
): PromptBlock[] {
  let steering = '';
  if (signal.more_like_titles.length) {
    steering +=
      ' Lean toward the qualities of these films and shows the viewer wants more of: ' +
      pyJsonDumps(signal.more_like_titles) +
      '.';
  }
  if (signal.less_like_titles.length) {
    steering +=
      ' Avoid the qualities of these films and shows the viewer wants less of: ' +
      pyJsonDumps(signal.less_like_titles) +
      '.';
  }
  const directive = (signal.directive_text ?? '').trim();
  if (directive) steering += "\n\nThe viewer's own standing instructions: " + directive;
  const owned = signal.owned_list.length
    ? "\n\nALREADY IN THE VIEWER'S LIBRARY (never propose these): " + signal.owned_list.join('; ')
    : '';
  const rejected = signal.rejected_list.length
    ? '\n\nPREVIOUSLY REJECTED (never propose these): ' + signal.rejected_list.join('; ')
    : '';

  const task =
    "The viewer's taste profile is above. It may rest on books, on films and shows, or on " +
    'both: a taste that shows up in their reading is evidence about what they will enjoy ' +
    `watching. Propose ${n} specific ${KIND_PHRASE[mediaFilter]} they are likely to rate ` +
    'highly. Give each by its exact, commonly used English title and its year (film release ' +
    'year, or the series premiere year). Chase their distinguishing traits and cover their ' +
    'range; avoid generic blockbusters they would find anyway.' +
    steering +
    owned +
    rejected;

  return [
    { type: 'text', text: screenTasteContext(signal), cache_control: { type: 'ephemeral' } },
    { type: 'text', text: task },
  ];
}

function screenSteeringBlock(signal: ScreenSignal): string {
  const lines: string[] = ['\n\n## User Steering'];
  if (signal.more_like_titles.length) {
    lines.push(
      'MORE LIKE (titles the viewer explicitly wants more of):\n' +
        pyJsonDumps(signal.more_like_titles)
    );
  }
  if (signal.less_like_titles.length) {
    lines.push(
      'LESS LIKE (titles the viewer explicitly wants less of):\n' +
        pyJsonDumps(signal.less_like_titles)
    );
  }
  if (signal.reject_reason_counts.size) {
    const reasons = [...signal.reject_reason_counts.entries()]
      .map(([r, c]) => `${r}: ${c} times`)
      .join(', ');
    lines.push('FREQUENT REJECT REASONS: ' + reasons);
  }
  const directive = (signal.directive_text ?? '').trim();
  if (directive) {
    lines.push(
      "CUSTOM INSTRUCTIONS (the viewer's own standing guidance, in their words; honor it as " +
        'direct high-priority intent, second only to the hard constraints already applied to ' +
        'the candidate set):\n' +
        directive
    );
  }
  lines.push(
    'Favor candidates resembling the more-like titles; penalize candidates resembling the ' +
      'less-like titles; penalize candidates matching frequent reject reasons (too_long means ' +
      "runtime or season count); weight trait influence by each trait's `user_weight`: traits " +
      'with a lower weight should influence the score less (0.0 = ignore, 1.0 = normal).'
  );
  return lines.join('\n\n');
}

export function buildScreenRerankPrompt(
  candidates: ScreenPoolCandidate[],
  signal: ScreenSignal,
  n: number
): PromptBlock[] {
  const indexed = candidates.map((c, i) => ({
    idx: i,
    type: c.media_type,
    title: c.title,
    year: c.year,
    genres: c.genres.slice(0, 6),
    people: (c.media_type === 'movie' ? c.directors : c.creators).slice(0, 3),
    original_language: c.original_language,
    ...(c.adaptation
      ? { adaptation_of: { book_id: c.adaptation.book_id, title: c.adaptation.book_title } }
      : {}),
  }));

  const rejectedBlock = signal.rejected_with_notes.length
    ? '\n\nREJECTED RECOMMENDATIONS WITH NOTES (JSON):\n' +
      'These are films and shows the viewer explicitly skipped with an explanation. Treat ' +
      'each note as direct testimony about what to avoid; heavily penalize candidates that ' +
      'share the same qualities.\n' +
      pyJsonDumps(signal.rejected_with_notes)
    : '';

  const task =
    `Rank the best ${n} candidates for this viewer and explain each. Choose ONLY from the ` +
    'CANDIDATES list (cite each by its `idx`). Score 0..1 for fit. Penalize anything that ' +
    "trips an aversion trait or resembles a rejected title's noted reason. Ground every pick " +
    'in specific trait ids, and in the library book ids and library title ids it most ' +
    'resembles - use only ids that appear above.\n\n' +
    'CANDIDATES (JSON):\n' +
    pyJsonDumps(indexed);

  return [
    {
      type: 'text',
      text: screenTasteContext(signal) + rejectedBlock + screenSteeringBlock(signal),
      cache_control: { type: 'ephemeral' },
    },
    { type: 'text', text: task },
  ];
}
