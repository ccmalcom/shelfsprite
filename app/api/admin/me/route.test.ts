import { afterEach, describe, expect, it } from 'vitest';
import { _resetJwksCache } from '@/lib/server/auth';

import { GET } from './route';

// resolveAuthMode() rejects a partial Supabase configuration, so each case sets the whole set it
// means to test and nothing more. The default test environment is deliberate local mode
// (vitest.setup.ts sets ALLOW_LOCAL_AUTH), which is why the local case sets nothing at all.
const SUPABASE_KEYS = [
  'SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_JWKS_URL',
  'SUPABASE_JWT_ISSUER',
] as const;
const saved = Object.fromEntries(SUPABASE_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const key of SUPABASE_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  _resetJwksCache();
});

function get(headers?: HeadersInit): Promise<Response> {
  return GET(new Request('http://test/api/admin/me', headers ? { headers } : undefined));
}

describe('GET /api/admin/me', () => {
  it('reports the local administrator in local mode', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ is_admin: true });
  });

  it('answers is_admin:false for a caller with no bearer token', async () => {
    process.env.SUPABASE_URL = 'https://auth.test';
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'pk_test';

    const res = await get();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ is_admin: false });
  });

  it('answers is_admin:false for a bearer token it cannot verify', async () => {
    process.env.SUPABASE_URL = 'https://auth.test';
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'pk_test';

    const res = await get({ Authorization: 'Bearer not-a-jwt' });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ is_admin: false });
  });

  // The route's catch is what makes it answer for non-admins, but a configuration fault is not an
  // answer about the caller: swallowing it here would report a confident is_admin:false out of a
  // deployment that cannot authenticate anyone, and hide the misconfiguration from the client and
  // the logs alike.
  it('503s on a partial Supabase configuration instead of swallowing it into is_admin:false', async () => {
    process.env.SUPABASE_URL = 'https://auth.test';
    delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

    const res = await get();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      detail: 'Server authentication is not configured',
    });
  });
});
