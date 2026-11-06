import type { Metadata, Viewport } from 'next';
import { Bricolage_Grotesque, Inter, JetBrains_Mono } from 'next/font/google';
import { Analytics } from '@vercel/analytics/next';
import './globals.css';
import { ToastProvider } from '@/components/ui';
import { ServiceWorkerRegistrar } from '@/components/ServiceWorkerRegistrar';

const displayFont = Bricolage_Grotesque({
  subsets: ['latin'],
  weight: ['700', '800'],
  variable: '--font-display',
  display: 'swap',
});

const bodyFont = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-body',
  display: 'swap',
});

const monoFont = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'ShelfSprite',
  description: 'Your personal AI-powered reading engine',
  icons: {
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/favicon.ico', sizes: '48x48' },
    ],
    apple: '/apple-icon.png',
  },
  // The installed app's name and status bar on iOS, which ignores most of the web manifest.
  appleWebApp: {
    capable: true,
    title: 'ShelfSprite',
    statusBarStyle: 'black',
  },
};

// Matches --bg in globals.css and the manifest's theme_color, so the browser chrome and the
// installed app's status bar blend into the page.
export const viewport: Viewport = {
  themeColor: '#191613',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`dark ${displayFont.variable} ${bodyFont.variable} ${monoFont.variable}`}
    >
      {/* Browser extensions (e.g. ColorZilla adds cz-shortcut-listen) mutate <body>
          before React hydrates, causing a benign attribute-mismatch warning. Suppress
          it on this element only — it does not hide real mismatches inside the app. */}
      <body className="min-h-screen bg-base text-text antialiased" suppressHydrationWarning>
        <ToastProvider>{children}</ToastProvider>
        <Analytics />
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
