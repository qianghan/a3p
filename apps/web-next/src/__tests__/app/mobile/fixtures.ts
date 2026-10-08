import type { MobileHome } from '@/lib/mobile/types';

/** A populated CA tenant: one critical overdue invoice, review + receipts alerts, one tax date. */
export function homeFixture(overrides: Partial<MobileHome> = {}): MobileHome {
  return {
    currency: 'CAD',
    generatedAt: '2026-10-07T15:04:00.000Z',
    isBrandNew: false,
    kpis: {
      monthNetCents: 412_300,
      cashTodayCents: 1_250_000,
      outstandingCents: 980_000,
      overdueCount: 2,
      overdueCents: 380_000,
      estTaxOwedCents: 615_000,
    },
    alerts: [
      {
        id: 'a1',
        kind: 'invoice_overdue',
        severity: 'critical',
        params: { client: 'Acme', days: 12, amountCents: 180_000 },
        action: { type: 'post', endpoint: '/api/v1/agentbook-invoice/invoices/inv-1/remind', labelKey: 'mobile.alerts.action_remind' },
      },
      { id: 'a2', kind: 'review_needed', severity: 'warn', params: { count: 3 }, target: { route: '/app/docs', query: { filter: 'needs-review' } } },
      { id: 'a3', kind: 'receipts_missing', severity: 'info', params: { count: 4 }, target: { route: '/app/docs', query: { filter: 'no-receipt' } } },
    ],
    nextUp: [
      { id: 'u1', kind: 'tax', titleKey: 'mobile.upcoming.tax_instalment', params: { quarter: 3, year: 2026 }, date: '2026-10-15', daysAway: 8, amountCents: 300_000 },
    ],
    recent: [
      { id: 'r1', kind: 'expense', label: 'Staples', amountCents: 4_250, at: '2026-10-06T18:00:00.000Z', docId: 'exp-1' },
      { id: 'r2', kind: 'payment', label: 'Payment from Acme', amountCents: 100_000, at: '2026-10-05T12:00:00.000Z' },
    ],
    ...overrides,
  };
}
