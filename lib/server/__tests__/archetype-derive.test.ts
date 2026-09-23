import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeTestDb, loadSeed, type Seed } from './helpers/pglite';
import { fakeClaude } from './helpers/fakeClaude';
import { setupTestEnv } from './helpers/testEnv';
import seedJson from './fixtures/seed.json';
import { schema, type Db } from '../db';
import { ApiError } from '../errors';
import { ARCHETYPE_MAX_TOKENS, deriveArchetype } from '../archetypeDerive';
import type { ClaudeMessage } from '../claude';

setupTestEnv();

async function withSeed(fn: (db: Db) => Promise<void>): Promise<void> {
  const { db, close } = await makeTestDb();
  try {
    await loadSeed(db, seedJson as Seed);
    await fn(db);
  } finally {
    await close();
  }
}

async function archetypeRow(db: Db) {
  const [row] = await db
    .select()
    .from(schema.readerArchetypes)
    .where(eq(schema.readerArchetypes.userId, 'local'));
  return row;
}

/** What the API returns when the four rationales use up the budget: the tool call stops early. */
function cutOffReply(): ClaudeMessage {
  return {
    content: [
      {
        type: 'tool_use',
        name: 'record_archetype_scores',
        input: { lens: 0.5, engine: -0.2, range: 0.1, lens_rationale: 'A long rationale…' },
      },
    ],
    stop_reason: 'max_tokens',
    usage: { input_tokens: 900, output_tokens: ARCHETYPE_MAX_TOKENS },
  };
}

describe('deriveArchetype output budget', () => {
  it('leaves room for four scores and four rationales', async () => {
    await withSeed(async (db) => {
      const client = fakeClaude([cutOffReply()]);
      await deriveArchetype(db, client, 'local').catch(() => undefined);
      expect(client.calls[0].params.max_tokens).toBeGreaterThanOrEqual(1024);
    });
  });

  it('answers a cut-off reply with a retryable 502 and writes nothing', async () => {
    await withSeed(async (db) => {
      const before = await archetypeRow(db);
      const err = await deriveArchetype(db, fakeClaude([cutOffReply()]), 'local').catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect({ status: err.status, detail: err.detail }).toEqual({
        status: 502,
        detail: 'Claude ran out of room describing your archetype. Try again.',
      });
      expect(await archetypeRow(db)).toEqual(before);
    });
  });
});
