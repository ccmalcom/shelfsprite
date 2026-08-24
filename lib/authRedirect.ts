// Supabase invite / password-recovery links are supposed to land on /auth/callback, which
// consumes the session tokens from the URL hash and prompts for a password. But if GoTrue
// falls back to the project Site URL (bare app root) — because the backend's redirect_to was
// unset or not on the Redirect-URLs allowlist — the tokens arrive in the hash at `/`.
//
// There are two ways that request is served, and BOTH must rescue it:
//   - `/library`, `/settings`, and every other page: middleware redirects to /login and the
//     fragment survives the 302.
//   - `/` with no session: middleware REWRITES to the marketing page, so the URL stays `/` and
//     /login never loads.
// components/InviteHashRedirect.tsx runs on both entry points and forwards such a hash to
// /auth/callback, so onboarding completes regardless of the Supabase redirect config.

/**
 * Given a URL hash (with or without the leading '#'), return the /auth/callback URL to forward
 * to when it carries Supabase invite/recovery session tokens or an auth error, else null.
 */
export function inviteCallbackRedirect(hash: string): string | null {
  const clean = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!clean) return null;
  const params = new URLSearchParams(clean);
  const type = params.get('type');
  const isAuthHash =
    params.has('access_token') ||
    type === 'invite' ||
    type === 'recovery' ||
    params.has('error_description'); // expired/invalid link — let the callback page render it
  return isAuthHash ? `/auth/callback#${clean}` : null;
}

/** The parts of `window.location` the forwarder needs. Narrow so tests can pass a plain object. */
export interface HashLocation {
  hash: string;
  replace: (url: string) => void;
}

/**
 * Forward `loc` to /auth/callback when its hash carries Supabase auth tokens, else leave it alone.
 *
 * This lives here rather than inline in the component because jsdom's `window.location` is
 * non-configurable and its `replace` is read-only, so an inline call cannot be observed in a
 * test. Taking the location as an argument keeps the redirect itself covered.
 */
export function forwardInviteHash(loc: HashLocation): void {
  const target = inviteCallbackRedirect(loc.hash);
  if (target) loc.replace(target);
}
