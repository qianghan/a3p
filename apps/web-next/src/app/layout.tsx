import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { Providers } from '@/components/providers';
import './globals.css';

/**
 * `preload: false` is deliberate, and it is about the landing page.
 *
 * These two families are declared in the ROOT layout, so Next lists them in
 * the preload manifest for EVERY route -- including `/`, which renders none
 * of their glyphs. The marketing page sets its own display, body and numeric
 * faces (see app/page.tsx) and never falls through to `font-sans`. Measured
 * on production: `/` fetched seven woff2 files totalling 501 kB, every one
 * with initiatorType "link", and 87 kB of that was Inter (47 kB) plus a
 * second copy of JetBrains Mono (40 kB) that no element on the page uses.
 *
 * Dropping the preload does not stop the app pages that DO use these from
 * getting them -- the @font-face rules still ship in render-blocking CSS in
 * <head>, so the fetch starts about one parse later instead of alongside the
 * HTML. next/font generates a metrics-matched `Inter Fallback`, so the swap
 * costs no layout shift, only a slightly later swap on dashboard routes. That
 * is the trade: a marginally later font swap behind the login wall, against
 * 87 kB off the first page every visitor loads.
 */
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  preload: false,
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  preload: false,
});

export const metadata: Metadata = {
  title: {
    default: 'AgentBook',
    template: '%s | AgentBook',
  },
  description: 'AI-powered accounting for freelancers and small businesses. Your financial agent that works 24/7.',
  keywords: ['AgentBook', 'AI accounting', 'freelancer', 'bookkeeping', 'invoicing', 'tax'],
  authors: [{ name: 'AgentBook' }],
  creator: 'AgentBook',
  icons: {
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: '/apple-touch-icon.png',
  },
  manifest: '/manifest.json',
  // iOS ignores the web manifest for "Add to Home Screen" polish — these
  // meta tags are what actually control the standalone title and status
  // bar once installed. Without appleWebApp.capable, Safari opens the
  // installed icon in a regular browser tab instead of standalone mode.
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'AgentBook',
  },
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3001'),
  openGraph: {
    type: 'website',
    locale: 'en_US',
    siteName: 'AgentBook',
  },
  robots: {
    index: true,
    follow: true,
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#181818' },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('theme');var d=t==='light'?false:true;document.documentElement.classList.toggle('dark',d);document.documentElement.style.colorScheme=d?'dark':'light'}catch(e){}})()`,
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `window.STRIPE_PUBLISHABLE_KEY = ${JSON.stringify(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '')};`,
          }}
        />
      </head>
      <body className="min-h-screen bg-background font-sans antialiased">
        <Providers>
          {children}
        </Providers>
      </body>
    </html>
  );
}
