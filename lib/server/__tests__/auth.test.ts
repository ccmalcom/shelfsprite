import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet } from 'jose';
import {
  verifyRequestUser,
  AuthConfigError,
  AuthError,
  LOCAL_USER_ID,
  isAdminEmail,
} from '../auth';
import { LOCAL_AUTH_FLAG } from '../authMode';

const ENV_KEYS = [
  'SUPABASE_JWKS_URL',
  'SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_JWT_ISSUER',
  'ADMIN_EMAILS',
  LOCAL_AUTH_FLAG,
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function makeJwksAndToken(
  claims: Record<string, unknown>,
  opts: { expired?: boolean; issuer?: string } = {}
) {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key';
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const now = Math.floor(Date.now() / 1000);
  const builder = new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
    .setIssuedAt(opts.expired ? now - 7200 : now)
    .setExpirationTime(opts.expired ? now - 3600 : now + 3600)
    .setAudience('authenticated');
  if (opts.issuer !== undefined) builder.setIssuer(opts.issuer);
  const token = await builder.sign(privateKey);
  return { jwks, token };
}

describe('auth', () => {
  it('local mode: no Supabase configured AND the opt-in flag -> local admin user', async () => {
    process.env[LOCAL_AUTH_FLAG] = 'true';
    const user = await verifyRequestUser(null);
    expect(user).toEqual({ userId: LOCAL_USER_ID, email: null, isAdmin: true });
  });

  it('fails closed when nothing is configured and local mode was not requested', async () => {
    await expect(verifyRequestUser(null)).rejects.toBeInstanceOf(AuthConfigError);
    // Never an AuthError: a 401 would invite a retry, and this is not the caller's fault.
    await expect(verifyRequestUser(null)).rejects.not.toBeInstanceOf(AuthError);
  });

  it('fails closed on a partial Supabase configuration, flag or not', async () => {
    process.env.SUPABASE_URL = 'https://proj.supabase.co';
    process.env[LOCAL_AUTH_FLAG] = 'true';
    await expect(verifyRequestUser(null)).rejects.toThrow(/partially configured/);
  });

  it('never hands out the local admin in production mode', async () => {
    const savedNodeEnv = process.env.NODE_ENV;
    try {
      // NODE_ENV is a read-only string type under next-env's typings; assign through the record.
      (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
      process.env[LOCAL_AUTH_FLAG] = 'true';
      await expect(verifyRequestUser(null)).rejects.toThrow(/never available in production/);
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = savedNodeEnv;
    }
  });

  it('checks the issuer claim when one is resolved', async () => {
    const { jwks, token } = await makeJwksAndToken(
      { sub: 'u1' },
      { issuer: 'https://evil.example/auth/v1' }
    );
    await expect(
      verifyRequestUser(`Bearer ${token}`, jwks, 'https://proj.supabase.co/auth/v1')
    ).rejects.toThrow(/invalid token/);
  });

  it('accepts a token whose issuer matches', async () => {
    const issuer = 'https://proj.supabase.co/auth/v1';
    const { jwks, token } = await makeJwksAndToken({ sub: 'u1' }, { issuer });
    const user = await verifyRequestUser(`Bearer ${token}`, jwks, issuer);
    expect(user.userId).toBe('u1');
  });

  it('rejects a token with no issuer when one is expected', async () => {
    const { jwks, token } = await makeJwksAndToken({ sub: 'u1' });
    await expect(
      verifyRequestUser(`Bearer ${token}`, jwks, 'https://proj.supabase.co/auth/v1')
    ).rejects.toThrow(/invalid token/);
  });

  it('verifies a valid ES256 token and extracts sub + email', async () => {
    process.env.ADMIN_EMAILS = 'chase@example.com';
    const { jwks, token } = await makeJwksAndToken({
      sub: 'user-123',
      email: 'reader@example.com',
    });
    const user = await verifyRequestUser(`Bearer ${token}`, jwks);
    expect(user).toEqual({ userId: 'user-123', email: 'reader@example.com', isAdmin: false });
  });

  it('flags admin emails case-insensitively', async () => {
    process.env.ADMIN_EMAILS = 'Chase@Example.com, other@example.com';
    const { jwks, token } = await makeJwksAndToken({ sub: 'u1', email: 'chase@example.com' });
    const user = await verifyRequestUser(`Bearer ${token}`, jwks);
    expect(user.isAdmin).toBe(true);
    expect(isAdminEmail('OTHER@example.com')).toBe(true);
    expect(isAdminEmail(null)).toBe(false);
  });

  it('rejects a missing bearer header when a jwks is in play', async () => {
    const { jwks } = await makeJwksAndToken({ sub: 'u1' });
    await expect(verifyRequestUser(null, jwks)).rejects.toBeInstanceOf(AuthError);
    await expect(verifyRequestUser('Token abc', jwks)).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects an expired token', async () => {
    const { jwks, token } = await makeJwksAndToken({ sub: 'u1' }, { expired: true });
    await expect(verifyRequestUser(`Bearer ${token}`, jwks)).rejects.toThrow(/invalid token/);
  });

  it('rejects a token with the wrong audience', async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256');
    const jwk = await exportJWK(publicKey);
    jwk.kid = 'k';
    const jwks = createLocalJWKSet({ keys: [jwk] });
    const token = await new SignJWT({ sub: 'u1' })
      .setProtectedHeader({ alg: 'ES256', kid: 'k' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .setAudience('somewhere-else')
      .sign(privateKey);
    await expect(verifyRequestUser(`Bearer ${token}`, jwks)).rejects.toThrow(/invalid token/);
  });

  it('rejects a token without sub', async () => {
    const { jwks, token } = await makeJwksAndToken({ email: 'x@example.com' });
    await expect(verifyRequestUser(`Bearer ${token}`, jwks)).rejects.toThrow(/no sub claim/);
  });
});
