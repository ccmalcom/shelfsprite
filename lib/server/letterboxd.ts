/**
 * Letterboxd export reader (spec §3.4). Pure: ZIP bytes in, LetterboxdFilm[] out.
 *
 * Two passes over the ZIP, deliberately:
 *   1. The central directory's DECLARED uncompressed sizes are checked against the per-entry and
 *      total caps before a single byte inflates (unzipSync with a filter that always says no).
 *   2. Only the allowlisted root entries are inflated, streaming, with every chunk counted. A
 *      declared size can lie, so the real size is enforced again here and must equal the
 *      declaration.
 *
 * Only exact root names are read: deleted/diary.csv and orphaned/reviews.csv share basenames
 * with real entries. Of profile.csv only `Favorite Films` is read; the parser maps every other
 * column to `false`, so the PII never becomes a JavaScript value.
 */
import { parse } from 'csv-parse/sync';
import { Unzip, UnzipInflate, unzipSync } from 'fflate';
import { ApiError } from './errors';
import { isValidRating } from './rating';

export const LETTERBOXD_ENTRIES = [
  'watched.csv',
  'ratings.csv',
  'watchlist.csv',
  'diary.csv',
  'reviews.csv',
  'profile.csv',
] as const;
type EntryName = (typeof LETTERBOXD_ENTRIES)[number];

export interface ZipLimits {
  maxEntryBytes: number;
  maxTotalBytes: number;
}

// A 5,000-film watched.csv is about 300 KB; these leave two orders of magnitude of headroom
// while keeping a serverless function's memory bounded.
export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntryBytes: 8 * 1024 * 1024,
  maxTotalBytes: 24 * 1024 * 1024,
};

export interface LetterboxdFilm {
  uri: string;
  name: string;
  year: number | null;
  status: 'watched' | 'want';
  rating: number | null;
  review: string | null;
  lastWatchedOn: string | null;
  favorite: boolean;
}

export interface LetterboxdExport {
  films: LetterboxdFilm[];
}

const NOT_AN_EXPORT =
  'This does not look like a Letterboxd export: watched.csv, ratings.csv or watchlist.csv must be at the top level of the ZIP.';
const REZIPPED =
  'Upload the ZIP exactly as Letterboxd sent it: its CSV files must be at the top level, not inside a folder.';
const TOO_BIG = 'The Letterboxd export is too large to import.';
const UNREADABLE = 'The upload is not a readable ZIP file.';

const REQUIRED_COLUMNS: Record<EntryName, string[]> = {
  'watched.csv': ['Name', 'Year', 'Letterboxd URI'],
  'ratings.csv': ['Name', 'Year', 'Letterboxd URI', 'Rating'],
  'watchlist.csv': ['Name', 'Year', 'Letterboxd URI'],
  'diary.csv': ['Name', 'Year', 'Watched Date'],
  'reviews.csv': ['Date', 'Name', 'Year', 'Review'],
  'profile.csv': [],
};

function isEntry(name: string): name is EntryName {
  return (LETTERBOXD_ENTRIES as readonly string[]).includes(name);
}

/** Pass 1: declared sizes from the central directory. Nothing is inflated. */
function declaredSizes(bytes: Uint8Array, limits: ZipLimits): Map<EntryName, number> {
  const declared = new Map<EntryName, number>();
  let total = 0;
  let nested = false;
  try {
    unzipSync(bytes, {
      filter(file) {
        if (isEntry(file.name)) {
          if (declared.has(file.name)) throw new ApiError(422, UNREADABLE);
          if (file.originalSize > limits.maxEntryBytes) throw new ApiError(413, TOO_BIG);
          total += file.originalSize;
          if (total > limits.maxTotalBytes) throw new ApiError(413, TOO_BIG);
          declared.set(file.name, file.originalSize);
        } else if (
          /^[^/]+\/(watched|ratings|watchlist)\.csv$/.test(file.name) &&
          !/^(deleted|orphaned|likes|lists)\//.test(file.name)
        ) {
          nested = true;
        }
        return false; // never inflate in this pass
      },
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(422, UNREADABLE);
  }
  if (
    !declared.has('watched.csv') &&
    !declared.has('ratings.csv') &&
    !declared.has('watchlist.csv')
  ) {
    throw new ApiError(422, nested ? REZIPPED : NOT_AN_EXPORT);
  }
  return declared;
}

/** Pass 2: inflate only the declared allowlisted entries, counting every chunk. */
function inflateEntries(
  bytes: Uint8Array,
  declared: Map<EntryName, number>,
  limits: ZipLimits
): Map<EntryName, Uint8Array> {
  const parts = new Map<EntryName, Uint8Array[]>();
  const sizes = new Map<EntryName, number>();
  // An object, not a `let`: TypeScript would narrow a closure-assigned `let` to null below.
  const state: { failure: ApiError | null; total: number } = { failure: null, total: 0 };

  const unzip = new Unzip((file) => {
    if (!isEntry(file.name)) return; // never started, so never inflated
    const name = file.name;
    const expected = declared.get(name);
    if (expected === undefined || parts.has(name)) {
      // Present locally but absent from (or duplicated against) the central directory.
      state.failure ??= new ApiError(422, UNREADABLE);
      return;
    }
    const chunks: Uint8Array[] = [];
    parts.set(name, chunks);
    sizes.set(name, 0);
    file.ondata = (err, data, _final) => {
      if (state.failure) return;
      if (err) {
        state.failure = new ApiError(422, UNREADABLE);
        return;
      }
      const size = (sizes.get(name) ?? 0) + data.length;
      state.total += data.length;
      if (size > expected) {
        state.failure = new ApiError(422, UNREADABLE); // the declaration lied
      } else if (size > limits.maxEntryBytes || state.total > limits.maxTotalBytes) {
        state.failure = new ApiError(413, TOO_BIG);
      }
      if (state.failure) {
        file.terminate();
        return;
      }
      sizes.set(name, size);
      chunks.push(data);
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  try {
    unzip.push(bytes, true);
  } catch {
    state.failure ??= new ApiError(422, UNREADABLE);
  }
  if (state.failure) throw state.failure;

  const out = new Map<EntryName, Uint8Array>();
  for (const [name, expected] of declared) {
    const chunks = parts.get(name);
    if (!chunks || sizes.get(name) !== expected) throw new ApiError(422, UNREADABLE);
    const joined = new Uint8Array(expected);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    out.set(name, joined);
  }
  return out;
}

function decode(name: EntryName, bytes: Uint8Array): string {
  const body =
    bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new ApiError(422, `${name} is not UTF-8 text.`);
  }
}

function headerOf(name: EntryName, text: string): string[] {
  try {
    const rows = parse(text, { to_line: 1, relax_column_count: true }) as string[][];
    return rows[0] ?? [];
  } catch {
    throw new ApiError(422, `${name} could not be read as CSV.`);
  }
}

function records(name: EntryName, text: string): Record<string, string>[] {
  const header = headerOf(name, text);
  for (const column of REQUIRED_COLUMNS[name]) {
    if (!header.includes(column)) {
      throw new ApiError(
        422,
        `${name} is missing its '${column}' column; is this a Letterboxd export?`
      );
    }
  }
  try {
    return parse(text, {
      // profile.csv: every column except Favorite Films maps to false, which csv-parse skips.
      columns:
        name === 'profile.csv'
          ? (cols: string[]) => cols.map((c) => (c === 'Favorite Films' ? c : false))
          : true,
      skip_empty_lines: true,
      relax_column_count: true,
    }) as Record<string, string>[];
  } catch {
    throw new ApiError(422, `${name} could not be read as CSV.`);
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const FILM_URI = /^https:\/\/(boxd\.it|letterboxd\.com)\//;

function yearOf(value: string | undefined): number | null {
  const t = (value ?? '').trim();
  return /^\d{4}$/.test(t) ? Number(t) : null;
}
function ratingOf(value: string | undefined): number | null {
  const t = (value ?? '').trim();
  if (!t) return null;
  const n = Number(t);
  return isValidRating(n) ? n : null;
}
function dateOf(value: string | undefined): string | null {
  const t = (value ?? '').trim();
  return DATE.test(t) ? t : null;
}
function uriOf(value: string | undefined): string | null {
  const t = (value ?? '').trim();
  return FILM_URI.test(t) ? t : null;
}
function nameYearKey(name: string, year: number | null): string {
  return `${name}\u0000${year ?? ''}`;
}

/** Joins the parsed entries into one film per film URI. Exported for tests only via readLetterboxdZip. */
function buildFilms(entries: Map<EntryName, Record<string, string>[]>): LetterboxdFilm[] {
  const films = new Map<string, LetterboxdFilm>();
  const upsert = (
    row: Record<string, string>,
    status: 'watched' | 'want',
    rating: number | null
  ) => {
    const uri = uriOf(row['Letterboxd URI']);
    const name = (row.Name ?? '').trim();
    if (!uri || !name) return;
    const film = films.get(uri) ?? {
      uri,
      name,
      year: yearOf(row.Year),
      status,
      rating: null,
      review: null,
      lastWatchedOn: null,
      favorite: false,
    };
    if (status === 'watched') film.status = 'watched';
    if (rating !== null) film.rating = rating;
    films.set(uri, film);
  };
  for (const row of entries.get('watched.csv') ?? []) upsert(row, 'watched', null);
  for (const row of entries.get('ratings.csv') ?? []) upsert(row, 'watched', ratingOf(row.Rating));
  for (const row of entries.get('watchlist.csv') ?? []) upsert(row, 'want', null);

  // Diary and review URIs are ENTRY links (spec §2.1 finding 1): join by exact (Name, Year).
  // A pair shared by two films is ambiguous and joins to neither.
  const byNameYear = new Map<string, string | null>();
  for (const film of films.values()) {
    const key = nameYearKey(film.name, film.year);
    byNameYear.set(key, byNameYear.has(key) ? null : film.uri);
  }
  const filmFor = (row: Record<string, string>): LetterboxdFilm | null => {
    const uri = byNameYear.get(nameYearKey((row.Name ?? '').trim(), yearOf(row.Year)));
    return uri ? (films.get(uri) ?? null) : null;
  };

  for (const row of entries.get('diary.csv') ?? []) {
    const film = filmFor(row);
    const watched = dateOf(row['Watched Date']);
    if (film && watched && (film.lastWatchedOn === null || watched > film.lastWatchedOn)) {
      film.lastWatchedOn = watched;
    }
  }

  // Most recent review wins: by Date, then Watched Date; a later row wins a full tie.
  const best = new Map<string, { date: string; watched: string }>();
  for (const row of entries.get('reviews.csv') ?? []) {
    const film = filmFor(row);
    const review = (row.Review ?? '').trim();
    if (!film || !review) continue;
    const date = dateOf(row.Date) ?? '';
    const watched = dateOf(row['Watched Date']) ?? '';
    const prior = best.get(film.uri);
    if (!prior || date > prior.date || (date === prior.date && watched >= prior.watched)) {
      best.set(film.uri, { date, watched });
      film.review = review;
    }
  }

  const profile = entries.get('profile.csv')?.[0];
  for (const part of (profile?.['Favorite Films'] ?? '').split(',')) {
    const uri = uriOf(part);
    const film = uri ? films.get(uri) : undefined;
    if (film) film.favorite = true;
  }

  return [...films.values()];
}

export function readLetterboxdZip(
  bytes: Uint8Array,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS
): LetterboxdExport {
  const declared = declaredSizes(bytes, limits);
  const raw = inflateEntries(bytes, declared, limits);
  const parsed = new Map<EntryName, Record<string, string>[]>();
  for (const [name, entryBytes] of raw) parsed.set(name, records(name, decode(name, entryBytes)));
  return { films: buildFilms(parsed) };
}
