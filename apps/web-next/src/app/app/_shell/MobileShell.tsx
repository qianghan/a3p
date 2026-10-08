'use client';

import React, { useEffect } from 'react';
import { initOfflineQueueReplay } from '@/lib/offline-queue';
import { LanguageSwitcher } from '@/components/layout/language-switcher';
import { tokens } from '../_kit/tokens';
import { ToastHost } from '../_kit/Toast';
import { TabBar } from './TabBar';

/** base64url VAPID public key → Uint8Array for pushManager.subscribe. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Register the service worker — needed for offline caching and the
 * background-sync queue regardless of whether push is configured, so this
 * runs unconditionally rather than bailing early when push isn't set up.
 *
 * Also guards against the infinite-loading-loop failure mode: this worker
 * registers at the root scope ('/'), so it takes over every page under it —
 * not just /app/* — including /agentbook. When a new worker activates after
 * a deploy (skipWaiting + clients.claim in sw.js), a tab that's already open
 * keeps running its old JS against the new worker's caching rules with no
 * way to reconcile. Reloading once on `controllerchange` lets it pick up
 * the deploy that just landed instead of getting stuck. */
let swReloadedOnce = false;
async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  try {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return null;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (swReloadedOnce) return;
      swReloadedOnce = true;
      window.location.reload();
    });
    return await navigator.serviceWorker.register('/sw.js');
  } catch {
    return null;
  }
}

/** Subscribe to Web Push, if configured (best-effort, once). */
async function ensurePushSubscription(reg: ServiceWorkerRegistration | null): Promise<void> {
  try {
    if (!reg || typeof window === 'undefined' || !('PushManager' in window)) return;
    const vapid = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    if (!vapid) return; // push not configured — skip silently
    if (Notification.permission === 'denied') return;
    if (Notification.permission === 'default') {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return;
    }
    const existing = await reg.pushManager.getSubscription();
    const sub = existing ?? (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapid),
    }));
    await fetch('/api/v1/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subscription: sub }),
    });
  } catch {
    /* push is optional — never block the app */
  }
}

export function MobileShell({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    void registerServiceWorker().then((reg) => { void ensurePushSubscription(reg); });
    initOfflineQueueReplay();
  }, []);

  return (
    <ToastHost>
      <div
        data-mobile-shell
        style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column', background: tokens.color.bg, color: tokens.color.fg }}
      >
        {/*
          Slim header carrying ONLY the language switcher.

          The mobile shell is deliberately spare — four tabs, no chrome — so this
          adds the minimum that makes language reachable on a phone. Without it a
          PWA user had no way to switch at all: this layout has no top bar, and
          the tab row has no room for a fifth item.

          The switcher renders nothing when only one language is offerable, so
          this row collapses to an empty 0-height strip in that case rather than
          adding permanent furniture.
        */}
        <header
          style={{
            display: 'flex', justifyContent: 'flex-end', alignItems: 'center',
            padding: '4px 8px', paddingTop: 'max(4px, env(safe-area-inset-top))',
            paddingLeft: 'max(8px, env(safe-area-inset-left))', paddingRight: 'max(8px, env(safe-area-inset-right))',
          }}
        >
          <LanguageSwitcher />
        </header>
        <main
          id="mobile-main"
          style={{
            flex: 1,
            overflowY: 'auto',
            paddingBottom: `calc(${tokens.tabBarHeight + tokens.space.xl}px + env(safe-area-inset-bottom))`,
            paddingLeft: 'env(safe-area-inset-left)',
            paddingRight: 'env(safe-area-inset-right)',
          }}
        >
          {children}
        </main>
        <TabBar />
      </div>
    </ToastHost>
  );
}
