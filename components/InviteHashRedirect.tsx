'use client';

import { useEffect } from 'react';
import { forwardInviteHash } from '@/lib/authRedirect';

/**
 * Rescues a misconfigured Supabase invite / password-recovery link whose session tokens land in
 * the URL hash at the bare app root instead of /auth/callback. Mounted on BOTH public entry
 * points such a link can reach: /login (which middleware redirects to, fragment intact) and the
 * marketing page at / (which middleware rewrites to /welcome, so the URL never changes and
 * /login never loads). Without this on the marketing page, an invited user would land on a
 * stranger's landing page with their one-time token sitting unused in the address bar, and the
 * failure would be silent — no error, no failed request.
 *
 * Renders nothing. It imports only lib/authRedirect, which has zero imports of its own, so it is
 * safe on a page that must not pull the Supabase browser client into its bundle.
 */
export default function InviteHashRedirect(): null {
  useEffect(() => {
    forwardInviteHash(window.location);
  }, []);
  return null;
}
