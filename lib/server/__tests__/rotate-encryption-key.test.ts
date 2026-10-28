import { describe, it, expect } from 'vitest';
import { asc } from 'drizzle-orm';
import { makeTestDb, loadSeed } from './helpers/pglite';
import { schema, type Db } from '../db';
import { decrypt, encrypt } from '../crypto';
import { parseKey, rotateEncryptionKey } from '../rotateEncryptionKey';

const OLD_B64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const NEW_B64 = Buffer.alloc(32, 7).toString('base64');
const OTHER_B64 = Buffer.alloc(32, 9).toString('base64');
const OLD = parseKey('OLD', OLD_B64);
const NEW = parseKey('NEW', NEW_B64);
const OTHER = parseKey('OTHER', OTHER_B64);

async function tokens(db: Db): Promise<Array<{ id: number; token: string | null }>> {
  return db
    .select({ id: schema.userSettings.id, token: schema.userSettings.anthropicApiKeyEncrypted })
    .from(schema.userSettings)
    .orderBy(asc(schema.userSettings.id));
}

async function withDb(fn: (db: Db) => Promise<void>): Promise<void> {
  const { db, close } = await makeTestDb();
  try {
    await fn(db);
  } finally {
    await close();
  }
}

describe('parseKey', () => {
  it('names the variable, never the value, when unset or the wrong length', () => {
    expect(() => parseKey('ENCRYPTION_KEY_OLD', undefined)).toThrow(
      'ENCRYPTION_KEY_OLD is not set'
    );
    const short = Buffer.alloc(16, 1).toString('base64');
    let message = '';
    try {
      parseKey('ENCRYPTION_KEY_NEW', short);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/ENCRYPTION_KEY_NEW must decode to exactly 32 bytes/);
    expect(message).not.toContain(short);
  });
});

describe('rotateEncryptionKey', () => {
  it('refuses identical keys', async () => {
    await withDb(async (db) => {
      await expect(rotateEncryptionKey(db, OLD, OLD, { apply: true })).rejects.toThrow(/identical/);
    });
  });

  it('dry run counts what it would change and writes nothing', async () => {
    await withDb(async (db) => {
      await loadSeed(db, {
        user_settings: [
          { id: 1, user_id: 'a', anthropic_api_key_encrypted: encrypt('sk-ant-a', OLD) },
          { id: 2, user_id: 'b', anthropic_api_key_encrypted: encrypt('sk-ant-b', OLD) },
        ],
      });
      const before = await tokens(db);
      const r = await rotateEncryptionKey(db, OLD, NEW);
      expect(r).toEqual({
        applied: false,
        scanned: 2,
        rotated: 2,
        alreadyNew: 0,
        unreadable: [],
        changedDuringRun: [],
      });
      expect(await tokens(db)).toEqual(before);
    });
  });

  it('re-encrypts every stored key under the new key, preserving the plaintext', async () => {
    await withDb(async (db) => {
      await loadSeed(db, {
        user_settings: [
          { id: 1, user_id: 'a', anthropic_api_key_encrypted: encrypt('sk-ant-a', OLD) },
          { id: 2, user_id: 'b', anthropic_api_key_encrypted: encrypt('sk-ant-b', OLD) },
          { id: 3, user_id: 'c', anthropic_api_key_encrypted: null },
        ],
      });
      const r = await rotateEncryptionKey(db, OLD, NEW, { apply: true });
      expect(r.applied).toBe(true);
      expect(r.scanned).toBe(2);
      expect(r.rotated).toBe(2);
      const rows = await tokens(db);
      expect(decrypt(rows[0].token as string, NEW)).toBe('sk-ant-a');
      expect(decrypt(rows[1].token as string, NEW)).toBe('sk-ant-b');
      expect(() => decrypt(rows[0].token as string, OLD)).toThrow();
      expect(rows[2].token).toBeNull();
    });
  });

  it('is idempotent: a second run changes nothing', async () => {
    await withDb(async (db) => {
      await loadSeed(db, {
        user_settings: [
          { id: 1, user_id: 'a', anthropic_api_key_encrypted: encrypt('sk-ant-a', OLD) },
        ],
      });
      await rotateEncryptionKey(db, OLD, NEW, { apply: true });
      const afterFirst = await tokens(db);
      const r = await rotateEncryptionKey(db, OLD, NEW, { apply: true });
      expect(r.rotated).toBe(0);
      expect(r.alreadyNew).toBe(1);
      expect(await tokens(db)).toEqual(afterFirst);
    });
  });

  it('leaves new-key and unreadable rows untouched and reports unreadable ids', async () => {
    await withDb(async (db) => {
      const already = encrypt('sk-ant-new', NEW);
      const stranger = encrypt('sk-ant-x', OTHER);
      await loadSeed(db, {
        user_settings: [
          { id: 1, user_id: 'a', anthropic_api_key_encrypted: already },
          { id: 2, user_id: 'b', anthropic_api_key_encrypted: stranger },
          { id: 3, user_id: 'c', anthropic_api_key_encrypted: 'not-base64!!!' },
          { id: 4, user_id: 'd', anthropic_api_key_encrypted: encrypt('sk-ant-d', OLD) },
        ],
      });
      const r = await rotateEncryptionKey(db, OLD, NEW, { apply: true });
      expect(r).toMatchObject({ scanned: 4, rotated: 1, alreadyNew: 1, unreadable: [2, 3] });
      const rows = await tokens(db);
      expect(rows[0].token).toBe(already);
      expect(rows[1].token).toBe(stranger);
      expect(rows[2].token).toBe('not-base64!!!');
      expect(decrypt(rows[3].token as string, NEW)).toBe('sk-ant-d');
    });
  });

  it('never puts a plaintext or key in its report', async () => {
    await withDb(async (db) => {
      await loadSeed(db, {
        user_settings: [
          { id: 1, user_id: 'a', anthropic_api_key_encrypted: encrypt('sk-ant-secret', OLD) },
        ],
      });
      const r = JSON.stringify(await rotateEncryptionKey(db, OLD, NEW, { apply: true }));
      expect(r).not.toContain('sk-ant-secret');
      expect(r).not.toContain(OLD_B64);
      expect(r).not.toContain(NEW_B64);
    });
  });
});
