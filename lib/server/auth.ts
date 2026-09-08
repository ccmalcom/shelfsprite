/**
 * Verify Supabase-issued ES256 JWTs and resolve the per-request user.
 * Audience "authenticated", issuer checked against the resolved auth mode, 10s
 * clock tolerance, sub -> userId.
 *
 * The auth-mode decision itself lives in ./authMode and is shared with page
 * middleware: this module never decides on its own that auth is off. With no
 * Supabase configuration, local single-user mode is granted only when
 * resolveAuthMode() says the deployment deliberately asked for it; otherwise the
 * request fails closed with an AuthConfigError.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { AuthConfigError, resolveAuthMode, type AuthMode } from './authMode';

export { AuthConfigError };

export const LOCAL_USER_ID = 'local';

export class AuthError extends Error {}

export interface AuthUser {
  userId: string;
  email: string | null;
  isAdmin: boolean;
}

/** Anything jwtVerify accepts as a key resolver (remote or local JWKS). */
export type JwksResolver = Parameters<typeof jwtVerify>[1];

function adminEmails(): Set<string> {
  return new Set(
    (process.env.ADMIN_EMAILS ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function isAdminEmail(email: string | null): boolean {
  return email !== null && adminEmails().has(email.trim().toLowerCase());
}

// Keyed by URL so a test or a re-resolved environment never verifies against a
// JWKS fetched for a different project.
let remoteJwks: { url: string; resolver: JwksResolver } | null = null;
function defaultJwks(url: string): JwksResolver {
  if (!remoteJwks || remoteJwks.url !== url) {
    remoteJwks = { url, resolver: createRemoteJWKSet(new URL(url)) };
  }
  return remoteJwks.resolver;
}

/** Test seam: drop the memoized remote JWKS resolver. */
export function _resetJwksCache(): void {
  remoteJwks = null;
}

export async function verifyRequestUser(
  authorizationHeader: string | null,
  jwks?: JwksResolver,
  issuerOverride?: string
): Promise<AuthUser> {
  let resolver: JwksResolver;
  let issuer: string | undefined = issuerOverride;

  if (jwks) {
    // Injected resolver (unit tests): the caller supplies the issuer explicitly
    // when it wants the issuer check exercised.
    resolver = jwks;
  } else {
    // Throws AuthConfigError on a missing or partial production configuration.
    // Do not catch it into a permissive default; throwing is the fail-closed path.
    const mode: AuthMode = resolveAuthMode();
    if (mode.kind === 'local') {
      return { userId: LOCAL_USER_ID, email: null, isAdmin: true };
    }
    resolver = defaultJwks(mode.jwksUrl);
    issuer ??= mode.issuer;
  }

  if (!authorizationHeader || !authorizationHeader.toLowerCase().startsWith('bearer ')) {
    throw new AuthError('missing bearer token');
  }
  const token = authorizationHeader.slice('bearer '.length).trim();

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, resolver, {
      audience: 'authenticated',
      ...(issuer === undefined ? {} : { issuer }),
      algorithms: ['ES256'],
      clockTolerance: 10,
    }));
  } catch (err) {
    throw new AuthError(`invalid token: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!payload.sub) throw new AuthError('token has no sub claim');
  const email = typeof payload.email === 'string' ? payload.email : null;
  return { userId: String(payload.sub), email, isAdmin: isAdminEmail(email) };
}
