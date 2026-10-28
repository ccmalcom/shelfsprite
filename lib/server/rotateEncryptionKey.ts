/**
 * Re-encrypts every stored per-user Anthropic key from one ENCRYPTION_KEY to another, so the key
 * can be rotated without stranding saved credentials. Driven by
 * `scripts/rotate-encryption-key.ts`; see docs/hosting.md "Rotating ENCRYPTION_KEY".
 *
 * Safe to rerun. A row that already decrypts under the new key is left byte-for-byte alone, so a
 * second pass after the Vercel swap picks up only rows the old deployment wrote in between. AES-GCM
 * authenticates, so a token never "decrypts" under the wrong key by accident.
 *
 * Nothing here returns or logs a key or a plaintext: the report carries counts and row ids only.
 */
import { and, eq, isNotNull } from 'drizzle-orm';
import { schema, type Db, type DbTx } from './db';
import { decrypt, encrypt } from './crypto';

export interface RotationReport {
  applied: boolean;
  scanned: number;
  /** Decrypted under the old key; re-encrypted (or, in a dry run, would be). */
  rotated: number;
  /** Already decrypts under the new key; untouched. */
  alreadyNew: number;
  /** Decrypts under neither key; untouched. Row ids, for follow-up. */
  unreadable: number[];
  /** Changed by someone else between read and write; untouched. Rerun to pick them up. */
  changedDuringRun: number[];
}

/** Decodes a base64 AES-256 key, naming the variable (never the value) on failure. */
export function parseKey(name: string, b64: string | undefined): Buffer {
  if (!b64) throw new Error(`${name} is not set`);
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error(`${name} must decode to exactly 32 bytes (AES-256)`);
  return key;
}

function tryDecrypt(token: string, key: Buffer): string | null {
  try {
    return decrypt(token, key);
  } catch {
    return null;
  }
}

async function run(
  db: Db | DbTx,
  oldKey: Buffer,
  newKey: Buffer,
  apply: boolean
): Promise<RotationReport> {
  const t = schema.userSettings;
  const rows = await db
    .select({ id: t.id, token: t.anthropicApiKeyEncrypted })
    .from(t)
    .where(isNotNull(t.anthropicApiKeyEncrypted))
    .orderBy(t.id);

  const report: RotationReport = {
    applied: apply,
    scanned: rows.length,
    rotated: 0,
    alreadyNew: 0,
    unreadable: [],
    changedDuringRun: [],
  };

  for (const row of rows) {
    const token = row.token as string;
    if (tryDecrypt(token, newKey) !== null) {
      report.alreadyNew += 1;
      continue;
    }
    const plaintext = tryDecrypt(token, oldKey);
    if (plaintext === null) {
      report.unreadable.push(row.id);
      continue;
    }
    if (apply) {
      // Conditional on the token we read, so a key the user saved mid-run is never clobbered.
      // updated_at is deliberately left alone: re-wrapping a key is not a user change.
      const written = await db
        .update(t)
        .set({ anthropicApiKeyEncrypted: encrypt(plaintext, newKey) })
        .where(and(eq(t.id, row.id), eq(t.anthropicApiKeyEncrypted, token)))
        .returning({ id: t.id });
      if (written.length === 0) {
        report.changedDuringRun.push(row.id);
        continue;
      }
    }
    report.rotated += 1;
  }
  return report;
}

/**
 * Dry run (the default) only reads. `apply: true` writes every re-encryption in one transaction,
 * so a failure part-way leaves the table exactly as it was.
 */
export async function rotateEncryptionKey(
  db: Db,
  oldKey: Buffer,
  newKey: Buffer,
  opts: { apply?: boolean } = {}
): Promise<RotationReport> {
  if (oldKey.equals(newKey)) {
    throw new Error('the old and new encryption keys are identical; nothing to rotate');
  }
  if (!opts.apply) return run(db, oldKey, newKey, false);
  return db.transaction((tx) => run(tx, oldKey, newKey, true));
}
