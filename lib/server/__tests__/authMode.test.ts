import { describe, expect, it } from 'vitest';
import { AuthConfigError, LOCAL_AUTH_FLAG, describeAuthMode, resolveAuthMode } from '../authMode';

const HOSTED = {
  NODE_ENV: 'production',
  SUPABASE_URL: 'https://proj.supabase.co',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'pk_live',
};

describe('resolveAuthMode — Supabase configured', () => {
  it('derives the JWKS URL and issuer from the project URL', () => {
    expect(resolveAuthMode(HOSTED)).toEqual({
      kind: 'supabase',
      projectUrl: 'https://proj.supabase.co',
      jwksUrl: 'https://proj.supabase.co/auth/v1/.well-known/jwks.json',
      issuer: 'https://proj.supabase.co/auth/v1',
      publishableKey: 'pk_live',
    });
  });

  it('strips trailing slashes from the project URL', () => {
    const mode = resolveAuthMode({ ...HOSTED, SUPABASE_URL: 'https://proj.supabase.co//' });
    expect(mode).toMatchObject({
      projectUrl: 'https://proj.supabase.co',
      issuer: 'https://proj.supabase.co/auth/v1',
    });
  });

  it('falls back to the public project URL when the server-side one is absent', () => {
    const mode = resolveAuthMode({
      NODE_ENV: 'production',
      NEXT_PUBLIC_SUPABASE_URL: 'https://pub.supabase.co',
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'pk_live',
    });
    expect(mode).toMatchObject({ projectUrl: 'https://pub.supabase.co' });
  });

  it('honours explicit JWKS and issuer overrides', () => {
    const mode = resolveAuthMode({
      ...HOSTED,
      SUPABASE_JWKS_URL: 'https://auth.test/.well-known/jwks.json',
      SUPABASE_JWT_ISSUER: 'https://auth.test',
    });
    expect(mode).toMatchObject({
      jwksUrl: 'https://auth.test/.well-known/jwks.json',
      issuer: 'https://auth.test',
    });
  });

  it('treats blank strings as unset', () => {
    const mode = resolveAuthMode({
      ...HOSTED,
      SUPABASE_URL: '   ',
      NEXT_PUBLIC_SUPABASE_URL: 'https://pub.supabase.co',
    });
    expect(mode).toMatchObject({ projectUrl: 'https://pub.supabase.co' });
    expect(() =>
      resolveAuthMode({ ...HOSTED, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: '  ' })
    ).toThrow(AuthConfigError);
  });
});

describe('resolveAuthMode — partial configuration fails closed', () => {
  it('rejects a project URL with no publishable key', () => {
    expect(() =>
      resolveAuthMode({ NODE_ENV: 'production', SUPABASE_URL: 'https://proj.supabase.co' })
    ).toThrow(/missing NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/);
  });

  it('rejects a publishable key with no project URL', () => {
    expect(() =>
      resolveAuthMode({ NODE_ENV: 'production', NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'pk' })
    ).toThrow(/missing SUPABASE_URL/);
  });

  it('rejects a bare JWKS override with nothing else', () => {
    expect(() =>
      resolveAuthMode({
        NODE_ENV: 'production',
        SUPABASE_JWKS_URL: 'https://auth.test/.well-known/jwks.json',
      })
    ).toThrow(AuthConfigError);
  });

  it('never downgrades a partial set to local mode, even with the opt-in flag', () => {
    expect(() =>
      resolveAuthMode({
        NODE_ENV: 'development',
        [LOCAL_AUTH_FLAG]: 'true',
        SUPABASE_URL: 'https://proj.supabase.co',
      })
    ).toThrow(AuthConfigError);
  });
});

describe('resolveAuthMode — local mode', () => {
  it('requires the explicit opt-in flag', () => {
    expect(() => resolveAuthMode({ NODE_ENV: 'development' })).toThrow(new RegExp(LOCAL_AUTH_FLAG));
  });

  it('is granted with the opt-in flag outside production', () => {
    expect(resolveAuthMode({ NODE_ENV: 'development', [LOCAL_AUTH_FLAG]: 'true' })).toEqual({
      kind: 'local',
    });
    expect(resolveAuthMode({ NODE_ENV: 'test', [LOCAL_AUTH_FLAG]: '1' })).toEqual({
      kind: 'local',
    });
  });

  it('is refused in production even with the opt-in flag', () => {
    expect(() => resolveAuthMode({ NODE_ENV: 'production', [LOCAL_AUTH_FLAG]: 'true' })).toThrow(
      /never available in production/
    );
  });

  it('ignores a non-truthy flag value', () => {
    expect(() => resolveAuthMode({ NODE_ENV: 'development', [LOCAL_AUTH_FLAG]: 'false' })).toThrow(
      AuthConfigError
    );
    expect(() => resolveAuthMode({ NODE_ENV: 'development', [LOCAL_AUTH_FLAG]: '' })).toThrow(
      AuthConfigError
    );
  });
});

describe('describeAuthMode', () => {
  it('returns the error rather than throwing', () => {
    expect(describeAuthMode({ NODE_ENV: 'production' })).toBeInstanceOf(AuthConfigError);
    expect(describeAuthMode(HOSTED)).toMatchObject({ kind: 'supabase' });
  });
});
