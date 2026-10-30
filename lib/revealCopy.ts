// Static reveal copy (started from wrapped-reveal-copy.md). No logic beyond selection.

/** One line per winning axis pole (Beat 6). Keys are `${axisKey}:${letter}`. */
export const POLE_LINES: Record<string, string> = {
  'lens:I': 'You read to leave. A book that can’t transport you isn’t doing its job.',
  'lens:R': 'You read to think. The book is a conversation, and you talk back.',
  'engine:P': 'Momentum is non-negotiable. A story owes you forward motion.',
  'engine:C': 'People are the plot. Everything else is scenery.',
  'range:B': 'Your shelf refuses a genre. Range isn’t indecision — it’s appetite.',
  'range:D':
    'You go deep, not wide. Loyalty is your love language — to genres, to series, to authors.',
  'resonance:H': 'A book earns its keep in feeling. If it didn’t move you, it didn’t happen.',
  'resonance:M': 'Structure is beautiful to you. You admire the how as much as the what.',
};

/**
 * Softer lines for a pole won by a narrow margin, where the strong line overstates it ("Your
 * shelf refuses a genre" for a reader who only leans broad).
 */
export const NEAR_CENTER_POLE_LINES: Record<string, string> = {
  'lens:I': 'You lean toward books that take you somewhere else.',
  'lens:R': 'You lean toward books that give you something to think about.',
  'engine:P': 'You lean toward a story that keeps moving.',
  'engine:C': 'You lean toward the people over the plot.',
  'range:B': 'You lean broad: a home genre or two, with plenty of wandering.',
  'range:D': 'You lean deep: you wander, but you keep coming back to the same kinds of book.',
  'resonance:H': 'You lean toward books that move you.',
  'resonance:M': 'You lean toward books built with visible care.',
};

/** range:D for a library with no repeat author and no series: genre loyalty only. */
export const DEEP_WITHOUT_LOYALTY_LINE =
  'You go deep, not wide. Once a kind of book works for you, you keep reading it.';

/** What each axis measures, in the reader's terms (Beat 6 heading and description). */
export const AXIS_COPY: Record<
  'lens' | 'engine' | 'range' | 'resonance',
  { label: string; question: string }
> = {
  lens: {
    label: 'Why you read',
    question: 'To be carried somewhere else, or to think something through?',
  },
  engine: {
    label: 'What pulls you through',
    question: 'What happens next, or who it is happening to?',
  },
  range: {
    label: 'How far you roam',
    question: 'Across every shelf, or deep into a few?',
  },
  resonance: {
    label: 'What stays with you',
    question: 'What a book made you feel, or how it was made?',
  },
};

/**
 * Beat 2 rating quip, chosen by average rating. The Goodreads-wide average sits near 3.9, so a
 * 4.1 is a generous rater, and "critic" is kept for averages clearly below the norm.
 */
export function ratingQuip(avg: number | null): string {
  if (avg === null) return '';
  if (avg >= 4.0)
    return 'You rate high. Either you’re generous, or you’re very good at picking your next book. We suspect the second.';
  if (avg >= 3.7)
    return 'You rate about where most readers do. A five from you still means something.';
  if (avg >= 3.2) return 'You rate like a critic — the stars have to be earned.';
  return 'You are not an easy audience. Good. That makes the five-stars mean something.';
}

/** Beat 5 format line, chosen by dominant format. Fiction copy; nonfiction shelves skip it. */
export const FORMAT_LINES: Record<'novel' | 'novella' | 'collection' | 'series', string> = {
  series: 'Mostly series. You don’t want a story — you want a residence.',
  novel: 'Standalones, mostly. One book, one world, done right.',
  novella: 'You like them short and sharp. Length is not depth, and you know it.',
  collection: 'Story collections keep showing up. You read like a taster, not a tourist.',
};
