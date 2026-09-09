/**
 * Diff of a user's PROPOSED taste-trait claims across a profile refresh, for the
 * post-refresh summary in ReprofileBanner (issue #81).
 *
 * Only `status = 'proposed'` rows participate: persistProposedTraits deletes and
 * re-inserts exactly those, so confirmed/rejected verdicts cannot pollute the diff.
 */
import { and, eq } from 'drizzle-orm';
import type { Db } from './db';
import * as schema from './schema';
import { ratio } from './similarity';

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
function normalizeClaim(claim: string): string {
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

/** Deduplicate by normalized claim, keeping the first occurrence's display text. */
function byNormalized(claims: ProposedClaim[]): Map<string, ProposedClaim> {
  const out = new Map<string, ProposedClaim>();
  for (const c of claims) {
    const key = normalizeClaim(c.claim);
    if (!key) continue;
    if (!out.has(key)) out.set(key, c);
  }
  return out;
}

/**
 * Compare two snapshots of proposed claims.
 *
 * Exact (normalized) matches are `unchanged`. Leftovers are paired greedily by
 * descending similarity -- highest-scoring pair first, each claim used at most once --
 * and reported as `reworded`; whatever stays unpaired is `dropped` or `added`.
 *
 * Pairing NEVER crosses polarity. A flip ('Rewards military SF' -> 'Avoids military
 * SF') scores 0.8108 and would otherwise render as a mild reword, when it is in fact
 * the model reversing its judgment about the reader.
 */
export function diffProposedClaims(
  before: ProposedClaim[],
  after: ProposedClaim[]
): ProfileChanges {
  const beforeMap = byNormalized(before);
  const afterMap = byNormalized(after);

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
      const score = claimSimilarity(droppedKeys[d], addedKeys[a]);
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

/** Read the user's current proposed claims. Cheap: two columns, no joins. */
export async function snapshotProposedClaims(db: Db, userId: string): Promise<ProposedClaim[]> {
  return db
    .select({ claim: schema.tasteTraits.claim, polarity: schema.tasteTraits.polarity })
    .from(schema.tasteTraits)
    .where(and(eq(schema.tasteTraits.userId, userId), eq(schema.tasteTraits.status, 'proposed')))
    .orderBy(schema.tasteTraits.id);
}
