'use client';

import { useEffect, useState } from 'react';

/**
 * Providers we render a button for, in display order. Deliberately excludes
 * GitHub — our target users (freelancers / small business) rarely have GitHub
 * accounts, so it stays hidden even if the backend reports it as configured.
 */
const KNOWN_PROVIDERS = ['google', 'microsoft'] as const;
export type OAuthProvider = (typeof KNOWN_PROVIDERS)[number];

const BUTTON_CLASS =
  'w-full flex items-center justify-center gap-2 px-3 py-2.5 text-sm border border-muted-foreground/25 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors';

const PROVIDER_META: Record<OAuthProvider, { label: string; icon: React.ReactNode }> = {
  google: {
    label: 'Continue with Google',
    icon: (
      <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
        <path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
        <path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
        <path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
      </svg>
    ),
  },
  microsoft: {
    label: 'Continue with Microsoft',
    icon: (
      <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="#F25022" d="M1 1h10v10H1z" />
        <path fill="#7FBA00" d="M13 1h10v10H13z" />
        <path fill="#00A4EF" d="M1 13h10v10H1z" />
        <path fill="#FFB900" d="M13 13h10v10H13z" />
      </svg>
    ),
  },
};

/**
 * Renders a full-width sign-in button for each OAuth provider the backend
 * reports as configured (via `/api/v1/auth/providers`). Google is shown
 * optimistically until the list resolves so the primary path never flickers.
 */
export function OAuthButtons({ onSelect }: { onSelect: (provider: OAuthProvider) => void }) {
  const [providers, setProviders] = useState<OAuthProvider[]>(['google']);

  useEffect(() => {
    let active = true;
    fetch('/api/v1/auth/providers', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const list: string[] = d?.data?.providers ?? [];
        const known = KNOWN_PROVIDERS.filter((p) => list.includes(p));
        if (active && known.length) setProviders(known);
      })
      .catch(() => {
        /* keep the optimistic default */
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="space-y-2.5">
      {providers.map((p) => (
        <button key={p} type="button" onClick={() => onSelect(p)} className={BUTTON_CLASS}>
          {PROVIDER_META[p].icon}
          {PROVIDER_META[p].label}
        </button>
      ))}
    </div>
  );
}
