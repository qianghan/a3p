'use client';

import React, { useId } from 'react';
import Link from 'next/link';
import { Camera, PlusCircle, MessageCircle } from 'lucide-react';
import { useT } from '@/hooks/use-t';
import { tokens, TOUCH } from '../_kit/tokens';

export function QuickActions() {
  const t = useT();
  const headingId = useId();
  // Existing mobile routes only. "Add expense" shares Capture with "Snap" until
  // PR 5 gives Capture a manual-entry mode.
  const actions = [
    { id: 'snap', href: '/app/capture', label: t('mobile.home.quick.snap'), Icon: Camera },
    { id: 'add', href: '/app/capture', label: t('mobile.home.quick.add_expense'), Icon: PlusCircle },
    { id: 'ask', href: '/app/chat', label: t('mobile.home.quick.ask'), Icon: MessageCircle },
  ];
  return (
    <section aria-labelledby={headingId} style={{ marginBottom: tokens.space.lg }}>
      <h2 id={headingId} style={{ fontSize: tokens.font.md, fontWeight: 600, margin: `0 0 ${tokens.space.sm}px` }}>
        {t('mobile.home.quick.title')}
      </h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: tokens.space.sm }}>
        {actions.map((a) => (
          <Link
            key={a.id}
            href={a.href}
            data-quick={a.id}
            style={{
              minHeight: 76,
              minWidth: TOUCH,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: tokens.space.xs,
              padding: tokens.space.sm,
              borderRadius: tokens.radius.md,
              border: `1px solid ${tokens.color.border}`,
              background: tokens.color.card,
              color: tokens.color.fg,
              textDecoration: 'none',
              fontSize: tokens.font.sm,
              textAlign: 'center',
            }}
          >
            <a.Icon aria-hidden="true" width={22} height={22} style={{ color: tokens.color.primary }} />
            <span>{a.label}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
