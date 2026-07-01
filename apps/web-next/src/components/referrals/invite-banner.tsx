'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Gift, X } from 'lucide-react';

const DISMISS_KEY = 'ab_referral_banner_dismissed';

/**
 * A one-line, dismissible invite to the referral program. Shown only on the
 * AgentBook home dashboard (not every page — stays non-invasive) and only
 * until the user dismisses it once, ever (localStorage).
 */
export function InviteBanner() {
  const pathname = usePathname();
  const router = useRouter();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (pathname !== '/agentbook') {
      setVisible(false);
      return;
    }
    if (typeof window === 'undefined') return;
    setVisible(window.localStorage.getItem(DISMISS_KEY) !== '1');
  }, [pathname]);

  if (!visible) return null;

  const dismiss = () => {
    window.localStorage.setItem(DISMISS_KEY, '1');
    setVisible(false);
  };

  return (
    <div className="mb-3 flex items-center gap-3 rounded-lg border border-primary/25 bg-primary/5 px-4 py-2.5">
      <Gift size={16} className="text-primary shrink-0" />
      <p className="flex-1 text-sm text-foreground min-w-0">
        Invite a friend — for every paid signup you get <span className="font-medium">1 month free</span>, up to a year.
      </p>
      <button
        type="button"
        onClick={() => router.push('/settings?tab=agentbook&subtab=referrals')}
        className="shrink-0 text-sm font-medium text-primary hover:underline"
      >
        Invite now
      </button>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="shrink-0 text-muted-foreground hover:text-foreground p-1 rounded-md hover:bg-muted transition-colors"
      >
        <X size={14} />
      </button>
    </div>
  );
}
