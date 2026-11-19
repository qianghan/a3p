'use client';
import React from 'react';
import Link from 'next/link';
import { Receipt } from 'lucide-react';
import { useT, useShellLocale } from '@/hooks/use-t';
import type { PurchaseRow } from '@/lib/purchases-view';
import { Pill, tokens, TOUCH } from '../../_kit';
import { formatDocDate } from '../../_lib/format';
import { Amount } from './Amount';

const ellipsis: React.CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

/** Where a tapped bill goes: the desktop Bills page. There is no mobile bill screen, and this is the smallest honest target. */
export const BILLS_HREF = '/agentbook/bills';

/**
 * One bill among the Docs rows (PR 3bc.7): a Due / Overdue / Paid badge, the
 * bill TOTAL, and for a part-paid bill what is still owed. The badge is text,
 * not colour alone.
 */
export function BillItem({ bill, currency }: { bill: PurchaseRow; currency: string | null }) {
  const t = useT();
  const locale = useShellLocale();
  const paid = bill.status === 'paid';
  const owed = bill.outstandingCents ?? 0;
  const part = !paid && owed > 0 && owed < bill.amountCents;
  return (
    <Link
      href={BILLS_HREF}
      data-testid="bill-item"
      style={{
        textDecoration: 'none', color: tokens.color.fg, background: tokens.color.card, border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.md, minHeight: TOUCH, display: 'flex', gap: tokens.space.md, alignItems: 'center', padding: tokens.space.md - 2,
      }}
    >
      <span aria-hidden="true" style={{ width: 48, height: 48, display: 'grid', placeItems: 'center', color: tokens.color.muted }}>
        <Receipt style={{ width: 22, height: 22 }} />
      </span>
      <span style={{ flex: 1, minWidth: 0, display: 'grid', gap: 2 }}>
        <span style={{ ...ellipsis, fontSize: tokens.font.md, fontWeight: 500 }}>{bill.vendor || t('mobile.docs.untitled')}</span>
        <span style={{ ...ellipsis, fontSize: tokens.font.sm, color: tokens.color.muted }}>
          {formatDocDate(bill.date, locale)} · {t('mobile.docs.bill_label')}
        </span>
        <span style={{ display: 'inline-flex', gap: tokens.space.xs, flexWrap: 'wrap', alignItems: 'center' }}>
          {paid ? (
            <Pill tone="good">{t('mobile.docs.bill_paid_pill')}</Pill>
          ) : (
            <Pill tone={bill.overdue ? 'critical' : 'warn'}>{bill.overdue ? t('mobile.docs.bill_overdue_pill') : t('mobile.docs.bill_due_pill')}</Pill>
          )}
          {part && (
            <span style={{ fontSize: tokens.font.xs, color: tokens.color.muted }}>
              {t('mobile.docs.bill_remaining')} <Amount cents={owed} currency={currency} />
            </span>
          )}
        </span>
      </span>
      <span style={{ fontSize: tokens.font.md, fontWeight: 600, whiteSpace: 'nowrap' }}><Amount cents={bill.amountCents} currency={currency} /></span>
    </Link>
  );
}
