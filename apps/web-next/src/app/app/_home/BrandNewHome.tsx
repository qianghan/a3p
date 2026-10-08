'use client';

import React from 'react';
import Link from 'next/link';
import { useT } from '@/hooks/use-t';
import { EmptyState } from '../_kit/EmptyState';
import { tokens, TOUCH } from '../_kit/tokens';

/**
 * A brand-new account has nothing to summarise. Zero tiles read as "broken" and
 * offer no way forward, so this keeps the three real next steps the previous
 * Home had — distinct from "we couldn't load your numbers".
 */
export function BrandNewHome() {
  const t = useT();
  const cards = [
    { href: '/app/capture', title: t('mobile.home.new.snap_title'), body: t('mobile.home.new.snap_body') },
    { href: '/app/chat', title: t('mobile.home.new.chat_title'), body: t('mobile.home.new.chat_body') },
    { href: '/app/docs', title: t('mobile.home.new.docs_title'), body: t('mobile.home.new.docs_body') },
  ];
  return (
    <EmptyState title={t('mobile.home.new.title')} body={t('mobile.home.new.body')}>
      <div style={{ display: 'grid', gap: tokens.space.sm + 2 }}>
        {cards.map((c) => (
          <Link
            key={c.href}
            href={c.href}
            data-action-card={c.href}
            style={{
              display: 'block',
              minHeight: TOUCH,
              minWidth: TOUCH,
              padding: tokens.space.lg,
              borderRadius: tokens.radius.md,
              background: tokens.color.card,
              border: `1px solid ${tokens.color.border}`,
              color: tokens.color.fg,
              textDecoration: 'none',
            }}
          >
            <span style={{ display: 'block', fontSize: tokens.font.md, fontWeight: 500, marginBottom: tokens.space.xs }}>
              {c.title} <span aria-hidden="true" style={{ color: tokens.color.muted }}>›</span>
            </span>
            <span style={{ display: 'block', fontSize: tokens.font.sm, color: tokens.color.muted }}>{c.body}</span>
          </Link>
        ))}
      </div>
    </EmptyState>
  );
}
