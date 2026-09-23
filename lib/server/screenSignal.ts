/**
 * The screen recommender's single read of the reader (spec §6.2). Mirrors recSignal.ts:
 * every query carries an explicit ORDER BY so prompts are deterministic.
 *
 * Two deliberate differences from the book signal:
 *  - It reads BOTH media. A book-built profile with no rated films is enough (spec §6.2:
 *    "No loved-titles requirement").
 *  - Owned identity covers every title status, `want` included, plus every rejected
 *    screen recommendation, keyed three ways: QID, TVmaze id and normalizeTitleKey.
 */
import { and, asc, desc, eq } from 'drizzle-orm';
import { schema, type Db } from './db';
import {
  LOVED_MIN,
  loadDirective,
  loadTraitPayloads,
  mostCommon,
  type TraitPayload,
} from './recSignal';
import { effectiveRating } from './serialize';
import { effectiveTitleRating, isTitleProfileEvidence, normalizeTitleKey } from './titles';

export type MediaType = 'movie' | 'tv';

export const TOP_GENRES = 8;
export const TOP_PEOPLE = 6;
/** Spec §6.3 / index decision 1: the seed prompt lists up to this many owned titles. */
export const OWNED_LIST_CAP = 800;
export const REJECTED_LIST_CAP = 100;

export interface ScreenLovedBook {
  id: number;
  title: string;
  author: string | null;
  additional_authors: string[];
  rating: number;
  read_year: number | null;
}

export interface ScreenLovedTitle {
  id: number;
  type: MediaType;
  title: string;
  year: number | null;
  rating: number;
  genres: string[];
  people: string[];
  wikidata_qid: string | null;
  watched_year: number | null;
}

export interface FavoriteBook {
  id: number;
  title: string;
  author: string | null;
}

export interface FavoriteTitle {
  id: number;
  type: MediaType;
  title: string;
  year: number | null;
}

export interface ScreenRejectedNote {
  title: string;
  year: number | null;
  type: MediaType;
  note: string;
}

export interface ScreenSignal {
  traits: TraitPayload[];
  loved_books: ScreenLovedBook[];
  loved_titles: ScreenLovedTitle[];
  favorite_books: FavoriteBook[];
  favorite_titles: FavoriteTitle[];
  top_genres: string[];
  top_people: string[];
  original_languages: string[];
  owned_qids: Set<string>;
  owned_tvmaze_ids: Set<number>;
  owned_keys: Set<string>;
  owned_list: string[];
  rejected_list: string[];
  rejected_with_notes: ScreenRejectedNote[];
  more_like_titles: string[];
  less_like_titles: string[];
  reject_reason_counts: Map<string, number>;
  directive_text: string | null;
  directive_constraints: Record<string, unknown>;
}

const REJECTED_STATUS = 'rejected';

function stringList(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    : [];
}

function yearOf(date: string | null): number | null {
  return date ? Number(date.slice(0, 4)) : null;
}

function asMediaType(v: string): MediaType {
  return v === 'tv' ? 'tv' : 'movie';
}

export function titleLabel(title: string, year: number | null): string {
  return year === null ? title : `${title} (${year})`;
}

export async function buildScreenSignal(db: Db, userId: string): Promise<ScreenSignal> {
  // --- books: loved (for the adaptation bridge and the prompts) and favorites ---
  const bookRows = await db
    .select()
    .from(schema.books)
    .where(eq(schema.books.userId, userId))
    .orderBy(asc(schema.books.id));
  const loved_books: ScreenLovedBook[] = [];
  const favorite_books: FavoriteBook[] = [];
  for (const b of bookRows) {
    if (b.isFavorite) favorite_books.push({ id: b.id, title: b.title, author: b.author });
    if (b.excludeFromProfile) continue;
    const rating = effectiveRating(b.appRating, b.goodreadsRating);
    if (rating === null || rating < LOVED_MIN) continue;
    loved_books.push({
      id: b.id,
      title: b.title,
      author: b.author,
      additional_authors: (b.additionalAuthors ?? '')
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean),
      rating,
      read_year: yearOf(b.dateRead ?? b.dateAdded),
    });
  }
  loved_books.sort(
    (x, y) => y.rating - x.rating || (y.read_year ?? 0) - (x.read_year ?? 0) || x.id - y.id
  );

  // --- titles: owned identity, loved titles, favorites, aggregates ---
  const titleRows = await db
    .select({ t: schema.titles, e: schema.titleEnrichment })
    .from(schema.titles)
    // 1:1 -- title_enrichment.title_id carries a unique index.
    .leftJoin(schema.titleEnrichment, eq(schema.titleEnrichment.titleId, schema.titles.id))
    .where(eq(schema.titles.userId, userId))
    .orderBy(asc(schema.titles.id));

  const owned_qids = new Set<string>();
  const owned_tvmaze_ids = new Set<number>();
  const owned_keys = new Set<string>();
  const loved_titles: ScreenLovedTitle[] = [];
  const favorite_titles: FavoriteTitle[] = [];
  const genreCounts = new Map<string, number>();
  const peopleCounts = new Map<string, number>();
  const languages: string[] = [];
  const titleById = new Map<number, { title: string; year: number | null }>();

  for (const { t, e } of titleRows) {
    const type = asMediaType(t.mediaType);
    titleById.set(t.id, { title: t.title, year: t.year });
    for (const qid of [t.wikidataQid, e?.wikidataQid ?? null]) if (qid) owned_qids.add(qid);
    for (const id of [t.tvmazeId, e?.tvmazeId ?? null]) if (id !== null) owned_tvmaze_ids.add(id);
    owned_keys.add(normalizeTitleKey(t.title, t.year));
    if (t.isFavorite) favorite_titles.push({ id: t.id, type, title: t.title, year: t.year });

    const rating = effectiveTitleRating(t);
    if (!isTitleProfileEvidence(t) || rating === null) continue;
    const lang = e?.originalLanguage ?? null;
    if (lang && !languages.includes(lang)) languages.push(lang);
    if (rating < LOVED_MIN) continue;

    const genres = stringList(e?.genres);
    const people = stringList(type === 'movie' ? e?.directors : e?.creators);
    for (const g of genres) genreCounts.set(g, (genreCounts.get(g) ?? 0) + 1);
    for (const p of people) peopleCounts.set(p, (peopleCounts.get(p) ?? 0) + 1);
    loved_titles.push({
      id: t.id,
      type,
      title: t.title,
      year: t.year,
      rating,
      genres: genres.slice(0, 8),
      people: people.slice(0, 3),
      wikidata_qid: t.wikidataQid ?? e?.wikidataQid ?? null,
      watched_year: yearOf(t.lastWatchedOn),
    });
  }
  loved_titles.sort(
    (x, y) => y.rating - x.rating || (y.watched_year ?? 0) - (x.watched_year ?? 0) || x.id - y.id
  );

  // Most recently watched first; never-watched (want) rows after, newest added first.
  const owned_list: string[] = [];
  const seenLabels = new Set<string>();
  const byRecency = [...titleRows].sort((a, b) => {
    const aw = a.t.lastWatchedOn ?? '';
    const bw = b.t.lastWatchedOn ?? '';
    if (aw !== bw) return aw < bw ? 1 : -1;
    if (a.t.createdAt !== b.t.createdAt) return a.t.createdAt < b.t.createdAt ? 1 : -1;
    return b.t.id - a.t.id;
  });
  for (const { t } of byRecency) {
    if (owned_list.length >= OWNED_LIST_CAP) break;
    const label = titleLabel(t.title, t.year);
    if (seenLabels.has(label)) continue;
    seenLabels.add(label);
    owned_list.push(label);
  }

  // --- rejected screen recommendations: excluded from retrieval, testimony for the rerank ---
  const rejected = await db
    .select()
    .from(schema.titleRecommendations)
    .where(
      and(
        eq(schema.titleRecommendations.userId, userId),
        eq(schema.titleRecommendations.status, REJECTED_STATUS)
      )
    )
    .orderBy(asc(schema.titleRecommendations.id));
  const rejected_list: string[] = [];
  const rejected_with_notes: ScreenRejectedNote[] = [];
  const reject_reason_counts = new Map<string, number>();
  for (const r of rejected) {
    if (r.wikidataQid) owned_qids.add(r.wikidataQid);
    if (r.tvmazeId !== null) owned_tvmaze_ids.add(r.tvmazeId);
    owned_keys.add(normalizeTitleKey(r.title, r.year));
    if (rejected_list.length < REJECTED_LIST_CAP) rejected_list.push(titleLabel(r.title, r.year));
    if (r.userNote) {
      rejected_with_notes.push({
        title: r.title,
        year: r.year,
        type: asMediaType(r.mediaType),
        note: r.userNote,
      });
    }
    for (const reason of stringList(r.rejectReasons)) {
      reject_reason_counts.set(reason, (reject_reason_counts.get(reason) ?? 0) + 1);
    }
  }

  // --- title more/less-like signals (wave 6 writes target_kind = 'title') ---
  const signalRows = await db
    .select()
    .from(schema.tasteSignal)
    .where(and(eq(schema.tasteSignal.userId, userId), eq(schema.tasteSignal.targetKind, 'title')))
    .orderBy(asc(schema.tasteSignal.id));
  const more_like_titles: string[] = [];
  const less_like_titles: string[] = [];
  for (const sig of signalRows) {
    if (sig.targetTitleId === null) continue;
    // titleById is built from the user-scoped query above: another user's id never resolves.
    const target = titleById.get(sig.targetTitleId);
    if (!target) continue;
    const label = titleLabel(target.title, target.year);
    if (sig.direction === 'more') more_like_titles.push(label);
    else if (sig.direction === 'less') less_like_titles.push(label);
  }

  const traits = await loadTraitPayloads(db, userId);
  const { directive_text, directive_constraints } = await loadDirective(db, userId);

  return {
    traits,
    loved_books,
    loved_titles,
    favorite_books,
    favorite_titles,
    top_genres: mostCommon(genreCounts, TOP_GENRES),
    top_people: mostCommon(peopleCounts, TOP_PEOPLE),
    original_languages: languages,
    owned_qids,
    owned_tvmaze_ids,
    owned_keys,
    owned_list,
    rejected_list,
    rejected_with_notes,
    more_like_titles,
    less_like_titles,
    reject_reason_counts,
    directive_text,
    directive_constraints,
  };
}
