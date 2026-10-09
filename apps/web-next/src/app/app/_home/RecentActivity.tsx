'use client';

import React, { useId } from 'react';
import Link from 'next/link';
import { Receipt, FileText, ArrowDownLeft, type LucideIcon } from 'lucide-react';
import type { RecentItem } from '@/lib/mobile/types';
import { useT } from '@/hooks/use-t';
import { Money } from '../_kit/Money';
import { tokens, TOUCH } from '../_kit/tokens';
import { useFormatters } from '../_kit/format';

/**
 * The document viewer lives at /app/docs/[id] (PR 4, Task 4.10), so an expense
 * row links straight to it. The flag stays as the one switch: a link to a route
 * that 404s is worse than a link one level up, so it can be turned back to false
 * (rows then link the Docs list) if the viewer is ever pulled.
 */
export const DOC_VIEWER_ROUTE_SHIPPED = true;

const DOCS_LIST = '/app/docs';

export function recentHref(item: RecentItem, viewerShipped: boolean = DOC_VIEWER_ROUTE_SHIPPED): string | null {
  if (item.kind !== 'expense' || !item.docId) return null;
  return viewerShipped ? `${DOCS_LIST}/${encodeURIComponent(item.docId)}` : DOCS_LIST;
}

const ICON: Record<RecentItem['kind'], LucideIcon> = { expense: Receipt, invoice: FileText, payment: ArrowDownLeft };

const row: React.CSSProperties = {
  minHeight: TOUCH,
  minWidth: TOUCH,
  display: 'flex',
  alignItems: 'center',
  gap: tokens.space.md,
  padding: `${tokens.space.sm}px 0`,
  color: tokens.color.fg,
  textDecoration: 'none',
};

export function RecentActivity({ items, currency }: { items: RecentItem[]; currency: string }) {
  const t = useT();
  const fmt = useFormatters();
  const headingId = useId();
  const list = items.slice(0, 5);
  return (
    <section aria-labelledby={headingId} style={{ marginBottom: tokens.space.lg }}>
      <h2 id={headingId} style={{ fontSize: tokens.font.md, fontWeight: 600, margin: `0 0 ${tokens.space.sm}px` }}>
        {t('mobile.home.recent.title')}
      </h2>
      {list.length === 0 ? (
        <p style={{ fontSize: tokens.font.sm, color: tokens.color.muted, margin: 0 }}>{t('mobile.home.recent.empty')}</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {list.map((r) => {
            const Icon = ICON[r.kind] ?? Receipt;
            const href = recentHref(r);
            // r.label is user data (a vendor or client name): rendered as a text node only.
            const body = (
              <>
                <Icon aria-hidden="true" width={18} height={18} style={{ color: tokens.color.muted, flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</span>
                  <span style={{ display: 'block', fontSize: tokens.font.xs, color: tokens.color.muted }}>{fmt.date(r.at)}</span>
                </span>
                <Money cents={r.amountCents} currency={currency} />
              </>
            );
            return (
              <li key={r.id} data-recent={r.kind} style={{ borderTop: `1px solid ${tokens.color.border}` }}>
                {href ? (
                  <Link href={href} style={row}>
                    {body}
                  </Link>
                ) : (
                  <div style={row}>{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
