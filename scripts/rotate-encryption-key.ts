/**
 * Re-encrypts every stored per-user Anthropic key from ENCRYPTION_KEY_OLD to ENCRYPTION_KEY_NEW.
 * Dry run by default; pass --apply to write. Safe to rerun. Prints counts and row ids only, never
 * a key or a decrypted value. Full procedure: docs/hosting.md "Rotating ENCRYPTION_KEY".
 *
 *   ENCRYPTION_KEY_OLD=... ENCRYPTION_KEY_NEW=... npm run db:rotate-encryption-key
 *   ENCRYPTION_KEY_OLD=... ENCRYPTION_KEY_NEW=... npm run db:rotate-encryption-key -- --apply
 *
 * DATABASE_URL comes from the environment or `.env`. The target host is printed first so a run
 * against the wrong database is obvious before anything is written.
 */
import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../lib/server/schema';
import type { Db } from '../lib/server/db';
import { parseKey, rotateEncryptionKey } from '../lib/server/rotateEncryptionKey';

loadEnv({ path: path.resolve(__dirname, '..', '.env') });

async function main() {
  const apply = process.argv.includes('--apply');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const oldKey = parseKey('ENCRYPTION_KEY_OLD', process.env.ENCRYPTION_KEY_OLD);
  const newKey = parseKey('ENCRYPTION_KEY_NEW', process.env.ENCRYPTION_KEY_NEW);

  console.log(`database host: ${new URL(url).host}`);
  console.log(apply ? 'mode: APPLY (writes in one transaction)' : 'mode: dry run (no writes)');

  // prepare: false for Supabase's pooler, same as lib/server/db.ts.
  const client = postgres(url, { prepare: false, max: 1 });
  try {
    const db = drizzle(client, { schema }) as unknown as Db;
    const r = await rotateEncryptionKey(db, oldKey, newKey, { apply });
    console.log(`scanned: ${r.scanned}`);
    console.log(`${apply ? 're-encrypted' : 'would re-encrypt'}: ${r.rotated}`);
    console.log(`already on the new key: ${r.alreadyNew}`);
    console.log(`unreadable under either key: ${r.unreadable.length}`);
    if (r.unreadable.length) console.log(`  user_settings ids: ${r.unreadable.join(', ')}`);
    if (r.changedDuringRun.length) {
      console.log(`changed during the run (rerun): ${r.changedDuringRun.join(', ')}`);
    }
    if (r.unreadable.length || r.changedDuringRun.length) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
