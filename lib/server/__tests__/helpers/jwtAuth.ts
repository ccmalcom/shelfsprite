import { afterAll, beforeAll, beforeEach, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { _resetJwksCache } from '../../auth';

/**
 * Hosted-auth route tests: a complete Supabase configuration (resolveAuthMode rejects a
 * partial one), a throwaway ES256 key served as the JWKS, and signed tokens per user, so a
 * test can call a route as two different tenants. Registers its own hooks. The JWKS is
 * served by stubbing global fetch; a test that needs fetch for anything else must not use
 * this helper.
 */
const TEST_ISSUER = 'https://auth.test/auth/v1';
const SUPABASE_TEST_ENV = {
  SUPABASE_URL: 'https://auth.test',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'pk_test',
  SUPABASE_JWKS_URL: 'https://auth.test/.well-known/jwks.json',
  SUPABASE_JWT_ISSUER: TEST_ISSUER,
} as const;

export function setupJwtAuth(): { authHeaders: (userId: string) => Promise<HeadersInit> } {
  let privateKey: KeyLike;
  let jwksBody = '';
  const saved = Object.fromEntries(Object.keys(SUPABASE_TEST_ENV).map((k) => [k, process.env[k]]));

  beforeAll(async () => {
    const keys = await generateKeyPair('ES256');
    privateKey = keys.privateKey;
    const jwk = await exportJWK(keys.publicKey);
    jwk.kid = 'route-test-key';
    jwksBody = JSON.stringify({ keys: [jwk] });
  });

  // Set per test: setupTestEnv's beforeEach deletes these, so a beforeAll would be undone.
  beforeEach(() => {
    Object.assign(process.env, SUPABASE_TEST_ENV);
    _resetJwksCache();
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(jwksBody, { headers: { 'Content-Type': 'application/json' } })
    );
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    _resetJwksCache();
  });

  return {
    authHeaders: async (userId: string) => {
      const token = await new SignJWT({ sub: userId })
        .setProtectedHeader({ alg: 'ES256', kid: 'route-test-key' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .setAudience('authenticated')
        .setIssuer(TEST_ISSUER)
        .sign(privateKey);
      return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    },
  };
}
