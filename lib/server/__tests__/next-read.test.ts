import { describe, test, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import seedJson from './fixtures/seed.json';
import { makeTestDb, loadSeed } from './helpers/pglite';
import { setupTestEnv } from './helpers/testEnv';
import { fakeClaude } from './helpers/fakeClaude';
import { installHttpReplay } from './helpers/httpReplay';
import { _setDbForTests, schema, type Db } from '../db';
import {
  runNextRead,
  NEXT_READ_EMPTY_MESSAGE,
  NEXT_READ_NO_EVIDENCE_MESSAGE,
} from '../nextReadRun';
import { NEXT_READ_TOOL } from '../nextReadPrompts';
import { POST as nextReadPost } from '@/app/api/next-read/route';
import { GET as settingsGet, PUT as settingsPut } from '@/app/api/settings/next-read/route';

function pickReply(picks: unknown[]) {
  return {
    content: [{ type: 'tool_use', name: NEXT_READ_TOOL.name, input: { picks } }],
    stop_reason: 'tool_use',
    usage: null,
  } as any;
}

async function addToRead(db: Db, userId: string, title: string, dateAdded: string) {
  const [row] = await db
    .insert(schema.books)
    .values({
      userId,
      title,
      author: `${title} Author`,
      exclusiveShelf: 'to-read',
      goodreadsRating: 0,
      source: 'manual',
      dateAdded,
    })
    .returning({ id: schema.books.id });
  return row.id;
}

/** The candidate list as the prompt sends it, parsed back out of the task block. */
function shelfInPrompt(call: { params: Record<string, unknown> }): Array<{ title: string }> {
  const content = (call.params.messages as any[])[0].content as Array<{ text: string }>;
  const task = content[1].text;
  return JSON.parse(task.slice(task.indexOf('TO-READ SHELF (JSON):\n') + 22));
}

const jsonReq = (url: string, method: string, body?: unknown) =>
  new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe('runNextRead', () => {
  setupTestEnv();

  test("ranks only the reader's own to-read shelf and drops anything not on it", async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      await addToRead(db, 'local', 'Shelf Book A', '2026-11-01');
      const b = await addToRead(db, 'local', 'Shelf Book B', '2026-11-02');
      await addToRead(db, 'other', 'Someone Else Book', '2026-11-03');

      const client = fakeClaude([
        pickReply([
          { candidate_index: 0, score: 0.6, rationale: '  second best  ' },
          { candidate_index: 99, score: 0.99, rationale: 'not on the shelf' },
          { candidate_index: 1, score: 0.9, rationale: 'best' },
          { candidate_index: 1, score: 0.95, rationale: 'cited twice' },
          { candidate_index: 'x', score: 1, rationale: 'not an index' },
        ]),
      ]);

      const out = (await runNextRead(db, client, 'local', 3)) as any;

      const shelf = shelfInPrompt(client.calls[0]);
      const titles = shelf.map((c) => c.title);
      // Newest saved first; the other reader's book never reaches the prompt.
      expect(titles.slice(0, 2)).toEqual(['Shelf Book B', 'Shelf Book A']);
      expect(titles).not.toContain('Someone Else Book');
      expect(out.to_read_count).toBe(shelf.length);
      expect(out.considered).toBe(shelf.length);

      expect(out.count).toBe(2);
      expect(out.picks.map((p: any) => [p.rank, p.book.title, p.rationale, p.score])).toEqual([
        [1, 'Shelf Book A', 'best', 0.9],
        [2, 'Shelf Book B', 'second best', 0.6],
      ]);
      expect(out.picks[1].book.id).toBe(b);
      expect(out.picks[0].book.exclusive_shelf).toBe('to-read');

      // Asks for the forced tool by name and records the call under its own operation.
      expect((client.calls[0].params.tools as any[])[0].name).toBe('pick_next_reads');
      const usage = await db.select().from(schema.usageEvents);
      expect(usage.some((u) => u.operation === 'next_read_rank')).toBe(true);
    } finally {
      await close();
    }
  });

  test('asks for no more picks than the shelf holds', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      const client = fakeClaude([pickReply([{ candidate_index: 0, score: 0.5, rationale: 'r' }])]);
      const out = (await runNextRead(db, client, 'local', 5)) as any;
      const content = (client.calls[0].params.messages as any[])[0].content;
      // The seed holds one to-read book for 'local'.
      expect(content[1].text).toContain('Pick the 1 books');
      expect(out.count).toBe(1);
    } finally {
      await close();
    }
  });

  test('refuses an empty shelf before calling Claude', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      await db
        .update(schema.books)
        .set({ exclusiveShelf: 'read' })
        .where(eq(schema.books.exclusiveShelf, 'to-read'));
      const client = fakeClaude([]);
      await expect(runNextRead(db, client, 'local', 3)).rejects.toMatchObject({
        status: 400,
        message: NEXT_READ_EMPTY_MESSAGE,
      });
      expect(client.calls).toEqual([]);
    } finally {
      await close();
    }
  });

  test('refuses a reader with no loved books or traits to weigh the shelf against', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      await addToRead(db, 'newcomer', 'Lonely Book', '2026-11-01');
      const client = fakeClaude([]);
      await expect(runNextRead(db, client, 'newcomer', 3)).rejects.toMatchObject({
        status: 400,
        message: NEXT_READ_NO_EVIDENCE_MESSAGE,
      });
      expect(client.calls).toEqual([]);
    } finally {
      await close();
    }
  });
});

describe('POST /api/next-read', () => {
  setupTestEnv();

  test('validates n and answers the no-key 400 without any outbound call', async () => {
    const { db, close } = await makeTestDb();
    const seen: string[] = [];
    const restore = installHttpReplay({}, (u) => seen.push(u));
    try {
      await loadSeed(db, seedJson as any);
      await db.update(schema.userSettings).set({ anthropicApiKeyEncrypted: null });
      _setDbForTests(db);
      const url = 'http://test/api/next-read';
      expect((await nextReadPost(jsonReq(url, 'POST', { n: 0 }))).status).toBe(422);
      expect((await nextReadPost(jsonReq(url, 'POST', { n: 11 }))).status).toBe(422);
      const res = await nextReadPost(jsonReq(url, 'POST'));
      expect(res.status).toBe(400);
      expect((await res.json()).detail).toContain('No Anthropic API key configured');
      expect(seen).toEqual([]);
    } finally {
      restore();
      _setDbForTests(null);
      await close();
    }
  });
});

describe('/api/settings/next-read', () => {
  setupTestEnv();

  test('defaults to asking, saves "don\'t ask again", and turns back on', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      _setDbForTests(db);
      const url = 'http://test/api/settings/next-read';
      expect(await (await settingsGet(jsonReq(url, 'GET'))).json()).toEqual({ prompt: true });

      const off = await settingsPut(jsonReq(url, 'PUT', { prompt: false }));
      expect(await off.json()).toEqual({ prompt: false });
      expect(await (await settingsGet(jsonReq(url, 'GET'))).json()).toEqual({ prompt: false });

      const on = await settingsPut(jsonReq(url, 'PUT', { prompt: true }));
      expect(await on.json()).toEqual({ prompt: true });

      expect((await settingsPut(jsonReq(url, 'PUT', { prompt: 'no' }))).status).toBe(422);
      expect((await settingsPut(jsonReq(url, 'PUT', { prompt: true, x: 1 }))).status).toBe(422);
    } finally {
      _setDbForTests(null);
      await close();
    }
  });

  test('a reader with no settings row reads as asking, and saving creates the row', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      await db.delete(schema.userSettings);
      _setDbForTests(db);
      const url = 'http://test/api/settings/next-read';
      expect(await (await settingsGet(jsonReq(url, 'GET'))).json()).toEqual({ prompt: true });
      await settingsPut(jsonReq(url, 'PUT', { prompt: false }));
      const rows = await db.select().from(schema.userSettings);
      expect(rows.map((r) => [r.userId, r.nextReadPromptOff])).toEqual([['local', true]]);
    } finally {
      _setDbForTests(null);
      await close();
    }
  });
});
