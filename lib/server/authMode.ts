/**
 * The single, validated auth-mode decision shared by API bearer verification
 * (lib/server/auth.ts) and page middleware (utils/supabase/middleware.ts).
 *
 * Before this module the two layers each read process.env on their own and each
 * treated "no Supabase variables" as "run unauthenticated as the local admin".
 * A production deploy with a missing — or half-set — Supabase variable therefore
 * served every anonymous request as an administrator, and the two layers could
 * disagree about whether auth was on at all.
 *
 * The rules here are deliberately strict:
 *
 *   - Any Supabase variable present means Supabase auth is intended. The set must
 *     then be complete; a partial set is a configuration error, never a silent
 *     downgrade to local mode.
 *   - Local unauthenticated mode requires an explicit ALLOW_LOCAL_AUTH opt-in and
 *     is rejected outright when NODE_ENV is 'production'.
 *
 * Keep this module dependency-free. Page middleware imports it, so anything added
 * here ships in the middleware bundle.
 */

/** Opt-in flag for local single-user mode. Ignored when NODE_ENV is 'production'. */
export const LOCAL_AUTH_FLAG = 'ALLOW_LOCAL_AUTH';

/** Thrown when the environment cannot produce a safe auth decision. Never an auth failure. */
export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthConfigError';
  }
}

export interface SupabaseAuthMode {
  kind: 'supabase';
  /** Project URL, trailing slashes stripped. */
  projectUrl: string;
  /** JWKS endpoint used to verify access tokens. */
  jwksUrl: string;
  /** Expected `iss` claim on access tokens. */
  issuer: string;
  /** Publishable (anon) key used by the browser client and page middleware. */
  publishableKey: string;
}

export interface LocalAuthMode {
  kind: 'local';
}

export type AuthMode = SupabaseAuthMode | LocalAuthMode;

type Env = Record<string, string | undefined>;

function read(env: Env, key: string): string | null {
  const raw = env[key];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

function isTruthy(value: string | null): boolean {
  return value !== null && ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

/**
 * Resolve the auth mode from the environment, or throw AuthConfigError.
 *
 * Callers must not catch this into a permissive default: throwing IS the
 * fail-closed behavior.
 */
export function resolveAuthMode(env: Env = process.env): AuthMode {
  const projectUrl = read(env, 'SUPABASE_URL') ?? read(env, 'NEXT_PUBLIC_SUPABASE_URL');
  const publishableKey = read(env, 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  const jwksOverride = read(env, 'SUPABASE_JWKS_URL');
  const issuerOverride = read(env, 'SUPABASE_JWT_ISSUER');

  const supabaseIntended = Boolean(projectUrl || publishableKey || jwksOverride || issuerOverride);

  if (!supabaseIntended) {
    if (env.NODE_ENV === 'production') {
      throw new AuthConfigError(
        'No Supabase auth variables are set and NODE_ENV is "production". Local unauthenticated ' +
          'mode is never available in production. Set SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) ' +
          'and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.'
      );
    }
    if (!isTruthy(read(env, LOCAL_AUTH_FLAG))) {
      throw new AuthConfigError(
        `No Supabase auth variables are set. Local unauthenticated mode must be requested ` +
          `deliberately: set ${LOCAL_AUTH_FLAG}=true for local development, or configure ` +
          `SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.`
      );
    }
    return { kind: 'local' };
  }

  const missing: string[] = [];
  if (!projectUrl) missing.push('SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)');
  if (!publishableKey) missing.push('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  if (missing.length > 0) {
    throw new AuthConfigError(
      `Supabase auth is partially configured; missing ${missing.join(', ')}. A partial set is ` +
        'rejected rather than downgraded to local mode, because that downgrade would serve ' +
        'anonymous requests as the local administrator.'
    );
  }

  const base = projectUrl!.replace(/\/+$/, '');
  return {
    kind: 'supabase',
    projectUrl: base,
    jwksUrl: jwksOverride ?? `${base}/auth/v1/.well-known/jwks.json`,
    issuer: issuerOverride ?? `${base}/auth/v1`,
    publishableKey: publishableKey!,
  };
}

/**
 * Resolve the auth mode, returning the AuthConfigError instead of throwing.
 * For callers that report configuration health (startup checks, readiness).
 */
export function describeAuthMode(env: Env = process.env): AuthMode | AuthConfigError {
  try {
    return resolveAuthMode(env);
  } catch (err) {
    if (err instanceof AuthConfigError) return err;
    throw err;
  }
}
