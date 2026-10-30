import type {
  Trait,
  ArchetypeOut,
  ProfileHighlights,
  Stats,
  Book,
  Directive,
  TitleOut,
} from './api';
import {
  AXIS_COPY,
  DEEP_WITHOUT_LOYALTY_LINE,
  FORMAT_LINES,
  NEAR_CENTER_POLE_LINES,
  POLE_LINES,
  ratingQuip,
} from './revealCopy';

const AXIS_ORDER = ['lens', 'engine', 'range', 'resonance'] as const;
export type AxisKey = (typeof AXIS_ORDER)[number];

const REWARD_CAP = 5;
const REWARD_CAP_THIN = 2;
const LOW_CONFIDENCE_MAX = 0.45; // bottom band -> softened frame
const NEAR_CENTER_MAX = 0.25;
/** Two traits whose exhibits overlap this much (Jaccard) read as the same beat twice. */
const SAME_EVIDENCE_MIN = 0.75;
/** Above this share, one genre is the shelf: "refuses a genre" would contradict it. */
const DOMINANT_GENRE_SHARE = 0.5;

/**
 * The sentence a reader sees for a trait: the reveal line, unless the reader rewrote the trait
 * (an edit is their own words; a reveal line written before it would undo the edit).
 */
export function readerLine(t: Trait): string {
  return t.status === 'edited' ? t.claim : (t.reveal_line ?? t.claim);
}

export interface GenreHighlight {
  subject: string;
  share: number;
}

export interface AversionItem {
  trait: Trait;
  evidence: string; // one reader-facing sentence, already assembled from the evidence book
}

/** How the shown contrast book was rated against the trait's evidence books. */
export type ContrastRelation = 'lower' | 'higher' | 'same' | null;

export type Beat =
  | { kind: 'cold-open'; nBooks: number; thin: boolean }
  | {
      kind: 'numbers';
      nRated: number;
      nAuthors: number;
      topGenre: string | null;
      avg: number | null;
      quip: string;
    }
  | {
      kind: 'reward-trait';
      trait: Trait;
      lowConfidence: boolean;
      exhibitTitles: string[];
      contrastTitles: string[];
      contrastRelation: ContrastRelation;
    }
  | { kind: 'aversions'; items: AversionItem[] }
  | { kind: 'shelves'; genres: GenreHighlight[]; authors: string[]; formatLine: string | null }
  | {
      kind: 'axis';
      axisKey: AxisKey;
      letter: string;
      poleLine: string;
      /** Reader-facing name and question for the axis; the model's scoring notes stay internal. */
      label: string;
      question: string;
      nearCenter: boolean;
      codeSoFar: string;
    }
  | { kind: 'finale'; archetype: ArchetypeOut; nBooks: number; thin: boolean }
  | { kind: 'directive'; nlText: string | null }
  | { kind: 'handoff' }
  // summary counts are computed live in the component from verdict state; this beat
  // only marks position + carries the thin flag for copy selection.
  | { kind: 'summary'; thin: boolean };

export interface BuildBeatsInput {
  stats: Stats;
  traits: Trait[];
  archetype: ArchetypeOut;
  highlights: ProfileHighlights;
  books: Book[];
  directive?: Directive | null;
  /** The screen library, passed only while ScreenSprite is on (spec §7.5). */
  titles?: TitleOut[];
}

function aversionEvidence(
  trait: Trait,
  byId: Map<number, Book>,
  titleById: Map<number, TitleOut>
): string {
  const bookId = (trait.exhibits ?? [])[0];
  const book = bookId != null ? byId.get(bookId) : undefined;
  if (!book) return titleAversionEvidence(trait, titleById);
  const title = `\u201C${book.title}\u201D`;
  if (book.exclusive_shelf === 'did-not-finish') return `You never finished ${title}.`;
  return ratedEvidence(title, book.effective_rating);
}

/** "Case in point: “X”, which you gave 2 stars." */
function ratedEvidence(label: string, stars: number | null): string {
  if (stars === null) return `Case in point: ${label}.`;
  return `Case in point: ${label}, which you gave ${stars} star${stars === 1 ? '' : 's'}.`;
}

/** How a cited film or show reads inside a beat's plain strings. */
function titleEvidenceLabel(t: TitleOut): string {
  return `${t.title} (${t.media_type === 'tv' ? 'TV' : 'film'})`;
}

function titleAversionEvidence(trait: Trait, titleById: Map<number, TitleOut>): string {
  const titleId = (trait.exhibit_title_ids ?? [])[0];
  const t = titleId != null ? titleById.get(titleId) : undefined;
  if (!t) return '';
  const label = titleEvidenceLabel(t);
  if (t.status === 'dropped') return `You never finished ${label}.`;
  return ratedEvidence(label, t.rating);
}

function jaccard(a: number[], b: number[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  let both = 0;
  for (const x of sa) if (sb.has(x)) both += 1;
  const either = sa.size + sb.size - both;
  return either === 0 ? 0 : both / either;
}

/** Book and title exhibits as one id space (titles negated), for comparing two traits. */
function evidenceKeys(t: Trait): number[] {
  return [...(t.exhibits ?? []), ...(t.exhibit_title_ids ?? []).map((id) => -1 - id)];
}

/**
 * Drops a trait whose exhibits (nearly) repeat an earlier one's. The list is already strongest
 * first, so the stronger of two look-alike traits keeps its beat; the other stays on the profile.
 */
function distinctEvidence(traits: Trait[]): Trait[] {
  const kept: Trait[] = [];
  for (const t of traits) {
    const keys = evidenceKeys(t);
    const repeats =
      keys.length >= 2 && kept.some((k) => jaccard(keys, evidenceKeys(k)) >= SAME_EVIDENCE_MIN);
    if (!repeats) kept.push(t);
  }
  return kept;
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
}

/** Series are a real part of the shelf; the same test as libraryShape.ts on the server. */
function readsSeries(h: ProfileHighlights): boolean {
  const m = h.format_mix;
  const total = m.novel + m.novella + m.collection + m.series;
  return m.series >= 2 && m.series >= total * 0.2;
}

/**
 * The axis headline, kept consistent with how far the score leans and with what the shelf beat
 * just said: a narrow lean gets the softer line, "refuses a genre" needs no dominant genre, and
 * loyalty "to series, to authors" needs a repeat author or a series.
 */
function poleLine(
  axisKey: AxisKey,
  letter: string,
  nearCenter: boolean,
  highlights: ProfileHighlights
): string {
  const key = `${axisKey}:${letter}`;
  const dominantGenre = (highlights.top_genres[0]?.share ?? 0) >= DOMINANT_GENRE_SHARE;
  if (nearCenter || (key === 'range:B' && dominantGenre)) {
    return NEAR_CENTER_POLE_LINES[key] ?? POLE_LINES[key] ?? '';
  }
  if (key === 'range:D' && highlights.top_authors.length === 0 && !readsSeries(highlights)) {
    return DEEP_WITHOUT_LOYALTY_LINE;
  }
  return POLE_LINES[key] ?? '';
}

export function buildBeats(input: BuildBeatsInput): Beat[] {
  const { stats, traits, archetype, highlights, books } = input;
  const byId = new Map(books.map((b) => [b.id, b]));
  const title = (id: number) => byId.get(id)?.title;
  const titleById = new Map((input.titles ?? []).map((t) => [t.id, t]));
  const screenTitle = (id: number) => {
    const t = titleById.get(id);
    return t ? titleEvidenceLabel(t) : undefined;
  };

  const thin = highlights.thin;
  const beats: Beat[] = [];

  // Beat 1
  beats.push({ kind: 'cold-open', nBooks: stats.total, thin });

  // Beat 2
  beats.push({
    kind: 'numbers',
    nRated: stats.rated,
    nAuthors: highlights.n_authors,
    topGenre: highlights.top_genres[0]?.subject ?? null,
    avg: stats.mean_rating,
    quip: ratingQuip(stats.mean_rating),
  });

  // Beats 3 (rewards) — strongest confidence first, capped.
  const rewards = distinctEvidence(
    traits
      .filter((t) => t.polarity === 'reward' && t.status !== 'rejected')
      .slice()
      .sort((a, b) => b.inference_confidence - a.inference_confidence)
  ).slice(0, thin ? REWARD_CAP_THIN : REWARD_CAP);
  const bookRating = (id: number) => byId.get(id)?.effective_rating ?? null;
  const titleRating = (id: number) => titleById.get(id)?.rating ?? null;
  for (const t of rewards) {
    // The first contrast that resolves is the one shown; its rating is compared with the mean
    // of the evidence, so a 5-star contrast is never called a book that "didn't land".
    const contrasts = [
      ...(t.contrasts ?? []).map((id) => ({ label: title(id), rating: bookRating(id) })),
      ...(t.contrast_title_ids ?? []).map((id) => ({
        label: screenTitle(id),
        rating: titleRating(id),
      })),
    ].filter((c): c is { label: string; rating: number | null } => !!c.label);
    const evidenceAvg = mean(
      [
        ...(t.exhibits ?? []).map(bookRating),
        ...(t.exhibit_title_ids ?? []).map(titleRating),
      ].filter((r): r is number => r !== null)
    );
    const shown = contrasts[0];
    let contrastRelation: ContrastRelation = null;
    if (shown && shown.rating !== null && evidenceAvg !== null) {
      contrastRelation =
        shown.rating < evidenceAvg ? 'lower' : shown.rating > evidenceAvg ? 'higher' : 'same';
    }
    beats.push({
      kind: 'reward-trait',
      trait: t,
      lowConfidence: t.inference_confidence <= LOW_CONFIDENCE_MAX,
      exhibitTitles: [
        ...(t.exhibits ?? []).map(title),
        ...(t.exhibit_title_ids ?? []).map(screenTitle),
      ]
        .filter(Boolean)
        .slice(0, 4) as string[],
      contrastTitles: shown ? [shown.label] : [],
      contrastRelation,
    });
  }

  // Beat 4 (aversions grouped) — skipped in thin mode (spec: beats 3-6 compress).
  if (!thin) {
    const aversions = distinctEvidence(
      traits.filter((t) => t.polarity === 'aversion' && t.status !== 'rejected')
    );
    if (aversions.length > 0) {
      beats.push({
        kind: 'aversions',
        items: aversions.map((t) => ({ trait: t, evidence: aversionEvidence(t, byId, titleById) })),
      });
    }
  }

  // Beat 5 (shelves) — skipped in thin mode.
  if (!thin) {
    const dom = highlights.format_mix.dominant;
    beats.push({
      kind: 'shelves',
      genres: highlights.top_genres,
      authors: highlights.top_authors,
      // The format lines are about novels and series; a nonfiction shelf gets none.
      formatLine: dom && !highlights.mostly_nonfiction ? FORMAT_LINES[dom] : null,
    });
  }

  // Beat 6 (four axes) — skipped in thin mode; builds the code letter-by-letter.
  if (!thin) {
    let code = '';
    for (const axisKey of AXIS_ORDER) {
      const axis = archetype[axisKey];
      code += axis.letter;
      const nearCenter = Math.abs(axis.score) < NEAR_CENTER_MAX;
      beats.push({
        kind: 'axis',
        axisKey,
        letter: axis.letter,
        poleLine: poleLine(axisKey, axis.letter, nearCenter, highlights),
        label: AXIS_COPY[axisKey].label,
        question: AXIS_COPY[axisKey].question,
        nearCenter,
        codeSoFar: code,
      });
    }
  }

  // Beat 7 (finale)
  beats.push({ kind: 'finale', archetype, nBooks: stats.rated, thin });

  // Beat 8 (summary) — full library only; thin has nothing to summarize verdict-wise.
  if (!thin) beats.push({ kind: 'summary', thin });

  // Beat: custom instructions (standing directive), surfaced so the reader can see/refine it.
  beats.push({ kind: 'directive', nlText: input.directive?.nl_text ?? null });

  // Beat 9 (handoff)
  beats.push({ kind: 'handoff' });

  return beats;
}

/**
 * Whether the reveal may start as far as titles are concerned (spec §7.5): at once while
 * ScreenSprite is off, once the titles load while it is on. A failed settings or titles read
 * counts as settled, so a hiccup degrades to book-only evidence instead of a reveal that never
 * opens.
 */
export function titlesSettled(s: {
  screenEnabled: boolean | undefined;
  settingsFailed: boolean;
  titlesLoaded: boolean;
  titlesFailed: boolean;
}): boolean {
  if (s.screenEnabled === undefined) return s.settingsFailed;
  if (!s.screenEnabled) return true;
  return s.titlesLoaded || s.titlesFailed;
}
