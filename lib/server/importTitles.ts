/**
 * Letterboxd import writer (spec §3.4). Import-once semantics, like the Goodreads import:
 * Letterboxd owns only LETTERBOXD_OWNED_FIELDS; app_* columns, title, year, media_type (which
 * enrichment may have changed to 'tv') and identity are never written by a re-import. Missing
 * rows are never deleted. The whole import and the screen opt-in land in one transaction
 * (spec §3.1).
 */
import { and, eq } from 'drizzle-orm';
import { schema, type Db, type DbTx } from './db';
import type { LetterboxdFilm } from './letterboxd';
import { setScreenEnabled } from './screenSettings';
import { utcnowTs } from './serialize';
import { effectiveTitleRating, normalizeTitleKey, type TitleRow } from './titles';

export const LETTERBOXD_OWNED_FIELDS = [
  'letterboxdRating',
  'letterboxdReview',
  'letterboxdUri',
  'lastWatchedOn',
  'status',
  'isFavorite',
] as const;

type OwnedField = (typeof LETTERBOXD_OWNED_FIELDS)[number];
export type TitleUpdate = Partial<Pick<TitleRow, OwnedField>>;

/** Fields whose change is profile-relevant and therefore stamps feedback_updated_at. */
const PROFILE_FIELDS: readonly OwnedField[] = [
  'letterboxdRating',
  'letterboxdReview',
  'status',
  'isFavorite',
  'lastWatchedOn',
];

export interface TitleImportCounts {
  inserted: number;
  updated: number;
  unchanged: number;
}

const INSERT_CHUNK = 200;

/** The allowlisted changes a re-import may make to one existing title. Empty = unchanged. */
export function letterboxdChanges(existing: TitleRow, film: LetterboxdFilm): TitleUpdate {
  const next: TitleUpdate = {};
  if (existing.letterboxdUri === null) next.letterboxdUri = film.uri;
  if (film.rating !== null && film.rating !== existing.letterboxdRating) {
    next.letterboxdRating = film.rating;
  }
  if (existing.status === 'want' && film.status === 'watched') next.status = 'watched';
  if (film.favorite && !existing.isFavorite) next.isFavorite = true;
  if (
    film.lastWatchedOn !== null &&
    (existing.lastWatchedOn === null || film.lastWatchedOn > existing.lastWatchedOn)
  ) {
    next.lastWatchedOn = film.lastWatchedOn;
  }
  const ratedAfter =
    effectiveTitleRating({
      appRating: existing.appRating,
      letterboxdRating: next.letterboxdRating ?? existing.letterboxdRating,
    }) !== null;
  const dropped = (next.status ?? existing.status) === 'dropped';
  if (
    film.review !== null &&
    film.review !== existing.letterboxdReview &&
    (ratedAfter || dropped)
  ) {
    next.letterboxdReview = film.review;
  }
  return next;
}

async function applyFilms(
  tx: DbTx,
  userId: string,
  films: LetterboxdFilm[]
): Promise<TitleImportCounts> {
  const existing = await tx.select().from(schema.titles).where(eq(schema.titles.userId, userId));
  const byUri = new Map<string, TitleRow>();
  const byKey = new Map<string, TitleRow[]>();
  for (const row of existing) {
    if (row.letterboxdUri !== null) {
      byUri.set(row.letterboxdUri, row);
      continue;
    }
    const key = normalizeTitleKey(row.title, row.year);
    if (key) byKey.set(key, [...(byKey.get(key) ?? []), row]);
  }

  const now = utcnowTs();
  const claimed = new Set<number>();
  const inserts: (typeof schema.titles.$inferInsert)[] = [];
  let updated = 0;
  let unchanged = 0;

  for (const film of films) {
    let match = byUri.get(film.uri);
    if (!match) {
      const key = normalizeTitleKey(film.name, film.year);
      const candidates = key ? (byKey.get(key) ?? []) : [];
      if (candidates.length === 1 && !claimed.has(candidates[0].id)) match = candidates[0];
    }

    if (match) {
      claimed.add(match.id);
      const changes = letterboxdChanges(match, film);
      if (Object.keys(changes).length === 0) {
        unchanged += 1;
        continue;
      }
      const touchesProfile = PROFILE_FIELDS.some((field) => field in changes);
      await tx
        .update(schema.titles)
        .set({ ...changes, updatedAt: now, ...(touchesProfile ? { feedbackUpdatedAt: now } : {}) })
        .where(and(eq(schema.titles.userId, userId), eq(schema.titles.id, match.id)));
      updated += 1;
      continue;
    }

    inserts.push({
      userId,
      mediaType: 'movie', // enrichment converts Letterboxd-logged series to 'tv' (spec decision 18)
      title: film.name,
      year: film.year,
      status: film.status,
      letterboxdRating: film.rating,
      letterboxdReview: film.rating !== null ? film.review : null,
      lastWatchedOn: film.lastWatchedOn,
      letterboxdUri: film.uri,
      isFavorite: film.favorite,
      feedbackUpdatedAt: film.rating !== null || film.favorite ? now : null,
    });
  }

  for (let i = 0; i < inserts.length; i += INSERT_CHUNK) {
    await tx.insert(schema.titles).values(inserts.slice(i, i + INSERT_CHUNK));
  }
  return { inserted: inserts.length, updated, unchanged };
}

export async function importLetterboxdFilms(
  db: Db,
  userId: string,
  films: LetterboxdFilm[]
): Promise<TitleImportCounts> {
  return db.transaction(async (tx) => {
    const counts = await applyFilms(tx, userId, films);
    await setScreenEnabled(tx, userId, true);
    return counts;
  });
}
