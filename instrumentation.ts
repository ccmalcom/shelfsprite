/**
 * Startup configuration check.
 *
 * `register` runs once per server instance, before the first request. The auth-mode decision
 * (lib/server/authMode.ts) is validated here so a missing or half-set Supabase configuration is
 * visible in the deploy's first log lines rather than only in the 503 that every subsequent
 * request will produce.
 *
 * This LOGS; it does not throw. Enforcement belongs on the request paths — lib/server/auth.ts and
 * utils/supabase/middleware.ts both fail closed on their own — and a throw here would take down a
 * server instance that can still serve /api/healthz, which the proxy matcher excludes and which
 * therefore keeps answering. Page routes do not: updateSession returns its 503 before it classifies
 * a route as public, so /welcome and / are 503 too under a configuration fault.
 */
import { AuthConfigError, describeAuthMode } from '@/lib/server/authMode';

export function register(): void {
  // The build worker also loads this file; its environment is not the runtime environment, so a
  // complaint there would be noise.
  if (process.env.NEXT_PHASE === 'phase-production-build') return;

  const mode = describeAuthMode();
  if (mode instanceof AuthConfigError) {
    console.error(`[auth] configuration error — requests will fail closed: ${mode.message}`);
    return;
  }
  if (mode.kind === 'local') {
    console.warn('[auth] local single-user mode: every request is served as the local admin.');
    return;
  }
  console.log('[auth] Supabase auth enabled (bearer verification + page gating active).');
}
