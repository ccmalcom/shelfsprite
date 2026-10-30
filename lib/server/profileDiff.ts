/**
 * Diff of a user's PROPOSED taste-trait claims across a profile refresh, for the
 * post-refresh summary in ReprofileBanner (issue #81).
 *
 * Only `status = 'proposed'` rows participate: persistProposedTraits rewrites exactly
 * those (updating kept/reworded ones in place via matchRevisedClaims, deleting dropped
 * ones), so confirmed/rejected verdicts cannot pollute the diff.
 */
import { and, eq } from 'drizzle-orm';
import type { Db } from './db';
import * as schema from './schema';
import { ratio } from './similarity';
import { readerClaim } from './traitText';

export interface ProposedClaim {
  claim: string;
  polarity: string;
}

export interface RewordedClaim {
  from: string;
  to: string;
}

export interface ProfileChanges {
  added: string[];
  dropped: string[];
  reworded: RewordedClaim[];
  unchanged: number;
}

/**
 * Minimum score for two claims to be reported as a reword rather than as a
 * separate drop and add.
 *
 * Calibrated, not guessed. Over sample claim pairs the seven genuine rewords score
 * 0.8409-1.0 and the six genuine non-pairs 0.6275 and below, so 0.80 sits in the gap.
 * A bare `ratio()` threshold does NOT work at any value: a suffix extension
 * ('Avoids military SF' -> "Avoids military SF unless it's satirical") scores 0.6207,
 * BELOW the 0.6275 of a genuine non-pair, because ratio() is length-sensitive. Hence
 * the containment rule in `claimSimilarity`.
 */
export const REWORD_THRESHOLD = 0.8;

/** Claims are compared case- and whitespace-insensitively; display keeps the original. */
export function normalizeClaim(claim: string): string {
  return claim.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * True when `a` and `b` are the same claim with material added to one end -- the most
 * common reword shape, and the one ratio() scores worst. Whole-word only, so 'avoids
 * war' does not contain-match 'avoids warmth' (same reasoning as subjectHits in
 * recFilters.ts).
 */
function isWholeWordExtension(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (!short) return false;
  if (long === short) return true;
  if (long.startsWith(short) && long[short.length] === ' ') return true;
  if (long.endsWith(short) && long[long.length - short.length - 1] === ' ') return true;
  return false;
}

/** Reword score for two NORMALIZED claims. */
export function claimSimilarity(a: string, b: string): number {
  return isWholeWordExtension(a, b) ? 1 : ratio(a, b);
}

interface ClaimEntry extends ProposedClaim {
  /** Normalized claim text, kept separate from the map key so scoring never sees polarity. */
  normalized: string;
}

/**
 * Identity of a claim: polarity AND text. The same words flipped from 'reward' to
 * 'aversion' are the model reversing its judgment about the reader, so they must not
 * collide on one key and be counted `unchanged`. NUL-separated, so no polarity value can
 * run into the claim text.
 */
function claimKey(polarity: string, normalized: string): string {
  return `${polarity}\u0000${normalized}`;
}

/** Deduplicate by polarity + normalized claim, keeping the first occurrence's display text. */
function byClaimKey(claims: ProposedClaim[]): Map<string, ClaimEntry> {
  const out = new Map<string, ClaimEntry>();
  for (const c of claims) {
    const normalized = normalizeClaim(c.claim);
    if (!normalized) continue;
    const key = claimKey(c.polarity, normalized);
    if (!out.has(key)) out.set(key, { ...c, normalized });
  }
  return out;
}

/**
 * Compare two snapshots of proposed claims.
 *
 * Exact matches -- same polarity AND same normalized text -- are `unchanged`. Leftovers
 * are paired greedily by descending similarity -- highest-scoring pair first, each claim
 * used at most once -- and reported as `reworded`; whatever stays unpaired is `dropped`
 * or `added`.
 *
 * NOTHING crosses polarity, neither the exact match nor the pairing. A reworded flip
 * ('Rewards military SF' -> 'Avoids military SF') scores 0.8108 and would otherwise
 * render as a mild reword; a flip that keeps its wording verbatim would otherwise vanish
 * into `unchanged`. Both are in fact the model reversing its judgment about the reader,
 * so both surface as one dropped claim plus one added claim.
 */
export function diffProposedClaims(
  before: ProposedClaim[],
  after: ProposedClaim[]
): ProfileChanges {
  const beforeMap = byClaimKey(before);
  const afterMap = byClaimKey(after);

  let unchanged = 0;
  const droppedKeys: string[] = [];
  for (const key of beforeMap.keys()) {
    if (afterMap.has(key)) unchanged++;
    else droppedKeys.push(key);
  }
  const addedKeys = [...afterMap.keys()].filter((k) => !beforeMap.has(k));

  // Score every same-polarity leftover pair, best first. Trait counts are ~10, so the
  // O(n*m) scan is free. Ties break by input order so the result is deterministic.
  const scored: Array<{ score: number; d: number; a: number }> = [];
  for (let d = 0; d < droppedKeys.length; d++) {
    for (let a = 0; a < addedKeys.length; a++) {
      const dropped = beforeMap.get(droppedKeys[d])!;
      const added = afterMap.get(addedKeys[a])!;
      if (dropped.polarity !== added.polarity) continue;
      const score = claimSimilarity(dropped.normalized, added.normalized);
      if (score >= REWORD_THRESHOLD) scored.push({ score, d, a });
    }
  }
  scored.sort((x, y) => y.score - x.score || x.d - y.d || x.a - y.a);

  const usedDropped = new Set<number>();
  const usedAdded = new Set<number>();
  const reworded: RewordedClaim[] = [];
  for (const { d, a } of scored) {
    if (usedDropped.has(d) || usedAdded.has(a)) continue;
    usedDropped.add(d);
    usedAdded.add(a);
    reworded.push({
      from: beforeMap.get(droppedKeys[d])!.claim,
      to: afterMap.get(addedKeys[a])!.claim,
    });
  }

  return {
    added: addedKeys.filter((_, i) => !usedAdded.has(i)).map((k) => afterMap.get(k)!.claim),
    dropped: droppedKeys.filter((_, i) => !usedDropped.has(i)).map((k) => beforeMap.get(k)!.claim),
    reworded,
    unchanged,
  };
}

/**
 * Which existing proposed trait each revised trait continues, by the same rules as
 * diffProposedClaims: an exact match (same polarity and normalized text) first, then
 * same-polarity rewords paired greedily, best score first. Returns, for each `after` entry,
 * the index into `before` it continues, or null when it is a new trait.
 *
 * persistProposedTraits uses this to update a kept or reworded trait in place, so its id --
 * which every recommendation run cites -- survives the refresh. Unlike the diff it does not
 * dedupe: each `before` row is continued by at most one `after` entry, in input order.
 */
export function matchRevisedClaims(
  before: ProposedClaim[],
  after: ProposedClaim[]
): Array<number | null> {
  const b = before.map((c) => normalizeClaim(c.claim));
  const a = after.map((c) => normalizeClaim(c.claim));
  const out: Array<number | null> = after.map(() => null);
  const usedBefore = new Set<number>();

  for (let ai = 0; ai < after.length; ai++) {
    if (!a[ai]) continue;
    const key = claimKey(after[ai].polarity, a[ai]);
    for (let bi = 0; bi < before.length; bi++) {
      if (usedBefore.has(bi) || !b[bi]) continue;
      if (claimKey(before[bi].polarity, b[bi]) !== key) continue;
      out[ai] = bi;
      usedBefore.add(bi);
      break;
    }
  }

  const scored: Array<{ score: number; d: number; a: number }> = [];
  for (let bi = 0; bi < before.length; bi++) {
    if (usedBefore.has(bi) || !b[bi]) continue;
    for (let ai = 0; ai < after.length; ai++) {
      if (out[ai] !== null || !a[ai]) continue;
      if (before[bi].polarity !== after[ai].polarity) continue;
      const score = claimSimilarity(b[bi], a[ai]);
      if (score >= REWORD_THRESHOLD) scored.push({ score, d: bi, a: ai });
    }
  }
  scored.sort((x, y) => y.score - x.score || x.d - y.d || x.a - y.a);
  for (const { d, a: ai } of scored) {
    if (usedBefore.has(d) || out[ai] !== null) continue;
    out[ai] = d;
    usedBefore.add(d);
  }
  return out;
}

/**
 * Read the user's current proposed claims as readers see them. The summary shows these texts,
 * so a row stored before the write-time id guard is stripped here exactly as traitOut strips it
 * (readerClaim, against the trait's own citations). Both snapshots go through this, so the diff
 * always compares stripped text with stripped text.
 */
export async function snapshotProposedClaims(db: Db, userId: string): Promise<ProposedClaim[]> {
  const rows = await db
    .select({
      claim: schema.tasteTraits.claim,
      polarity: schema.tasteTraits.polarity,
      exhibits: schema.tasteTraits.exhibits,
      contrasts: schema.tasteTraits.contrasts,
      exhibitTitleIds: schema.tasteTraits.exhibitTitleIds,
      contrastTitleIds: schema.tasteTraits.contrastTitleIds,
    })
    .from(schema.tasteTraits)
    .where(and(eq(schema.tasteTraits.userId, userId), eq(schema.tasteTraits.status, 'proposed')))
    .orderBy(schema.tasteTraits.id);
  return rows.map((r) => ({ claim: readerClaim(r.claim, r), polarity: r.polarity }));
}
