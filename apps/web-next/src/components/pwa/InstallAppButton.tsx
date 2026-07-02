'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';

type Platform = 'ios' | 'android' | 'desktop' | 'unsupported';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'unsupported';
  const ua = navigator.userAgent;
  // iPadOS 13+ reports as "Macintosh" but exposes multi-touch — the
  // standard sniff for telling it apart from a real Mac.
  const isIOS = /iPhone|iPad|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
  if (isIOS) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    // iOS Safari's own (non-standard, still the only signal it exposes)
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/**
 * Install-app control for the marketing site. Android/desktop Chromium
 * browsers fire `beforeinstallprompt`, which we capture and trigger on
 * click — a real native install with zero extra steps. iOS Safari never
 * fires that event (there is no install API), so tapping it there opens
 * a same-page walkthrough of the manual Share-sheet steps instead, with
 * a link to the fully illustrated version in the docs.
 */
export function InstallAppButton() {
  const [platform, setPlatform] = useState<Platform>('unsupported');
  const [installed, setInstalled] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIosSteps, setShowIosSteps] = useState(false);

  useEffect(() => {
    setPlatform(detectPlatform());
    setInstalled(isStandalone());

    const onBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setInstalled(true);

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const handleClick = useCallback(async () => {
    if (platform === 'ios') {
      setShowIosSteps(true);
      return;
    }
    if (deferredPrompt) {
      await deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') setInstalled(true);
      setDeferredPrompt(null);
      return;
    }
    // Android/desktop without a captured prompt (already dismissed once,
    // or a non-Chromium browser) — send them to the full guide instead
    // of doing nothing.
    window.location.href = '/docs/setup/install-app';
  }, [platform, deferredPrompt]);

  // Nothing to offer: already installed, or a desktop browser that never
  // fired the event (no point advertising an action that won't do anything).
  if (installed) return null;
  if (platform === 'desktop' && !deferredPrompt) return null;
  if (platform === 'unsupported') return null;

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
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
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
        className="w-full max-w-[480px] rounded-sm p-7 sm:p-9"
        style={{ background: 'var(--paper)', border: '1px solid var(--rule)' }}
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
          <IosStep n={1}>
            Tap the <ShareGlyph /> <strong>Share</strong> icon in Safari&apos;s toolbar.
          </IosStep>
          <IosStep n={2}>
            Scroll down and tap <strong>Add to Home Screen</strong>.
          </IosStep>
          <IosStep n={3}>
            Tap <strong>Add</strong> in the top-right corner.
          </IosStep>
        </ol>

        <div className="mt-7 pt-5 flex items-center justify-between" style={{ borderTop: '1px solid var(--rule)' }}>
          <Link href="/docs/setup/install-app" className="ab-link num text-[11.5px] tracking-[0.14em] uppercase">
            Full illustrated guide →
          </Link>
          <button onClick={onClose} className="btn btn-ghost text-[12px] !py-2 !px-4">
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

function IosStep({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-4">
      <span
        className="num shrink-0 flex items-center justify-center w-6 h-6 rounded-full text-[12px]"
        style={{ background: 'var(--accent)', color: 'var(--paper)' }}
      >
        {n}
      </span>
      <span className="text-[14.5px] leading-relaxed pt-0.5">{children}</span>
    </li>
  );
}

function ShareGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" className="inline -mt-0.5 mx-0.5" aria-hidden="true">
      <path d="M12 3v12" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M8 7l4-4 4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="5" y="9.5" width="14" height="11.5" rx="2" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}
