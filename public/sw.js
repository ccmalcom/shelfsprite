/*
 * ShelfSprite service worker.
 *
 * Its whole job is to make the app installable and to show an offline page instead of the
 * browser's error screen. It deliberately caches almost nothing:
 *
 *   - /_next/static/* — content-hashed build output (JS, CSS, fonts). Cache-first: a hashed URL
 *     never changes meaning, so a cached copy can never be stale.
 *   - The offline page and the install icons, fetched once when the worker installs.
 *
 * Everything else goes to the network untouched, and nothing it returns is stored: page HTML,
 * React Server Component payloads, /api/*, /auth/*, /_next/image, any request carrying an
 * Authorization header, any non-GET request, and every cross-origin request (Supabase, cover
 * hosts). Signed-in data therefore never lands in Cache Storage, and a signed-out visitor on a
 * shared device cannot be shown the last reader's pages.
 *
 * Versioning: the page registers /sw.js?v=<build id>. A new deploy changes that URL, which makes
 * the browser install a fresh worker; on activation it deletes every older ShelfSprite cache.
 * skipWaiting and clients.claim are safe here because this worker never serves HTML from a cache,
 * so a page loaded under the old worker keeps working under the new one.
 *
 * Kill switch: if this file ever misbehaves in production, replace its body with
 *   self.addEventListener('install', () => self.skipWaiting());
 *   self.addEventListener('activate', (e) => e.waitUntil(
 *     caches.keys().then((ks) => Promise.all(ks.map((k) => caches.delete(k))))
 *       .then(() => self.registration.unregister())));
 * and deploy; browsers check /sw.js for changes on every navigation.
 */

const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE_PREFIX = 'shelfsprite-';
const STATIC_CACHE = `${CACHE_PREFIX}static-${VERSION}`;
const SHELL_CACHE = `${CACHE_PREFIX}shell-${VERSION}`;

const OFFLINE_URL = '/offline.html';
const SHELL_URLS = [
  OFFLINE_URL,
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-192.png',
  '/icons/maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // cache: 'reload' skips the HTTP cache so a new deploy never precaches a stale copy.
      .then((cache) => cache.addAll(SHELL_URLS.map((url) => new Request(url, { cache: 'reload' }))))
      // Precaching is best-effort. If it fails (storage full, a flaky icon fetch) the worker must
      // still install: a failed install leaves the previous deploy's worker in charge, and only a
      // new worker's activation deletes that deploy's caches, so a full disk would stay full. The
      // cost is no offline page until the next deploy; navigations fall back to the browser's own
      // error screen, exactly as with no worker.
      .catch(() => undefined)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([STATIC_CACHE, SHELL_CACHE]);
      // Each step is best-effort so a Cache Storage error cannot stop the next one; above all,
      // clients.claim must still run.
      try {
        const names = await caches.keys();
        await Promise.all(
          names
            .filter((name) => name.startsWith(CACHE_PREFIX) && !keep.has(name))
            .map((name) => caches.delete(name).catch(() => false))
        );
      } catch {
        // Old caches stay until the next activation; nothing reads them.
      }
      // Navigation preload lets the network request for a page start while the worker boots,
      // so routing navigations through this worker adds no latency.
      try {
        if (self.registration.navigationPreload) {
          await self.registration.navigationPreload.enable();
        }
      } catch {
        // Without preload, navigations still go to the network, just a moment later.
      }
      await self.clients.claim();
    })()
  );
});

function isStaticAsset(url) {
  return url.pathname.startsWith('/_next/static/');
}

function isShellAsset(url) {
  return SHELL_URLS.includes(url.pathname) && url.search === '';
}

// A response is only stored if it is a plain same-origin 200 that the server itself allows to be
// stored. Belt and braces: the URL rules above already limit caching to public build output.
function isStorable(response) {
  if (!response || response.status !== 200 || response.type !== 'basic') return false;
  const cacheControl = (response.headers.get('cache-control') || '').toLowerCase();
  return !cacheControl.includes('no-store') && !cacheControl.includes('private');
}

// Cache Storage is a progressive enhancement and must never stand between the browser and a
// response the network can give. Opening, reading or writing a cache can reject (a full disk
// throws QuotaExceededError on put; a browser in a privacy mode can refuse to open caches at all),
// and every such failure falls back to the plain network path.
async function openCache(cacheName) {
  try {
    return await caches.open(cacheName);
  } catch {
    return undefined;
  }
}

async function matchFromCache(cache, request) {
  if (!cache) return undefined;
  try {
    return await cache.match(request);
  } catch {
    return undefined;
  }
}

async function cacheFirst(event, cacheName) {
  const { request } = event;
  const cache = await openCache(cacheName);
  const cached = await matchFromCache(cache, request);
  if (cached) return cached;
  const response = await fetch(request);
  if (cache && isStorable(response)) {
    // Not awaited before returning: the response goes back to the page now, and a failed write
    // only means the next request goes to the network again.
    event.waitUntil(cache.put(request, response.clone()).catch(() => undefined));
  }
  return response;
}

async function networkWithOfflineFallback(event) {
  try {
    const preloaded = await event.preloadResponse;
    if (preloaded) return preloaded;
    return await fetch(event.request);
  } catch (error) {
    // Only a network failure lands here; a 4xx/5xx from the server is a real answer and is
    // returned as-is above. The offline page is static and holds no user data.
    const cache = await openCache(SHELL_CACHE);
    const offline = await matchFromCache(cache, OFFLINE_URL);
    if (offline) return offline;
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Leaving respondWith uncalled hands the request to the browser exactly as if no worker existed.
  if (request.method !== 'GET') return;
  if (request.headers.has('authorization')) return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return;

  if (request.mode === 'navigate') {
    // Network only. The response is passed through and never stored.
    event.respondWith(networkWithOfflineFallback(event));
    return;
  }

  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(event, STATIC_CACHE));
    return;
  }

  if (isShellAsset(url)) {
    event.respondWith(
      openCache(SHELL_CACHE)
        .then((cache) => matchFromCache(cache, request))
        .then((hit) => hit || fetch(request))
    );
  }
  // Everything else (RSC payloads, /_next/image, public images, the manifest) falls through to
  // the network untouched.
});
