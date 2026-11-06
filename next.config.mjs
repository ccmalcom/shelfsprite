/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    // Versions the service worker (components/ServiceWorkerRegistrar.tsx registers
    // /sw.js?v=<this>). Vercel sets VERCEL_GIT_COMMIT_SHA at build time, so each deploy gets a
    // new worker that drops the previous deploy's caches. Local builds fall back to 'dev'.
    NEXT_PUBLIC_SW_BUILD_ID:
      process.env.VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_DEPLOYMENT_ID || 'dev',
  },
  async headers() {
    return [
      {
        // The worker script must always be revalidated, or a stale copy could pin an old worker.
        // Root scope needs no Service-Worker-Allowed header because the file is served from /.
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Content-Type', value: 'application/javascript; charset=utf-8' },
        ],
      },
    ];
  },
  images: {
    // Allowlist only the cover providers the catalog actually returns. A prior
    // `hostname: '**'` entry let any HTTPS URL be fetched and re-encoded by
    // /_next/image, which is an SSRF and resource-exhaustion surface now that
    // this is a multi-user service rather than a personal tool.
    remotePatterns: [
      // Open Library covers
      { protocol: 'https', hostname: 'covers.openlibrary.org' },
      // Google Books thumbnails. The volumes API still hands back http:// URLs
      // for imageLinks.thumbnail and nothing normalizes them yet, so the plain
      // http pattern has to stay until it does.
      { protocol: 'https', hostname: 'books.google.com' },
      { protocol: 'http', hostname: 'books.google.com' },
    ],
  },
};

export default nextConfig;
