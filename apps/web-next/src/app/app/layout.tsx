'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Home, Camera, FileText, MessageCircle } from 'lucide-react';

const TABS = [
  { href: '/app', label: 'Home', icon: Home },
  { href: '/app/capture', label: 'Capture', icon: Camera },
  { href: '/app/docs', label: 'Docs', icon: FileText },
  { href: '/app/chat', label: 'Chat', icon: MessageCircle },
];

export default function MobileAppLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
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
