/**
 * Port of recommend.py's two /recommend prompts (_SEED_TOOL/_SEED_SYSTEM and
 * _RANK_TOOL/_RANK_SYSTEM) plus their builders.
 *
 * The seed strings are copied VERBATIM from Python. The rerank tool's low_confidence field,
 * its "up to n" task wording and the cold-start title-seed prompt are later additions
 * (QA 2026-10-30). recommend-run.test.ts asserts all three calls byte-for-byte against
 * fixtures/claude/prompts.json, so do not reflow or re-punctuate them casually.
 */
import { readPreferences } from './preferences';
import { modelFor } from './models';
import type { AssembledCandidate } from './recAssemble';
import { LOVED_SAMPLE, type RecSignal } from './recSignal';
import { pyJsonDumps } from './serialize';

export interface PromptBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

// --- stage 1b: propose search queries --------------------------------------

export const SEED_MAX_TOKENS = 1500;

export const SEED_TOOL = {
  name: 'propose_search_queries',
  description:
    'Propose catalog SEARCH queries that would surface books this reader is likely ' +
    'to love next. These are search terms (subjects, micro-genres, comp-author ' +
    'phrasings), NOT specific book titles. Each is run against a live book catalog.',
  input_schema: {
    type: 'object',
    properties: {
      queries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description:
                // Plain words only: Google's field operators (inauthor:, subject:) now
                // return nothing (#123), so the old inauthor: example invited dead queries.
                "A plain-words catalog search query, e.g. 'literary science fiction " +
                "first contact' or 'Ursula K. Le Guin anthropological'. Do not use " +
                'field operators like inauthor: or subject:. Avoid naming books the ' +
                'reader already owns.',
            },
            reason: {
              type: 'string',
              description: 'Which trait/pattern this query chases.',
            },
          },
          required: ['query', 'reason'],
        },
      },
    },
    required: ['queries'],
  },
};

export const SEED_SYSTEM =
  "You expand a reader's taste profile into catalog search queries for discovery. You " +
  "propose search TERMS, never specific titles, and you aim the queries at the reader's " +
  'distinguishing traits (what separates their 5-star from 4-star books), not generic ' +
  'bestsellers.';

// --- stage 1c (cold start only): adjacent real titles ------------------------
//
// New, not a Python port, so no byte-parity constraint; recommend-run.test.ts pins it against
// fixtures/claude/prompts.json (recommend_title_seed). Modeled on SCREEN_SEED_TOOL: under the
// cold-start threshold the metadata pool is a few subject keyword searches, which free-text
// catalogs answer with keyword-titled filler, so Claude names the established books next to
// the library. Each name is a LOOKUP: titleSeedPool resolves it through searchBooks, keeps it
// only when the catalog's own title and author match, and the reranker still decides.

/** Titles asked for. Twelve, one small Haiku call: about 40 output tokens each. */
export const TITLE_SEED_COUNT = 12;
export const TITLE_SEED_MAX_TOKENS = 1200;
/** Library titles listed as off-limits. A cold-start library is small; this bounds a long to-read shelf. */
export const TITLE_SEED_LIBRARY_SAMPLE = 40;

export const TITLE_SEED_TOOL = {
  name: 'propose_adjacent_books' as const,
  description:
    "Name real, well-known, already-published books adjacent to this reader's library. " +
    'Each is looked up by title and author in a public book catalog, and one the catalog ' +
    'does not hold is dropped.',
  input_schema: {
    type: 'object',
    properties: {
      books: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: {
              type: 'string',
              description:
                'The title as commonly published in English, with no series name, number ' +
                'or subtitle.',
            },
            author: {
              type: 'string',
              description: "The author's full name as commonly credited.",
            },
            reason: {
              type: 'string',
              description: 'Which loved book or trait this book sits next to.',
            },
          },
          required: ['title', 'author', 'reason'],
        },
      },
    },
    required: ['books'],
  },
};

export const TITLE_SEED_SYSTEM =
  'You help a reader whose library is still small find the well-loved books next to it. You ' +
  'name specific, real, already-published books, each with its author, that readers of ' +
  'their favorites widely go on to read: the established books of the genres and moods they ' +
  'rate highly, and other books by authors they loved. You prefer books with a real ' +
  'readership over obscure, self-published or keyword-titled ones, you never name a book ' +
  'already in their library, and you write each title and author the way the book is ' +
  'commonly published in English. Your names are catalog lookups, not recommendations: a ' +
  'separate step ranks whatever the catalog finds.';

/** The cold-start title-seed call's message content. */
export function buildTitleSeedPrompt(signal: RecSignal, count: number): PromptBlock[] {
  const owned = [...new Set(signal.library_titles)].slice(0, TITLE_SEED_LIBRARY_SAMPLE);
  const taskPrompt =
    'This reader has rated only a few books; their taste profile and loved books are above. ' +
    `Name up to ${count} well-known books adjacent to them: mostly books by other authors ` +
    'that readers of these favorites commonly love next, plus at most two more books by any ' +
    "one author they loved. Cover the reader's range rather than one corner of it." +
    (owned.length
      ? ' Do not name any of these, which they already have or turned down: ' +
        pyJsonDumps(owned) +
        '.'
      : '');
  return [
    { type: 'text', text: tasteAndLoved(signal), cache_control: { type: 'ephemeral' } },
    { type: 'text', text: taskPrompt },
  ];
}

// --- stage 2: rerank + explain ---------------------------------------------

export const RANK_MAX_TOKENS = 4000;

/**
 * The smallest deck served when the reranker returned at least this many picks: confident
 * picks first, then its low_confidence ones by score until the deck reaches it. Five is half
 * the default batch of ten, enough for a swipe session to feel like one, and small enough
 * that a thin pool is not padded back to ten with doubtful books.
 */
export const MIN_DECK = 5;

/** The rerank model (lib/server/models.ts), read at call time. */
export function rankModel(): string {
  return modelFor('rerank');
}

export const RANK_TOOL = {
  name: 'rank_recommendations',
  description:
    "Rank the provided real catalog candidates by how well they fit this reader's " +
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
            score: {
              type: 'number',
              description: "0..1 fit with the reader's taste profile.",
            },
            rationale: {
              type: 'string',
              description:
                '1-2 sentences in the voice of a well-read friend: what the ' +
                'book does, anchored to at most two library books by title, ' +
                'naming the mechanism of the fit. Honest about stretch picks. ' +
                'Plain punctuation, no em dashes. No generic praise, no ' +
                'clinical trait-speak.',
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
            // Not in the Python original (QA 2026-10-30). Optional, so a pick that omits it
            // counts as confident; recommendRun serves flagged picks only to reach MIN_DECK.
            low_confidence: {
              type: 'boolean',
              description:
                'true when you would not press this book on the reader yourself: the fit is ' +
                'a stretch you cannot tie to a specific mechanism, the catalog metadata is ' +
                'too thin to judge it, or the edition or authorship looks doubtful (a ' +
                'summary, a companion, a keyword-titled or pseudonymous mill book). Flagged ' +
                'picks are served only when there are too few confident ones.',
            },
          },
          required: [
            'candidate_index',
            'score',
            'rationale',
            'grounded_trait_ids',
            'grounded_book_ids',
          ],
        },
      },
    },
    required: ['recommendations'],
  },
};

export const RANK_SYSTEM =
  'You are a book recommender. You rank a fixed list of real catalog candidates against ' +
  "a reader's evidence-backed taste profile. You never invent books; you only rank the " +
  'candidates given. Every pick cites the trait ids and library book ids it is grounded ' +
  'in, drawn only from the provided data. You prefer specific fit over popularity, and ' +
  'you respect aversion traits (penalize candidates that trip them).\n\n' +
  'Write each rationale like a well-read friend pressing the book into their hands, in ' +
  '1-2 sentences: lead with what the book does, then anchor it to at most two of their ' +
  'library books by title. Name the mechanism of the fit (pace, voice, structure, mood: ' +
  'whatever the trait actually is), never just shared genre. If the pick is a stretch, ' +
  'say so honestly and name what still connects. Use plain punctuation only: no em ' +
  'dashes. Never write "you\'ll love this", generic praise, or clinical trait ' +
  'language.\n\n' +
  'Examples of the target voice:\n' +
  '- Technically sci-fi, but it moves like the quiet family novels you rate highest: one ' +
  'household, twenty years, every chapter a knife slid in slowly.\n' +
  "- A reach: you rarely go for war fiction. But it's told in the clipped, unsentimental " +
  "voice that carried The Remains of the Day for you, and it's short enough to bail on " +
  'cheap.\n' +
  '- Romance-adjacent without the love-triangle stall you keep one-starring: the couple ' +
  'is together by chapter three, and the book is about what happens after.';

// --- builders ---------------------------------------------------------------

/**
 * The `TASTE TRAITS (JSON):` / `LOVED BOOKS (JSON):` pair shared by /recommend's two
 * prompts and /discover's two prompts. Exported for recDiscoverPrompts.ts, which
 * prefixes it with its own header line rather than duplicating the serialization.
 */
export function tasteAndLoved(signal: RecSignal): string {
  return (
    'TASTE TRAITS (JSON):\n' +
    pyJsonDumps(signal.traits) +
    '\n\nLOVED BOOKS (JSON):\n' +
    pyJsonDumps(signal.loved.slice(0, LOVED_SAMPLE))
  );
}

/** recommend._claude_seed_queries' message content. */
export function buildSeedPrompt(signal: RecSignal, nQueries: number): PromptBlock[] {
  const profileContext = tasteAndLoved(signal);

  let steering = '';
  if (signal.more_like.length) {
    steering +=
      ' Bias the queries toward the qualities of these books the reader wants ' +
      'more of: ' +
      pyJsonDumps(signal.more_like) +
      '.';
  }
  if (signal.less_like.length) {
    steering +=
      ' Avoid the qualities of these books the reader wants less of: ' +
      pyJsonDumps(signal.less_like) +
      '.';
  }
  // Emitted only when populated, so today's output is preserved byte-for-byte for a
  // reader with no favorites (recommend-run.test.ts pins this prompt).
  const preferences = readPreferences(signal.directive_constraints);
  if (preferences.prefer_authors.length) {
    steering +=
      ' Favor queries that would surface books by these authors the reader has ' +
      'marked as favorites: ' +
      pyJsonDumps(preferences.prefer_authors) +
      '.';
  }
  if (preferences.prefer_subjects.length) {
    steering +=
      ' Favor queries covering these subjects the reader has marked as favorites: ' +
      pyJsonDumps(preferences.prefer_subjects) +
      '.';
  }
  // Emitted only when populated, like the favorites above (genreSuppression.ts).
  if (signal.genre_suppression.suppressed.length) {
    steering +=
      ' Do not chase these genres: the reader recently skipped books in them as the ' +
      'wrong genre: ' +
      pyJsonDumps(signal.genre_suppression.suppressed) +
      '.';
  }

  const taskPrompt =
    "A reader's taste profile and a sample of their loved books are above. Propose " +
    `up to ${nQueries} CATALOG SEARCH QUERIES (search terms, not book titles) that ` +
    'would surface books they are likely to rate highly. Chase their distinguishing ' +
    'traits, cover their range, and avoid generic bestseller terms.' +
    steering;

  return [
    { type: 'text', text: profileContext, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: taskPrompt },
  ];
}

/**
 * recommend._user_steering_block: the `## User Steering` section appended to the
 * cached profile prefix. The trailing weighting instruction is ALWAYS emitted, so
 * this never returns "" -- the reranker must always know traits carry weights.
 */
export function userSteeringBlock(signal: RecSignal): string {
  const directiveText = (signal.directive_text ?? '').trim();
  const lines: string[] = ['\n\n## User Steering'];

  if (signal.more_like.length) {
    lines.push(
      'MORE LIKE (books the reader explicitly wants more of):\n' + pyJsonDumps(signal.more_like)
    );
  }
  if (signal.less_like.length) {
    lines.push(
      'LESS LIKE (books the reader explicitly wants less of):\n' + pyJsonDumps(signal.less_like)
    );
  }
  // Favorites sit between the more/less-like books and the reader's own prose: more
  // specific than prose guidance, less specific than their own sentences.
  const preferences = readPreferences(signal.directive_constraints);
  const hasFavorites =
    preferences.prefer_authors.length > 0 || preferences.prefer_subjects.length > 0;
  if (preferences.prefer_authors.length) {
    lines.push(
      'FAVORITE AUTHORS (the reader explicitly marked these as favorites; treat a ' +
        'candidate written by one of them as a strong positive signal):\n' +
        pyJsonDumps(preferences.prefer_authors)
    );
  }
  if (preferences.prefer_subjects.length) {
    lines.push(
      'FAVORITE SUBJECTS (the reader explicitly marked these as favorites; treat a ' +
        'candidate carrying one of them as a strong positive signal):\n' +
        pyJsonDumps(preferences.prefer_subjects)
    );
  }
  if (signal.reject_reason_counts.size) {
    // A Map, so this joins in Python's dict insertion order.
    const reasons = [...signal.reject_reason_counts.entries()]
      .map(([r, c]) => `${r}: ${c} times`)
      .join(', ');
    lines.push('FREQUENT REJECT REASONS: ' + reasons);
  }
  // Both emitted only when populated, so the pinned no-skip prompt is unchanged.
  const { suppressed, soft } = signal.genre_suppression;
  if (suppressed.length) {
    lines.push(
      'WRONG-GENRE SKIPS (genres of books the reader recently skipped as the wrong ' +
        'genre; candidates carrying them were already removed, so heavily penalize any ' +
        'candidate that is still the same kind of book):\n' +
        pyJsonDumps(suppressed)
    );
  }
  if (soft.length) {
    lines.push(
      'SOFT WRONG-GENRE SKIPS (the reader skipped a book in these genres as the wrong ' +
        'genre but rates other books in them highly, so the skip was likely about ' +
        'something else; treat it as a mild signal only, never a reason to drop the ' +
        'genre):\n' +
        pyJsonDumps(soft)
    );
  }
  if (directiveText) {
    lines.push(
      "CUSTOM INSTRUCTIONS (the reader's own standing guidance, in their words; honor " +
        'it as direct high-priority intent, second only to the hard constraints already ' +
        'applied to the candidate set):\n' +
        directiveText
    );
  }
  lines.push(
    'Favor candidates resembling the more-like books; penalize candidates ' +
      'resembling the less-like books; penalize candidates matching frequent reject ' +
      "reasons; weight trait influence by each trait's `user_weight`: traits with a " +
      'lower weight should influence the score less (0.0 = ignore, 1.0 = normal).' +
      // CONDITIONAL ON PURPOSE. recommend-run.test.ts asserts this whole block
      // byte-for-byte against fixtures/claude/prompts.json for a reader with no
      // favorites; an unconditional clause breaks that fixture.
      (hasFavorites
        ? ' Separately, reward candidates by a favorite author or carrying a favorite ' +
          'subject: treat those as strong positive evidence, second only to the ' +
          "reader's own custom instructions."
        : '')
  );
  return lines.join('\n\n');
}

/** recommend._claude_rerank's message content. */
export function buildRerankPrompt(
  candidates: AssembledCandidate[],
  signal: RecSignal,
  n: number
): PromptBlock[] {
  const indexed = candidates.map((c, i) => ({
    idx: i,
    title: c.title,
    author: c.author,
    year: c.year,
    subjects: c.subjects ?? [],
  }));

  const rejectedBlock = signal.rejected_with_notes.length
    ? '\n\nREJECTED RECOMMENDATIONS WITH NOTES (JSON):\n' +
      'These are books the reader explicitly skipped with an explanation. Treat ' +
      'each note as direct testimony about what to avoid; heavily penalize ' +
      'candidates that share the same qualities.\n' +
      pyJsonDumps(signal.rejected_with_notes)
    : '';

  const profileContext = tasteAndLoved(signal) + rejectedBlock + userSteeringBlock(signal);

  // Up to n, not exactly n (QA 2026-10-30): a deck padded to n with picks the reranker
  // itself doubted served "a stretch" and "metadata is thin" rationales. The floor clause
  // gives recommendRun's MIN_DECK backfill something to draw on.
  const floor = Math.min(MIN_DECK, n);
  const taskPrompt =
    `Rank up to ${n} of the best candidates for this reader and explain each. Return ` +
    `fewer than ${n} rather than padding the list with weak fits: if fewer than ${floor} ` +
    `are strong, add the next-best up to ${floor} picks and mark those low_confidence. ` +
    'Choose ONLY from ' +
    'the CANDIDATES list (cite each by its `idx`). Score 0..1 for fit. Penalize ' +
    "anything that trips an aversion trait or resembles a rejected book's noted reason. " +
    'Ground every pick in specific trait ids ' +
    'and the library book ids it most resembles - use only ids that appear above.\n\n' +
    'CANDIDATES (JSON):\n' +
    pyJsonDumps(indexed);

  return [
    { type: 'text', text: profileContext, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: taskPrompt },
  ];
}
