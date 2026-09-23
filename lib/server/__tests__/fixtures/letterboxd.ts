import { strToU8, zipSync } from 'fflate';

/**
 * A synthetic Letterboxd export shaped from the spike's measurements (spec §2.1 finding 1).
 * Nothing here comes from a real account. Diary and review URIs are ENTRY links (boxd.it/e*,
 * boxd.it/r*) that match no film URI, exactly as in real exports.
 */
export const SYNTHETIC_LETTERBOXD: Record<string, string> = {
  'profile.csv':
    'Date Joined,Username,Given Name,Family Name,Email Address,Location,Website,Bio,Pronoun,Favorite Films\n' +
    '2020-01-01,synthetic_user,Sam,Example,sam@example.invalid,Nowhere,,A bio,they/them,' +
    '"https://boxd.it/aaa2, https://boxd.it/aaa4"\n',
  'watched.csv':
    'Date,Name,Year,Letterboxd URI\n' +
    '2024-01-05,The Lantern Keeper,2019,https://boxd.it/aaa1\n' +
    '2024-02-10,Salt & Static,2021,https://boxd.it/aaa2\n' +
    '2024-03-15,"Quiet Harbor, Loud Sea",2008,https://boxd.it/aaa3\n' +
    '2024-04-20,夜の図書館,2016,https://boxd.it/aaa4\n' +
    '2024-05-25,Paper Moons,,https://boxd.it/aaa5\n',
  'ratings.csv':
    'Date,Name,Year,Letterboxd URI,Rating\n' +
    '2024-01-06,The Lantern Keeper,2019,https://boxd.it/aaa1,4.5\n' +
    '2024-02-11,Salt & Static,2021,https://boxd.it/aaa2,2\n' +
    '2024-04-21,夜の図書館,2016,https://boxd.it/aaa4,5\n',
  'watchlist.csv':
    'Date,Name,Year,Letterboxd URI\n' +
    '2024-06-01,Glass Orchard,2023,https://boxd.it/bbb1\n' +
    '2024-06-02,The Lantern Keeper,2019,https://boxd.it/aaa1\n',
  'diary.csv':
    'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\n' +
    '2024-01-06,The Lantern Keeper,2019,https://boxd.it/e1,4.5,,,2024-01-04\n' +
    '2024-07-01,The Lantern Keeper,2019,https://boxd.it/e2,4.5,Yes,,2024-06-30\n' +
    '2024-02-11,Salt & Static,2021,https://boxd.it/e3,2,,,2024-02-09\n' +
    '2024-08-01,Unknown Film,1999,https://boxd.it/e4,3,,,2024-07-31\n',
  'reviews.csv':
    'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Review,Tags,Watched Date\n' +
    '2024-01-06,The Lantern Keeper,2019,https://boxd.it/r1,4.5,,"First take, with ""quotes""\nand a second line.",,2024-01-04\n' +
    '2024-07-01,The Lantern Keeper,2019,https://boxd.it/r2,4.5,Yes,Second take wins.,,2024-06-30\n' +
    '2024-05-26,Paper Moons,,https://boxd.it/r3,,,Loved it but never rated.,,2024-05-25\n',
  'comments.csv': 'Date,Content,Comment\n',
  'likes/films.csv':
    'Date,Name,Year,Letterboxd URI\n2024-03-16,"Quiet Harbor, Loud Sea",2008,https://boxd.it/aaa3\n',
  'lists/favorite-bad-movies.csv': 'Date,Name,URL,Description\n',
  'deleted/diary.csv':
    'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\n' +
    '2025-12-31,The Lantern Keeper,2019,https://boxd.it/e9,1,,,2025-12-31\n',
  'orphaned/reviews.csv':
    'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Review,Tags,Watched Date\n' +
    '2025-12-31,The Lantern Keeper,2019,https://boxd.it/r9,1,,Orphaned text must never import.,,2025-12-31\n',
};

export function letterboxdZip(
  files: Record<string, string> = SYNTHETIC_LETTERBOXD,
  level: 0 | 6 = 6
): Uint8Array {
  return zipSync(
    Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])),
    { level }
  );
}

/** Rewrites every local and central-directory header field at `offset` (little-endian). */
function patchHeaders(
  zip: Uint8Array,
  local: number,
  central: number,
  width: 2 | 4,
  value: number
) {
  const out = zip.slice();
  const view = new DataView(out.buffer);
  for (let i = 0; i + 4 <= out.length; i += 1) {
    const sig = view.getUint32(i, true);
    const at = sig === 0x04034b50 ? i + local : sig === 0x02014b50 ? i + central : -1;
    if (at < 0) continue;
    if (width === 4) view.setUint32(at, value, true);
    else view.setUint16(at, value, true);
  }
  return out;
}

/** Declares a false uncompressed size in both headers (a "lying" ZIP). */
export function withDeclaredSize(zip: Uint8Array, size: number): Uint8Array {
  return patchHeaders(zip, 22, 24, 4, size);
}

/** Declares an unsupported compression method, so any attempt to inflate fails. */
export function withCompressionMethod(zip: Uint8Array, method: number): Uint8Array {
  return patchHeaders(zip, 8, 10, 2, method);
}
