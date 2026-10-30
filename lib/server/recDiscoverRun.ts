/**
 * Port of recommend.discover() — ephemeral natural-language discovery.
 *
 * Two-stage and REQUEST-anchored: stage A (Haiku) interprets the free-text request
 * into catalog queries + hard constraints, retrieval resolves them against the live
 * catalog, and stage B (the rerank model) ranks the real candidates by fit to the
 * request. The taste profile is secondary tie-break context only, the standing
 * directive does not steer this path at all, and there is no profile-missing/stale
 * gate. Results are NOT persisted, so this opens no transaction.
 */
import { trackedToolCall } from './anthropic';
import { toolInput, type ClaudeClient } from './claude';
import { DISCOVER_EMPTY_QUERY_MESSAGE, RECOMMEND_NO_KEY_MESSAGE } from './claudeErrors';
import type { Db } from './db';
import { ApiError } from './errors';
import {
  assemble,
  authorPool,
  discoveryPool,
  dropUnstartedLaterSeries,
  fillOlDescriptions,
  referencePool,
  resolveReferenceBooks,
  MAX_CANDIDATES,
  PER_AUTHOR,
  PER_QUERY,
  type AssembledCandidate,
  type ReferenceBook,
} from './recAssemble';
import { applyDiscoveryConstraints, cleanConstraints, dedupKey } from './recFilters';
import {
  DISCOVER_RANK_SYSTEM,
  DISCOVER_RANK_TOOL,
  DISCOVER_SYSTEM,
  DISCOVER_TOOL,
  buildDiscoverRerankPrompt,
  buildInterpretPrompt,
} from './recDiscoverPrompts';
import { rankModel, RANK_MAX_TOKENS, SEED_MAX_TOKENS } from './recPrompts';
import { buildSignal, type RecSignal } from './recSignal';
import { round2 } from './serialize';
import { modelFor } from './models';
import { surname } from './dedup';

interface Interpretation {
  interpretation: string;
  queries: string[];
  /** Authors whose own books the reader asked for ("my next Scalzi read"). */
  authors: string[];
  /** Books the request names as a comparison ("like Gilead"), at most MAX_REFERENCE_BOOKS. */
  references: ReferenceBook[];
  constraints: Record<string, unknown>;
}

/** Comparison books resolved per request: each costs four catalog searches plus its pool. */
const MAX_REFERENCE_BOOKS = 2;

interface RankedDiscovery extends AssembledCandidate {
  score: number;
  rationale: string;
}

export async function runDiscover(
  db: Db,
  client: ClaudeClient | null,
  userId: string,
  query: string,
  n: number
): Promise<Record<string, unknown>> {
  const q = (query ?? '').trim();
  if (!q) throw new ApiError(400, DISCOVER_EMPTY_QUERY_MESSAGE);

  // Python's _client() checks the key at point of USE, inside _interpret_query.
  // Discovery has no metadata pool, so that is before any catalog request.
  const requireClient = (): ClaudeClient => {
    if (!client) throw new ApiError(400, RECOMMEND_NO_KEY_MESSAGE);
    return client;
  };

  // The FULL signal: library exclusion sets (including rejected recommendations)
  // plus traits/loved as secondary context. buildSignal never raises on a thin or
  // profile-less library, which is why discovery works before a profile exists.
  let signal = await buildSignal(db, userId);

  const interp = await interpretQuery(db, requireClient(), q, signal, userId);
  const model = rankModel();

  if (
    interp.queries.length === 0 &&
    interp.authors.length === 0 &&
    interp.references.length === 0
  ) {
    return {
      query: q,
      interpretation: interp.interpretation,
      count: 0,
      model,
      queries: [],
      recommendations: [],
    };
  }

  // A stated language constraint OVERRIDES the reader's library languages for this
  // run (people ask for other-language books on purpose). assemble() reads
  // library_languages via allowedLanguages, so overriding it here is enough.
  const statedLanguages = interp.constraints.languages as string[] | undefined;
  if (statedLanguages && statedLanguages.length) {
    signal = { ...signal, library_languages: new Set(statedLanguages) } as RecSignal;
  }

  // Books BY a named author are fetched directly and passed as the metadata pool (see
  // authorPool), so they survive the cap ahead of the free-text hits. With no author
  // named there is no metadata pool, and every candidate comes out tagged 'claude_seed'.
  const byAuthor = await authorPool(db, interp.authors, PER_AUTHOR);
  // A book named as a comparison ("a quiet novel like Gilead") is resolved in the catalog
  // first, and its own author and subjects seed retrieval: free-text facet queries alone
  // returned omnibuses for it. The reference itself never becomes a candidate.
  const references = await resolveReferenceBooks(db, interp.references);
  if (references.length) {
    signal = {
      ...signal,
      library_keys: new Set([
        ...signal.library_keys,
        ...references.map((r) => dedupKey(r.title, r.author)),
      ]),
      library_titles: [...signal.library_titles, ...references.map((r) => r.title ?? '')],
    } as RecSignal;
  }
  const excludeSubjects = (interp.constraints.exclude_subjects as string[] | undefined) ?? [];
  const byReference = await referencePool(db, references, PER_QUERY, excludeSubjects);
  // Free-text search returns periodicals and catalogs (TV Guide, Library Journal) with no
  // author; nothing author-less is a book to recommend.
  const pool = (await discoveryPool(db, interp.queries, PER_QUERY)).filter(([c]) => c.author);
  const requested = new Set(interp.authors.map(surname).filter(Boolean));
  // Constraints filter the RAW pools, before the cap, so a constraint-violating book can
  // never displace a valid one.
  let candidates = assemble(
    applyDiscoveryConstraints([...byAuthor, ...byReference], interp.constraints),
    applyDiscoveryConstraints(pool, interp.constraints),
    signal,
    MAX_CANDIDATES,
    // Named authors skip both author caps: the library-author trim (they are often on
    // the shelf already, which is the point of "my NEXT Scalzi read") and MAX_PER_AUTHOR.
    requested,
    requested
  );
  await fillOlDescriptions(db, candidates);
  candidates = dropUnstartedLaterSeries(candidates, signal.library_authors);

  if (candidates.length === 0) {
    // NOTE: unlike the no-queries return above, this one carries the queries.
    return {
      query: q,
      interpretation: interp.interpretation,
      count: 0,
      model,
      queries: interp.queries,
      recommendations: [],
    };
  }

  const ranked = await rerankDiscovery(
    db,
    requireClient(),
    candidates,
    q,
    interp.interpretation,
    signal,
    userId,
    n
  );

  const recsOut = ranked.map((c, i) => ({
    rank: i + 1,
    title: c.title,
    author: c.author,
    year: c.year,
    isbn13: c.isbn13,
    cover_url: c.cover_url,
    subjects: c.subjects ?? [],
    description: c.description,
    catalog_source: c.catalog_source,
    catalog_id: c.catalog_id,
    retrieval_pool: c.retrieval_pool,
    seed_reason: c.seed_reason,
    score: round2(c.score),
    rationale: c.rationale,
  }));

  return {
    query: q,
    interpretation: interp.interpretation,
    count: recsOut.length,
    model,
    queries: interp.queries,
    reference_books: references.map((r) => (r.author ? `${r.title} by ${r.author}` : r.title)),
    recommendations: recsOut,
  };
}

/** recommend._interpret_query: stage A. */
async function interpretQuery(
  db: Db,
  client: ClaudeClient,
  query: string,
  signal: RecSignal,
  userId: string
): Promise<Interpretation> {
  const message = await trackedToolCall(
    client,
    db,
    { userId, operation: 'discover_interpret' },
    {
      model: modelFor('seed'),
      max_tokens: SEED_MAX_TOKENS,
      system: DISCOVER_SYSTEM,
      tools: [DISCOVER_TOOL],
      tool_choice: { type: 'tool', name: 'interpret_request' },
      messages: [{ role: 'user', content: buildInterpretPrompt(query, signal) }],
    }
  );

  // Python matches the FIRST tool_use block without checking its name, and falls
  // back to a fully-empty interpretation when there is none.
  const input = toolInput(message as any, '');
  if (!input) {
    return { interpretation: '', queries: [], authors: [], references: [], constraints: {} };
  }

  const items = (input.queries as Array<{ query?: string }> | undefined) ?? [];
  const authors = Array.isArray(input.authors) ? input.authors : [];
  return {
    interpretation: String(input.interpretation ?? '').trim(),
    queries: items.filter((x) => (x?.query ?? '').trim() !== '').map((x) => String(x.query).trim()),
    authors: [
      ...new Set(authors.filter((a): a is string => typeof a === 'string').map((a) => a.trim())),
    ].filter(Boolean),
    references: parseReferenceBooks(input.reference_books),
    constraints: cleanConstraints((input.constraints as Record<string, unknown>) ?? {}),
  };
}

/** The interpreter's reference_books, cleaned: a title present, deduplicated, at most two. */
export function parseReferenceBooks(raw: unknown): ReferenceBook[] {
  const out: ReferenceBook[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (out.length >= MAX_REFERENCE_BOOKS) break;
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    if (!title) continue;
    const author =
      typeof item.author === 'string' && item.author.trim() ? item.author.trim() : null;
    const key = dedupKey(title, author);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title, author });
  }
  return out;
}

/** recommend._rerank_discovery: stage B. */
async function rerankDiscovery(
  db: Db,
  client: ClaudeClient,
  candidates: AssembledCandidate[],
  query: string,
  interpretation: string,
  signal: RecSignal,
  userId: string,
  n: number
): Promise<RankedDiscovery[]> {
  const message = await trackedToolCall(
    client,
    db,
    { userId, operation: 'discover_rerank' },
    {
      model: rankModel(),
      max_tokens: RANK_MAX_TOKENS,
      system: DISCOVER_RANK_SYSTEM,
      tools: [DISCOVER_RANK_TOOL],
      tool_choice: { type: 'tool', name: 'rank_discovery' },
      messages: [
        {
          role: 'user',
          content: buildDiscoverRerankPrompt(candidates, query, interpretation, signal, n),
        },
      ],
    }
  );

  const input = toolInput(message as any, '');
  const rankedRaw = (input?.recommendations as Array<Record<string, unknown>> | undefined) ?? [];

  const out: RankedDiscovery[] = [];
  const seenIdx = new Set<number>();
  for (const r of rankedRaw) {
    const idx = r.candidate_index;
    // Drop hallucinated / duplicate indices. Same intentional divergence from
    // Python's `isinstance(idx, int)` as recommendRun and recSimilarRun.
    if (
      typeof idx !== 'number' ||
      !Number.isInteger(idx) ||
      idx < 0 ||
      idx >= candidates.length ||
      seenIdx.has(idx)
    ) {
      continue;
    }
    seenIdx.add(idx);
    out.push({
      ...candidates[idx],
      score: Number(r.score ?? 0),
      rationale: String(r.rationale ?? '').trim(),
    });
  }

  out.sort((a, b) => b.score - a.score);
  // Prefer candidates with descriptions (better UX), but never drop below n if
  // description-having candidates are scarce.
  const withDesc = out.filter((c) => c.description);
  const withoutDesc = out.filter((c) => !c.description);
  return [...withDesc, ...withoutDesc].slice(0, n);
}
