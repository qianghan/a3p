// @vitest-environment node
/**
 * PR 3bc.6 — BAS includes BILLS, accrual (billDate) vs cash (AbBillPayment.date,
 * pro-rata, cumulative rounding). Golden literals are hand-computed below.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@naap/database', async () => ({ prisma: (await import('@/__tests__/helpers/mem-db')).memDb }));
vi.mock('@/lib/agentbook-tenant', async () => (await import('@/__tests__/helpers/route-request')).tenantModuleMock);

import { memDb } from '@/__tests__/helpers/mem-db';
import { tenantReq, json } from '@/__tests__/helpers/route-request';
import { GET as basGET } from '@/app/api/v1/agentbook-tax/au/bas-return/route';
import { GET as caGET } from '@/app/api/v1/agentbook-tax/ca/gst-hst-return/route';
import { proRataShare, billPurchasesInPeriod } from '@/lib/tax-return-bills';

const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const pay = (id: string, date: string, amountCents: number, voidedAt: Date | null = null) =>
  ({ id, tenantId: 't1', date: day(date), amountCents, voidedAt, createdAt: day(date) });
const bill = (o: Record<string, unknown>) => ({
  tenantId: 't1', deletedAt: null, paidCents: 0, postingMode: 'at_entry', taxCents: null,
  billDate: null, paidDate: null, journalEntryId: null, lines: [], payments: [], ...o,
});

/*
 * A: billDate 2026-08-15 (Q3), total 33000 = GST line 11000 (ITC 1000) + CAP line 22000 (ITC 2000).
 *    Payments: 5000 on 09-15 VOIDED (ignored), 10000 on 09-30 (Q3), 23000 on 10-01 (Q4).
 *    Q3 cash (cum 0→10000 of 33000):
 *      GST ITC round(1000·10000/33000)=round(303.03)=303   gross round(11000·10000/33000)=round(3333.33)=3333
 *      CAP ITC round(2000·10000/33000)=round(606.06)=606   gross round(22000·10000/33000)=round(6666.67)=6667
 *    Q4 cash (remainder): GST ITC 697, gross 7667; CAP ITC 1394, gross 15333.
 * B: billDate 2026-07-10, one GST line 1000 (ITC 91); paid 333 (07-20) + 333 (08-20), partial.
 *    Q3 cash: ITC round(91·666/1000)=round(60.606)=61; gross 666.  Accrual Q3: 91 / 1000.
 * C: legacy at_payment, paid, paidCents 0, no lines/payments, createdAt 2026-06-20, paidDate 2026-07-05,
 *    amount 5500, taxCents 500 → untyped. Accrual: Q2 (createdAt). Cash: Q3 (paidDate).
 * D: legacy paid, no paidDate, journalEntryId je-d dated 2026-08-01, createdAt 2026-05-01,
 *    amount 2200, taxCents 200. Accrual: Q2. Cash: Q3 (journal date).
 * E: cancelled, billDate Q3 → never counts. F: deleted, billDate Q3 → never counts.
 */
function seed(gstReportingBasis: 'accrual' | 'cash' | null, jurisdiction = 'au') {
  memDb.reset({
    abTenantConfig: [{ id: 'c', userId: 't1', jurisdiction, gstRegistered: true, gstReportingBasis }],
    abInvoice: [], abExpense: [], abPayRun: [], abAccount: [],
    abJournalEntry: [{ id: 'je-d', tenantId: 't1', date: day('2026-08-01') }],
    abBill: [
      bill({ id: 'A', status: 'paid', amountCents: 33000, paidCents: 33000, billDate: day('2026-08-15'), createdAt: day('2026-08-15'),
        lines: [
          { id: 'a1', taxCode: 'GST', amountCents: 11000, taxCents: 1000, recoverableTaxCents: 1000, categoryId: null },
          { id: 'a2', taxCode: 'CAP', amountCents: 22000, taxCents: 2000, recoverableTaxCents: 2000, categoryId: null },
        ],
        payments: [pay('pv', '2026-09-15', 5000, day('2026-09-16')), pay('p1', '2026-09-30', 10000), pay('p2', '2026-10-01', 23000)] }),
      bill({ id: 'B', status: 'partial', amountCents: 1000, paidCents: 666, billDate: day('2026-07-10'), createdAt: day('2026-07-10'),
        lines: [{ id: 'b1', taxCode: 'GST', amountCents: 1000, taxCents: 91, recoverableTaxCents: 91, categoryId: null }],
        payments: [pay('q1', '2026-07-20', 333), pay('q2', '2026-08-20', 333)] }),
      bill({ id: 'C', status: 'paid', postingMode: 'at_payment', amountCents: 5500, taxCents: 500, createdAt: day('2026-06-20'), paidDate: day('2026-07-05') }),
      bill({ id: 'D', status: 'paid', postingMode: 'at_payment', amountCents: 2200, taxCents: 200, createdAt: day('2026-05-01'), journalEntryId: 'je-d' }),
      bill({ id: 'E', status: 'cancelled', amountCents: 9900, billDate: day('2026-08-01'), createdAt: day('2026-08-01'),
        lines: [{ id: 'e1', taxCode: 'GST', amountCents: 9900, taxCents: 900, recoverableTaxCents: 900, categoryId: null }] }),
      bill({ id: 'F', status: 'open', amountCents: 7700, billDate: day('2026-08-01'), createdAt: day('2026-08-01'), deletedAt: day('2026-08-02'),
        lines: [{ id: 'f1', taxCode: 'GST', amountCents: 7700, taxCents: 700, recoverableTaxCents: 700, categoryId: null }] }),
    ],
  });
}

type Bas = { data: { label1BGstOnPurchasesCents: number; g10CapitalPurchasesCents: number; g11NonCapitalPurchasesCents: number } };
const bas = async (start: string, end: string) =>
  (await json<Bas>(await basGET(tenantReq(`/api/v1/agentbook-tax/au/bas-return?periodStart=${start}&periodEnd=${end}`, 't1')))).data;

describe('BAS bills — accrual basis (billDate)', () => {
  beforeEach(() => seed(null)); // null = accrual
  it('Q3: A in full + B in full; legacy C/D dated by createdAt (Q2); E/F excluded', async () => {
    const d = await bas('2026-07-01', '2026-09-30');
    expect(d.label1BGstOnPurchasesCents).toBe(3091); // 1000 + 2000 (A) + 91 (B)
    expect(d.g10CapitalPurchasesCents).toBe(22000); // A CAP line
    expect(d.g11NonCapitalPurchasesCents).toBe(12000); // 11000 (A GST) + 1000 (B)
  });
  it('Q4: nothing (A dated Q3 even though half paid in Q4)', async () => {
    const d = await bas('2026-10-01', '2026-12-31');
    expect([d.label1BGstOnPurchasesCents, d.g10CapitalPurchasesCents, d.g11NonCapitalPurchasesCents]).toEqual([0, 0, 0]);
  });
  it('Q2: legacy C + D untyped by createdAt', async () => {
    const d = await bas('2026-04-01', '2026-06-30');
    expect(d.label1BGstOnPurchasesCents).toBe(700); // 500 + 200
    expect(d.g11NonCapitalPurchasesCents).toBe(7700); // 5500 + 2200
  });
});

describe('BAS bills — cash basis (payment date, pro-rata)', () => {
  beforeEach(() => seed('cash'));
  it('Q3: A share of the 09-30 payment (voided 09-15 excluded) + B partials + legacy C (paidDate) + D (journal date)', async () => {
    const d = await bas('2026-07-01', '2026-09-30');
    expect(d.label1BGstOnPurchasesCents).toBe(1670); // 303 + 606 (A) + 61 (B) + 500 (C) + 200 (D)
    expect(d.g10CapitalPurchasesCents).toBe(6667); // A CAP share
    expect(d.g11NonCapitalPurchasesCents).toBe(11699); // 3333 (A) + 666 (B) + 5500 (C) + 2200 (D)
  });
  it('Q4: A remainder — Q3+Q4 sum to the exact bill totals', async () => {
    const d = await bas('2026-10-01', '2026-12-31');
    expect(d.label1BGstOnPurchasesCents).toBe(2091); // 697 + 1394; 909 + 2091 = 3000
    expect(d.g10CapitalPurchasesCents).toBe(15333); // 6667 + 15333 = 22000
    expect(d.g11NonCapitalPurchasesCents).toBe(7667); // 3333 + 7667 = 11000
  });
  it('Q2: nothing paid in Q2', async () => {
    const d = await bas('2026-04-01', '2026-06-30');
    expect([d.label1BGstOnPurchasesCents, d.g10CapitalPurchasesCents, d.g11NonCapitalPurchasesCents]).toEqual([0, 0, 0]);
  });
});

describe('proRataShare — cumulative rounding', () => {
  it('three payments 333/333/334 of 1000 split ITC 91 as 30/31/30 = 91', () => {
    const s = [proRataShare(91, 0, 333, 1000), proRataShare(91, 333, 666, 1000), proRataShare(91, 666, 1000, 1000)];
    expect(s).toEqual([30, 31, 30]); // round(30.303)=30; round(60.606)=61→31; 91−61=30
  });
});

describe('CA GST/HST line 108 includes bills', () => {
  it('accrual Q3: A ITCs (typed GST + CAP) + B', async () => {
    seed(null, 'ca');
    const d = (await json<{ data: { line108ItcCents: number } }>(
      await caGET(tenantReq('/api/v1/agentbook-tax/ca/gst-hst-return?periodStart=2026-07-01&periodEnd=2026-09-30', 't1')),
    )).data;
    expect(d.line108ItcCents).toBe(3091);
  });
});

describe('review follow-ups (M1–M3)', () => {
  it('M1: a paid at_entry bill with no live payments is NOT dated by its entry date on cash basis', async () => {
    seed('cash');
    // G: at_entry, status paid (inconsistent legacy row), billDate + paidDate in Q3, its only payment voided.
    await memDb.abBill.create({ data: bill({ id: 'G', status: 'paid', amountCents: 1100, billDate: day('2026-08-01'), createdAt: day('2026-08-01'),
      paidDate: day('2026-08-02'), lines: [{ id: 'g1', taxCode: 'GST', amountCents: 1100, taxCents: 100, recoverableTaxCents: 100, categoryId: null }],
      payments: [pay('gv', '2026-08-02', 1100, day('2026-08-03'))] }) });
    const d = await bas('2026-07-01', '2026-09-30');
    expect(d.label1BGstOnPurchasesCents).toBe(1670); // unchanged from the base Q3 cash fixture; G adds nothing
  });

  it('M2: every legacy-paid branch of the cash query is date-bounded', async () => {
    seed('cash');
    const spy = vi.spyOn(memDb.abBill, 'findMany');
    await bas('2026-07-01', '2026-09-30');
    const where = spy.mock.calls[0][0].where as { OR: Array<Record<string, any>> };
    const legacy = where.OR.find((b) => b.status === 'paid')!;
    expect(legacy.postingMode).toEqual({ not: 'at_entry' });
    for (const branch of legacy.OR) {
      const bounded = ['paidDate', 'billDate', 'createdAt'].some((k) => branch[k] && typeof branch[k] === 'object' && ('lte' in branch[k]));
      expect(bounded).toBe(true);
    }
    spy.mockRestore();
  });

  it('M3: 10001¢ bill, ITC 909, payments 3333/3334/3334 → 303/303/303 = 909', () => {
    // round(909·3333/10001)=round(302.94)=303; round(909·6667/10001)=round(605.97)=606 → 303; 909−606 = 303
    const s = [proRataShare(909, 0, 3333, 10001), proRataShare(909, 3333, 6667, 10001), proRataShare(909, 6667, 10001, 10001)];
    expect(s).toEqual([303, 303, 303]);
    expect(s.reduce((a, b) => a + b, 0)).toBe(909);
  });
});

describe('M1 (pure rule, independent of the query)', () => {
  it('cash: paid at_entry bill with no live payments → nothing; same row at_payment → its paidDate', () => {
    const row = bill({ id: 'G', status: 'paid', amountCents: 1100, taxCents: 100, createdAt: day('2026-08-01'), paidDate: day('2026-08-02') });
    const opts = { basis: 'cash' as const, gte: day('2026-07-01'), lte: day('2026-09-30') };
    expect(billPurchasesInPeriod([row], opts)).toEqual([]);
    expect(billPurchasesInPeriod([{ ...row, postingMode: 'at_payment' }], opts)).toEqual([
      { taxCode: null, recoverableTaxCents: 0, taxPaidCents: 100, grossCents: 1100, categoryId: null },
    ]);
  });
});

describe('M6: sales basis is labelled', () => {
  it('cash BAS says sales are by invoice date', async () => {
    seed('cash');
    const body = await json<{ data: { gstReportingBasis: string; salesBasis: string } }>(
      await basGET(tenantReq('/api/v1/agentbook-tax/au/bas-return?periodStart=2026-07-01&periodEnd=2026-09-30', 't1')));
    expect([body.data.gstReportingBasis, body.data.salesBasis]).toEqual(['cash', 'invoice_date']);
  });
});
