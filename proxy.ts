import { type NextRequest } from 'next/server';
import { updateSession } from '@/utils/supabase/middleware';

export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  // Run on page routes except Next internals, static image assets, and the installable-app files.
  // The web manifest, service worker and offline page must stay public: Chrome fetches the
  // manifest without cookies, and a redirect to /login there makes the app uninstallable.
  matcher: [
    '/((?!api|_next/static|_next/image|favicon.ico|manifest\\.webmanifest$|sw\\.js$|offline\\.html$|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
