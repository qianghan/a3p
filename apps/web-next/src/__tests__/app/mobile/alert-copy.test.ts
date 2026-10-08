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
    // The invoice number tells two same-client, same-amount invoices apart.
    expect(c).toEqual({ title: 'Acme · INV-7 · CA$1,800 is 12 days overdue', actionLabel: 'Remind', href: null });
    expect(alertCopy(alert({ kind: 'invoice_overdue', params: { client: 'Acme', days: 12, amountCents: 180_000 }, action: REMIND }), en, cad).title).toBe(
      'Acme · CA$1,800 is 12 days overdue',
    );
  });

  it('two overdue invoices from the same client for the same amount read differently', () => {
    const a = alertCopy(alert({ kind: 'invoice_overdue', params: { client: 'Acme', days: 12, amountCents: 180_000, number: 'INV-7' }, action: REMIND }), en, cad).title;
    const b = alertCopy(alert({ kind: 'invoice_overdue', params: { client: 'Acme', days: 12, amountCents: 180_000, number: 'INV-9' }, action: REMIND }), en, cad).title;
    expect(a).not.toBe(b);
    expect(alertCopy(alert({ kind: 'invoice_overdue', params: { client: 'Acme', days: 3, amountCents: 5_000, number: 'F-12' }, action: REMIND }), fr, cad).title).toBe('Acme · F-12 · CA$50 en retard de 3 jours');
    expect(alertCopy(alert({ kind: 'invoice_overdue', params: { client: 'Acme', days: 3, amountCents: 5_000, number: 'F-12' }, action: REMIND }), zh, cad).title).toBe('Acme · F-12 · CA$50 已逾期 3 天');
    // A blank number is ignored.
    expect(alertCopy(alert({ kind: 'invoice_overdue', params: { client: 'Acme', days: 3, amountCents: 5_000, number: '  ' }, action: REMIND }), en, cad).title).toBe('Acme · CA$50 is 3 days overdue');
  });

  it.each([
    ['missing', undefined],
    ['garbage text', 'lots'],
    ['NaN', Number.NaN],
    ['empty string', ''],
    ['a boolean', true],
  ])('an invoice/bill amount that is %s is OMITTED — never "$0.00"', (_label, amountCents) => {
    const p = (extra: Record<string, unknown>) => ({ ...extra, ...(amountCents === undefined ? {} : { amountCents }) }) as MobileAlert['params'];
    const inv = alertCopy(alert({ kind: 'invoice_overdue', params: p({ client: 'Acme', days: 12 }), action: REMIND }), en, cad).title;
    expect(inv).toBe('Acme is 12 days overdue');
    expect(alertCopy(alert({ kind: 'bill_due', params: p({ vendor: 'Rogers', days: 3 }) }), en, cad).title).toBe('Rogers bill due in 3 days');
    expect(alertCopy(alert({ kind: 'bill_due', params: p({ vendor: 'Rogers', days: 0 }) }), en, cad).title).toBe('Rogers bill due today');
    expect(alertCopy(alert({ kind: 'bill_due', params: p({ vendor: 'Rogers', days: -1 }) }), en, cad).title).toBe('Rogers bill is 1 day overdue');
    for (const title of [inv]) expect(title).not.toMatch(/\$0/);
  });

  it('no-amount invoice/bill copy in French and Chinese', () => {
    expect(alertCopy(alert({ kind: 'invoice_overdue', params: { client: 'Acme', days: 1 }, action: REMIND }), fr, cad).title).toBe('Acme en retard de 1 jour');
    expect(alertCopy(alert({ kind: 'bill_due', params: { vendor: 'Rogers', days: 4 } }), fr, cad).title).toBe('Facture Rogers due dans 4 jours');
    expect(alertCopy(alert({ kind: 'bill_due', params: { vendor: 'Rogers', days: 0 } }), fr, cad).title).toBe('Facture Rogers due aujourd’hui');
    expect(alertCopy(alert({ kind: 'bill_due', params: { vendor: 'Rogers', days: -2 } }), fr, cad).title).toBe('Facture Rogers en retard de 2 jours');
    expect(alertCopy(alert({ kind: 'invoice_overdue', params: { client: 'Acme', days: 5 }, action: REMIND }), zh, cad).title).toBe('Acme 已逾期 5 天');
    expect(alertCopy(alert({ kind: 'bill_due', params: { vendor: 'Rogers', days: 4 } }), zh, cad).title).toBe('Rogers 账单将在 4 天后到期');
    expect(alertCopy(alert({ kind: 'bill_due', params: { vendor: 'Rogers', days: 0 } }), zh, cad).title).toBe('Rogers 账单今天到期');
    expect(alertCopy(alert({ kind: 'bill_due', params: { vendor: 'Rogers', days: -2 } }), zh, cad).title).toBe('Rogers 账单已逾期 2 天');
  });

  it('a zero amount is a real amount (shown), only garbage is omitted', () => {
    expect(alertCopy(alert({ kind: 'bill_due', params: { vendor: 'Rogers', days: 3, amountCents: 0 } }), en, cad).title).toBe('Rogers bill of CA$0 due in 3 days');
    expect(alertCopy(alert({ kind: 'bill_due', params: { vendor: 'Rogers', days: 3, amountCents: '9000' } }), en, cad).title).toBe('Rogers bill of CA$90 due in 3 days');
  });

  it('singular day, and a missing client name reads as "A client"', () => {
    expect(alertCopy(alert({ kind: 'invoice_overdue', params: { days: 1, amountCents: 5_000 }, action: REMIND }), en, cad).title).toBe(
      'A client · CA$50 is 1 day overdue',
    );
  });

  it('tax deadline: says ESTIMATED — with amount, without amount, and today (quarter/year params are ignored)', () => {
    expect(alertCopy(alert({ kind: 'tax_deadline', params: { days: 9, quarter: 2, year: 2026, amountCents: 300_000 } }), en, cad).title).toBe('Estimated tax payment of CA$3,000 due in 9 days');
    expect(alertCopy(alert({ kind: 'tax_deadline', params: { days: 1, amountCents: 300_000 } }), en, cad).title).toBe('Estimated tax payment of CA$3,000 due in 1 day');
    expect(alertCopy(alert({ kind: 'tax_deadline', params: { days: 9, quarter: 2, year: 2026 } }), en, cad).title).toBe('Estimated tax payment due in 9 days');
    expect(alertCopy(alert({ kind: 'tax_deadline', params: { days: 0, amountCents: 300_000 } }), en, cad).title).toBe('Estimated tax payment due today');
  });

  it('tax deadline in French and Chinese says estimated too, with plural forms', () => {
    expect(alertCopy(alert({ kind: 'tax_deadline', params: { days: 9, amountCents: 300_000 } }), fr, cad).title).toBe('Versement d’impôt estimé de CA$3,000 à échéance dans 9 jours');
    expect(alertCopy(alert({ kind: 'tax_deadline', params: { days: 1 } }), fr, cad).title).toBe('Versement d’impôt estimé à échéance dans 1 jour');
    expect(alertCopy(alert({ kind: 'tax_deadline', params: { days: 0 } }), fr, cad).title).toBe('Versement d’impôt estimé à échéance aujourd’hui');
    expect(alertCopy(alert({ kind: 'tax_deadline', params: { days: 9, amountCents: 300_000 } }), zh, cad).title).toBe('预估税款 CA$3,000 将在 9 天后到期');
    expect(alertCopy(alert({ kind: 'tax_deadline', params: { days: 9 } }), zh, cad).title).toBe('预估税款将在 9 天后到期');
    expect(alertCopy(alert({ kind: 'tax_deadline', params: { days: 0 } }), zh, cad).title).toBe('预估税款今天到期');
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
