import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeTestDb, loadSeed, type Seed } from './helpers/pglite';
import seedJson from './fixtures/seed.json';
import { schema, type Db } from '../db';
import type { ClaudeClient, ClaudeMessage } from '../claude';
import { extractTasteProfile, persistProposedTraits } from '../profileBuild';
import { booksChangedSince, updateTasteProfile } from '../profileUpdate';
import { readRebuildReason, setRebuildReason } from '../profileMeta';
import { utcnowTs } from '../serialize';
import { fakeClaude } from './helpers/fakeClaude';

const tool = (name: string, traits: unknown[] = []): ClaudeMessage => ({
  content: [{ type: 'tool_use', name, input: { traits } }],
  usage: { input_tokens: 1, output_tokens: 1 },
});

/**
 * A Claude client whose call runs `during` (a concurrent user edit) before answering,
 * so the edit lands strictly after the run started and strictly before it persists.
 */
function clientWithEdit(response: ClaudeMessage, during: () => Promise<void>) {
  const calls: Record<string, unknown>[] = [];
  const client: ClaudeClient = {
    messages: {
      async create(params) {
        calls.push(params);
        await new Promise((r) => setTimeout(r, 5));
        await during();
        await new Promise((r) => setTimeout(r, 5));
        return response;
      },
    },
  };
  return { client, calls };
}

/** A rating change exactly as PATCH /api/books/[id]/feedback writes it. */
async function rateBook(db: Db, bookId: number, rating: number) {
  await db
    .update(schema.books)
    .set({ appRating: rating, feedbackUpdatedAt: utcnowTs() })
    .where(eq(schema.books.id, bookId));
}

async function lastProfiledAt(db: Db): Promise<string | null> {
  const rows = await db
    .select()
    .from(schema.profileMeta)
    .where(eq(schema.profileMeta.userId, 'local'));
  return rows[0]?.lastProfiledAt ?? null;
}

describe('markProfiled stamps the start of the run', () => {
  it('a rating changed during a FULL build is still pending afterwards', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      const { client } = clientWithEdit(tool('record_taste_traits'), () => rateBook(db, 5, 4.5));

      await extractTasteProfile(db, client, 'local');

      const pending = await booksChangedSince(db, await lastProfiledAt(db), 'local');
      expect(pending.map((b) => b.id)).toContain(5);
    } finally {
      await close();
    }
  });

  it('a rating changed during an INCREMENTAL update is still pending afterwards', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed); // proposed traits exist; books 2, 3, 9 changed
      const { client, calls } = clientWithEdit(tool('revise_taste_traits'), () =>
        rateBook(db, 5, 4.5)
      );

      const out = await updateTasteProfile(db, client, 'local');
      expect(out.mode).toBe('update');
      expect((calls[0].tool_choice as { name: string }).name).toBe('revise_taste_traits');

      const pending = await booksChangedSince(db, await lastProfiledAt(db), 'local');
      expect(pending.map((b) => b.id)).toEqual([5]);
    } finally {
      await close();
    }
  });

  it('stamps exactly the runStartedAt it is given', async () => {
    const { db, close } = await makeTestDb();
    try {
      await persistProposedTraits(db, 'local', [], new Set(), 'full', '2026-01-02 03:04:05.678');
      expect(await lastProfiledAt(db)).toBe('2026-01-02 03:04:05.678');
    } finally {
      await close();
    }
  });
});

describe('a full rebuild clears only the rebuild reason it read at its start', () => {
  it('clears the reason that was pending when the run began', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      await setRebuildReason(db, 'local', 'title_deleted');
      // The clear needs rebuild_requested_at < runStartedAt, strictly; a same-millisecond tie
      // keeps the reason (the safe direction), so make the request strictly earlier.
      await new Promise((r) => setTimeout(r, 5));
      await extractTasteProfile(db, fakeClaude([tool('record_taste_traits')]), 'local');
      expect(await readRebuildReason(db, 'local')).toBeNull();
    } finally {
      await close();
    }
  });

  it('keeps a reason that arrived while the run was in flight', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      const { client } = clientWithEdit(tool('record_taste_traits'), () =>
        setRebuildReason(db, 'local', 'title_deleted')
      );
      await extractTasteProfile(db, client, 'local');
      expect(await readRebuildReason(db, 'local')).toBe('title_deleted');
    } finally {
      await close();
    }
  });

  it('keeps a reason re-requested mid-run while one was already pending', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      await setRebuildReason(db, 'local', 'screen_enabled');
      await new Promise((r) => setTimeout(r, 5)); // the request strictly predates the run
      // The run observes 'screen_enabled'; a title is deleted while Claude is thinking. The
      // label stays 'screen_enabled' (first wins), but the build must not clear it.
      const { client } = clientWithEdit(tool('record_taste_traits'), () =>
        setRebuildReason(db, 'local', 'title_deleted')
      );
      await extractTasteProfile(db, client, 'local');
      expect(await readRebuildReason(db, 'local')).toBe('screen_enabled');
    } finally {
      await close();
    }
  });

  it('an incremental persist never clears a reason', async () => {
    const { db, close } = await makeTestDb();
    try {
      await setRebuildReason(db, 'local', 'screen_enabled');
      await persistProposedTraits(
        db,
        'local',
        [],
        new Set(),
        'update',
        utcnowTs(),
        'screen_enabled'
      );
      expect(await readRebuildReason(db, 'local')).toBe('screen_enabled');
    } finally {
      await close();
    }
  });
});

describe('updateTasteProfile with a pending rebuild reason', () => {
  it('escalates to a full rebuild instead of revising, then clears the reason', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed); // proposed traits + changed books: normally incremental
      await setRebuildReason(db, 'local', 'screen_disabled');
      const client = fakeClaude([tool('record_taste_traits')]);

      const out = await updateTasteProfile(db, client, 'local');

      expect(out.mode).toBe('full');
      expect(client.calls[0].params.tool_choice).toEqual({
        type: 'tool',
        name: 'record_taste_traits',
      });
      expect(await readRebuildReason(db, 'local')).toBeNull();
    } finally {
      await close();
    }
  });

  it('escalates even when nothing else changed', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      // Move the cutoff past every seeded change and feedback timestamp.
      await db
        .update(schema.profileMeta)
        .set({ lastProfiledAt: '2999-01-01 00:00:00', recFeedbackUpdatedAt: null })
        .where(eq(schema.profileMeta.userId, 'local'));
      await setRebuildReason(db, 'local', 'title_deleted');
      const client = fakeClaude([tool('record_taste_traits')]);

      const out = await updateTasteProfile(db, client, 'local');

      expect(out.mode).toBe('full'); // not the "already up to date" early return
      expect(client.calls).toHaveLength(1);
    } finally {
      await close();
    }
  });
});
