'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { isStandaloneDisplay, mobileEntryFor } from '@/lib/standalone';

/**
 * Send the installed app to the mobile shell instead of the desktop dashboard.
 *
 * The manifest starts at /app, but every other route into the product lands on
 * /agentbook: "/" and "/login" both 307 there once you are authenticated, and
 * /signed-in — which exists ONLY for sign-in begun inside the installed PWA —
 * linked there too. So a PWA user reliably ended up in the full desktop UI.
 *
 * Done on the client on purpose. Whether a page is running as an installed app
 * is not in the request: there is no header for display-mode, so the server
 * cannot know, and a User-Agent guess would catch mobile BROWSERS too — people
 * who chose the full site and should keep it.
 *
 * `router.replace`, not `push`, so Back does not bounce between the two shells.
 */
export function StandaloneEntryGate() {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (!isStandaloneDisplay()) return;
    const target = mobileEntryFor(pathname ?? '');
    if (target) router.replace(target);
  }, [pathname, router]);

  return null;
}
