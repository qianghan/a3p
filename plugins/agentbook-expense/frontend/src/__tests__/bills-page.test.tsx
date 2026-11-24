import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { withShell } from './i18n-harness';
import { BillsPage, filterBills } from '../pages/Bills';
import { createTranslator } from '@agentbook/i18n';
import { CATALOG } from '@agentbook/i18n/catalog';

/**
 * PR 3d.1 — the web Bills page: Open/Overdue/Paid filters, aging buckets from
 * reports/ap-aging, add / edit (PATCH amend for at_entry, PUT for legacy) /
 * pay / partial / void, and payment void. Each test reads the request the
 * page sent (URL, method, body) or a figure rendered from the route.
 */
const OPEN = { id: 'b1', vendorName: 'Hydro One', description: null, amountCents: 8450, paidCents: 0, dueDate: '2026-12-15', billDate: '2026-11-20', status: 'open', effectiveStatus: 'open', postingMode: 'at_entry' };
const PARTIAL = { id: 'b2', vendorName: 'Staples', description: null, amountCents: 23000, paidCents: 3000, dueDate: '2026-10-01', status: 'partial', effectiveStatus: 'overdue', postingMode: 'at_entry' };
const PAID = { id: 'b3', vendorName: 'Telus', description: null, amountCents: 9500, paidCents: 9500, dueDate: '2026-10-01', status: 'paid', effectiveStatus: 'paid', postingMode: 'at_entry' };
const LEGACY = { id: 'b4', vendorName: 'Rent Co', description: null, amountCents: 150000, paidCents: 0, dueDate: '2026-12-01', status: 'open', effectiveStatus: 'open', postingMode: 'at_payment' };
const BUCKETS = { current: { totalCents: 158450, count: 2 }, d1_30: { totalCents: 0, count: 0 }, d31_60: { totalCents: 20000, count: 1 }, d60_plus: { totalCents: 0, count: 0 } };

type Call = { url: string; method: string; headers: Record<string, string>; body: any };
let calls: Call[];
let reply: (c: Call) => { status: number; body: unknown } | undefined;

beforeEach(() => {
  calls = [];
  reply = () => undefined;
  vi.stubGlobal('confirm', vi.fn(() => true));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const c: Call = { url, method: init.method || 'GET', headers: (init.headers as Record<string, string>) || {}, body: init.body ? JSON.parse(init.body as string) : undefined };
    calls.push(c);
    const custom = reply(c);
    const out = custom ?? (
      url.includes('/reports/ap-aging') ? { status: 200, body: { success: true, data: { buckets: BUCKETS } } }
        : url.includes('/tenant-config') ? { status: 200, body: { success: true, data: { currency: 'USD' } } }
          : url.endsWith('/bills/b1') && c.method === 'GET' ? { status: 200, body: { success: true, data: { ...OPEN, payments: [{ id: 'p1', amountCents: 2000, date: '2026-11-21', voidedAt: null }] } } }
            : c.method === 'GET' ? { status: 200, body: { success: true, data: [OPEN, PARTIAL, PAID, LEGACY], summary: { openCents: 8450 + 20000 + 150000, overdueCents: 20000, count: 4 } } }
              : { status: 200, body: { success: true, data: {} } });
    return { ok: out.status < 400, status: out.status, json: async () => out.body } as Response;
  }));
});
afterEach(() => vi.unstubAllGlobals());

const T = (locale = 'en') => createTranslator(locale, CATALOG).t;
async function mount(locale = 'en') {
  render(withShell(<BillsPage />, locale));
  await screen.findByTestId('bill-row-b1');
  return T(locale);
}
const writes = () => calls.filter((c) => c.method !== 'GET');
const row = (id: string) => within(screen.getByTestId(`bill-row-${id}`));

describe('filters (pure)', () => {
  it('Open = open + partial (overdue included); Overdue = past due unpaid; Paid = paid', () => {
    const all = [OPEN, PARTIAL, PAID, LEGACY] as never[];
    expect(filterBills(all, 'open').map((b: any) => b.id)).toEqual(['b1', 'b2', 'b4']);
    expect(filterBills(all, 'overdue').map((b: any) => b.id)).toEqual(['b2']);
    expect(filterBills(all, 'paid').map((b: any) => b.id)).toEqual(['b3']);
  });
});

describe('Bills page', () => {
  it('shows aging buckets from ap-aging and what is still owing per bill', async () => {
    const t = await mount();
    const aging = within(screen.getByTestId('bills-aging'));
    expect(aging.getByText(t('expenses_ui.aging_31_60')).nextElementSibling?.textContent).toBe('$200.00');
    expect(aging.getByText(t('expenses_ui.aging_current')).nextElementSibling?.textContent).toBe('$1,584.50');
    expect(screen.getByTestId('bill-owing-b2').textContent).toBe('$200.00');
    expect(screen.getByTestId('bill-owing-b3').textContent).toBe('—');
  });

  it('filter tabs switch the rows (Overdue shows only the overdue partial bill)', async () => {
    const t = await mount();
    fireEvent.click(screen.getByRole('tab', { name: t('expenses_ui.overdue') }));
    expect(screen.queryByTestId('bill-row-b1')).toBeNull();
    expect(screen.getByTestId('bill-row-b2')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: t('expenses_ui.bill_paid') }));
    expect([!!screen.queryByTestId('bill-row-b3'), !!screen.queryByTestId('bill-row-b2')]).toEqual([true, false]);
  });

  it('add: POST /bills with the parsed cents, both dates and one idempotency key in header + body', async () => {
    const t = await mount();
    fireEvent.click(screen.getByRole('button', { name: t('expenses_ui.add_bill') }));
    const form = within(screen.getByRole('form', { name: t('expenses_ui.add_bill') }));
    fireEvent.change(form.getByLabelText(t('expenses_ui.col_vendor')), { target: { value: 'Bell' } });
    fireEvent.change(form.getByLabelText(t('expenses_ui.col_amount')), { target: { value: '120.40' } });
    fireEvent.change(form.getByLabelText(t('expenses_ui.bill_date')), { target: { value: '2026-11-20' } });
    fireEvent.change(form.getByLabelText(t('expenses_ui.bill_due_date')), { target: { value: '2026-12-20' } });
    fireEvent.click(form.getByRole('button', { name: t('expenses_ui.save_bill') }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    const w = writes()[0];
    expect([w.url, w.method]).toEqual(['/api/v1/agentbook-expense/bills', 'POST']);
    expect(w.body).toMatchObject({ vendorName: 'Bell', amountCents: 12040, billDate: '2026-11-20', dueDate: '2026-12-20' });
    expect(w.body.idempotencyKey).toBe(w.headers['Idempotency-Key']);
  });

  it('pay in full: POST ?action=pay with no amount; partial sends amountCents; over-owing is refused locally', async () => {
    const t = await mount();
    fireEvent.click(row('b1').getByRole('button', { name: t('expenses_ui.pay') }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect([writes()[0].url, writes()[0].body.amountCents]).toEqual(['/api/v1/agentbook-expense/bills/b1?action=pay', undefined]);

    fireEvent.click(row('b2').getByRole('button', { name: t('expenses_ui.bill_pay_partial') }));
    const amt = screen.getByLabelText(t('expenses_ui.bill_partial_amount', { amount: '$200.00' }));
    fireEvent.change(amt, { target: { value: '250' } });
    fireEvent.click(screen.getByRole('button', { name: t('expenses_ui.bill_record_payment') }));
    expect(await screen.findByText(t('expenses_ui.bill_overpayment'))).toBeTruthy();
    expect(writes()).toHaveLength(1);
    fireEvent.change(amt, { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: t('expenses_ui.bill_record_payment') }));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect([writes()[1].url, writes()[1].body.amountCents]).toEqual(['/api/v1/agentbook-expense/bills/b2?action=pay', 5000]);
  });

  it('a legacy at_payment bill offers Pay but not Pay part (payBill refuses partials there)', async () => {
    const t = await mount();
    expect(row('b4').getByRole('button', { name: t('expenses_ui.pay') })).toBeTruthy();
    expect(row('b4').queryByRole('button', { name: t('expenses_ui.bill_pay_partial') })).toBeNull();
    expect(row('b1').getByRole('button', { name: t('expenses_ui.bill_pay_partial') })).toBeTruthy();
  });

  it('void: DELETE the bill; a 409 bill_has_payments says to void payments first', async () => {
    const t = await mount();
    reply = (c) => (c.method === 'DELETE' ? { status: 409, body: { success: false, code: 'bill_has_payments' } } : undefined);
    fireEvent.click(row('b2').getByRole('button', { name: t('expenses_ui.bill_void') }));
    expect(await screen.findByText(t('expenses_ui.bill_void_has_payments'))).toBeTruthy();
    expect([writes()[0].url, writes()[0].method]).toEqual(['/api/v1/agentbook-expense/bills/b2', 'DELETE']);
  });

  it('edit: a posted bill is amended (PATCH); a legacy at_payment bill is PUT', async () => {
    const t = await mount();
    fireEvent.click(row('b1').getByRole('button', { name: t('common.edit') }));
    let form = within(screen.getByRole('form', { name: t('expenses_ui.edit_bill') }));
    fireEvent.change(form.getByLabelText(t('expenses_ui.col_amount')), { target: { value: '90' } });
    fireEvent.click(form.getByRole('button', { name: t('common.save') }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect([writes()[0].url, writes()[0].method, writes()[0].body.amountCents]).toEqual(['/api/v1/agentbook-expense/bills/b1', 'PATCH', 9000]);

    fireEvent.click(row('b4').getByRole('button', { name: t('common.edit') }));
    form = within(screen.getByRole('form', { name: t('expenses_ui.edit_bill') }));
    fireEvent.click(form.getByRole('button', { name: t('common.save') }));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect([writes()[1].method, writes()[1].body.amountCents]).toEqual(['PUT', 150000]);
  });

  it('payment void: expand a bill, void its payment → DELETE /bills/:id/payments/:pid', async () => {
    const t = await mount();
    fireEvent.click(screen.getByRole('button', { name: t('expenses_ui.bill_show_payments', { vendor: 'Hydro One' }) }));
    const p = await screen.findByTestId('payment-p1');
    fireEvent.click(within(p).getByRole('button', { name: t('expenses_ui.bill_void_payment') }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect([writes()[0].url, writes()[0].method]).toEqual(['/api/v1/agentbook-expense/bills/b1/payments/p1', 'DELETE']);
  });

  it('renders in fr-CA through the catalog', async () => {
    const fr = await mount('fr-CA');
    expect(screen.getByRole('tab', { name: fr('expenses_ui.bill_filter_all') }).textContent).toBe('Toutes');
    expect(row('b1').getByText('Ouverte')).toBeTruthy();
    expect(row('b1').getByRole('button', { name: 'Payer en partie' })).toBeTruthy();
    expect(screen.getByText('Ancienneté')).toBeTruthy();
  });
});
