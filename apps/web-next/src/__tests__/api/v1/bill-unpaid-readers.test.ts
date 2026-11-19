// @vitest-environment node
/**
 * PR 3bc.5 — every bill reader treats open AND partial as unpaid, excludes
 * soft-deleted bills, and quotes OUTSTANDING (total − paidCents for partial;
 * total for open — legacy at_payment rows never maintained paidCents).
 *
 * Seed (tenant t1, now = 2026-06-01):
 *   b-open    legacy at_payment open        10000  due 05-20 (overdue)
 *   b-paid    legacy at_payment paid, paid=0 20000 due 05-10
 *   b-part    at_entry partial, paid 4000   10000  due 06-05 → outstanding 6000
 *   b-new     at_entry open                  3000  due 06-10
 *   b-del     open but deletedAt set        50000  due 05-01
 *   b-cxl     cancelled                     70000  due 05-01
 *   b-x       other tenant open                 1
 * Unpaid outstanding = 10000 + 6000 + 3000 = 19000; overdue = b-open = 10000.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@naap/database', async () => ({ prisma: (await import('@/__tests__/helpers/mem-db')).memDb }));
vi.mock('@/lib/agentbook-tenant', async () => (await import('@/__tests__/helpers/route-request')).tenantModuleMock);

const reviewSpy = vi.hoisted(() => ({ metrics: null as null | { overdueBillCount: number; overdueBillCents: number } }));
vi.mock('@/lib/cpa-review', async (orig) => {
  const actual = await orig<typeof import('@/lib/cpa-review')>();
  return { ...actual, runCpaReview: (m: never) => { reviewSpy.metrics = m; return actual.runCpaReview(m); } };
});

import { memDb } from '@/__tests__/helpers/mem-db';
import { tenantReq, json } from '@/__tests__/helpers/route-request';
import { GET as BILLS } from '@/app/api/v1/agentbook-expense/bills/route';
import { GET as AGING } from '@/app/api/v1/agentbook-tax/reports/ap-aging/route';
import { getUpcoming } from '@/lib/mobile/upcoming';
import { runReviewForTenant } from '@/lib/cpa-run';
import { loadUnpaidBills } from '@agentbook-core/bill-amounts';
import { outstandingCents, summarizeUnpaidBills } from '@/lib/bill-amounts';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const bill = (o: Record<string, unknown>) => ({
  tenantId: 't1', vendorName: String(o.id), paidCents: 0, postingMode: 'at_payment', deletedAt: null, createdAt: day('2026-04-01'), ...o,
});
const SEED = () => ({
  abTenantConfig: [{ id: 'c1', userId: 't1', jurisdiction: 'us', currency: 'USD' }],
  abBill: [
    bill({ id: 'b-open', amountCents: 10000, status: 'open', dueDate: day('2026-05-20') }),
    bill({ id: 'b-paid', amountCents: 20000, status: 'paid', dueDate: day('2026-05-10') }),
    bill({ id: 'b-part', amountCents: 10000, paidCents: 4000, status: 'partial', postingMode: 'at_entry', dueDate: day('2026-06-05') }),
    bill({ id: 'b-new', amountCents: 3000, status: 'open', postingMode: 'at_entry', dueDate: day('2026-06-10') }),
    bill({ id: 'b-del', amountCents: 50000, status: 'open', deletedAt: day('2026-05-02'), dueDate: day('2026-05-01') }),
    bill({ id: 'b-cxl', amountCents: 70000, status: 'cancelled', dueDate: day('2026-05-01') }),
    bill({ id: 'b-x', tenantId: 't2', amountCents: 1, status: 'open', dueDate: day('2026-05-01') }),
  ],
  abCalendarEvent: [],
  abQuarterlyPayment: [],
  abExpense: [],
  abAccount: [],
  abJournalLine: [],
  abCpaReviewReport: [],
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  memDb.reset(SEED());
});
afterEach(() => vi.useRealTimers());

describe('bill-amounts rules', () => {
  it('outstanding: open=total, partial=total−paid, legacy paid (paidCents 0)=0, deleted/cancelled=0', () => {
    expect(outstandingCents({ status: 'open', amountCents: 500, paidCents: 0 })).toBe(500);
    expect(outstandingCents({ status: 'partial', amountCents: 500, paidCents: 120 })).toBe(380);
    expect(outstandingCents({ status: 'paid', amountCents: 500, paidCents: 0 })).toBe(0);
    expect(outstandingCents({ status: 'open', amountCents: 500, deletedAt: new Date() })).toBe(0);
    expect(outstandingCents({ status: 'cancelled', amountCents: 500 })).toBe(0);
  });
});

describe('bills GET', () => {
  it('openCents = Σ outstanding of open+partial live bills; overdue counts partial too', async () => {
    const res = await BILLS(tenantReq('/api/v1/agentbook-expense/bills', 't1'));
    const body = await json<{ data: Array<{ id: string; effectiveStatus: string }>; summary: { openCents: number; overdueCents: number } }>(res);
    expect(body.summary.openCents).toBe(19000);
    expect(body.summary.overdueCents).toBe(10000);
    expect(body.data.map((b) => b.id)).not.toContain('b-del');
  });

  it('a partial bill past due is overdue at its outstanding amount', async () => {
    memDb.reset({ ...SEED(), abBill: [bill({ id: 'p', amountCents: 9000, paidCents: 2000, status: 'partial', postingMode: 'at_entry', dueDate: day('2026-05-01') })] });
    const body = await json<{ data: Array<{ effectiveStatus: string }>; summary: { openCents: number; overdueCents: number } }>(
      await BILLS(tenantReq('/api/v1/agentbook-expense/bills?status=overdue', 't1')),
    );
    expect(body.data.map((b) => b.effectiveStatus)).toEqual(['overdue']);
    expect(body.summary).toMatchObject({ openCents: 7000, overdueCents: 7000 });
  });
});

describe('AP aging', () => {
  it('buckets outstanding of open+partial live bills only', async () => {
    const body = await json<{ data: { buckets: Record<string, { totalCents: number; count: number }>; totalOwedCents: number; billCount: number } }>(
      await AGING(tenantReq('/api/v1/agentbook-tax/reports/ap-aging', 't1')),
    );
    expect(body.data.totalOwedCents).toBe(19000);
    expect(body.data.billCount).toBe(3);
    expect(body.data.buckets.current).toMatchObject({ totalCents: 9000, count: 2 });
    expect(body.data.buckets.d1_30).toMatchObject({ totalCents: 10000, count: 1 });
  });
});

describe('mobile Upcoming', () => {
  it('lists open + partial bills at their outstanding amount, never deleted ones', async () => {
    const items = (await getUpcoming('t1', 30, NOW)).filter((i) => i.kind === 'bill');
    expect(items.map((i) => [i.id, i.amountCents])).toEqual([['bill:b-part', 6000], ['bill:b-new', 3000]]);
  });
});

describe('CPA run', () => {
  it('overdue bills = unpaid live past due, at outstanding', async () => {
    await runReviewForTenant('t1');
    const metrics = reviewSpy.metrics!;
    expect(metrics.overdueBillCount).toBe(1);
    expect(metrics.overdueBillCents).toBe(10000);
  });
});

describe('chat skills (manage-bills / cpa-review) loader', () => {
  it('loadUnpaidBills + summarize: open+partial live, outstanding totals', async () => {
    const bills = await loadUnpaidBills(memDb as never, 't1');
    expect(bills.map((b) => b.id)).toEqual(['b-open', 'b-part', 'b-new']);
    const s = summarizeUnpaidBills(bills as never, NOW);
    expect(s).toMatchObject({ openCents: 19000, overdueCents: 10000 });
    expect(s.overdue).toHaveLength(1);
  });
});
