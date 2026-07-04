'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { UserCircle, X } from 'lucide-react';

const DISMISS_KEY = 'ab_profile_banner_dismissed';

/**
 * A lightweight, non-blocking nudge to complete the personal profile
 * (name, DOB, address, income, etc. — see AbPersonalProfile) so the agent
 * can give richer, contextual tax/personal-finance answers instead of
 * generic ones. Same dismiss-once-ever pattern as InstallAppBanner /
 * InviteBanner, but also re-checks live completion status — unlike a pure
 * dismiss flag, it disappears on its own once the profile is actually
 * completed, not just when the user clicks away.
 */
export function ProfileCompletionBanner() {
  const pathname = usePathname();
  const router = useRouter();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (pathname !== '/agentbook') {
      setVisible(false);
      return;
    }
    if (typeof window === 'undefined') return;
    if (window.localStorage.getItem(DISMISS_KEY) === '1') {
      setVisible(false);
      return;
    }
    let cancelled = false;
    fetch('/api/v1/agentbook-core/personal-profile')
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setVisible(Boolean(d.success && d.data && !d.data.isComplete));
      })
      .catch(() => { /* non-fatal — just don't show the banner */ });
    return () => { cancelled = true; };
  }, [pathname]);

  if (!visible) return null;

  const dismiss = () => {
    window.localStorage.setItem(DISMISS_KEY, '1');
    setVisible(false);
  };

  return (
    <div className="mb-3 flex items-center gap-3 rounded-lg border border-primary/25 bg-primary/5 px-4 py-2.5">
      <UserCircle size={16} className="text-primary shrink-0" />
      <p className="flex-1 text-sm text-foreground min-w-0">
        Tell your agent a bit about yourself — name, income, family — for much better tax and financial advice.
      </p>
      <button
        type="button"
        onClick={() => { router.push('/settings?tab=agentbook&subtab=personal'); dismiss(); }}
        className="shrink-0 text-sm font-medium text-primary hover:underline"
      >
        Complete profile
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
