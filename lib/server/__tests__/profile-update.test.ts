import { describe, it, expect } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { makeTestDb, loadSeed } from './helpers/pglite';
import { fakeClaude } from './helpers/fakeClaude';
import seedJson from './fixtures/seed.json';
import type { Seed } from './helpers/pglite';
import { booksChangedSince, buildUpdatePrompt, updateTasteProfile } from '../profileUpdate';
import { pyFloat } from '../serialize';
import { schema } from '../db';

describe('booksChangedSince', () => {
  it('returns rated/DNF/favorited books whose feedback changed after the cutoff', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      const changed = await booksChangedSince(db, '2026-07-01 12:00:00', 'local');
      // 2: favorited (unrated by app but goodreads 5) @ 07-15
      // 3: re-rated @ 07-20
      // 9: DNF @ 07-18
      // 7 changed @ 06-01, before the cutoff.
      expect(changed.map((b) => b.id)).toEqual([2, 3, 9]);
    } finally {
      await close();
    }
  });

  it('treats a null cutoff as "everything carrying feedback"', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      const changed = await booksChangedSince(db, null, 'local');
      expect(changed.map((b) => b.id)).toEqual([2, 3, 7, 9]);
    } finally {
      await close();
    }
  });
});

describe('buildUpdatePrompt', () => {
  it('renders changed ids as a Python list repr, not a JS join', () => {
    const out = buildUpdatePrompt([], new Map(), [2, 3, 9], null);
    expect(out).toContain('CHANGED BOOK IDS (the edits driving this update): [2, 3, 9]');
    expect(out).not.toContain('2,3,9');
  });

  it('renders an empty changed list as []', () => {
    expect(buildUpdatePrompt([], new Map(), [], null)).toContain('update): []\n');
  });

  it('renders an integral inference_confidence as a Python float', () => {
    const traits = [
      {
        id: 1,
        claim: 'A.',
        polarity: 'reward',
        inference_confidence: pyFloat(1),
        exhibits: [1],
        contrasts: [],
      },
    ];
    const out = buildUpdatePrompt(traits, new Map(), [1], null);
    expect(out).toContain('"inference_confidence": 1.0');
    expect(out).not.toContain('"inference_confidence": 1,');
  });
});

function reviseResponse(traits: unknown[]) {
  return {
    content: [{ type: 'tool_use', name: 'revise_taste_traits', input: { traits } }],
    usage: { input_tokens: 5, output_tokens: 5 },
  };
}

/** What the escalated full build gets back: a full build refuses an empty reply. */
function fullBuildResponse() {
  return {
    content: [
      {
        type: 'tool_use',
        name: 'record_taste_traits',
        input: { traits: [{ claim: 'Rewards dense prose.', polarity: 'reward', exhibits: [1] }] },
      },
    ],
    usage: { input_tokens: 5, output_tokens: 5 },
  };
}

/** Every trait row for `local`, by id: what a recommendation's trait citations resolve against. */
async function traitsById(db: Awaited<ReturnType<typeof makeTestDb>>['db']) {
  const rows = await db
    .select()
    .from(schema.tasteTraits)
    .where(eq(schema.tasteTraits.userId, 'local'))
    .orderBy(asc(schema.tasteTraits.id));
  return new Map(rows.map((r) => [r.id, r]));
}

describe('updateTasteProfile keeps trait ids stable (recommendations cite them)', () => {
  const IDEA_SF = 'Drawn to idea-driven science fiction that interrogates political systems.';
  const STANDALONE = 'Prefers standalone novels over long series commitments.';

  it('keeps every id across an update whose revised set is unchanged', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      const client = fakeClaude([
        reviseResponse([
          {
            claim: IDEA_SF,
            polarity: 'positive',
            exhibits: [1, 2, 3],
            contrasts: [],
            inference_confidence: 0.9,
          },
          {
            claim: STANDALONE,
            polarity: 'positive',
            exhibits: [2, 13],
            contrasts: [12],
            inference_confidence: 0.8,
          },
        ]),
      ]);

      await updateTasteProfile(db, client, 'local');

      const after = await traitsById(db);
      // Seeded proposed traits 1 and 3, confirmed 2 and rejected 4: the same ids, nothing new.
      expect([...after.keys()]).toEqual([1, 2, 3, 4]);
      expect(after.get(1)!.status).toBe('proposed');
      expect(after.get(1)!.claim).toBe(IDEA_SF);
      // Evidence and confidence are refreshed in place; the reveal line survives.
      expect(after.get(1)!.exhibits).toEqual([1, 2, 3]);
      expect(after.get(1)!.inferenceConfidence).toBe(0.9);
      expect(after.get(1)!.revealLine).toBe('You read to argue with civilizations.');
      expect(after.get(3)!.claim).toBe(STANDALONE);
    } finally {
      await close();
    }
  });

  it('updates a reworded trait in place and deletes only the trait it drops', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      const reworded = IDEA_SF.replace(/\.$/, ' and the people who run them.');
      const client = fakeClaude([
        reviseResponse([
          {
            claim: reworded,
            polarity: 'positive',
            exhibits: [1, 2],
            contrasts: [],
            inference_confidence: 0.9,
          },
          {
            claim: 'Rewards problem-solving under pressure.',
            polarity: 'reward',
            exhibits: [3],
            contrasts: [],
            inference_confidence: 0.7,
          },
        ]),
      ]);

      await updateTasteProfile(db, client, 'local');

      const after = await traitsById(db);
      expect(after.get(1)!.claim).toBe(reworded);
      expect(after.get(1)!.status).toBe('proposed');
      // The old reveal line narrated the old wording, so it is cleared for regeneration.
      expect(after.get(1)!.revealLine).toBeNull();
      expect(after.has(3)).toBe(false); // dropped
      expect(after.get(2)!.status).toBe('confirmed'); // verdicted traits untouched
      expect(after.get(4)!.status).toBe('rejected');
      const added = [...after.values()].filter((r) => r.id > 4);
      expect(added.map((r) => r.claim)).toEqual(['Rewards problem-solving under pressure.']);
    } finally {
      await close();
    }
  });
  it('matches a stored claim with echoed ids to its stripped rewrite exactly', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      // Trait 1 as stored before the write-time guard: its cited ids echoed into the claim.
      await db
        .update(schema.tasteTraits)
        .set({ claim: IDEA_SF.replace(' science fiction', ' science fiction (1, 2)') })
        .where(eq(schema.tasteTraits.id, 1));
      const client = fakeClaude([
        reviseResponse([
          // Claude returns the trait in clean text, as CLAIM_TEXT_RULE asks.
          { claim: IDEA_SF, polarity: 'positive', exhibits: [1, 2], inference_confidence: 0.9 },
          {
            claim: STANDALONE,
            polarity: 'positive',
            exhibits: [2, 13],
            contrasts: [12],
            inference_confidence: 0.8,
          },
        ]),
      ]);

      await updateTasteProfile(db, client, 'local');

      const after = await traitsById(db);
      expect([...after.keys()]).toEqual([1, 2, 3, 4]);
      expect(after.get(1)!.claim).toBe(IDEA_SF);
      // Read as readers see it, the claim did not change, so this is no reword: the reveal
      // line, which a reword clears, survives.
      expect(after.get(1)!.revealLine).toBe('You read to argue with civilizations.');
    } finally {
      await close();
    }
  });
});

describe('updateTasteProfile', () => {
  it('revises the trait set from the seeded changes', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      const client = fakeClaude([
        reviseResponse([
          {
            claim: 'Rewards problem-solving under pressure.',
            polarity: 'reward',
            exhibits: [3],
            contrasts: [9999],
            inference_confidence: 0.9,
          },
        ]),
      ]);

      const out = await updateTasteProfile(db, client, 'local');

      expect(out.mode).toBe('update');
      expect(out.changed_books).toBe(3); // books 2, 3, 9
      expect(out.traits_before).toBe(2); // seeded proposed traits 1 and 3
      expect(out.traits_after).toBe(1);
      expect(typeof out.books_sent).toBe('number');

      const proposed = await db
        .select()
        .from(schema.tasteTraits)
        .where(
          and(eq(schema.tasteTraits.userId, 'local'), eq(schema.tasteTraits.status, 'proposed'))
        );
      expect(proposed).toHaveLength(1);
      // 9999 is not in books_meta, so it is filtered from contrasts.
      expect(proposed[0].contrasts).toEqual([]);

      const events = await db.select().from(schema.usageEvents);
      expect(events.some((e) => e.operation === 'profile_update')).toBe(true);
    } finally {
      await close();
    }
  });

  it('falls back to a full build when there is no prior profile', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      await db
        .delete(schema.tasteTraits)
        .where(
          and(eq(schema.tasteTraits.userId, 'local'), eq(schema.tasteTraits.status, 'proposed'))
        );

      const client = fakeClaude([fullBuildResponse()]);
      const out = await updateTasteProfile(db, client, 'local');
      expect(out.mode).toBe('full');
      // The full builder must have been the one that called Claude.
      expect((client.calls[0].params.tools as { name: string }[])[0].name).toBe(
        'record_taste_traits'
      );
    } finally {
      await close();
    }
  });

  it('falls back to a full build after an enrichment correction', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      await db
        .update(schema.profileMeta)
        .set({ enrichmentCorrectedAt: '2026-07-25 12:00:00' })
        .where(eq(schema.profileMeta.userId, 'local'));

      const client = fakeClaude([fullBuildResponse()]);
      const out = await updateTasteProfile(db, client, 'local');
      expect(out.mode).toBe('full');
      // The full builder must have been the one that called Claude, not the revise path.
      expect((client.calls[0].params.tools as { name: string }[])[0].name).toBe(
        'record_taste_traits'
      );
    } finally {
      await close();
    }
  });

  it('returns the up-to-date note without calling Claude when nothing changed', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      // Push the last-profiled stamp past every change in the seed.
      await db
        .update(schema.profileMeta)
        .set({ lastProfiledAt: '2027-01-01 00:00:00', recFeedbackUpdatedAt: null })
        .where(eq(schema.profileMeta.userId, 'local'));

      const client = fakeClaude([]);
      const out = await updateTasteProfile(db, client, 'local');

      expect(out).toEqual({
        mode: 'update',
        changed_books: 0,
        traits_before: 2,
        traits_after: 2,
        note: 'Profile already up to date — no rating/review changes since last build.',
        model: 'claude-sonnet-5-5',
      });
      expect('books_sent' in out).toBe(false);
      expect(client.calls).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it('falls back to a full build when only exclusion toggles changed', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      await db
        .update(schema.profileMeta)
        .set({ lastProfiledAt: '2027-01-01 00:00:00', recFeedbackUpdatedAt: null })
        .where(eq(schema.profileMeta.userId, 'local'));
      // One excluded book with feedback after the cutoff: it counts as `changed`
      // but is filtered out of `changed_ids`.
      await db
        .update(schema.books)
        .set({ excludeFromProfile: true, feedbackUpdatedAt: '2027-02-01 00:00:00' })
        .where(eq(schema.books.id, 3));

      const client = fakeClaude([fullBuildResponse()]);
      const out = await updateTasteProfile(db, client, 'local');
      expect(out.mode).toBe('full');
      // The full builder must have been the one that called Claude, not the revise path.
      expect((client.calls[0].params.tools as { name: string }[])[0].name).toBe(
        'record_taste_traits'
      );
    } finally {
      await close();
    }
  });

  it('falls through to the revise call with an empty changed-ids list when only feedback changed', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      // Push the last-profiled stamp past every book change in the seed, but stamp
      // rec_feedback_updated_at AFTER that cutoff: no changed books, but feedback
      // arrived since the last build. Branch-table row 5.
      await db
        .update(schema.profileMeta)
        .set({ lastProfiledAt: '2027-01-01 00:00:00', recFeedbackUpdatedAt: '2027-02-01 00:00:00' })
        .where(eq(schema.profileMeta.userId, 'local'));

      const client = fakeClaude([reviseResponse([])]);
      const out = await updateTasteProfile(db, client, 'local');

      expect(out.mode).toBe('update');
      expect(out.changed_books).toBe(0);
      // Must have fallen through to the Claude call (not the early-return note path).
      expect(client.calls).toHaveLength(1);
      expect((client.calls[0].params.tools as { name: string }[])[0].name).toBe(
        'revise_taste_traits'
      );
      const messages = client.calls[0].params.messages as { content: string }[];
      expect(messages[0].content).toContain('CHANGED BOOK IDS (the edits driving this update): []');
    } finally {
      await close();
    }
  });
});
