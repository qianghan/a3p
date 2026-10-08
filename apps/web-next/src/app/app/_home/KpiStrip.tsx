'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import type { MobileHome } from '@/lib/mobile/types';
import { useT, useShellLocale, type TFn } from '@/hooks/use-t';
import { Money, moneyText } from '../_kit/Money';
import { Sheet } from '../_kit/Sheet';
import { Button } from '../_kit/Button';
import { buttonStyle } from '../_kit/styles';
import { tokens, TOUCH } from '../_kit/tokens';
import { useFormatters } from '../_kit/format';
import { alertCopy, mobileHref } from '../_lib/alert-copy';
import type { AlertActions } from './useAlertAction';

export type KpiId = 'month_net' | 'cash' | 'outstanding' | 'tax';
const ORDER: KpiId[] = ['month_net', 'cash', 'outstanding', 'tax'];

export function kpiCents(data: MobileHome, id: KpiId): number | null {
  switch (id) {
    case 'month_net':
      return data.kpis.monthNetCents;
    case 'cash':
      return data.kpis.cashTodayCents;
    case 'outstanding':
      return data.kpis.outstandingCents;
    default:
      return data.kpis.estTaxOwedCents;
  }
}

function kpiLabel(t: TFn, id: KpiId): string {
  switch (id) {
    case 'month_net':
      return t('mobile.home.kpi.month_net');
    case 'cash':
      return t('mobile.home.kpi.cash');
    case 'outstanding':
      return t('mobile.home.kpi.outstanding');
    default:
      return t('mobile.home.kpi.tax');
  }
}

const DOCS_HREF = mobileHref({ route: '/app/docs' }) ?? '/app';
const CHAT_HREF = mobileHref({ route: '/app/chat' }) ?? '/app';

const help: React.CSSProperties = { fontSize: tokens.font.sm, color: tokens.color.muted, margin: 0, lineHeight: 1.45 };
const column: React.CSSProperties = { display: 'grid', gap: tokens.space.md };
const big: React.CSSProperties = { fontSize: tokens.font.xl, fontWeight: 600, margin: 0 };

export function KpiStrip({ data, actions }: { data: MobileHome; actions: AlertActions }) {
  const t = useT();
  const locale = useShellLocale();
  const [open, setOpen] = useState<KpiId | null>(null);
  const overdue =
    data.kpis.overdueCount > 0
      ? t('mobile.home.kpi.overdue_sub', { count: data.kpis.overdueCount, amount: moneyText(data.kpis.overdueCents, data.currency, locale) })
      : null;

  const accessibleName = (id: KpiId): string => {
    const cents = kpiCents(data, id);
    const value = cents === null || !Number.isFinite(cents) ? t('mobile.kit.not_available') : moneyText(cents, data.currency, locale);
    return [kpiLabel(t, id), value, id === 'outstanding' ? overdue : null].filter(Boolean).join(', ');
  };

  return (
    <section
      role="region"
      aria-label={t('mobile.home.kpi.region')}
      style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: tokens.space.sm, marginBottom: tokens.space.lg }}
    >
      {ORDER.map((id) => (
        <button
          key={id}
          type="button"
          data-kpi={id}
          aria-label={accessibleName(id)}
          aria-haspopup="dialog"
          onClick={() => setOpen(id)}
          style={{
            minHeight: 88,
            minWidth: TOUCH,
            textAlign: 'left',
            padding: tokens.space.md,
            borderRadius: tokens.radius.md,
            border: `1px solid ${tokens.color.border}`,
            background: tokens.color.card,
            color: tokens.color.fg,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            gap: tokens.space.xs,
            cursor: 'pointer',
          }}
        >
          <span style={{ fontSize: tokens.font.sm, color: tokens.color.muted }}>{kpiLabel(t, id)}</span>
          <Money cents={kpiCents(data, id)} currency={data.currency} size={tokens.font.kpi} weight={600} />
          {id === 'outstanding' && overdue && (
            <span data-kpi-sub style={{ fontSize: tokens.font.xs, color: tokens.color.fg, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: tokens.radius.pill, background: tokens.color.critical }} />
              {overdue}
            </span>
          )}
        </button>
      ))}
      <Sheet open={open !== null} onClose={() => setOpen(null)} title={open ? kpiLabel(t, open) : ''}>
        {open && <KpiDetail id={open} data={data} actions={actions} />}
      </Sheet>
    </section>
  );
}

function KpiDetail({ id, data, actions }: { id: KpiId; data: MobileHome; actions: AlertActions }) {
  const t = useT();
  const fmt = useFormatters();
  const cents = kpiCents(data, id);
  const figure = (
    <p style={big}>
      <Money cents={cents} currency={data.currency} />
    </p>
  );

  if (id === 'month_net') {
    return (
      <div style={column}>
        {figure}
        <p style={help}>{t('mobile.home.kpi.month_net_help')}</p>
        <Link href={DOCS_HREF} style={buttonStyle('secondary')}>{t('mobile.home.kpi.see_expenses')}</Link>
      </div>
    );
  }

  if (id === 'cash') {
    return (
      <div style={column}>
        {figure}
        <p style={help}>{cents === null ? t('mobile.home.kpi.cash_unavailable') : t('mobile.home.kpi.cash_help')}</p>
        <Link href={CHAT_HREF} style={buttonStyle('secondary')}>{t('mobile.home.kpi.ask_cash')}</Link>
      </div>
    );
  }

  if (id === 'tax') {
    const next = data.nextUp.find((u) => u.kind === 'tax');
    return (
      <div style={column}>
        {figure}
        <p style={help}>{cents === null ? t('mobile.home.kpi.tax_unavailable') : t('mobile.home.kpi.tax_help')}</p>
        {next && <p data-next-tax style={{ margin: 0 }}>{t('mobile.home.kpi.next_tax_on', { date: fmt.dateOnly(next.date) })}</p>}
        <Link href={CHAT_HREF} style={buttonStyle('secondary')}>{t('mobile.home.kpi.ask_tax')}</Link>
      </div>
    );
  }

  return <OutstandingDetail data={data} actions={actions} />;
}

function OutstandingDetail({ data, actions }: { data: MobileHome; actions: AlertActions }) {
  const t = useT();
  const locale = useShellLocale();
  const overdue = data.alerts.filter((a) => a.kind === 'invoice_overdue');
  return (
    <div style={column}>
      <p style={big}>
        <Money cents={data.kpis.outstandingCents} currency={data.currency} />
      </p>
      <p style={help}>{t('mobile.home.kpi.outstanding_help')}</p>
      <dl style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: tokens.space.sm, margin: 0 }}>
        <dt>{t('mobile.home.kpi.overdue_count')}</dt>
        <dd style={{ margin: 0, fontWeight: 600 }}>{data.kpis.overdueCount}</dd>
        <dt>{t('mobile.home.kpi.overdue_amount')}</dt>
        <dd style={{ margin: 0, fontWeight: 600 }}>
          <Money cents={data.kpis.overdueCents} currency={data.currency} />
        </dd>
      </dl>
      {overdue.length > 0 && (
        <ul aria-label={t('mobile.home.kpi.overdue_list')} style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: tokens.space.sm }}>
          {overdue.map((a) => {
            const client = typeof a.params.client === 'string' && a.params.client.trim() ? a.params.client : t('mobile.home.alert.a_client');
            const rawDays = Math.round(Number(a.params.days));
            const days = Number.isFinite(rawDays) ? Math.max(0, rawDays) : 0;
            const rawCents = Number(a.params.amountCents);
            const amount = moneyText(Number.isFinite(rawCents) ? rawCents : 0, data.currency, locale);
            const actionLabel = alertCopy(a, t, (cents) => moneyText(cents, data.currency, locale)).actionLabel;
            const sent = actions.isDone(a.id);
            return (
              <li
                key={a.id}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.space.sm, padding: `${tokens.space.sm}px 0`, borderTop: `1px solid ${tokens.color.border}` }}
              >
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: 'block', fontWeight: 500 }}>{client}</span>
                  <span style={{ display: 'block', fontSize: tokens.font.sm, color: tokens.color.muted }}>
                    {t('mobile.home.kpi.overdue_days', { count: days })} · {amount}
                  </span>
                </span>
                {a.action && (
                  <Button variant="secondary" disabled={sent || actions.isPending(a.id)} onClick={() => void actions.run(a)}>
                    {sent ? t('mobile.home.action.reminded') : actionLabel}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
