import { describe, test, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeTestDb } from './helpers/pglite';
import { setupTestEnv } from './helpers/testEnv';
import { _setDbForTests, schema, type Db } from '../db';
import { PATCH } from '@/app/api/recommendations/[id]/feedback/route';

const call = (id: number, body: unknown) =>
  PATCH(
    new Request(`http://test/api/recommendations/${id}/feedback`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: { id: String(id) } }
  );

async function withRec(fn: (db: Db, id: number) => Promise<void>) {
  const { db, close } = await makeTestDb();
  try {
    const [rec] = await db
      .insert(schema.recommendations)
      .values({
        userId: 'local',
        runId: 'run-a',
        rank: 1,
        title: 'Piranesi',
        author: 'Susanna Clarke',
        score: 0.9,
        status: 'served',
      })
      .returning();
    _setDbForTests(db);
    await fn(db, rec.id);
  } finally {
    _setDbForTests(null);
    await close();
  }
}

describe('PATCH /api/recommendations/[id]/feedback reject reasons', () => {
  setupTestEnv();

  test('stores the new skip reasons alongside the existing ones', async () => {
    await withRec(async (db, id) => {
      const reasons = ['too_similar', 'not_out_yet', 'not_my_kind', 'wrong_vibe'];
      const res = await call(id, { status: 'rejected', reject_reasons: reasons });
      expect(res.status).toBe(200);
      const [row] = await db
        .select()
        .from(schema.recommendations)
        .where(eq(schema.recommendations.id, id));
      expect(row.rejectReasons).toEqual(reasons);
    });
  });

  test('still rejects an unknown code', async () => {
    await withRec(async (_db, id) => {
      const res = await call(id, { status: 'rejected', reject_reasons: ['meh'] });
      expect(res.status).toBe(422);
    });
  });
});
