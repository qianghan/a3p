import React from 'react';
import { formatMoney } from '@agentbook/i18n';
import { useTenantCurrency } from '../../hooks/useTenantCurrency';

export function computeDelta(current: number, prior: number): { pct: number; sign: 'up' | 'down' } | null {
  if (prior === 0) return null;
  const pct = Math.round(((current - prior) / Math.abs(prior)) * 100);
  return { pct, sign: pct >= 0 ? 'up' : 'down' };
}

const Cell: React.FC<{ label: string; cents: number; prior: number; currency: string }> = ({ label, cents, prior, currency }) => {
  const delta = computeDelta(cents, prior);
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm font-bold text-foreground">{formatMoney(cents, currency)}</span>
      {delta ? (
        <span className={`text-xs ${delta.sign === 'up' ? 'text-green-600' : 'text-red-500'}`}>
          {delta.sign === 'up' ? '↑' : '↓'}{Math.abs(delta.pct)}%
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">—</span>
      )}
    </div>
  );
};

interface Props {
  mtd: { revenueCents: number; expenseCents: number; netCents: number } | null;
  prev: { revenueCents: number; expenseCents: number; netCents: number } | null;
}

export const ThisMonthStrip: React.FC<Props> = ({ mtd, prev }) => {
  const currency = useTenantCurrency();
  if (!mtd) return null;
  const p = prev || { revenueCents: 0, expenseCents: 0, netCents: 0 };
  return (
    <section className="bg-card border border-border rounded-2xl p-4 flex items-center gap-4 flex-wrap">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">This month</span>
      <Cell label="Rev" cents={mtd.revenueCents} prior={p.revenueCents} currency={currency} />
      <Cell label="Exp" cents={mtd.expenseCents} prior={p.expenseCents} currency={currency} />
      <Cell label="Net" cents={mtd.netCents} prior={p.netCents} currency={currency} />
    </section>
  );
};
