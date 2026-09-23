/**
 * SPARQL for screen recommendation retrieval (spec §6.3), ported from the queries the
 * 2026-09-22 spike ran against live WDQS: pool_meta.py and pool_tv.py (metadata pool),
 * bridge_final.py (adaptation bridge with the series hop), books_only.py (seed film lookup)
 * and pool_tv.py's P8600 crosswalk. Pure string builders and row readers: no network.
 *
 * Every query adds the popularity floor the spike found necessary: an English Wikipedia
 * article and >= 10 sitelinks ("Talk 2 Me" at 0 sitelinks and *Bikini Frankenstein* both fell
 * below it). Every label read is en or mul (spec §2.1 finding 2a).
 *
 * INJECTION: book titles and Claude's seed titles are untrusted text. Every literal goes
 * through sparqlString -- JSON string escaping is valid SPARQL STRING_LITERAL2 (it escapes
 * `"` and `\`, and emits \n, \r, \uXXXX for control characters) -- and every entity through
 * qidRef, which throws on anything that is not a QID. Nothing is interpolated raw.
 *
 * Each query starts with a `# screen:<name>` comment. It is a legal SPARQL comment and the
 * key the test fake catalog port matches on.
 */
export type SparqlRow = Record<string, { value: string } | undefined>;

export const POPULARITY_MIN_SITELINKS = 10;
export const FILM_CLASS = 'Q11424';
export const TV_SERIES_CLASS = 'Q5398426';
/** pool_meta.py: the 150 most common people and 40 most common genres of loved titles. */
export const LOVED_PEOPLE_LIMIT = 150;
export const LOVED_GENRES_LIMIT = 40;

const QID_RE = /^Q[1-9]\d*$/;

export function sparqlString(s: string): string {
  return JSON.stringify(s);
}

export function isQid(v: string): boolean {
  return QID_RE.test(v);
}

export function qidRef(qid: string): string {
  if (!isQid(qid)) throw new Error(`not a Wikidata QID: ${qid}`);
  return `wd:${qid}`;
}

export function qidOf(uri: string | undefined): string | null {
  if (!uri) return null;
  const id = uri.slice(uri.lastIndexOf('/') + 1);
  return isQid(id) ? id : null;
}

export function rowStr(row: SparqlRow, key: string): string | null {
  const v = row[key]?.value;
  return v === undefined || v === '' ? null : v;
}

export function rowInt(row: SparqlRow, key: string): number | null {
  const v = rowStr(row, key);
  if (v === null) return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

/** The English label, else the `mul` one (famous items often carry only `mul`). */
export function rowLabel(row: SparqlRow): string | null {
  return rowStr(row, 'len') ?? rowStr(row, 'lmul');
}

/**
 * The popularity floor. `runLast` adds a Blazegraph optimizer hint that evaluates the
 * enwiki-article join after everything else: without it the adaptation query's work-OR-series
 * UNION timed out on live WDQS (502/504 after ~65-80 s, measured 2026-09-23); with it, 0.8 s.
 */
function floor(v: string, runLast = false): string {
  const hint = runLast ? ' hint:Prior hint:runLast true .' : '';
  return (
    `?${v} wikibase:sitelinks ?sl . FILTER(?sl >= ${POPULARITY_MIN_SITELINKS})\n` +
    `  ?art schema:about ?${v} ; schema:isPartOf <https://en.wikipedia.org/> .${hint}`
  );
}

function labels(v: string, en: string, mul: string): string {
  return (
    `OPTIONAL { ?${v} rdfs:label ?${en} FILTER(LANG(?${en}) = "en") }\n` +
    `  OPTIONAL { ?${v} rdfs:label ?${mul} FILTER(LANG(?${mul}) = "mul") }`
  );
}

function values(qids: string[]): string {
  return qids.map(qidRef).join(' ');
}

function assertInteger(n: number, what: string): void {
  if (!Number.isInteger(n)) throw new Error(`${what} must be an integer: ${n}`);
}

export function lovedPeopleQuery(lovedQids: string[]): string {
  return `# screen:loved-people
SELECT ?p (COUNT(DISTINCT ?loved) AS ?n) WHERE {
  VALUES ?loved { ${values(lovedQids)} }
  ?loved wdt:P57|wdt:P58|wdt:P170 ?p .
} GROUP BY ?p ORDER BY DESC(?n) ?p LIMIT ${LOVED_PEOPLE_LIMIT}`;
}

export function lovedGenresQuery(lovedQids: string[]): string {
  return `# screen:loved-genres
SELECT ?g (COUNT(DISTINCT ?loved) AS ?n) WHERE {
  VALUES ?loved { ${values(lovedQids)} }
  ?loved wdt:P136 ?g .
} GROUP BY ?g ORDER BY DESC(?n) ?g LIMIT ${LOVED_GENRES_LIMIT}`;
}

/**
 * Films (director or screenwriter) or series (creator, screenwriter or director) sharing a
 * person AND a genre with the loved titles, counted for ranking (spec §6.3: shared people,
 * then genres, then sitelinks). Series must carry a TVmaze id: `?f wdt:P8600 ?tvm0` is a
 * required triple, not OPTIONAL, so an uncross-walked show never comes back.
 */
export function metadataQuery(kind: 'movie' | 'tv', people: string[], genres: string[]): string {
  const peopleProps = kind === 'movie' ? 'wdt:P57|wdt:P58' : 'wdt:P170|wdt:P58|wdt:P57';
  const cls = kind === 'movie' ? FILM_CLASS : TV_SERIES_CLASS;
  const crosswalk = kind === 'tv' ? '\n  ?f wdt:P8600 ?tvm0 .' : '';
  const dateProps = kind === 'movie' ? 'wdt:P577' : 'wdt:P580|wdt:P577';
  return `# screen:metadata-${kind}
SELECT ?f (COUNT(DISTINCT ?p) AS ?np) (COUNT(DISTINCT ?g) AS ?ng) (SAMPLE(?sl) AS ?nsl) (SAMPLE(?tvm0) AS ?tvm) (SAMPLE(?len0) AS ?len) (SAMPLE(?lmul0) AS ?lmul) (MIN(YEAR(?d)) AS ?yr) WHERE {
  VALUES ?p { ${values(people)} }
  VALUES ?g { ${values(genres)} }
  ?f ${peopleProps} ?p ; wdt:P136 ?g ; wdt:P31/wdt:P279* wd:${cls} .${crosswalk}
  ${floor('f')}
  ${labels('f', 'len0', 'lmul0')}
  OPTIONAL { ?f ${dateProps} ?d }
} GROUP BY ?f`;
}

export interface AdaptationInput {
  variant: string;
  surname: string;
}

/**
 * bridge_final.py plus the floor: films and series based on (P144) the loved book's work
 * item OR that work's series item (P179). The series hop produced 41 of 102 bridge
 * candidates in the spike. The author label is restricted to en/mul here; the full
 * order-insensitive token-set comparison happens in screenAssemble.ts.
 */
export function adaptationQuery(inputs: AdaptationInput[]): string {
  const rows = inputs
    .flatMap(({ variant, surname }) =>
      ['@en', '@mul'].map((tag) => `(${sparqlString(variant)}${tag} ${sparqlString(surname)})`)
    )
    .join(' ');
  return `# screen:adaptation
SELECT DISTINCT ?title ?an ?via ?src ?adapt ?kind ?tvm ?sl ?len ?lmul ?yr WHERE {
  VALUES (?title ?surname) { ${rows} }
  ?work rdfs:label|skos:altLabel ?title ; wdt:P50 ?author .
  ?author rdfs:label ?an . FILTER(LANG(?an) IN ("en", "mul") && CONTAINS(LCASE(?an), ?surname))
  { ?adapt wdt:P144 ?work . BIND("work" AS ?via) BIND(?work AS ?src) }
  UNION { ?work wdt:P179 ?ser . ?adapt wdt:P144 ?ser . BIND("series" AS ?via) BIND(?ser AS ?src) }
  ${floor('adapt', true)}
  { ?adapt wdt:P31/wdt:P279* wd:${FILM_CLASS} . BIND("movie" AS ?kind) }
  UNION { ?adapt wdt:P31/wdt:P279* wd:${TV_SERIES_CLASS} . BIND("tv" AS ?kind) }
  OPTIONAL { ?adapt wdt:P8600 ?tvm }
  ${labels('adapt', 'len', 'lmul')}
  OPTIONAL { ?adapt wdt:P577|wdt:P580 ?d . BIND(YEAR(?d) AS ?yr) }
}`;
}

export interface LabelYear {
  label: string;
  year: number;
}

/** books_only.py plus the floor: an exact en/mul label or alias, a film, any P577 year. */
export function seedMovieQuery(lookups: LabelYear[]): string {
  for (const { year } of lookups) assertInteger(year, 'seed year');
  const rows = lookups
    .flatMap(({ label, year }) =>
      ['@en', '@mul'].map((tag) => `(${sparqlString(label)}${tag} ${year})`)
    )
    .join(' ');
  return `# screen:seed-movie
SELECT ?name ?y ?q ?sl ?len ?lmul WHERE {
  VALUES (?name ?y) { ${rows} }
  { ?q rdfs:label ?name } UNION { ?q skos:altLabel ?name }
  ?q wdt:P31/wdt:P279* wd:${FILM_CLASS} ; wdt:P577 ?d .
  FILTER(YEAR(?d) = ?y)
  ${floor('q')}
  ${labels('q', 'len', 'lmul')}
}`;
}

/** pool_tv.py's crosswalk plus the floor: TVmaze id -> Wikidata series (P8600). */
export function tvmazeCrosswalkQuery(ids: number[]): string {
  for (const id of ids) assertInteger(id, 'TVmaze id');
  const vals = ids.map((id) => sparqlString(String(id))).join(' ');
  return `# screen:tv-crosswalk
SELECT ?s ?tvm ?sl ?len ?lmul ?yr WHERE {
  VALUES ?tvm { ${vals} }
  ?s wdt:P8600 ?tvm .
  ${floor('s')}
  ${labels('s', 'len', 'lmul')}
  OPTIONAL { ?s wdt:P580|wdt:P577 ?d . BIND(YEAR(?d) AS ?yr) }
}`;
}
