import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

import { AuthConfigError, resolveAuthMode } from '@/lib/server/authMode';

// Routes reachable without a session. /welcome is the marketing page: it is also served at / via
// the rewrite below, but stays directly reachable so it can be seen in local mode, where this
// middleware no-ops and / renders the dashboard.
const PUBLIC_PREFIXES = ['/login', '/auth', '/welcome'];

// A configuration fault is a property of the deployment, not of the request, so it is logged once
// per server instance. The matcher covers nearly every page, so logging per request would turn a
// single misconfiguration into a log line for every hit; instrumentation.ts already reports it at
// startup, and this is the backstop for an instance that somehow missed that.
let loggedAuthConfigError = false;

/**
 * Refresh the Supabase session cookie on each request and gate page routes: an unauthenticated
 * request for / is rewritten to the public marketing page at /welcome, and every other
 * unauthenticated page is redirected to /login. No-op in local mode, so local dev runs
 * unauthenticated exactly as before.
 *
 * The local-mode decision is NOT "the env vars are missing" — it comes from the shared, validated
 * resolveAuthMode(), the same call lib/server/auth.ts makes for API bearer verification. That is
 * what keeps the two layers from disagreeing, and what stops a missing or half-set Supabase
 * variable in production from quietly turning page gating off. A configuration error answers 503
 * rather than serving the page unauthenticated.
 *
 * This middleware gates pages only. API routes do their own bearer authentication via withApi
 * and must stay excluded from the proxy matcher.
 */
export async function updateSession(request: NextRequest) {
  let mode;
  try {
    mode = resolveAuthMode();
  } catch (err) {
    if (!(err instanceof AuthConfigError)) throw err;
    if (!loggedAuthConfigError) {
      loggedAuthConfigError = true;
      console.error('[auth] refusing to serve pages:', err.message);
    }
    return new NextResponse('Server authentication is not configured.', {
      status: 503,
      headers: { 'cache-control': 'no-store' },
    });
  }
  if (mode.kind === 'local') return NextResponse.next({ request }); // local mode: auth disabled

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(mode.projectUrl, mode.publishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options)
        );
      },
    },
  });

  // Touch getUser() to refresh an expired token (writes new cookies via setAll above).
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PREFIXES.some((p) => path.startsWith(p));

  if (!user && path === '/') {
    // A REWRITE, not a redirect: the URL people share is shelfsprite.app, and a redirect means
    // that is never what they land on. Exact '/' only — every other unauthenticated page still
    // goes to /login below.
    //
    // Built from supabaseResponse's cookies, not a bare NextResponse: getUser() above may have
    // just refreshed the session and written new cookies via setAll, and dropping them here
    // would silently throw away the refreshed token.
    //
    // The URL staying at / is also why components/InviteHashRedirect.tsx must be mounted on the
    // welcome page: /login never loads, so its invite-hash rescue never fires.
    const welcome = NextResponse.rewrite(new URL('/welcome', request.url), { request });
    supabaseResponse.cookies.getAll().forEach((cookie) => welcome.cookies.set(cookie));
    return welcome;
  }
  if (!user && !isPublic) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = '/login';
    const redirect = NextResponse.redirect(loginUrl);
    supabaseResponse.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));
    return redirect;
  }
  if (user && path.startsWith('/login')) {
    const homeUrl = request.nextUrl.clone();
    homeUrl.pathname = '/';
    const redirect = NextResponse.redirect(homeUrl);
    supabaseResponse.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));
    return redirect;
  }

  return supabaseResponse;
}
