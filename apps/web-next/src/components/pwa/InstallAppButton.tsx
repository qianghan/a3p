'use client';

import { useState, useCallback, useEffect } from 'react';
import Link from 'next/link';
import { usePwaInstall } from '@/hooks/use-pwa-install';

/**
 * Install-app control for the marketing site. Android/desktop Chromium
 * browsers fire `beforeinstallprompt`, which we capture and trigger on
 * click — a real native install with zero extra steps. iOS Safari never
 * fires that event (there is no install API), so tapping it there opens
 * a same-page walkthrough of the manual Share-sheet steps instead, with
 * a link to the fully illustrated version in the docs.
 */
export function InstallAppButton() {
  const { platform, canOfferInstall, promptInstall } = usePwaInstall();
  const [showIosSteps, setShowIosSteps] = useState(false);

  const handleClick = useCallback(async () => {
    if (platform === 'ios') {
      setShowIosSteps(true);
      return;
    }
    const outcome = await promptInstall();
    if (outcome === 'unavailable') {
      // Already dismissed once this session, or a non-Chromium browser —
      // send them to the full guide instead of doing nothing.
      window.location.href = '/docs/setup/install-app';
    }
  }, [platform, promptInstall]);

  if (!canOfferInstall) return null;

  return (
    <>
      <button
        onClick={handleClick}
        className="ab-link flex items-center gap-1.5 text-[12px] tracking-[0.06em]"
        aria-label="Install the AgentBook app"
        title="Install app"
      >
        <InstallGlyph />
        <span className="hidden md:inline">Install app</span>
      </button>

      {showIosSteps && <IosInstallModal onClose={() => setShowIosSteps(false)} />}
    </>
  );
}

function InstallGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="5" y="2.5" width="14" height="19" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 8v6.5M12 14.5l-2.6-2.6M12 14.5l2.6-2.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9.5 18.5h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function IosInstallModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    // Plain `body.overflow: hidden` doesn't reliably lock scroll on iOS
    // Safari/WebKit — the background can still shift under the fixed
    // overlay, which reads as "cluttered": content bleeding through
    // behind the modal as the user's thumb moves. Locking both <html>
    // and <body> to `position: fixed` at the current scroll offset is
    // the standard iOS-safe scroll-lock.
    const scrollY = window.scrollY;
    const { documentElement: html, body } = document;
    const prev = { htmlOverflow: html.style.overflow, bodyPosition: body.style.position, bodyTop: body.style.top, bodyWidth: body.style.width };
    html.style.overflow = 'hidden';
    body.style.position = 'fixed';
    body.style.top = `-${scrollY}px`;
    body.style.width = '100%';
    return () => {
      document.removeEventListener('keydown', onKey);
      html.style.overflow = prev.htmlOverflow;
      body.style.position = prev.bodyPosition;
      body.style.top = prev.bodyTop;
      body.style.width = prev.bodyWidth;
      window.scrollTo(0, scrollY);
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      style={{ background: 'rgba(20,16,10,0.45)' }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Install AgentBook on iOS"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[480px] rounded-sm p-6 sm:p-9"
        style={{ background: 'var(--paper)', border: '1px solid var(--rule)', paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))' }}
      >
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-[20px] leading-tight" style={{ fontFamily: 'var(--font-display-stack)' }}>
            Add AgentBook to your Home Screen
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 text-[20px] leading-none text-[var(--muted)] hover:text-[var(--ink)]"
          >
            ×
          </button>
        </div>
        <p className="mt-2 text-[13.5px] text-[var(--muted)]">
          iOS doesn&apos;t let apps trigger this automatically — three taps in Safari, ~10 seconds.
        </p>

        <ol className="mt-6 space-y-5">
          <IosStep n={1} icon={<ShareGlyph />}>
            Tap the <strong>Share</strong> icon in Safari&apos;s toolbar.
          </IosStep>
          <IosStep n={2}>
            Scroll down and tap <strong>Add to Home Screen</strong>.
          </IosStep>
          <IosStep n={3}>
            Tap <strong>Add</strong> in the top-right corner.
          </IosStep>
        </ol>

        <div className="mt-7 pt-5 flex items-center justify-between gap-3" style={{ borderTop: '1px solid var(--rule)' }}>
          <Link href="/docs/setup/install-app" className="ab-link num text-[11.5px] tracking-[0.14em] uppercase">
            Full illustrated guide →
          </Link>
          <button onClick={onClose} className="shrink-0 btn btn-ghost text-[12px] !py-2 !px-4">
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

function IosStep({ n, icon, children }: { n: number; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-4">
      <span
        className="num shrink-0 flex items-center justify-center w-6 h-6 rounded-full text-[12px]"
        style={{ background: 'var(--accent)', color: 'var(--paper)' }}
      >
        {n}
      </span>
      <span className="flex items-start gap-1.5 text-[14.5px] leading-relaxed pt-0.5">
        {icon && <span className="shrink-0 mt-0.5">{icon}</span>}
        <span>{children}</span>
      </span>
    </li>
  );
}

function ShareGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3v12" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M8 7l4-4 4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="5" y="9.5" width="14" height="11.5" rx="2" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}
