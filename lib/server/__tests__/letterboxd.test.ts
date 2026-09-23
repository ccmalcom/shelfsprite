import { describe, expect, test } from 'vitest';
import { ApiError } from '../errors';
import { readLetterboxdZip, type LetterboxdFilm } from '../letterboxd';
import {
  letterboxdZip,
  SYNTHETIC_LETTERBOXD,
  withCompressionMethod,
  withDeclaredSize,
} from './fixtures/letterboxd';

function rejection(fn: () => unknown): { status: number; detail: string } {
  try {
    fn();
  } catch (error) {
    if (error instanceof ApiError) return { status: error.status, detail: error.detail };
    throw error;
  }
  throw new Error('expected an ApiError');
}

const byUri = (films: LetterboxdFilm[]) => new Map(films.map((f) => [f.uri, f]));

describe('readLetterboxdZip — joins', () => {
  test('builds one film per film URI with ratings, statuses, diary dates, reviews and favorites', () => {
    const { films } = readLetterboxdZip(letterboxdZip());
    expect(films.map((f) => f.uri)).toEqual([
      'https://boxd.it/aaa1',
      'https://boxd.it/aaa2',
      'https://boxd.it/aaa3',
      'https://boxd.it/aaa4',
      'https://boxd.it/aaa5',
      'https://boxd.it/bbb1',
    ]);
    const m = byUri(films);
    expect(m.get('https://boxd.it/aaa1')).toEqual({
      uri: 'https://boxd.it/aaa1',
      name: 'The Lantern Keeper',
      year: 2019,
      status: 'watched', // on the watchlist too, but watched wins
      rating: 4.5,
      review: 'Second take wins.', // most recent review by Date
      lastWatchedOn: '2024-06-30', // latest diary Watched Date
      favorite: false,
    });
    expect(m.get('https://boxd.it/aaa2')).toMatchObject({
      rating: 2,
      favorite: true,
      lastWatchedOn: '2024-02-09',
    });
    expect(m.get('https://boxd.it/aaa3')).toMatchObject({
      name: 'Quiet Harbor, Loud Sea',
      rating: null,
      favorite: false, // liked, and likes are never read (spec decision 15)
    });
    expect(m.get('https://boxd.it/aaa4')).toMatchObject({
      name: '夜の図書館',
      rating: 5,
      favorite: true,
    });
    expect(m.get('https://boxd.it/aaa5')).toMatchObject({
      year: null,
      rating: null,
      review: 'Loved it but never rated.', // kept here; importTitles decides whether to store it
    });
    expect(m.get('https://boxd.it/bbb1')).toMatchObject({ status: 'want', rating: null });
  });

  test('diary and review rows join by exact (Name, Year), never by their entry URI', () => {
    const { films } = readLetterboxdZip(letterboxdZip());
    for (const f of films) expect(f.uri).not.toMatch(/boxd\.it\/[er]\d/);
    // "Unknown Film" (1999) is only in the diary: it has no film URI, so it is not imported.
    expect(films.some((f) => f.name === 'Unknown Film')).toBe(false);
  });

  test('a quoted multi-line review with commas and doubled quotes survives', () => {
    const files = { ...SYNTHETIC_LETTERBOXD };
    files['reviews.csv'] =
      'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Review,Tags,Watched Date\n' +
      '2024-01-06,The Lantern Keeper,2019,https://boxd.it/r1,4.5,,"First take, with ""quotes""\nand a second line.",,2024-01-04\n';
    const film = byUri(readLetterboxdZip(letterboxdZip(files)).films).get('https://boxd.it/aaa1');
    expect(film?.review).toBe('First take, with "quotes"\nand a second line.');
  });

  test('an ambiguous (Name, Year) pair joins diary and review rows to neither film', () => {
    const files = { ...SYNTHETIC_LETTERBOXD };
    files['watched.csv'] =
      'Date,Name,Year,Letterboxd URI\n' +
      '2024-01-05,Twin,2020,https://boxd.it/t1\n' +
      '2024-01-05,Twin,2020,https://boxd.it/t2\n';
    files['ratings.csv'] = 'Date,Name,Year,Letterboxd URI,Rating\n';
    files['watchlist.csv'] = 'Date,Name,Year,Letterboxd URI\n';
    files['diary.csv'] =
      'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\n2024-02-01,Twin,2020,https://boxd.it/e1,3,,,2024-02-01\n';
    files['reviews.csv'] =
      'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Review,Tags,Watched Date\n2024-02-01,Twin,2020,https://boxd.it/r1,3,,Which one?,,2024-02-01\n';
    const { films } = readLetterboxdZip(letterboxdZip(files));
    expect(films.map((f) => [f.uri, f.lastWatchedOn, f.review])).toEqual([
      ['https://boxd.it/t1', null, null],
      ['https://boxd.it/t2', null, null],
    ]);
  });

  test('never reads deleted/ or orphaned/ entries', () => {
    const film = byUri(readLetterboxdZip(letterboxdZip()).films).get('https://boxd.it/aaa1');
    expect(film?.lastWatchedOn).toBe('2024-06-30'); // deleted/diary.csv says 2025-12-31
    expect(film?.review).not.toContain('Orphaned');
  });

  test('profile PII never reaches the result', () => {
    const text = JSON.stringify(readLetterboxdZip(letterboxdZip()));
    for (const pii of ['synthetic_user', 'sam@example.invalid', 'Nowhere', 'A bio']) {
      expect(text).not.toContain(pii);
    }
  });

  test('a profile.csv without Favorite Films, or no profile.csv, means no favorites', () => {
    const noColumn = {
      ...SYNTHETIC_LETTERBOXD,
      'profile.csv': 'Date Joined,Username\n2020-01-01,x\n',
    };
    expect(readLetterboxdZip(letterboxdZip(noColumn)).films.some((f) => f.favorite)).toBe(false);
    const { ['profile.csv']: _omit, ...noProfile } = SYNTHETIC_LETTERBOXD;
    expect(readLetterboxdZip(letterboxdZip(noProfile)).films.some((f) => f.favorite)).toBe(false);
  });

  test('ratings off the half grid are treated as absent', () => {
    const files = {
      ...SYNTHETIC_LETTERBOXD,
      'ratings.csv':
        'Date,Name,Year,Letterboxd URI,Rating\n2024-01-06,The Lantern Keeper,2019,https://boxd.it/aaa1,4.3\n',
    };
    expect(
      byUri(readLetterboxdZip(letterboxdZip(files)).films).get('https://boxd.it/aaa1')?.rating
    ).toBeNull();
  });
});

describe('readLetterboxdZip — shape errors', () => {
  test('rejects a re-zipped folder with a specific message', () => {
    const nested = Object.fromEntries(
      Object.entries(SYNTHETIC_LETTERBOXD).map(([name, text]) => [
        `letterboxd-export/${name}`,
        text,
      ])
    );
    expect(rejection(() => readLetterboxdZip(letterboxdZip(nested)))).toEqual({
      status: 422,
      detail:
        'Upload the ZIP exactly as Letterboxd sent it: its CSV files must be at the top level, not inside a folder.',
    });
  });

  test('rejects a ZIP with no Letterboxd entries, even when deleted/ has look-alikes', () => {
    const onlyDeleted = { 'deleted/diary.csv': SYNTHETIC_LETTERBOXD['deleted/diary.csv'] };
    expect(rejection(() => readLetterboxdZip(letterboxdZip(onlyDeleted)))).toEqual({
      status: 422,
      detail:
        'This does not look like a Letterboxd export: watched.csv, ratings.csv or watchlist.csv must be at the top level of the ZIP.',
    });
  });

  test('rejects bytes that are not a ZIP', () => {
    expect(rejection(() => readLetterboxdZip(new TextEncoder().encode('not a zip')))).toEqual({
      status: 422,
      detail: 'The upload is not a readable ZIP file.',
    });
  });

  test('rejects a CSV missing a required column', () => {
    const files = { ...SYNTHETIC_LETTERBOXD, 'ratings.csv': 'Date,Name,Year,Letterboxd URI\n' };
    expect(rejection(() => readLetterboxdZip(letterboxdZip(files)))).toEqual({
      status: 422,
      detail: "ratings.csv is missing its 'Rating' column; is this a Letterboxd export?",
    });
  });

  test('rejects an entry that is not UTF-8', () => {
    const header = 'Date,Name,Year,Letterboxd URI\n';
    const stored = letterboxdZip({ 'watched.csv': `${header}x` }, 0);
    // Stored (level 0) entry: 30-byte local header + name, then the raw bytes. Replace the final
    // data byte 'x' with 0xff, which is invalid UTF-8 on its own.
    const at = 30 + 'watched.csv'.length + header.length;
    expect(stored[at]).toBe(0x78);
    const invalid = stored.slice();
    invalid[at] = 0xff;
    const error = rejection(() => readLetterboxdZip(invalid));
    expect(error.status).toBe(422);
    // fflate may reject the CRC mismatch before decoding; either message is a correct refusal.
    expect(['watched.csv is not UTF-8 text.', 'The upload is not a readable ZIP file.']).toContain(
      error.detail
    );
  });
});

describe('readLetterboxdZip — bounds (spec §3.4 ZIP-bomb guard)', () => {
  const small = { maxEntryBytes: 64, maxTotalBytes: 100 };

  test('checks declared sizes before inflating anything', () => {
    // The entry is too big AND uses an unsupported compression method. If inflation ran first
    // the error would be the unreadable-ZIP 422; the size check must answer 413 first.
    const zip = withCompressionMethod(
      letterboxdZip({ 'watched.csv': 'Date,Name,Year,Letterboxd URI\n' + 'x'.repeat(200) }, 0),
      99
    );
    expect(rejection(() => readLetterboxdZip(zip, small))).toEqual({
      status: 413,
      detail: 'The Letterboxd export is too large to import.',
    });
  });

  test('enforces the total across allowlisted entries', () => {
    const files = {
      'watched.csv': 'Date,Name,Year,Letterboxd URI\n' + 'a'.repeat(20),
      'ratings.csv': 'Date,Name,Year,Letterboxd URI,Rating\n' + 'b'.repeat(20),
      'watchlist.csv': 'Date,Name,Year,Letterboxd URI\n' + 'c'.repeat(20),
    };
    expect(rejection(() => readLetterboxdZip(letterboxdZip(files), small)).status).toBe(413);
  });

  test('ignored entries do not count toward the total', () => {
    const files = {
      'watched.csv': 'Date,Name,Year,Letterboxd URI\n',
      'lists/huge.csv': 'z'.repeat(5_000),
    };
    expect(readLetterboxdZip(letterboxdZip(files), small).films).toEqual([]);
  });

  test('stops inflating when the real size exceeds a lying declared size', () => {
    const honest = letterboxdZip({
      'watched.csv': 'Date,Name,Year,Letterboxd URI\n' + 'y'.repeat(2_000),
    });
    const lying = withDeclaredSize(honest, 10);
    expect(rejection(() => readLetterboxdZip(lying))).toEqual({
      status: 422,
      detail: 'The upload is not a readable ZIP file.',
    });
  });

  test('refuses a lying declaration as soon as it is exceeded, before the per-entry cap', () => {
    // Declared 10 bytes, real ~2 KB, cap 64: the declared-size guard must answer (422) before the
    // per-entry cap would (413). The final size-equality check alone would also say 422, but only
    // after inflating the whole entry, so it is the cap that tells the two apart here.
    const honest = letterboxdZip({
      'watched.csv': 'Date,Name,Year,Letterboxd URI\n' + 'y'.repeat(2_000),
    });
    expect(rejection(() => readLetterboxdZip(withDeclaredSize(honest, 10), small))).toEqual({
      status: 422,
      detail: 'The upload is not a readable ZIP file.',
    });
  });

  test('stops inflating at the per-entry cap even when the declaration claims to fit', () => {
    const honest = letterboxdZip({
      'watched.csv': 'Date,Name,Year,Letterboxd URI\n' + 'y'.repeat(2_000),
    });
    const lying = withDeclaredSize(honest, 50); // declared 50 <= cap 64, real ~2 KB
    expect(rejection(() => readLetterboxdZip(lying, small)).status).toBeGreaterThanOrEqual(413);
  });
});
