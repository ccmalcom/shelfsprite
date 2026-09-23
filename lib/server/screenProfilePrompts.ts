/**
 * The screen variant of the taste-profile prompts and tools (spec 2026-09-22 §5.2, §5.4, §5.5).
 *
 * These are deliberate COPIES of profileBuild.ts / profileUpdate.ts's book prompts, edited for two
 * media. The book prompts are pinned byte-for-byte by profile-books-golden.test.ts and must never
 * be edited to serve the screen variant. Tool NAMES are shared (record_taste_traits,
 * revise_taste_traits), so toolInput and persistence treat both variants alike; the schemas
 * differ by the two title fields.
 *
 * Must not import profileBuild.ts or profileUpdate.ts: both import this module.
 */
import { feedbackBlock, type FeedbackContext } from './profileFeedback';
import type { Tiers } from './profileTiers';
import type { ScreenTierBuild } from './screenTiers';
import { pyJsonDumps, pyRepr } from './serialize';

const ID_ARRAY = { type: 'array', items: { type: 'integer' } };

export const SCREEN_TRAIT_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    traits: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: {
            type: 'string',
            description:
              'A specific, falsifiable claim about what drives this ' +
              "person's ratings, e.g. 'Rewards dense political " +
              "world-building over fast plotting.' Avoid generic " +
              'genre statements. When the evidence spans books and ' +
              'films or shows, phrase the claim medium-neutrally.',
          },
          polarity: {
            type: 'string',
            enum: ['reward', 'aversion'],
            description:
              "'reward' = trait associated with higher ratings; " +
              "'aversion' = trait shared by lower-rated items.",
          },
          exhibits: {
            ...ID_ARRAY,
            description:
              'Book ids (from LIBRARY DATA only) that EXHIBIT the trait: ' +
              "for a 'reward', the high-rated books showing it; for an " +
              "'aversion', the low-rated or DNF books showing it. May be " +
              'empty when the trait rests on films or shows alone.',
          },
          contrasts: {
            ...ID_ARRAY,
            description:
              'Book ids (from LIBRARY DATA only) that anchor the CONTRAST — ' +
              'the counter-examples that make the distinction sharp. May be empty.',
          },
          exhibit_titles: {
            ...ID_ARRAY,
            description:
              'Title ids (from SCREEN DATA only) of films and shows that ' +
              'EXHIBIT the trait, under the same polarity rule as ' +
              "`exhibits`: high-rated for a 'reward', low-rated or dropped " +
              "for an 'aversion'. May be empty when the trait rests on books " +
              'alone, but every trait needs at least one exhibit in ' +
              '`exhibits` or `exhibit_titles`.',
          },
          contrast_titles: {
            ...ID_ARRAY,
            description:
              'Title ids (from SCREEN DATA only) that anchor the CONTRAST. May be empty.',
          },
          inference_confidence: {
            type: 'number',
            description: '0..1 — how strongly the evidence supports the claim.',
          },
        },
        required: [
          'claim',
          'polarity',
          'exhibits',
          'contrasts',
          'exhibit_titles',
          'contrast_titles',
          'inference_confidence',
        ],
      },
    },
  },
  required: ['traits'],
};

export const SCREEN_PROFILE_TOOL = {
  name: 'record_taste_traits',
  description:
    "Record the taste traits inferred from the person's rated books, films and TV shows. " +
    'Each trait must distinguish rating tiers and cite the book ids and/or title ids that ' +
    'support it.',
  input_schema: SCREEN_TRAIT_INPUT_SCHEMA,
};

export const SCREEN_REVISE_TOOL = {
  name: 'revise_taste_traits',
  description:
    "Return the REVISED full taste-trait set after accounting for the person's " +
    'latest rating, review and watch-status changes. Keep traits that still hold (adjusting ' +
    'confidence or evidence as warranted), drop traits the new evidence contradicts, and add ' +
    'new traits the changes reveal. Cite only book ids and title ids present in the provided ' +
    'data, each in its own field.',
  input_schema: SCREEN_TRAIT_INPUT_SCHEMA,
};

export const SCREEN_PROFILE_SYSTEM =
  "You are a taste analyst. You infer what drives a specific person's ratings of books, " +
  'films and TV shows from their library metadata. You reason about CONTRAST between rating ' +
  'tiers, never asserting a trait without citing the books or titles that evidence it. You ' +
  'only cite book ids and title ids that appear in the provided data, each in its own field.';

export const SCREEN_REVISE_SYSTEM =
  "You are a taste analyst maintaining a person's evolving taste profile across books, films " +
  'and TV shows. You are given the profile you previously inferred plus the most recent ' +
  'rating, review and watch-status changes. You make the SMALLEST revision that honors the ' +
  'new evidence: keep what still holds, adjust confidence where the new data strengthens or ' +
  'weakens a claim, retire claims the new evidence contradicts, and add genuinely new traits. ' +
  "Review text is the person's own words — weight it above metadata inference. Cite only book " +
  'ids and title ids that appear in the provided data, each in its own field.';

function bookTierCounts(tiers: Tiers): Map<string, number> {
  return new Map([...tiers.entries()].map(([k, v]) => [k, v.length]));
}

/** Full-build prompt, screen variant: the book prompt's structure plus SCREEN DATA. */
export function buildScreenProfilePrompt(
  tiers: Tiers,
  screen: ScreenTierBuild,
  feedback: FeedbackContext | null
): string {
  return (
    "Below is a person's library in two media: books (LIBRARY DATA) and films and TV shows " +
    '(SCREEN DATA), each grouped by star rating and status. Books carry enriched metadata ' +
    '(subjects, year, length, series); films and shows carry genres, directors or creators, ' +
    'and the works they are based on. Most items have no review text, so reason mainly from ' +
    'metadata + the rating tiers — but where an item carries a `review` field, those are the ' +
    "person's own words: treat them as the strongest, most direct signal, above any metadata " +
    'inference.\n\n' +
    `Book tier sizes: ${pyRepr(bookTierCounts(tiers))}. ` +
    `Screen tier sizes as sent: ${pyRepr(screen.sent)}. ` +
    `Screen tier sizes in total, before the volume cap: ${pyRepr(screen.total)}. ` +
    "Note the heavy positive skew — 'loved it' has low discriminative power, so focus on what " +
    'is genuinely distinguishing.\n\n' +
    'Books are rated on Goodreads or in ShelfSprite and films and shows on Letterboxd, and ' +
    'rating habits differ between the two. Compare tiers within a medium; do not treat a ' +
    '4-star film and a 4-star book as equally loved.\n\n' +
    'The `dnf` book tier and the `dropped` screen tiers contain books the person abandoned ' +
    'before finishing and films or shows they stopped watching. Treat these as the strongest ' +
    'possible aversion signal, even stronger than 1-2 star ratings. Any `review` field on them ' +
    'is direct first-person evidence explaining why they quit.\n\n' +
    "Each medium's `rejected` tier contains items the person explicitly skipped when " +
    'recommended, with a note explaining why. These are direct first-person statements of ' +
    'aversion — treat each `note` as reliable testimony about what this person does NOT want, ' +
    'and use them to sharpen aversion traits.\n\n' +
    "Infer the person's taste traits. Prioritize, in order:\n" +
    '  1. What separates the 5-star items from the 4-star items, within each medium?\n' +
    '  2. What do the lowest-rated items (<=2 and 3), DNF books, dropped titles, and rejected ' +
    "recommendations share? (these are 'aversion' traits)\n" +
    '  3. Cross-cutting rewards visible across the high tiers — including patterns that hold ' +
    'across books AND films or shows.\n\n' +
    'Evidence may span media: a trait may cite books, titles, or both. When its evidence spans ' +
    'both media, phrase the claim medium-neutrally ("stories", "worlds", "characters") rather ' +
    'than as a claim about novels or films alone.\n\n' +
    'For EACH trait, split the evidence into four fields. Book ids and title ids are separate ' +
    'namespaces: book ids come only from LIBRARY DATA and go only in `exhibits`/`contrasts`; ' +
    'title ids come only from SCREEN DATA and go only in `exhibit_titles`/`contrast_titles`.\n' +
    '  - `exhibits` and `exhibit_titles`: the books and titles that SHOW the trait. These MUST ' +
    "match the polarity — an aversion's exhibits are LOW-rated (or DNF, or dropped), a reward's " +
    "exhibits are HIGH-rated. Never put high-rated items in an aversion's exhibits, in either " +
    'medium.\n' +
    '  - `contrasts` and `contrast_titles`: the counter-examples that sharpen the distinction. ' +
    'May be empty.\n' +
    '  - Every trait needs at least one exhibit in `exhibits` or `exhibit_titles`.\n\n' +
    'Temporal context: The `read_year` field shows when each book was read (or added to the ' +
    'shelf) and `watched_year` when each film or show was last watched. Tastes evolve, so ' +
    'weight this accordingly:\n' +
    '  - Recent reads and watches (2020+) are the strongest signal of current preferences.\n' +
    '  - Mid-era ones (2015-2019) are relevant but may reflect a transitional period.\n' +
    '  - Older ones (pre-2015) may reflect a different life stage entirely — for example, a ' +
    "heavy YA phase in one's teens is not necessarily a current preference.\n" +
    '  - A title with no `watched_year` has no known watch date; do not treat it as old.\n' +
    '  - Lower `inference_confidence` for traits supported only by older items unless those ' +
    'same traits are echoed in more recent ones. If a trait is consistent across all eras, ' +
    'call it an enduring preference (and note that in the claim).\n' +
    '  IMPORTANT EXCEPTION — do NOT apply temporal discounting to traits rooted in values or ' +
    'representation (e.g. LGBTQ+ themes, feminist perspectives, racial or political identity ' +
    "in fiction). A person's core values rarely regress with age: the absence of such themes " +
    'in recent items more likely reflects what was available than a shift in preferences. If ' +
    'a value-based trait is consistent across any era of the library, treat it as enduring ' +
    'regardless of when those items were read or watched. Only downweight it if recent items ' +
    'actively contradict it.\n\n' +
    'Quality rules:\n' +
    '  - Use ONLY book ids from LIBRARY DATA and title ids from SCREEN DATA.\n' +
    '  - Make claims specific and falsifiable, not generic genre labels ("drama film" is not a ' +
    'trait).\n' +
    "  - Do NOT force an item into a trait it doesn't fit just to pad the evidence.\n" +
    "  - Keep traits DISTINCT — don't emit two traits describing the same pattern.\n" +
    '  - Distinguish genuine taste from mechanical rating drift (e.g. later books in a long ' +
    'series, or later films in a franchise, slipping a star is fatigue, not a standalone taste ' +
    'trait).\n' +
    '  - Lower your inference_confidence when a trait rests on very few items.\n' +
    '  - Aim for 6-12 traits. Record them with the record_taste_traits tool.\n\n' +
    'LIBRARY DATA (JSON):\n' +
    pyJsonDumps(tiers) +
    '\n\nSCREEN DATA (JSON):\n' +
    pyJsonDumps(screen.tiers) +
    feedbackBlock(feedback)
  );
}

/** Incremental prompt, screen variant: changed and cited books AND titles (spec §5.5). */
export function buildScreenUpdatePrompt(
  currentTraits: Record<string, unknown>[],
  booksMeta: Map<string, Record<string, unknown>>,
  titlesMeta: Map<string, Record<string, unknown>>,
  changedIds: number[],
  changedTitleIds: number[],
  feedback: FeedbackContext | null
): string {
  return (
    'The person has updated some ratings, reviews or watch statuses since this profile was ' +
    'last built. Revise the profile accordingly — do NOT re-derive it from scratch.\n\n' +
    'You are NOT given the whole library, only the items needed to reason about the change: ' +
    'the books and titles that changed, plus the books and titles the current traits already ' +
    'cite. Cite book ids only from the BOOKS map and title ids only from the TITLES map below; ' +
    'the two id namespaces are separate.\n\n' +
    'Each title carries its current `rating` and `status`. A title whose status is `want`, or ' +
    'that is `watched`/`watching` with no rating, is not evidence: remove it from every trait ' +
    'that cites it and do not cite it. A `dropped` title is aversion evidence even unrated.\n\n' +
    'How to revise:\n' +
    '  - Keep traits that still hold. Raise/lower `inference_confidence` if the new evidence ' +
    'strengthens or weakens them, and add/remove cited ids as fitting.\n' +
    '  - Drop a trait whose evidence the changes now contradict (e.g. the person re-rated its ' +
    'key exhibit, or a new review states the opposite).\n' +
    '  - Add new traits the changes reveal — especially anything stated outright in a review.\n' +
    '  - A new/edited `review` is direct testimony; prefer it over metadata guesses.\n' +
    '  - When a trait now spans books and titles, phrase it medium-neutrally.\n' +
    '  - Every trait needs at least one exhibit in `exhibits` or `exhibit_titles`.\n' +
    '  - Return the COMPLETE revised trait set (the unchanged traits too), 6-12 traits, via the ' +
    'revise_taste_traits tool.\n\n' +
    `CHANGED BOOK IDS (the edits driving this update): ${pyRepr(changedIds)}\n` +
    `CHANGED TITLE IDS (the edits driving this update): ${pyRepr(changedTitleIds)}\n\n` +
    'CURRENT TRAITS (JSON):\n' +
    pyJsonDumps(currentTraits) +
    '\n\nBOOKS (id -> metadata; the only books you may cite) (JSON):\n' +
    pyJsonDumps(booksMeta) +
    '\n\nTITLES (id -> metadata; the only titles you may cite) (JSON):\n' +
    pyJsonDumps(titlesMeta) +
    feedbackBlock(feedback)
  );
}
