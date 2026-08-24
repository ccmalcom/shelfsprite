import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

// Routes reachable without a session. /welcome is the marketing page: it is also served at / via
// the rewrite below, but stays directly reachable so it can be seen in local mode, where this
// middleware no-ops and / renders the dashboard.
const PUBLIC_PREFIXES = ['/login', '/auth', '/welcome'];

/**
 * Refresh the Supabase session cookie on each request and gate page routes: an unauthenticated
 * request for / is rewritten to the public marketing page at /welcome, and every other
 * unauthenticated page is redirected to /login. No-op in local mode (no Supabase env), so local
 * dev runs unauthenticated exactly as before.
 *
 * This middleware gates pages only. API routes do their own bearer authentication via withApi
 * and must stay excluded from the proxy matcher.
 */
export async function updateSession(request: NextRequest) {
  if (!url || !key) return NextResponse.next({ request }); // local mode: auth disabled

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(url, key, {
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
