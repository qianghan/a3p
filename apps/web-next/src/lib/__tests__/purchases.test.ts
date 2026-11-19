// @vitest-environment node
/**
 * PR 3bc.1 — the purchases engine against the stateful fake ledger.
 *
 * Every assertion reads computed cents per account / the exact
 * (sourceType, sourceId) the spec §5.2 table prescribes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));
const ensureChartOfAccounts = vi.fn(async () => ({ seeded: false, count: 0 }));
vi.mock('@/lib/agentbook-chart-of-accounts', () => ({
  ensureChartOfAccounts: (...a: unknown[]) => ensureChartOfAccounts(...(a as [])),
  ensureUncategorizedAccount: vi.fn(async () => ({ id: 'acct-suspense' })),
  CASH_CODE: '1000',
  UNCATEGORIZED_CODE: '6999',
}));
const suggestCategory = vi.fn(async (..._a: unknown[]) => null as null | { categoryId: string });
vi.mock('@/lib/agentbook-suggest-category', () => ({ suggestCategory: (...a: unknown[]) => suggestCategory(...a) }));

import { createFakeLedgerDb } from './fake-ledger-db';
import { postBill, payBill, voidBill, voidPayment, amendBill, PurchaseError } from '../purchases';

type Fake = ReturnType<typeof createFakeLedgerDb>;
let f: Fake;
const AU = { id: 'cfg', userId: 't1', jurisdiction: 'au', region: 'NSW', gstRegistered: true, currency: 'AUD', accountingBasis: 'accrual' };
const D = (s: string) => new Date(`${s}T00:00:00.000Z`);

function entry(sourceType: string, sourceId: string) {
  return f.state.entries.find((e) => e.sourceType === sourceType && e.sourceId === sourceId);
}
function linesOf(entryId: string): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  for (const l of f.state.lines.filter((x) => x.entryId === entryId)) {
    const [d, c] = out[l.accountId] ?? [0, 0];
    out[l.accountId] = [d + l.debitCents, c + l.creditCents];
  }
  return out;
}
const apBalance = () => -(f.netByAccount()['acct-ap'] ?? 0) || 0; // credit balance
const totals = (): [number, number] => f.state.lines.reduce<[number, number]>((s, l) => [s[0] + l.debitCents, s[1] + l.creditCents], [0, 0]);

const billInput = (over: Record<string, unknown> = {}) => ({
  vendorName: 'Officeworks',
  billDate: D('2026-11-02'),
  dueDate: D('2026-12-02'),
  lines: [{ description: 'Paper', amountCents: 11000, categoryId: 'acct-meals', taxCode: 'GST' }],
  postingMode: 'at_entry' as const,
  ...over,
});

beforeEach(() => {
  f = createFakeLedgerDb();
  f.state.tenantConfigs.push({ ...AU });
  ensureChartOfAccounts.mockClear();
  suggestCategory.mockReset();
  suggestCategory.mockResolvedValue(null);
});

describe('postBill (at_entry)', () => {
  it('posts DR expense net | DR 2100 recoverable | CR 2000 gross, keyed bill/bill.id, dated billDate', async () => {
    const { bill } = await postBill(f.db as never, 't1', billInput());
    const e = entry('bill', bill.id)!;
    expect(e).toBeTruthy();
    expect(e.date.getTime()).toBe(D('2026-11-02').getTime());
    expect(linesOf(e.id)).toEqual({ 'acct-meals': [10000, 0], 'acct-gst': [1000, 0], 'acct-ap': [0, 11000] });
    expect(bill).toMatchObject({ amountCents: 11000, taxCents: 1000, recoverableTaxCents: 1000, subtotalCents: 10000, status: 'open', postingMode: 'at_entry', paidCents: 0, journalEntryId: e.id, currency: 'AUD' });
    expect(f.state.billLines.filter((l) => l.billId === bill.id)).toHaveLength(1);
    expect(apBalance()).toBe(11000);
  });

  it('replays the same idempotencyKey: same bill, one journal entry', async () => {
    const a = await postBill(f.db as never, 't1', billInput({ idempotencyKey: 'k1' }));
    const b = await postBill(f.db as never, 't1', billInput({ idempotencyKey: 'k1' }));
    expect(b.bill.id).toBe(a.bill.id);
    expect(b.replayed).toBe(true);
    expect(f.state.bills).toHaveLength(1);
    expect(f.state.entries).toHaveLength(1);
  });

  it('two CONCURRENT same-key posts yield one bill and one entry', async () => {
    const [a, b] = await Promise.all([
      postBill(f.db as never, 't1', billInput({ idempotencyKey: 'k2' })),
      postBill(f.db as never, 't1', billInput({ idempotencyKey: 'k2' })),
    ]);
    expect(a.bill.id).toBe(b.bill.id);
    expect(f.state.bills).toHaveLength(1);
    expect(f.state.entries).toHaveLength(1);
  });

  it('refuses a bill dated in a closed period (nothing written)', async () => {
    f.state.periods.push({ tenantId: 't1', year: 2026, month: 11, status: 'closed' });
    await expect(postBill(f.db as never, 't1', billInput())).rejects.toMatchObject({ status: 422, code: 'period_closed' });
    expect(f.state.bills).toHaveLength(0);
    expect(f.state.entries).toHaveLength(0);
  });

  it('rejects a non-tenant currency with 422 bill_currency_unsupported', async () => {
    await expect(postBill(f.db as never, 't1', billInput({ currency: 'USD' }))).rejects.toMatchObject({ status: 422, code: 'bill_currency_unsupported' });
    expect(f.state.bills).toHaveLength(0);
  });

  it('uses the category suggestion when a line has no category, else 6999 suspense', async () => {
    suggestCategory.mockResolvedValueOnce({ categoryId: 'acct-travel' });
    const { bill } = await postBill(f.db as never, 't1', billInput({ lines: [{ description: 'Taxi', amountCents: 2200, taxCode: 'GST' }] }));
    expect(linesOf(entry('bill', bill.id)!.id)).toEqual({ 'acct-travel': [2000, 0], 'acct-gst': [200, 0], 'acct-ap': [0, 2200] });
    expect(suggestCategory).toHaveBeenCalledWith('t1', expect.objectContaining({ vendor: 'Officeworks', description: 'Taxi', amountCents: 2200 }));
    const { bill: b2 } = await postBill(f.db as never, 't1', billInput({ lines: [{ description: 'Mystery', amountCents: 500, taxCode: null }] }));
    expect(linesOf(entry('bill', b2.id)!.id)).toEqual({ 'acct-suspense': [500, 0], 'acct-ap': [0, 500] });
  });
});

describe('payBill / partial payments', () => {
  it('full payment posts DR 2000 / CR 1000 keyed bill_payment/payment.id; AP back to 0; no expense row', async () => {
    const { bill } = await postBill(f.db as never, 't1', billInput());
    const { bill: paid, payment } = await payBill(f.db as never, 't1', bill.id, { date: D('2026-11-20') });
    const e = entry('bill_payment', payment.id)!;
    expect(linesOf(e.id)).toEqual({ 'acct-ap': [11000, 0], 'acct-cash': [0, 11000] });
    expect(e.date.getTime()).toBe(D('2026-11-20').getTime());
    expect(paid).toMatchObject({ status: 'paid', paidCents: 11000 });
    expect(payment.journalEntryId).toBe(e.id);
    expect(apBalance()).toBe(0);
    expect(f.state.expenses).toHaveLength(0);
    expect(f.netByAccount()['acct-meals']).toBe(10000); // expense counted once
  });

  it('partial then remainder: partial → paid; paidCents tracks', async () => {
    const { bill } = await postBill(f.db as never, 't1', billInput());
    const r1 = await payBill(f.db as never, 't1', bill.id, { amountCents: 4000, date: D('2026-11-10') });
    expect(r1.bill).toMatchObject({ status: 'partial', paidCents: 4000 });
    expect(apBalance()).toBe(7000);
    const r2 = await payBill(f.db as never, 't1', bill.id, { date: D('2026-11-11') });
    expect(r2.payment.amountCents).toBe(7000);
    expect(r2.bill).toMatchObject({ status: 'paid', paidCents: 11000 });
  });

  it('overpayment → 422, nothing written', async () => {
    const { bill } = await postBill(f.db as never, 't1', billInput());
    await expect(payBill(f.db as never, 't1', bill.id, { amountCents: 11001 })).rejects.toMatchObject({ status: 422, code: 'overpayment' });
    expect(f.state.billPayments).toHaveLength(0);
    expect(f.state.entries).toHaveLength(1);
  });

  it('concurrent payments never overpay (optimistic paidCents guard)', async () => {
    const { bill } = await postBill(f.db as never, 't1', billInput());
    const results = await Promise.allSettled([
      payBill(f.db as never, 't1', bill.id, { amountCents: 8000 }),
      payBill(f.db as never, 't1', bill.id, { amountCents: 8000 }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rej = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rej.reason).toBeInstanceOf(PurchaseError);
    expect(rej.reason.code).toBe('overpayment');
    expect(f.state.bills[0].paidCents).toBe(8000);
    expect(f.state.billPayments).toHaveLength(1);
    expect(apBalance()).toBe(3000);
  });

  it('concurrent payments that fit both land (retry, not fail)', async () => {
    const { bill } = await postBill(f.db as never, 't1', billInput());
    await Promise.all([
      payBill(f.db as never, 't1', bill.id, { amountCents: 5000 }),
      payBill(f.db as never, 't1', bill.id, { amountCents: 6000 }),
    ]);
    expect(f.state.bills[0]).toMatchObject({ paidCents: 11000, status: 'paid' });
    expect(apBalance()).toBe(0);
  });

  it('payment idempotencyKey replays the same payment', async () => {
    const { bill } = await postBill(f.db as never, 't1', billInput());
    const a = await payBill(f.db as never, 't1', bill.id, { amountCents: 1000, idempotencyKey: 'p1' });
    const b = await payBill(f.db as never, 't1', bill.id, { amountCents: 1000, idempotencyKey: 'p1' });
    expect(b.payment.id).toBe(a.payment.id);
    expect(b.replayed).toBe(true);
    expect(f.state.billPayments).toHaveLength(1);
    expect(f.state.bills[0].paidCents).toBe(1000);
  });

  it('payment in a closed period is refused', async () => {
    const { bill } = await postBill(f.db as never, 't1', billInput());
    f.state.periods.push({ tenantId: 't1', year: 2026, month: 12, status: 'closed' });
    await expect(payBill(f.db as never, 't1', bill.id, { date: D('2026-12-05') })).rejects.toMatchObject({ status: 422, code: 'period_closed' });
    expect(f.state.bills[0].paidCents).toBe(0);
  });

  it('cross-tenant bill id → 404', async () => {
    const { bill } = await postBill(f.db as never, 't1', billInput());
    await expect(payBill(f.db as never, 't2', bill.id, {})).rejects.toMatchObject({ status: 404 });
  });
});

describe('voids', () => {
  it('voidBill on an unpaid bill mirrors the entry keyed bill_void/bill.id', async () => {
    const { bill } = await postBill(f.db as never, 't1', billInput());
    const { bill: v } = await voidBill(f.db as never, 't1', bill.id, { date: D('2026-11-05') });
    expect(v.status).toBe('cancelled');
    expect(linesOf(entry('bill_void', bill.id)!.id)).toEqual({ 'acct-meals': [0, 10000], 'acct-gst': [0, 1000], 'acct-ap': [11000, 0] });
    expect(f.netByAccount()).toEqual({});
  });

  it('voidBill with payments is refused until payments are voided', async () => {
    const { bill } = await postBill(f.db as never, 't1', billInput());
    const { payment } = await payBill(f.db as never, 't1', bill.id, { amountCents: 3000 });
    await expect(voidBill(f.db as never, 't1', bill.id, {})).rejects.toMatchObject({ status: 409, code: 'bill_has_payments' });
    const vp = await voidPayment(f.db as never, 't1', payment.id, { date: D('2026-11-06') });
    expect(vp.bill).toMatchObject({ status: 'open', paidCents: 0 });
    expect(vp.payment.voidedAt).toBeInstanceOf(Date);
    expect(linesOf(entry('bill_payment_void', payment.id)!.id)).toEqual({ 'acct-ap': [0, 3000], 'acct-cash': [3000, 0] });
    await voidBill(f.db as never, 't1', bill.id, { date: D('2026-11-06') });
    expect(f.netByAccount()).toEqual({});
  });

  it('voidPayment twice is refused', async () => {
    const { bill } = await postBill(f.db as never, 't1', billInput());
    const { payment } = await payBill(f.db as never, 't1', bill.id, {});
    await voidPayment(f.db as never, 't1', payment.id, {});
    await expect(voidPayment(f.db as never, 't1', payment.id, {})).rejects.toMatchObject({ status: 409 });
  });
});

describe('amendBill', () => {
  it('reverses the current entry keyed by its id, posts bill_amend/<id>:<revision>', async () => {
    const { bill } = await postBill(f.db as never, 't1', billInput());
    const firstEntry = bill.journalEntryId as string;
    const { bill: a } = await amendBill(f.db as never, 't1', bill.id, { lines: [{ description: 'Paper', amountCents: 22000, categoryId: 'acct-meals', taxCode: 'GST' }] });
    expect(a).toMatchObject({ revision: 1, amountCents: 22000 });
    expect(linesOf(entry('bill_amend_reversal', firstEntry)!.id)).toEqual({ 'acct-meals': [0, 10000], 'acct-gst': [0, 1000], 'acct-ap': [11000, 0] });
    const ne = entry('bill_amend', `${bill.id}:1`)!;
    expect(linesOf(ne.id)).toEqual({ 'acct-meals': [20000, 0], 'acct-gst': [2000, 0], 'acct-ap': [0, 22000] });
    expect(a.journalEntryId).toBe(ne.id);
    expect(apBalance()).toBe(22000);
  });

  it('a revision race retries: both amends land, revision 2, ledger matches the final bill', async () => {
    const { bill } = await postBill(f.db as never, 't1', billInput());
    await Promise.all([
      amendBill(f.db as never, 't1', bill.id, { lines: [{ description: 'A', amountCents: 5500, categoryId: 'acct-meals', taxCode: 'GST' }] }),
      amendBill(f.db as never, 't1', bill.id, { lines: [{ description: 'B', amountCents: 3300, categoryId: 'acct-meals', taxCode: 'GST' }] }),
    ]);
    const final = f.state.bills[0];
    expect(final.revision).toBe(2);
    expect(apBalance()).toBe(final.amountCents);
    const [dr, cr] = totals();
    expect(dr).toBe(cr);
  });

  it('a paid/partial bill cannot be amended', async () => {
    const { bill } = await postBill(f.db as never, 't1', billInput());
    await payBill(f.db as never, 't1', bill.id, { amountCents: 100 });
    await expect(amendBill(f.db as never, 't1', bill.id, { lines: [{ description: 'x', amountCents: 100, categoryId: 'acct-meals' }] })).rejects.toMatchObject({ status: 409 });
  });
});

describe('legacy at_payment', () => {
  function seedLegacy(over: Record<string, unknown> = {}) {
    const b = { id: 'legacy-1', tenantId: 't1', vendorName: 'Telstra', description: 'Phone', amountCents: 8800, categoryCode: '5300', dueDate: D('2026-11-30'), status: 'open', paidDate: null, journalEntryId: null, paidCents: 0, postingMode: 'at_payment', revision: 0, deletedAt: null, createdAt: D('2026-10-01'), ...over };
    f.state.bills.push(b);
    return b;
  }

  it('pays DR expense / CR 1000 through the writer, sourceType bill + real payment id', async () => {
    seedLegacy();
    const { bill, payment } = await payBill(f.db as never, 't1', 'legacy-1', { date: D('2026-11-15') });
    const e = entry('bill', payment.id)!;
    expect(linesOf(e.id)).toEqual({ 'acct-travel': [8800, 0], 'acct-cash': [0, 8800] });
    expect(bill).toMatchObject({ status: 'paid', paidCents: 8800, journalEntryId: e.id });
    expect(bill.paidDate.getTime()).toBe(D('2026-11-15').getTime());
  });

  it('no category → 6999 suspense (never "first expense account")', async () => {
    seedLegacy({ categoryCode: null });
    const { payment } = await payBill(f.db as never, 't1', 'legacy-1', {});
    expect(linesOf(entry('bill', payment.id)!.id)).toEqual({ 'acct-suspense': [8800, 0], 'acct-cash': [0, 8800] });
  });

  it('missing account after ensureChartOfAccounts fails the request; bill stays open', async () => {
    seedLegacy({ categoryCode: '5999' });
    await expect(payBill(f.db as never, 't1', 'legacy-1', {})).rejects.toMatchObject({ status: 422, code: 'ledger_account_missing' });
    expect(ensureChartOfAccounts).toHaveBeenCalledWith('t1');
    expect(f.state.bills[0]).toMatchObject({ status: 'open', journalEntryId: null });
    expect(f.state.entries).toHaveLength(0);
  });

  it('legacy paid status is authoritative even with paidCents 0', async () => {
    seedLegacy({ status: 'paid', paidCents: 0 });
    await expect(payBill(f.db as never, 't1', 'legacy-1', {})).rejects.toMatchObject({ status: 409, code: 'bill_already_paid' });
    await expect(voidBill(f.db as never, 't1', 'legacy-1', {})).rejects.toMatchObject({ status: 409, code: 'bill_has_payments' });
  });

  it('partial payment of an at_payment bill is refused', async () => {
    seedLegacy();
    await expect(payBill(f.db as never, 't1', 'legacy-1', { amountCents: 100 })).rejects.toMatchObject({ status: 422, code: 'partial_not_supported' });
  });

  it('voiding an unpaid legacy bill posts nothing', async () => {
    seedLegacy();
    const { bill } = await voidBill(f.db as never, 't1', 'legacy-1', {});
    expect(bill.status).toBe('cancelled');
    expect(f.state.entries).toHaveLength(0);
  });

  it('closed period refuses the legacy payment', async () => {
    seedLegacy();
    f.state.periods.push({ tenantId: 't1', year: 2026, month: 11, status: 'closed' });
    await expect(payBill(f.db as never, 't1', 'legacy-1', { date: D('2026-11-15') })).rejects.toMatchObject({ status: 422, code: 'period_closed' });
    expect(f.state.bills[0].status).toBe('open');
  });
});
