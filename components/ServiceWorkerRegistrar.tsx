'use client';

import { useEffect } from 'react';

// Set in next.config.mjs from the deploy's commit, so every deploy registers a new worker URL and
// the browser installs a fresh worker that clears the previous deploy's caches.
const BUILD_ID = process.env.NEXT_PUBLIC_SW_BUILD_ID || 'dev';

/**
 * Registers public/sw.js, which makes ShelfSprite installable and shows an offline page. Only in
 * production builds: in `next dev` a worker would keep serving cached chunks across hot reloads.
 * Renders nothing.
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker
      .register(`/sw.js?v=${encodeURIComponent(BUILD_ID)}`, {
        scope: '/',
        // Always check the network for a new worker script rather than the HTTP cache.
        updateViaCache: 'none',
      })
      .catch((err) => {
        // Installability and offline fallback are progressive enhancements; the app works without.
        console.warn('[sw] registration failed', err);
      });
  }, []);

  return null;
}
