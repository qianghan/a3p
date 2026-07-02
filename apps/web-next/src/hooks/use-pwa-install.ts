'use client';

import { useEffect, useState, useCallback } from 'react';

export type PwaPlatform = 'ios' | 'android' | 'desktop' | 'unsupported';

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function detectPlatform(): PwaPlatform {
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
 * Shared install-detection state for both the marketing-site button and the
 * in-app banner. Android/desktop Chromium browsers fire `beforeinstallprompt`,
 * which we capture and can trigger on demand — a real native install with
 * zero extra steps. iOS Safari never fires that event (there is no install
 * API), so `platform === 'ios'` is the caller's signal to show manual
 * instructions instead of calling `promptInstall()`.
 */
export function usePwaInstall() {
  const [platform, setPlatform] = useState<PwaPlatform>('unsupported');
  const [installed, setInstalled] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);

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

  const promptInstall = useCallback(async (): Promise<'accepted' | 'dismissed' | 'unavailable'> => {
    if (!deferredPrompt) return 'unavailable';
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') setInstalled(true);
    setDeferredPrompt(null);
    return outcome;
  }, [deferredPrompt]);

  // Nothing to offer: already installed, unsupported browser, or a desktop
  // browser that never fired the event (no point advertising an action that
  // won't do anything).
  const canOfferInstall = !installed && platform !== 'unsupported' && (platform === 'ios' || !!deferredPrompt);

  return { platform, installed, canOfferInstall, promptInstall };
}
