import { afterEach, beforeEach, describe, test, expect } from 'vitest';
import { asc, eq } from 'drizzle-orm';
// Snapshot of the prompt as recorded at the Python cutover (2026-08-14). This is
// no longer a cross-backend parity check — it is a regression guard proving the
// deterministic retrieval pipeline still assembles an identical prompt. The
// recorder (scripts/gen_claude_fixtures.py) is gone, so if the prompt changes
// legitimately, update this fixture BY HAND and say why in the commit.
import prompts from './fixtures/claude/prompts.json';
import httpFixtures from './fixtures/claude/recommend-http.json';
import seedJson from './fixtures/seed.json';
import { makeTestDb, loadSeed } from './helpers/pglite';
import { setupTestEnv } from './helpers/testEnv';
import { installHttpReplay } from './helpers/httpReplay';
import { fakeClaude } from './helpers/fakeClaude';
import {
  coldSeedQueriesResponse,
  coldStartSeed,
  installFakeCatalog,
  titleSeedResponse,
} from './helpers/coldStartFixture';
import { schema } from '../db';
import { confidentDeck, lowConfidence, parseTitleSeeds, runRecommend } from '../recommendRun';

const PROFILED_AT = '2026-08-01 00:00:00'; // mirrors _prepare_recommend in the generator

/** Canned payload recorded for the prompt snapshot's seed call. */
const seedResponse = {
  content: [
    {
      type: 'tool_use',
      name: 'propose_search_queries',
      input: {
        queries: [
          { query: 'literary science fiction political systems', reason: 'fixture' },
          { query: 'anthropological science fiction first contact', reason: 'fixture' },
        ],
      },
    },
  ],
  usage: null,
};

const rerankResponse = (indices: number[]) => ({
  content: [
    {
      type: 'tool_use',
      name: 'rank_recommendations',
      input: {
        recommendations: indices.map((idx, i) => ({
          candidate_index: idx,
          score: 1 - i * 0.1,
          rationale: `  Because reasons ${idx}.  `,
          grounded_trait_ids: [1, 999], // 999 is not a real trait id
          grounded_book_ids: [1, 888], // 888 is not a loved book id
        })),
      },
    },
  ],
  usage: null,
});

async function seeded() {
  const { db, close } = await makeTestDb();
  await loadSeed(db, seedJson as any);
  await db.update(schema.profileMeta).set({ lastProfiledAt: PROFILED_AT });
  return { db, close };
}

function opts() {
  return { n: 10, useMetadata: true, useClaudeSeeds: true };
}

describe('runRecommend gates', () => {
  setupTestEnv();

  test('400s on an empty library, a missing profile, and a stale profile', async () => {
    const { db, close } = await makeTestDb();
    try {
      await expect(runRecommend(db, null, 'local', opts())).rejects.toMatchObject({
        status: 400,
        detail: expect.stringContaining('No loved books found'),
      });

      await loadSeed(db, seedJson as any);
      await db.update(schema.profileMeta).set({ lastProfiledAt: null });
      await expect(runRecommend(db, null, 'local', opts())).rejects.toMatchObject({
        status: 400,
        detail: expect.stringContaining('No taste profile found'),
      });

      // The seed is deliberately stale: 3 books carry a later feedback_updated_at.
      await db.update(schema.profileMeta).set({ lastProfiledAt: '2026-07-01 12:00:00' });
      await expect(runRecommend(db, null, 'local', opts())).rejects.toMatchObject({
        status: 400,
        detail:
          '3 book(s) have been rated/reviewed since the last profile build. Re-profile first (POST /profile/update) so recommendations reflect your current taste.',
      });
    } finally {
      await close();
    }
  });

  test('400s with the no-key message when a Claude stage is reached without a client', async () => {
    const { db, close } = await seeded();
    const restore = installHttpReplay(httpFixtures as any);
    try {
      await expect(runRecommend(db, null, 'local', opts())).rejects.toMatchObject({
        status: 400,
        detail: expect.stringContaining('No Anthropic API key configured'),
      });
    } finally {
      restore();
      await close();
    }
  });
});

describe('runRecommend happy path', () => {
  setupTestEnv();

  test('matches the recorded request snapshots', async () => {
    const { db, close } = await seeded();
    const restore = installHttpReplay(httpFixtures as any);
    const client = fakeClaude([seedResponse, rerankResponse([0, 1, 2])] as any);
    try {
      await runRecommend(db, client, 'local', opts());
      expect(client.calls).toHaveLength(2);
      // Total equality: no extra params, no missing params, byte-identical prompts.
      expect(client.calls[0].params).toEqual((prompts as any).recommend_seed.kwargs);
      expect(client.calls[1].params).toEqual((prompts as any).recommend_rerank.kwargs);
    } finally {
      restore();
      await close();
    }
  });

  test('persists the served set and validates the ids Claude cited', async () => {
    const { db, close } = await seeded();
    const restore = installHttpReplay(httpFixtures as any);
    const client = fakeClaude([seedResponse, rerankResponse([0, 1, 2])] as any);
    try {
      const out = (await runRecommend(db, client, 'local', opts())) as any;
      expect(out.served).toBe(3);
      expect(out.cold_start).toBe(false);
      expect(out.run_id).toMatch(/^[0-9a-f]{12}$/);
      expect(out.seed_queries).toEqual([
        'literary science fiction political systems',
        'anthropological science fiction first contact',
      ]);
      expect(out.recommendations[0].rank).toBe(1);
      // Rationale is trimmed. Do NOT assert WHICH candidate lands at rank 1: after the
      // score sort, _claude_rerank re-orders description-carrying candidates first, so
      // the winner depends on the replayed catalog payloads.
      expect(out.recommendations[0].rationale).toMatch(/^Because reasons \d+\.$/);

      const rows = await db
        .select()
        .from(schema.recommendations)
        .where(eq(schema.recommendations.runId, out.run_id))
        .orderBy(asc(schema.recommendations.rank));
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.rank)).toEqual([1, 2, 3]);
      expect(rows.every((r) => r.status === 'served')).toBe(true);
      // Hallucinated ids are dropped (999 / 888); real ones survive.
      expect(rows.every((r) => JSON.stringify(r.groundedTraitIds) === '[1]')).toBe(true);
      expect(rows.every((r) => JSON.stringify(r.groundedBookIds) === '[1]')).toBe(true);
    } finally {
      restore();
      await close();
    }
  });

  test('drops out-of-range and duplicate candidate indices', async () => {
    const { db, close } = await seeded();
    const restore = installHttpReplay(httpFixtures as any);
    const client = fakeClaude([seedResponse, rerankResponse([0, 0, 9999, 1])] as any);
    try {
      const out = (await runRecommend(db, client, 'local', opts())) as any;
      expect(out.served).toBe(2); // idx 0 once, idx 1 once
    } finally {
      restore();
      await close();
    }
  });

  test('use_claude_seeds=false makes no seed call and reports an empty seed pool', async () => {
    const { db, close } = await seeded();
    const restore = installHttpReplay(httpFixtures as any);
    const client = fakeClaude([rerankResponse([0])] as any);
    try {
      const out = (await runRecommend(db, client, 'local', {
        n: 10,
        useMetadata: true,
        useClaudeSeeds: false,
      })) as any;
      expect(client.calls).toHaveLength(1);
      expect(out.pool_seed).toBe(0);
      expect(out.seed_queries).toEqual([]);
    } finally {
      restore();
      await close();
    }
  });

  test('returns the no-candidates note without a rerank call when retrieval is empty', async () => {
    const { db, close } = await seeded();
    const client = fakeClaude([] as any);
    try {
      const out = (await runRecommend(db, client, 'local', {
        n: 10,
        useMetadata: false,
        useClaudeSeeds: false,
      })) as any;
      expect(client.calls).toHaveLength(0);
      expect(out).toMatchObject({ run_id: null, served: 0, candidates: 0, recommendations: [] });
      expect(out.note).toContain('Retrieval surfaced no new candidates');
    } finally {
      await close();
    }
  });

  // Observed in production 2026-08-30: both Claude stages ran and the reranker
  // answered with a full 1378-token tool call, yet not one row was written --
  // recommendations.id_seq never advanced. Every candidate_index it cited had been
  // dropped, so `ranked` was empty and the run "succeeded" with nothing served.
  test('returns a note instead of an empty run when the rerank yields no usable picks', async () => {
    const { db, close } = await seeded();
    const restore = installHttpReplay(httpFixtures as any);
    // A complete response whose every cited index is out of range.
    const client = fakeClaude([seedResponse, rerankResponse([9001, 9002, 9003])] as any);
    try {
      const before = await db.select().from(schema.recommendations);
      const out = (await runRecommend(db, client, 'local', opts())) as any;
      expect(client.calls).toHaveLength(2);
      expect(out.candidates).toBeGreaterThan(0);
      expect(out).toMatchObject({ run_id: null, served: 0, recommendations: [] });
      expect(out.note).toContain('no usable picks');
      const after = await db.select().from(schema.recommendations);
      expect(after).toHaveLength(before.length);
    } finally {
      restore();
      await close();
    }
  });

  test('sends the seed and rerank overrides without touching the snapshot defaults', async () => {
    process.env.MYLIBRARY_MODEL_SEED = 'model-seed';
    process.env.MYLIBRARY_MODEL_RERANK = 'model-rerank';
    const { db, close } = await seeded();
    const restore = installHttpReplay(httpFixtures as any);
    const client = fakeClaude([seedResponse, rerankResponse([0, 1, 2])] as any);
    try {
      const out = (await runRecommend(db, client, 'local', opts())) as any;
      expect(client.calls[0].params.model).toBe('model-seed');
      expect(client.calls[1].params.model).toBe('model-rerank');
      expect(out.model).toBe('model-rerank');
    } finally {
      restore();
      await close();
    }
  });
});

describe('runRecommend reroll (#135)', () => {
  setupTestEnv();

  async function titlesOf(db: Awaited<ReturnType<typeof seeded>>['db'], runId: string) {
    const rows = await db
      .select()
      .from(schema.recommendations)
      .where(eq(schema.recommendations.runId, runId));
    return rows.map((r) => r.title);
  }

  test("keeps the replaced deck's unswiped picks out of the new batch", async () => {
    const { db, close } = await seeded();
    const restore = installHttpReplay(httpFixtures as any);
    const client = fakeClaude([
      seedResponse,
      rerankResponse([0, 1, 2]),
      seedResponse,
      rerankResponse([0, 1, 2]),
      seedResponse,
      rerankResponse([0, 1, 2]),
    ] as any);
    const rejectedCount = async () =>
      (
        await db
          .select()
          .from(schema.recommendations)
          .where(eq(schema.recommendations.status, 'rejected'))
      ).length;
    try {
      const rejectedBefore = await rejectedCount();
      const first = (await runRecommend(db, client, 'local', opts())) as any;
      const firstTitles = await titlesOf(db, first.run_id);

      // Control: an ordinary run over the same catalog serves the same picks again.
      const plain = (await runRecommend(db, client, 'local', opts())) as any;
      expect(await titlesOf(db, plain.run_id)).toEqual(expect.arrayContaining(firstTitles));

      const rerolled = (await runRecommend(db, client, 'local', {
        ...opts(),
        reroll: true,
      })) as any;
      expect(rerolled.served).toBeGreaterThan(0);
      const rerolledTitles = await titlesOf(db, rerolled.run_id);
      expect(rerolledTitles.filter((t) => firstTitles.includes(t))).toEqual([]);

      // Skipped picks are not rejections, so they leave no trace in the taste signal.
      expect(await rejectedCount()).toBe(rejectedBefore);
    } finally {
      restore();
      await close();
    }
  });
});

describe('runRecommend cold start (QA 2026-10-30)', () => {
  setupTestEnv();
  let savedRps: string | undefined;
  beforeEach(() => {
    savedRps = process.env.MYLIBRARY_REQ_PER_SEC;
    process.env.MYLIBRARY_REQ_PER_SEC = '1000000';
  });
  afterEach(() => {
    if (savedRps === undefined) delete process.env.MYLIBRARY_REQ_PER_SEC;
    else process.env.MYLIBRARY_REQ_PER_SEC = savedRps;
  });

  async function coldDb() {
    const { db, close } = await makeTestDb();
    await loadSeed(db, coldStartSeed());
    return { db, close };
  }

  function candidateTitles(call: { params: Record<string, any> }): string[] {
    const text = call.params.messages[0].content[1].text as string;
    const list = JSON.parse(text.slice(text.indexOf('CANDIDATES (JSON):') + 19)) as any[];
    return list.map((c) => c.title);
  }

  test('asks for adjacent real titles, keeps only those the catalog holds, and pins them', async () => {
    const { db, close } = await coldDb();
    const restore = installFakeCatalog();
    const client = fakeClaude([
      coldSeedQueriesResponse,
      titleSeedResponse,
      rerankResponse([0, 1, 2, 3, 4]),
    ] as any);
    try {
      const out = (await runRecommend(db, client, 'local', opts())) as any;
      expect(out.cold_start).toBe(true);
      // One extra call, and only one: seed queries, title seeds, rerank.
      expect(client.calls.map((c) => (c.params as any).tools[0].name)).toEqual([
        'propose_search_queries',
        'propose_adjacent_books',
        'rank_recommendations',
      ]);
      expect(client.calls[1].params).toEqual((prompts as any).recommend_title_seed.kwargs);

      // Blank and repeated seeds are dropped before any lookup.
      expect(out.title_seeds).toEqual([
        "Emily Wilde's Encyclopaedia of Faeries by Heather Fawcett",
        'Nettle & Bone by T. Kingfisher',
        'The Long Way to a Small, Angry Planet by Becky Chambers',
        'Under the Whispering Door by TJ Klune',
        'Bookshops & Bonedust by Travis Baldree',
        'Legends & Lattes by Travis Baldree',
        'A Book No Catalog Holds by Nobody Real',
      ]);
      // Resolved: the four the catalog holds under their own author. Bookshops & Bonedust
      // finds only someone else's summary; the owned book and the invented one find nothing.
      expect(out.pool_title_seed).toBe(4);

      const titles = candidateTitles(client.calls[2]);
      // Every resolved seed reaches the reranker (capPool pins them; see rec-assemble.test.ts).
      expect(titles).toEqual(
        expect.arrayContaining([
          "Emily Wilde's Encyclopaedia of Faeries",
          'Nettle & Bone',
          'The Long Way to a Small, Angry Planet',
          'Under the Whispering Door',
        ])
      );
      // The seeds are lookups, not picks: the filler still reaches the reranker, which decides.
      expect(titles).toContain('Tea Shop of Whimsy');
      // Never a study aid that names a seed, nor the unreleased title, nor (in this mostly
      // fiction library) the nonfiction companions.
      for (const gone of [
        "Study Guide: Emily Wilde's Encyclopaedia of Faeries",
        'Summary of Bookshops & Bonedust',
        'Ninth Life of an Erstwhile Witch',
        "Miyazaki and the Hero's Journey",
        'Ghiblipedia',
        'Legends & Lattes',
      ]) {
        expect(titles).not.toContain(gone);
      }

      const rows = await db
        .select()
        .from(schema.recommendations)
        .where(eq(schema.recommendations.runId, out.run_id));
      // Persisted picks are catalog candidates; the seed reason records how one was found.
      expect(rows.filter((r) => r.seedReason?.startsWith('title:')).length).toBeGreaterThan(0);
    } finally {
      restore();
      await close();
    }
  });

  test('a library past the cold-start threshold makes no title-seed call', async () => {
    const { db, close } = await seeded();
    const restore = installHttpReplay(httpFixtures as any);
    const client = fakeClaude([seedResponse, rerankResponse([0, 1])] as any);
    try {
      const out = (await runRecommend(db, client, 'local', opts())) as any;
      expect(out.cold_start).toBe(false);
      expect(client.calls).toHaveLength(2);
      expect(out.title_seeds).toEqual([]);
      expect(out.pool_title_seed).toBe(0);
    } finally {
      restore();
      await close();
    }
  });

  test('use_claude_seeds=false skips the title seeds too', async () => {
    const { db, close } = await coldDb();
    const restore = installFakeCatalog();
    const client = fakeClaude([rerankResponse([0])] as any);
    try {
      const out = (await runRecommend(db, client, 'local', {
        n: 10,
        useMetadata: true,
        useClaudeSeeds: false,
      })) as any;
      expect(client.calls).toHaveLength(1);
      expect(out.title_seeds).toEqual([]);
    } finally {
      restore();
      await close();
    }
  });
});

describe('runRecommend short decks (QA 2026-10-30)', () => {
  setupTestEnv();

  /** A rerank of `count` picks; `flagged` set low_confidence, `prose` doubt the book in words. */
  const ranked = (count: number, flagged: number[], prose: number[] = []) => ({
    content: [
      {
        type: 'tool_use',
        name: 'rank_recommendations',
        input: {
          recommendations: Array.from({ length: count }, (_, idx) => ({
            candidate_index: idx,
            score: 1 - idx * 0.05,
            rationale: prose.includes(idx)
              ? 'A stretch, and the metadata is thin, so the authorship looks questionable.'
              : `Because reasons ${idx}.`,
            grounded_trait_ids: [1],
            grounded_book_ids: [1],
            ...(flagged.includes(idx) ? { low_confidence: true } : {}),
          })),
        },
      },
    ],
    usage: null,
  });

  async function run(response: unknown) {
    const { db, close } = await seeded();
    const restore = installHttpReplay(httpFixtures as any);
    const client = fakeClaude([seedResponse, response] as any);
    try {
      const out = (await runRecommend(db, client, 'local', opts())) as any;
      const rows = await db
        .select()
        .from(schema.recommendations)
        .where(eq(schema.recommendations.runId, out.run_id));
      return { out, rows };
    } finally {
      restore();
      await close();
    }
  }

  test('serves only the confident picks when there are at least five', async () => {
    const { out, rows } = await run(ranked(10, [6, 7, 8], [9]));
    expect(out.served).toBe(6);
    expect(out.held_back).toBe(4);
    expect(rows).toHaveLength(6);
    expect(out.recommendations.map((r: any) => r.rank)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rows.every((r) => !/metadata is thin/.test(r.rationale ?? ''))).toBe(true);
  });

  test('backfills the best doubted picks up to the five-card floor', async () => {
    const { out, rows } = await run(ranked(10, [2, 3, 4, 5, 6, 7, 8, 9]));
    expect(out.served).toBe(5);
    expect(out.held_back).toBe(5);
    // Confident 0 and 1, then the three best-scored doubted picks.
    expect(rows.map((r) => r.rationale).sort()).toEqual(
      [0, 1, 2, 3, 4].map((i) => `Because reasons ${i}.`).sort()
    );
  });

  test('never pads past what the reranker returned', async () => {
    const { out } = await run(ranked(3, [2]));
    expect(out.served).toBe(3);
    expect(out.held_back).toBe(0);
  });

  test('the rerank prompt asks for up to n and names the floor', () => {
    const kwargs = (prompts as any).recommend_rerank.kwargs;
    const text = kwargs.messages[0].content[1].text as string;
    expect(text).toContain('Rank up to 10 of the best candidates');
    expect(text).toContain('if fewer than 5 are strong');
    const item = kwargs.tools[0].input_schema.properties.recommendations.items;
    expect(item.properties.low_confidence.type).toBe('boolean');
    // Optional: a pick that omits it counts as confident.
    expect(item.required).not.toContain('low_confidence');
  });
});

describe('confidentDeck / lowConfidence / parseTitleSeeds', () => {
  const pick = (id: number, low: boolean) => ({ id, low_confidence: low });

  test('keeps confident picks, then fills to min(MIN_DECK, n) in the given order', () => {
    const byScore = [pick(1, true), pick(2, false), pick(3, true), pick(4, false)];
    expect(confidentDeck(byScore, 10).picks.map((p) => p.id)).toEqual([1, 2, 3, 4]);
    expect(confidentDeck(byScore, 3).picks.map((p) => p.id)).toEqual([1, 2, 4]);
    expect(confidentDeck(byScore, 3).heldBack).toBe(1);
  });

  test('reads the flag or a rationale that doubts the book, not an honest stretch', () => {
    expect(lowConfidence({ low_confidence: true, rationale: 'x' })).toBe(true);
    expect(lowConfidence({ rationale: 'The catalog metadata is thin here.' })).toBe(true);
    expect(lowConfidence({ rationale: 'Authorship looks questionable.' })).toBe(true);
    expect(lowConfidence({ rationale: 'A reach, but the voice is The Remains of the Day.' })).toBe(
      false
    );
    expect(lowConfidence({ low_confidence: false, rationale: 'Spare and wintry.' })).toBe(false);
  });

  test('parseTitleSeeds drops blanks and repeats and caps the list', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ title: `T${i}`, author: 'A B' }));
    expect(parseTitleSeeds({ books: many })).toHaveLength(12);
    expect(parseTitleSeeds({ books: [{ title: 'X' }, { author: 'Y' }, 'junk'] })).toEqual([]);
    expect(parseTitleSeeds(null)).toEqual([]);
  });
});
