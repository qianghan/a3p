import { describe, it, expect } from 'vitest';
import type { MobileAlert } from '@/lib/mobile/types';
import { alertCopy, mobileHref } from '@/app/app/_lib/alert-copy';
import { formatCurrencyCents } from '@/lib/jurisdiction-currency';
import { i18nT } from './test-utils';

const en = i18nT('en');
const fr = i18nT('fr-CA');
const zh = i18nT('zh-CN');
const cad = (c: number) => formatCurrencyCents(c, 'CAD', 'en');

function alert(over: Partial<MobileAlert>): MobileAlert {
  return { id: 'x', kind: 'uncategorized', severity: 'info', params: {}, ...over };
}

// The exact action buildMobileHome emits (lib/mobile/home.ts) — labelKey included.
const REMIND = { type: 'post' as const, endpoint: '/api/v1/agentbook-invoice/invoices/inv-1/remind', labelKey: 'mobile.alerts.action_remind' };

describe('alertCopy — sentences', () => {
  it('overdue invoice: client, amount and days, with the Remind action', () => {
    const c = alertCopy(alert({ kind: 'invoice_overdue', severity: 'critical', params: { client: 'Acme', days: 12, amountCents: 180_000, number: 'INV-7' }, action: REMIND }), en, cad);
    expect(c).toEqual({ title: 'Acme · CA$1,800 is 12 days overdue', actionLabel: 'Remind', href: null });
  });

  it('singular day, and a missing client name reads as "A client"', () => {
    expect(alertCopy(alert({ kind: 'invoice_overdue', params: { days: 1, amountCents: 5_000 }, action: REMIND }), en, cad).title).toBe(
      'A client · CA$50 is 1 day overdue',
    );
  });

  it('tax deadline: with amount, without amount, and today (quarter/year params are ignored)', () => {
    expect(alertCopy(alert({ kind: 'tax_deadline', params: { days: 9, quarter: 2, year: 2026, amountCents: 300_000 } }), en, cad).title).toBe('Tax payment of CA$3,000 due in 9 days');
    expect(alertCopy(alert({ kind: 'tax_deadline', params: { days: 9, quarter: 2, year: 2026 } }), en, cad).title).toBe('Tax payment due in 9 days');
    expect(alertCopy(alert({ kind: 'tax_deadline', params: { days: 0, amountCents: 300_000 } }), en, cad).title).toBe('Tax payment due today');
  });

  it('bill due, including today, a missing vendor and an overdue bill (negative days)', () => {
    expect(alertCopy(alert({ kind: 'bill_due', params: { vendor: 'Rogers', days: 3, amountCents: 9_000 } }), en, cad).title).toBe('Rogers bill of CA$90 due in 3 days');
    expect(alertCopy(alert({ kind: 'bill_due', params: { days: 0, amountCents: 9_000 } }), en, cad).title).toBe('A vendor bill of CA$90 due today');
    // home.ts emits a negative `days` for an already-overdue bill — it must not read as "due today".
    expect(alertCopy(alert({ kind: 'bill_due', params: { vendor: 'Rogers', days: -4, amountCents: 9_000 } }), en, cad).title).toBe('Rogers bill of CA$90 is 4 days overdue');
    expect(alertCopy(alert({ kind: 'bill_due', params: { vendor: 'Rogers', days: -1, amountCents: 9_000 } }), en, cad).title).toBe('Rogers bill of CA$90 is 1 day overdue');
  });

  it.each([
    ['receipts_missing', 1, '1 expense is missing a receipt'],
    ['receipts_missing', 4, '4 expenses are missing a receipt'],
    ['uncategorized', 2, '2 expenses need a category'],
    ['review_needed', 1, '1 item is waiting for your review'],
  ] as const)('%s with count %s', (kind, count, expected) => {
    expect(alertCopy(alert({ kind, params: { count } }), en, cad).title).toBe(expected);
  });

  it('review_needed with count 0 but pending AI suggestions shows the suggestion count, never "0 items"', () => {
    expect(alertCopy(alert({ kind: 'review_needed', params: { count: 0, suggestions: 3 } }), en, cad).title).toBe('3 items are waiting for your review');
    expect(alertCopy(alert({ kind: 'review_needed', params: { count: 2, suggestions: 3 } }), en, cad).title).toBe('2 items are waiting for your review');
  });

  it('the receipts sentence does not promise a list length', () => {
    const title = alertCopy(alert({ kind: 'receipts_missing', params: { count: 4 } }), en, cad).title;
    expect(title).not.toMatch(/\ball\b/i);
  });

  it('French counts zero as singular; Chinese has one form', () => {
    expect(alertCopy(alert({ kind: 'receipts_missing', params: { count: 0 } }), fr, cad).title).toBe('0 dépense sans reçu');
    expect(alertCopy(alert({ kind: 'review_needed', params: { count: 5 } }), zh, cad).title).toBe('5 项等待您审核');
  });

  it('an unknown kind still says something true', () => {
    expect(alertCopy(alert({ kind: 'mystery' as MobileAlert['kind'] }), en, cad).title).toBe('Something needs your attention');
  });
});

describe('alertCopy — destinations', () => {
  it.each([
    ['review_needed', { route: '/app/docs', query: { filter: 'needs-review' } }, 'Review', '/app/docs?filter=needs-review'],
    ['receipts_missing', { route: '/app/docs', query: { filter: 'no-receipt' } }, 'Add receipts', '/app/docs?filter=no-receipt'],
    ['uncategorized', { route: '/app/docs', query: { filter: 'no-category' } }, 'Categorize', '/app/docs?filter=no-category'],
    // The query home.ts really emits for tax_deadline / bill_due.
    ['tax_deadline', { route: '/app/chat', query: { topic: 'tax_deadline' } }, 'Details', '/app/chat?topic=tax_deadline'],
    ['bill_due', { route: '/app/chat', query: { topic: 'bill_due' } }, 'Details', '/app/chat?topic=bill_due'],
  ] as const)('%s links to the mobile screen', (kind, target, label, href) => {
    const c = alertCopy(alert({ kind, params: { count: 2, days: 3 }, target: target as MobileAlert['target'] }), en, cad);
    expect(c.actionLabel).toBe(label);
    expect(c.href).toBe(href);
  });

  it('localises the action label', () => {
    const target = { route: '/app/docs', query: { filter: 'needs-review' } } as MobileAlert['target'];
    expect(alertCopy(alert({ kind: 'review_needed', params: { count: 1 }, target }), fr, cad).actionLabel).toBe('Vérifier');
    expect(alertCopy(alert({ kind: 'review_needed', params: { count: 1 }, target }), zh, cad).actionLabel).toBe('审核');
    expect(alertCopy(alert({ kind: 'invoice_overdue', params: { days: 2, amountCents: 100 }, action: REMIND }), fr, cad).actionLabel).toBe('Relancer');
    expect(alertCopy(alert({ kind: 'invoice_overdue', params: { days: 2, amountCents: 100 }, action: REMIND }), zh, cad).actionLabel).toBe('催款');
  });

  it('a target outside /app gets no link and no button — never a desktop page', () => {
    const c = alertCopy(alert({ kind: 'review_needed', params: { count: 1 }, target: { route: '/agentbook/expenses' as never } }), en, cad);
    expect(c.href).toBeNull();
    expect(c.actionLabel).toBeNull();
  });

  it('mobileHref accepts /app and its subtree only', () => {
    expect(mobileHref({ route: '/app' })).toBe('/app');
    expect(mobileHref({ route: '/app/docs/exp-1' })).toBe('/app/docs/exp-1');
    expect(mobileHref({ route: '/app/docs', query: { filter: 'needs-review', q: 'a b' } })).toBe('/app/docs?filter=needs-review&q=a+b');
    expect(mobileHref({ route: '/appx' as never })).toBeNull();
    expect(mobileHref({ route: 'https://evil.example/app' as never })).toBeNull();
    expect(mobileHref(undefined)).toBeNull();
  });
});
