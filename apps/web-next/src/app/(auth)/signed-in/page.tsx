'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Wordmark } from '@/components/brand/Wordmark';
import { isStandaloneDisplay } from '@/lib/standalone';

/**
 * Reached only when an OAuth sign-in that started inside the installed PWA
 * completed in a context (typically iOS's system browser) whose cookie
 * storage the standalone app can't read. The session cookie set by the
 * callback route IS valid here — this page's own "Open AgentBook" link
 * works immediately in this browser tab. Returning to the home-screen app
 * icon requires the user to sign in there too; there's no web-platform way
 * to hand the session to the installed app's separate storage container.
 *
 * The link used to be hardcoded to /agentbook — the DESKTOP dashboard — on the
 * one page in the product that only a PWA user ever sees. That was the sharpest
 * of the three routes that landed installed apps in the full desktop UI.
 *
 * Resolved after mount rather than at render: display-mode is a client fact, so
 * the server has no way to know it, and rendering the desktop href first would
 * ship the wrong link to anyone who taps quickly.
 */
export default function SignedInPage() {
  const [href, setHref] = useState('/agentbook');

  useEffect(() => {
    if (isStandaloneDisplay()) setHref('/app');
  }, []);

  return (
    <div className="w-full max-w-sm px-4 mx-auto flex flex-col items-center text-center gap-4 py-16">
      <Wordmark size={40} />
      <h1 className="text-lg font-medium text-muted-foreground">You&apos;re signed in</h1>
      <p className="text-sm text-muted-foreground/80">
        If you opened AgentBook from your home screen, switch back to that app icon and continue there.
        Otherwise, you can keep using AgentBook right here.
      </p>
      <Link
        href={href}
        className="w-full py-2.5 bg-gradient-to-b from-brand-bright to-brand-primary text-[#04231b] rounded-lg text-sm font-semibold transition hover:brightness-105 text-center"
      >
        Open AgentBook
      </Link>
    </div>
  );
}
