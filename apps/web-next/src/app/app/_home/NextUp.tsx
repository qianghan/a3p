'use client';

import React, { useId } from 'react';
import type { UpcomingItem } from '@/lib/mobile/types';
import { useT, type TFn } from '@/hooks/use-t';
import { Money } from '../_kit/Money';
import { tokens } from '../_kit/tokens';
import { useFormatters } from '../_kit/format';
import { resolveServerKey } from '../_lib/server-key';

export function dueLabel(t: TFn, daysAway: number): string {
  if (daysAway === 0) return t('mobile.home.next_up.today');
  if (daysAway < 0) return t('mobile.home.next_up.overdue', { count: Math.abs(daysAway) });
  return t('mobile.home.next_up.in_days', { count: daysAway });
}

/** Seeded calendar titleKeys that are a tax/filing date, whatever the jurisdiction spells them. */
const TAX_KEY = /tax|instal|install|payg|bas_|super_|vat_|filing|return|t1_|t4a|rrsp|self_assessment|sa_/i;

/**
 * The row title. Instalments and bills use `mobile.upcoming.*`; calendar events
 * carry the jurisdiction pack's own `calendar.*` key, which may not exist in
 * the catalog. Never a raw or humanised key: an unresolved one becomes a
 * neutral localized label (see resolveServerKey).
 */
export function upcomingTitle(t: TFn, u: UpcomingItem): string {
  const resolved = resolveServerKey(t, u.titleKey, u.params);
  if (resolved !== null) return resolved;
  return u.kind === 'tax' || TAX_KEY.test(u.titleKey) ? t('mobile.home.next_up.fallback_tax') : t('mobile.home.next_up.fallback_other');
}

export function NextUp({ items, currency }: { items: UpcomingItem[]; currency: string }) {
  const t = useT();
  const fmt = useFormatters();
  const headingId = useId();
  const list = items.slice(0, 3);
  return (
    <section aria-labelledby={headingId} style={{ marginBottom: tokens.space.lg }}>
      <h2 id={headingId} style={{ fontSize: tokens.font.md, fontWeight: 600, margin: `0 0 ${tokens.space.sm}px` }}>
        {t('mobile.home.next_up.title')}
      </h2>
      {list.length === 0 ? (
        <p style={{ fontSize: tokens.font.sm, color: tokens.color.muted, margin: 0 }}>{t('mobile.home.next_up.empty')}</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: tokens.space.xs }}>
          {list.map((u) => (
            <li
              key={u.id}
              data-next-up={u.kind}
              style={{
                minHeight: 52,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: tokens.space.sm,
                padding: `${tokens.space.sm}px ${tokens.space.md}px`,
                borderRadius: tokens.radius.md,
                background: tokens.color.card,
                border: `1px solid ${tokens.color.border}`,
              }}
            >
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', fontWeight: 500 }}>{upcomingTitle(t, u)}</span>
                <span style={{ display: 'block', fontSize: tokens.font.sm, color: u.daysAway < 0 ? tokens.color.fg : tokens.color.muted }}>
                  {fmt.dateOnly(u.date)} · {dueLabel(t, u.daysAway)}
                </span>
              </span>
              {u.amountCents !== null && <Money cents={u.amountCents} currency={currency} weight={600} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
