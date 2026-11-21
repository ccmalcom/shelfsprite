/**
 * "Pick my next read": rank the reader's own to-read shelf against their taste.
 *
 * Unlike the recommender's rerank, the candidates here are books the reader already saved,
 * not catalog retrieval, so there is no Stage 1 and nothing new can enter: the tool cites a
 * shelf book by index and nextReadRun drops any index that is not on the list. The taste
 * context reuses the recommender's `tasteAndLoved` serialization; the steering block is this
 * file's own, because the recommender's (userSteeringBlock) talks about a candidate pool that
 * filters already ran over, which is not true of a shelf.
 */
import type { PromptBlock } from './recPrompts';
import { tasteAndLoved } from './recPrompts';
import type { RecSignal } from './recSignal';
import { pyJsonDumps } from './serialize';

export const NEXT_READ_MAX_TOKENS = 2000;

/** Descriptions are trimmed to this many characters: enough to judge mood and premise. */
export const NEXT_READ_DESC_CHARS = 400;

/** One to-read book as the prompt sees it. */
export interface NextReadCandidate {
  title: string;
  author: string | null;
  year: number | null;
  subjects: string[];
  series: string | null;
  description: string | null;
  page_count: number | null;
  date_added: string | null;
}

export const NEXT_READ_TOOL = {
  name: 'pick_next_reads',
  description:
    "Pick the books from the reader's own to-read shelf they should read next, best first, " +
    'and explain each pick. Choose ONLY from the given shelf.',
  input_schema: {
    type: 'object',
    properties: {
      picks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            candidate_index: {
              type: 'integer',
              description: 'The `idx` of a book on the provided shelf. Must exist.',
            },
            score: {
              type: 'number',
              description: "0..1 fit with the reader's taste right now.",
            },
            rationale: {
              type: 'string',
              description:
                '1-2 sentences in the voice of a well-read friend: why this one next, ' +
                'anchored to at most two loved books by title, naming the mechanism of the ' +
                'fit. Plain punctuation, no em dashes. No generic praise.',
            },
          },
          required: ['candidate_index', 'score', 'rationale'],
        },
      },
    },
    required: ['picks'],
  },
};

export const NEXT_READ_SYSTEM =
  'You help a reader decide what to read next from books they already saved to their ' +
  "to-read shelf. You rank a fixed list of the reader's own saved books against their " +
  'evidence-backed taste profile and the books they loved. You never suggest a book that ' +
  'is not on the list. Favor the strongest fit with their taste and respect aversion ' +
  'traits. When fits are close, prefer variety across your picks (no two books by the ' +
  'same author or from the same series), and prefer the first book of a series over a ' +
  'later one. Use the metadata given; where it is thin, rely only on what you reliably ' +
  'know about that exact title and author, and say so honestly when you are unsure.\n\n' +
  'Write each rationale like a well-read friend, in 1-2 sentences: say why this one should ' +
  'be next, anchored to at most two books they loved by title, and name the mechanism of ' +
  'the fit (pace, voice, structure, mood, subject), never just shared genre. Use plain ' +
  'punctuation only: no em dashes. Never write "you\'ll love this", generic praise, or ' +
  'clinical trait language.';

/** The reader's explicit steering, emitted only where present. */
export function nextReadSteering(signal: RecSignal): string {
  const lines: string[] = [];
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
  const directiveText = (signal.directive_text ?? '').trim();
  if (directiveText) {
    lines.push(
      "CUSTOM INSTRUCTIONS (the reader's own standing guidance, in their words):\n" + directiveText
    );
  }
  return lines.length ? '\n\n## User Steering\n\n' + lines.join('\n\n') : '';
}

function trimDescription(text: string | null): string | null {
  if (!text) return null;
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= NEXT_READ_DESC_CHARS) return clean || null;
  return clean.slice(0, NEXT_READ_DESC_CHARS).trimEnd() + '...';
}

export function buildNextReadPrompt(
  candidates: NextReadCandidate[],
  signal: RecSignal,
  n: number
): PromptBlock[] {
  const indexed = candidates.map((c, i) => ({
    idx: i,
    title: c.title,
    author: c.author,
    year: c.year,
    series: c.series,
    pages: c.page_count,
    subjects: c.subjects.slice(0, 8),
    description: trimDescription(c.description),
    saved_on: c.date_added,
  }));

  const profileContext = tasteAndLoved(signal) + nextReadSteering(signal);
  const taskPrompt =
    `Pick the ${n} books from this reader's TO-READ SHELF they should read next, best ` +
    'first, and explain each. Choose ONLY from the shelf below (cite each by its `idx`). ' +
    'Score 0..1 for fit. Penalize anything that trips an aversion trait.\n\n' +
    'TO-READ SHELF (JSON):\n' +
    pyJsonDumps(indexed);

  return [
    { type: 'text', text: profileContext, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: taskPrompt },
  ];
}
