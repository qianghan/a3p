'use client';
import React from 'react';
import { useT, useShellLocale } from '@/hooks/use-t';
import type { PurchaseRow } from '@/lib/purchases-view';
import { Sheet, tokens } from '../../_kit';
import { formatDocDate } from '../../_lib/format';
import { Amount } from './Amount';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: tokens.space.md, padding: `${tokens.space.sm}px 0`, borderBottom: `1px solid ${tokens.color.border}` }}>
      <dt style={{ color: tokens.color.muted, fontSize: tokens.font.sm }}>{label}</dt>
      <dd style={{ margin: 0, fontSize: tokens.font.md, fontWeight: 500, textAlign: 'right' }}>{children}</dd>
    </div>
  );
}

/** Read-only detail for one bill. No actions: paying from the phone is a later PR. */
export default function BillSheet({ open, onClose, bill, vendor, badge, currency }: {
  open: boolean; onClose: () => void; bill: PurchaseRow; vendor: string; badge: React.ReactNode; currency: string | null;
}) {
  const t = useT();
  const locale = useShellLocale();
  const paid = bill.status === 'paid';
  // A legacy at_payment bill is 'paid' with paidCents 0: show the total, never a derived "0 paid".
  const paidCents = paid ? bill.amountCents : (bill.paidCents ?? 0);
  return (
    <Sheet open={open} onClose={onClose} title={vendor} testId="bill-sheet">
      <dl style={{ margin: 0 }}>
        <Row label={t('mobile.docs.bill_status')}>{badge}</Row>
        {bill.billNumber ? <Row label={t('mobile.docs.bill_number')}>{bill.billNumber}</Row> : null}
        <Row label={t('mobile.docs.bill_date')}>{formatDocDate(bill.date, locale)}</Row>
        {bill.dueDate ? <Row label={t('mobile.docs.bill_due_date')}>{formatDocDate(bill.dueDate, locale)}</Row> : null}
        <Row label={t('mobile.docs.bill_total')}><Amount cents={bill.amountCents} currency={currency} /></Row>
        <Row label={t('mobile.docs.bill_paid_so_far')}><Amount cents={paidCents} currency={currency} /></Row>
        <Row label={t('mobile.docs.bill_outstanding')}><Amount cents={bill.outstandingCents ?? 0} currency={currency} /></Row>
      </dl>
    </Sheet>
  );
}
