/** @type {import('next').NextConfig} */
const nextConfig = {
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
