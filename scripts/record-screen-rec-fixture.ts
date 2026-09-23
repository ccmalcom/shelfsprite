/**
 * Controller-run, needs the network: records the Stage 1 port traffic for the screen recommender.
 *
 *   npx tsx scripts/record-screen-rec-fixture.ts
 *   npx prettier --write lib/server/__tests__/fixtures/screen/recommend-port.json
 *
 * Runs the pool set live over Task 3's synthetic library, aborts on any retryable answer,
 * replays the recording through replayPort, and writes only if both runs match exactly.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  emptyRecording,
  recordingPort,
  replayPort,
  runRecommendSet,
  type RecObserved,
  type RecordedPort,
} from '../lib/server/__tests__/fixtures/screen/recommend-set';
import { makeTestDb } from '../lib/server/__tests__/helpers/pglite';
import { seedScreenLibrary } from '../lib/server/__tests__/helpers/screenRecFixtures';
import type { Db } from '../lib/server/db';
import { defaultScreenCatalogPort, type ScreenCatalogPort } from '../lib/server/screenAssemble';
import { deadlineIn } from '../lib/server/screenCatalog';

const OUT = path.resolve(
  __dirname,
  '..',
  'lib/server/__tests__/fixtures/screen/recommend-port.json'
);

async function run(portFor: (db: Db) => ScreenCatalogPort): Promise<RecObserved> {
  const { db, close } = await makeTestDb();
  try {
    await seedScreenLibrary(db);
    return await runRecommendSet(db, portFor(db), deadlineIn(900_000));
  } finally {
    await close();
  }
}

async function main(): Promise<void> {
  const recorded: RecordedPort = emptyRecording();
  const failures: string[] = [];
  const live = await run((db) =>
    recordingPort(defaultScreenCatalogPort(db, deadlineIn(900_000)), recorded, failures)
  );
  if (failures.length > 0) {
    console.error('Not writing the fixture; retryable answers:\n' + failures.join('\n'));
    process.exit(1);
  }
  const replayed = await run(() => replayPort(recorded));
  if (!isDeepStrictEqual(live, replayed)) {
    console.error('Not writing the fixture; the replay differs from the live run.');
    console.error(JSON.stringify({ live, replayed }, null, 2));
    process.exit(1);
  }
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify({
      recorded_at: new Date().toISOString(),
      note: 'Recorded by scripts/record-screen-rec-fixture.ts over the synthetic seedScreenLibrary. Re-record, never hand-edit.',
      observed: live,
      recorded,
    })
  );
  console.log(JSON.stringify(live, null, 2));
  console.log(
    `recorded ${Object.keys(recorded.sparql).length} queries, ${Object.keys(recorded.tvmaze).length} TVmaze lookups, ${Object.keys(recorded.metadata).length} candidates`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
