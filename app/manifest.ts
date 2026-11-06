import type { MetadataRoute } from 'next';

// Served at /manifest.webmanifest, and Next adds the <link rel="manifest"> tag on its own.
// proxy.ts excludes that path: Chrome fetches the manifest without cookies, so a gated fetch would
// be redirected to /login and the app would stop being installable for every visitor.
//
// The colors are the app's own --bg token (app/globals.css), so the splash screen and the
// standalone window's status bar match the first painted frame instead of flashing a brand color.
const APP_BACKGROUND = '#191613';

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'ShelfSprite',
    short_name: 'ShelfSprite',
    description: 'Your personal AI-powered reading engine',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: APP_BACKGROUND,
    theme_color: APP_BACKGROUND,
    categories: ['books', 'lifestyle'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
