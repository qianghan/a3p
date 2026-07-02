'use client';

import React, { useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Home, Camera, FileText, MessageCircle } from 'lucide-react';
import { initOfflineQueueReplay } from '@/lib/offline-queue';

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
 * runs unconditionally rather than bailing early when push isn't set up. */
async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  try {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return null;
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

const TABS = [
  { href: '/app', label: 'Home', icon: Home },
  { href: '/app/capture', label: 'Capture', icon: Camera },
  { href: '/app/docs', label: 'Docs', icon: FileText },
  { href: '/app/chat', label: 'Chat', icon: MessageCircle },
];

export default function MobileAppLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  useEffect(() => {
    void registerServiceWorker().then((reg) => { void ensurePushSubscription(reg); });
    initOfflineQueueReplay();
  }, []);
  return (
    <div style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column', background: 'var(--background, #0a0a0a)' }}>
      <main style={{ flex: 1, overflowY: 'auto', paddingBottom: 72 }}>{children}</main>
      <nav
        style={{
          position: 'fixed', bottom: 0, left: 0, right: 0, height: 64,
          display: 'grid', gridTemplateColumns: 'repeat(4,1fr)',
          borderTop: '1px solid var(--border, #262626)', background: 'var(--card, #111)',
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}
      >
        {TABS.map((t) => {
          const active = t.href === '/app' ? pathname === '/app' : pathname.startsWith(t.href);
          const Icon = t.icon;
          return (
            <Link key={t.href} href={t.href}
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4,
                textDecoration: 'none', minHeight: 44,
                color: active ? 'var(--primary, #10b981)' : 'var(--muted-foreground, #888)',
              }}>
              <Icon style={{ width: 22, height: 22 }} />
              <span style={{ fontSize: 11 }}>{t.label}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
