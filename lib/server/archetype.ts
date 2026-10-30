/** Static archetype data, ported from mylibrary/archetype.py (two taglines since reworded). */

export const AXIS_LETTERS: Record<string, { left: string; right: string }> = {
  lens: { left: 'I', right: 'R' },
  engine: { left: 'P', right: 'C' },
  range: { left: 'B', right: 'D' },
  resonance: { left: 'H', right: 'M' },
};

/** Negative or zero → left letter; positive → right letter. */
export function scoreToLetter(axis: keyof typeof AXIS_LETTERS, score: number): string {
  const a = AXIS_LETTERS[axis];
  return score > 0 ? a.right : a.left;
}

/** The 4-char code assembly order — twin of archetype.py::scores_to_code's concatenation order. */
export const AXIS_ORDER = ['lens', 'engine', 'range', 'resonance'] as const;

/** Port of archetype.py::scores_to_code (105-112). */
export function scoresToCode(scores: {
  lens: number;
  engine: number;
  range: number;
  resonance: number;
}): string {
  return AXIS_ORDER.map((axis) => scoreToLetter(axis, scores[axis])).join('');
}

/** Port of archetype.py:54-71's ARCHETYPES dict — code → {name, tagline}. */
export const ARCHETYPES: Record<string, { name: string; tagline: string }> = {
  IPBH: { name: 'The Wandering Escapist', tagline: 'Give me a new world every week.' },
  IPBM: { name: 'The Plot Mechanic', tagline: 'A perfect engine of a story.' },
  IPDH: { name: 'The Serial Thrill-Seeker', tagline: 'One more chapter. Always one more.' },
  IPDM: { name: 'The Genre Architect', tagline: 'The rules of the genre exist to be mastered.' },
  ICBH: { name: 'The Empathic Rover', tagline: 'Show me how different people feel.' },
  ICBM: { name: 'The Character Analyst', tagline: 'Tell me who they are, not what happens.' },
  ICDH: { name: 'The Devoted Fan', tagline: 'I live in this world now.' },
  ICDM: { name: 'The Deep Empath', tagline: 'I only finish books that feel true.' },
  RPBH: { name: 'The Conscious Adventurer', tagline: 'Beautiful prose AND a great story.' },
  RPBM: { name: 'The Eclectic Critic', tagline: "I'll read anything once, and have opinions." },
  RPDH: { name: 'The Committed Purist', tagline: 'I know exactly what I like, and why.' },
  RPDM: { name: 'The Structural Connoisseur', tagline: 'Architecture and execution, above all.' },
  RCBH: { name: 'The Literary Wanderer', tagline: 'Voice and feeling, across every genre.' },
  RCBM: { name: 'The Cerebral Explorer', tagline: 'Minds first: complex characters, big ideas.' },
  RCDH: { name: 'The Canon Keeper', tagline: 'A few authors, read completely and deeply.' },
  RCDM: { name: 'The Cerebral Architect', tagline: 'A well-built mind on the page is everything.' },
};

export const ARCHETYPE_HOOKS: Record<string, string> = {
  IPBH: 'wants the portal, not the postcard',
  IPBM: 'can hear a plot click into place',
  IPDH: 'has said "one more chapter" and meant it, at 3 a.m., seven times',
  IPDM: 'reads a genre the way an engineer reads a blueprint',
  ICBH: "collects other people's inner lives",
  ICBM: 'would rather understand a character than like one',
  ICDH: 'reread the whole series to get ready for the new one',
  ICDM: "can't be fooled by a false note in a character",
  RPBH: 'refuses to choose between a page-turner and a poem',
  RPBM: "has never met a genre they wouldn't cross-examine",
  RPDH: 'ordered the same thing twice because it was perfect',
  RPDM: 'sees the load-bearing walls in every story',
  RCBH: 'follows voices across any border',
  RCBM: 'reads minds for sport',
  RCDH: 'keeps a canon and tends it like a garden',
  RCDM: 'admires a well-built mind above all fireworks',
};

/** What the library itself shows; see libraryShape.ts. */
export interface ArchetypeLibraryFacts {
  repeatAuthors: boolean;
  readsSeries: boolean;
  mostlyNonfiction: boolean;
}

type CopyOverride = { tagline?: string; hook?: string };

/**
 * Copy for a "Deep" code whose library has no repeat author and no series. Deep also means genre
 * loyalty, so the code stands, but copy about following authors or series would contradict the
 * reveal's own "no repeat authors" line.
 */
const NO_LOYALTY_COPY: Record<string, CopyOverride> = {
  ICDH: {
    tagline: 'When a kind of book works for me, I stay with it.',
    hook: 'reads the kind of book they love until the shelf runs out',
  },
  RCDH: { tagline: 'A few kinds of book, read closely and deeply.' },
};

/** Copy for a mostly-nonfiction library, where "story", "plot" and "world" do not fit. */
const NONFICTION_COPY: Record<string, CopyOverride> = {
  IPBH: { tagline: 'Give me a new subject every week.' },
  IPBM: {
    tagline: 'A book that runs like a well-tuned engine.',
    hook: 'can hear an argument click into place',
  },
  IPDM: { tagline: 'The rules of a field exist to be mastered.' },
  ICDH: {
    tagline: 'When a subject gets me, I stay with it.',
    hook: 'reads everything on a subject before moving on',
  },
  ICBM: { tagline: 'Tell me who they are, not just what they did.' },
  RPBH: { tagline: 'Beautiful prose AND a story worth telling.' },
  RCBM: { tagline: 'Minds first: complex people, big ideas.' },
  RCDH: { tagline: 'A few subjects, read closely and deeply.' },
};

/**
 * The tagline and finale hook for `code`, fitted to what the library shows. The name stays the
 * code's own (it pairs with the reader sprite); only the descriptive copy varies.
 */
export function archetypeCopy(
  code: string,
  facts: ArchetypeLibraryFacts
): { tagline: string; hook: string } {
  const overrides: (CopyOverride | undefined)[] = [
    facts.repeatAuthors || facts.readsSeries ? undefined : NO_LOYALTY_COPY[code],
    facts.mostlyNonfiction ? NONFICTION_COPY[code] : undefined,
  ];
  let tagline = ARCHETYPES[code]?.tagline ?? '';
  let hook = ARCHETYPE_HOOKS[code] ?? '';
  for (const o of overrides) {
    tagline = o?.tagline ?? tagline;
    hook = o?.hook ?? hook;
  }
  return { tagline, hook };
}
