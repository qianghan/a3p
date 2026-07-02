'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Smartphone, X, Share } from 'lucide-react';
import { usePwaInstall } from '@/hooks/use-pwa-install';

const DISMISS_KEY = 'ab_pwa_banner_dismissed';

/**
 * QA-P2-002: AgentBook has a fully working installable PWA, but nothing
 * inside the authenticated app ever told a mobile user it exists. Rather
 * than surface the separate `/app/*` PWA shell as a navigable page (a
 * product decision left open), this nudges mobile visitors — on whichever
 * platform they're on — to install the current app to their home screen.
 * Same dismiss-once-ever pattern as `InviteBanner`, shown only on the home
 * dashboard so it doesn't become a persistent nag on every page.
 */
export function InstallAppBanner() {
  const pathname = usePathname();
  const { platform, canOfferInstall, promptInstall } = usePwaInstall();
  const [visible, setVisible] = useState(false);
  const [showIosSteps, setShowIosSteps] = useState(false);

  const isMobile = platform === 'ios' || platform === 'android';

  useEffect(() => {
    if (pathname !== '/agentbook' || !isMobile || !canOfferInstall) {
      setVisible(false);
      return;
    }
    if (typeof window === 'undefined') return;
    setVisible(window.localStorage.getItem(DISMISS_KEY) !== '1');
  }, [pathname, isMobile, canOfferInstall]);

  if (!visible) return null;

  const dismiss = () => {
    window.localStorage.setItem(DISMISS_KEY, '1');
    setVisible(false);
  };

  const handleInstall = async () => {
    if (platform === 'ios') {
      setShowIosSteps(true);
      return;
    }
    await promptInstall();
    dismiss();
  };

  return (
    <>
      <div className="mb-3 flex items-center gap-3 rounded-lg border border-primary/25 bg-primary/5 px-4 py-2.5">
        <Smartphone size={16} className="text-primary shrink-0" />
        <p className="flex-1 text-sm text-foreground min-w-0">
          Add AgentBook to your home screen for the full app experience and push reminders.
        </p>
        <button
          type="button"
          onClick={handleInstall}
          className="shrink-0 text-sm font-medium text-primary hover:underline"
        >
          Install
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

      {showIosSteps && (
        <IosInstallModal
          onClose={() => {
            setShowIosSteps(false);
            dismiss();
          }}
        />
      )}
    </>
  );
}

function IosInstallModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Install AgentBook on iOS"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[420px] rounded-xl border border-border bg-card p-6"
      >
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-base font-semibold text-foreground">Add to your Home Screen</h2>
          <button onClick={onClose} aria-label="Close" className="shrink-0 text-muted-foreground hover:text-foreground">
            <X size={18} />
          </button>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">iOS needs a few manual taps in Safari — about 10 seconds.</p>

        <ol className="mt-5 space-y-4">
          <Step n={1}>Tap the <Share size={13} className="inline -mt-0.5 mx-0.5" /> <strong>Share</strong> icon in Safari&apos;s toolbar.</Step>
          <Step n={2}>Scroll down and tap <strong>Add to Home Screen</strong>.</Step>
          <Step n={3}>Tap <strong>Add</strong> in the top-right corner.</Step>
        </ol>

        <div className="mt-6 pt-4 border-t border-border flex items-center justify-between">
          <a href="/docs/setup/install-app" className="text-xs font-medium text-primary hover:underline">
            Full illustrated guide →
          </a>
          <button onClick={onClose} className="text-sm font-medium px-3 py-1.5 rounded-md border border-border hover:bg-muted transition-colors">
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span className="shrink-0 flex items-center justify-center w-5 h-5 rounded-full bg-primary text-primary-foreground text-[11px] font-medium">
        {n}
      </span>
      <span className="text-sm text-foreground leading-relaxed pt-px">{children}</span>
    </li>
  );
}
