// @vitest-environment node
/**
 * PR 3bc.9 — route-level wiring for every bills route, against the stateful
 * fake ledger: each assertion reads the journal lines the route caused.
 * create at_entry / at_payment, pay, partial pay, void, void payment, amend,
 * delete; soft-deleted bills are 404 on GET/PUT/PATCH.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/agentbook-tenant', () => ({ safeResolveAgentbookTenant: async () => ({ tenantId: 't1' }) }));
vi.mock('@/lib/agentbook-chart-of-accounts', () => ({
  ensureChartOfAccounts: async () => ({ seeded: false, count: 0 }),
  ensureUncategorizedAccount: async () => ({ id: 'acct-suspense' }),
  CASH_CODE: '1000',
  UNCATEGORIZED_CODE: '6999',
}));
vi.mock('@/lib/agentbook-suggest-category', () => ({ suggestCategory: async () => null }));
let flagOn = true;
vi.mock('@/lib/purchases-flag', () => ({
  purchasesAtEntryApplies: async (_t: string, cfg: { accountingBasis?: string } | null) => flagOn && !!cfg && cfg.accountingBasis !== 'cash',
}));

import { createFakeLedgerDb } from '@/lib/__tests__/fake-ledger-db';
let f: ReturnType<typeof createFakeLedgerDb>;
vi.mock('@naap/database', () => ({
  get prisma() { return f.db; },
}));

import { POST as createBill } from '../route';
import { GET as getBill, PUT as putBill, PATCH as patchBill, DELETE as deleteBill, POST as payRoute } from '../[id]/route';
import { DELETE as voidPaymentRoute } from '../[id]/payments/[paymentId]/route';

const AU = { id: 'cfg', userId: 't1', jurisdiction: 'au', region: 'NSW', gstRegistered: true, currency: 'AUD', accountingBasis: 'accrual' };

function req(url: string, body?: unknown) {
  return { url, nextUrl: new URL(url), headers: new Headers(), json: async () => body ?? {} } as never;
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const pctx = (id: string, paymentId: string) => ({ params: Promise.resolve({ id, paymentId }) });
const B = 'http://x/api/v1/agentbook-expense/bills';

/** Net (debit − credit) per account across every entry with this sourceType. */
function netBySource(sourceType: string): Record<string, number> {
  const ids = new Set(f.state.entries.filter((e) => e.sourceType === sourceType).map((e) => e.id));
  const out: Record<string, number> = {};
  for (const l of f.state.lines.filter((x) => ids.has(x.entryId))) out[l.accountId] = (out[l.accountId] ?? 0) + l.debitCents - l.creditCents;
  return out;
}
const net = () => f.netByAccount();
const ap = () => -(net()['acct-ap'] ?? 0) || 0;

async function newAtEntry(amountCents = 11000) {
  const res = await createBill(req(B, { vendorName: 'Officeworks', amountCents, dueDate: '2026-12-02', billDate: '2026-11-02', categoryCode: '5200', taxCode: 'GST' }));
  expect(res.status).toBe(201);
  return (await res.json()).data;
}
const pay = (id: string, body: Record<string, unknown> = {}) => payRoute(req(`${B}/${id}?action=pay`, { paidDate: '2026-11-10', ...body }), ctx(id));

beforeEach(() => {
  f = createFakeLedgerDb();
  f.state.tenantConfigs.push({ ...AU });
  flagOn = true;
});

describe('POST /bills', () => {
  it('flag on + accrual: at_entry posts DR 5200 net | DR 2100 recoverable | CR 2000 gross', async () => {
    const bill = await newAtEntry();
    expect(bill.postingMode).toBe('at_entry');
    expect(netBySource('bill')).toEqual({ 'acct-meals': 10000, 'acct-gst': 1000, 'acct-ap': -11000 });
    expect(f.state.expenses).toHaveLength(0);
  });
  it('flag on + cash basis: stays at_payment, no ledger impact', async () => {
    f.state.tenantConfigs[0].accountingBasis = 'cash';
    const res = await createBill(req(B, { vendorName: 'Acme', amountCents: 5000, dueDate: '2026-12-02', categoryCode: '5200' }));
    const bill = (await res.json()).data;
    expect([res.status, bill.postingMode, f.state.entries.length]).toEqual([201, 'at_payment', 0]);
  });
  it('flag off: at_payment, and paying it books DR expense / CR 1000 keyed bill/payment.id', async () => {
    flagOn = false;
    const bill = (await (await createBill(req(B, { vendorName: 'Acme', amountCents: 5000, dueDate: '2026-12-02', categoryCode: '5200' }))).json()).data;
    expect([bill.postingMode, f.state.entries.length]).toEqual(['at_payment', 0]);
    const res = await pay(bill.id);
    const body = await res.json();
    expect([res.status, body.data.status]).toEqual([200, 'paid']);
    expect(netBySource('bill')).toEqual({ 'acct-meals': 5000, 'acct-cash': -5000 });
    expect(f.state.entries[0].sourceId).toBe(body.payment.id);
  });
});

describe('pay / partial pay (at_entry)', () => {
  it('full pay: DR 2000 / CR 1000, AP to 0, no expense row', async () => {
    const bill = await newAtEntry();
    const res = await pay(bill.id);
    expect((await res.json()).data.status).toBe('paid');
    expect(netBySource('bill_payment')).toEqual({ 'acct-ap': 11000, 'acct-cash': -11000 });
    expect([ap(), f.state.expenses.length]).toEqual([0, 0]);
    expect(net()['acct-meals']).toBe(10000); // expense counted once
  });
  it('partial pay: status partial, AP down by the part; overpay 422', async () => {
    const bill = await newAtEntry();
    const res = await pay(bill.id, { amountCents: 5500 });
    expect((await res.json()).data).toMatchObject({ status: 'partial', paidCents: 5500 });
    expect([ap(), net()['acct-cash']]).toEqual([5500, -5500]);
    const over = await pay(bill.id, { amountCents: 6000 });
    expect([over.status, (await over.json()).code]).toEqual([422, 'overpayment']);
  });
});

describe('void payment', () => {
  it('DELETE /bills/:id/payments/:pid mirrors the payment entry; AP back to the total', async () => {
    const bill = await newAtEntry();
    const paid = await (await pay(bill.id, { amountCents: 5500 })).json();
    const res = await voidPaymentRoute(req(`${B}/${bill.id}/payments/${paid.payment.id}`), pctx(bill.id, paid.payment.id));
    expect((await res.json()).data).toMatchObject({ status: 'open', paidCents: 0 });
    expect(netBySource('bill_payment_void')).toEqual({ 'acct-ap': -5500, 'acct-cash': 5500 });
    expect([ap(), net()['acct-cash'] ?? 0]).toEqual([11000, 0]);
  });
  it('a payment of another bill → 404', async () => {
    const a = await newAtEntry();
    const b = await newAtEntry(2200);
    const paid = await (await pay(a.id)).json();
    const res = await voidPaymentRoute(req(`${B}/${b.id}/payments/${paid.payment.id}`), pctx(b.id, paid.payment.id));
    expect(res.status).toBe(404);
    expect(f.state.entries.filter((e) => e.sourceType === 'bill_payment_void')).toHaveLength(0);
  });
});

describe('void (DELETE) and amend (PATCH)', () => {
  it('DELETE an open at_entry bill reverses its entry: every account back to 0', async () => {
    const bill = await newAtEntry();
    const res = await deleteBill(req(`${B}/${bill.id}`), ctx(bill.id));
    expect((await res.json()).data.status).toBe('cancelled');
    expect(netBySource('bill_void')).toEqual({ 'acct-meals': -10000, 'acct-gst': -1000, 'acct-ap': 11000 });
    expect([ap(), net()['acct-meals'] ?? 0, net()['acct-gst'] ?? 0]).toEqual([0, 0, 0]);
  });
  it('DELETE a paid bill → 409 bill_has_payments, nothing posted', async () => {
    const bill = await newAtEntry();
    await pay(bill.id);
    const before = f.state.entries.length;
    const res = await deleteBill(req(`${B}/${bill.id}`), ctx(bill.id));
    expect([res.status, (await res.json()).code, f.state.entries.length]).toEqual([409, 'bill_has_payments', before]);
  });
  it('PATCH amends: reversal + new entry; AP = the new total', async () => {
    const bill = await newAtEntry();
    const res = await patchBill(req(`${B}/${bill.id}`, { amountCents: 22000 }), ctx(bill.id));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ amountCents: 22000, revision: 1 });
    expect(netBySource('bill_amend_reversal')).toEqual({ 'acct-meals': -10000, 'acct-gst': -1000, 'acct-ap': 11000 });
    expect(netBySource('bill_amend')).toEqual({ 'acct-meals': 20000, 'acct-gst': 2000, 'acct-ap': -22000 });
    expect(ap()).toBe(22000);
  });
});

describe('soft-deleted bills are gone (deletedAt)', () => {
  it('GET / PUT / PATCH → 404 and nothing changes', async () => {
    flagOn = false;
    const legacy = (await (await createBill(req(B, { vendorName: 'Acme', amountCents: 5000, dueDate: '2026-12-02' }))).json()).data;
    const posted = await newAtEntry();
    for (const b of f.state.bills) b.deletedAt = new Date('2026-11-05');
    expect((await getBill(req(`${B}/${legacy.id}`), ctx(legacy.id))).status).toBe(404);
    expect((await putBill(req(`${B}/${legacy.id}`, { amountCents: 1 }), ctx(legacy.id))).status).toBe(404);
    expect((await patchBill(req(`${B}/${posted.id}`, { amountCents: 1 }), ctx(posted.id))).status).toBe(404);
    expect(f.state.bills.find((b) => b.id === legacy.id)!.amountCents).toBe(5000);
  });
  it('GET returns a live bill with its payments', async () => {
    const bill = await newAtEntry();
    await pay(bill.id, { amountCents: 1000 });
    const body = await (await getBill(req(`${B}/${bill.id}`), ctx(bill.id))).json();
    expect([body.data.id, body.data.payments.map((p: { amountCents: number }) => p.amountCents)]).toEqual([bill.id, [1000]]);
  });
});
