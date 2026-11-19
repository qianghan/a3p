import { describe, it, expect } from 'vitest';
import { billToPurchase, expenseToPurchase, mergePurchases, todayInZone } from '../purchases-view';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const bill = (o: Record<string, unknown>) => ({
  id: 'b', vendorName: 'Acme', amountCents: 10000, status: 'open', paidCents: 0, billDate: d('2026-10-05'),
  createdAt: d('2026-10-01'), dueDate: d('2026-11-05'), ...o,
}) as Parameters<typeof billToPurchase>[0];

describe('billToPurchase', () => {
  it('open bill is due at the full total', () => {
    const r = billToPurchase(bill({}), '2026-10-10');
    expect(r).toMatchObject({ kind: 'bill', status: 'due', amountCents: 10000, outstandingCents: 10000, overdue: false });
  });
  it('partial bill is due at total - paid, total stays the row amount', () => {
    const r = billToPurchase(bill({ status: 'partial', paidCents: 4000 }), '2026-10-10');
    expect(r).toMatchObject({ status: 'due', amountCents: 10000, outstandingCents: 6000 });
  });
  it('paid bill: paid badge, nothing outstanding, even with paidCents 0 (legacy)', () => {
    expect(billToPurchase(bill({ status: 'paid' }))).toMatchObject({ status: 'paid', outstandingCents: 0, overdue: false });
  });
  it('overdue only while unpaid', () => {
    expect(billToPurchase(bill({}), '2026-12-01').overdue).toBe(true);
    expect(billToPurchase(bill({ status: 'paid' }), '2026-12-01').overdue).toBe(false);
  });
  it('date is billDate, falling back to createdAt', () => {
    expect(billToPurchase(bill({})).date).toBe('2026-10-05T00:00:00.000Z');
    expect(billToPurchase(bill({ billDate: null })).date).toBe('2026-10-01T00:00:00.000Z');
  });
});

describe('overdue is judged on the tenant calendar date (I1)', () => {
  // 17:00 PT on Nov 5 is 01:00 UTC on Nov 6: the server clock is already "tomorrow".
  const now = new Date('2026-11-06T01:00:00.000Z');
  const dueToday = bill({ dueDate: d('2026-11-05') });
  it('todayInZone gives the tenant date', () => {
    expect(todayInZone('America/Los_Angeles', now)).toBe('2026-11-05');
    expect(todayInZone('UTC', now)).toBe('2026-11-06');
    expect(todayInZone('Not/AZone', now)).toBe('2026-11-06');
  });
  it('a bill due today is not overdue for a Los Angeles tenant at 17:00 PT', () => {
    expect(billToPurchase(dueToday, todayInZone('America/Los_Angeles', now)).overdue).toBe(false);
  });
  it('the same bill is overdue the next tenant day', () => {
    expect(billToPurchase(dueToday, '2026-11-06').overdue).toBe(true);
  });
});

describe('mergePurchases', () => {
  const e1 = expenseToPurchase({ id: 'e1', date: d('2026-10-07'), amountCents: 500, vendor: { name: 'Staples' } });
  const e2 = expenseToPurchase({ id: 'e2', date: d('2026-10-03'), amountCents: 700 });
  const b1 = billToPurchase(bill({ id: 'b1' }));                       // 10-05
  const b2 = billToPurchase(bill({ id: 'b2', status: 'paid', billDate: d('2026-10-03') }));
  it('sorts newest first, id desc on a date tie, and keeps each bill once', () => {
    const out = mergePurchases([e2, b1, e1, b2], 10, 0);
    expect(out.map((r) => `${r.kind}:${r.id}`)).toEqual(['expense:e1', 'bill:b1', 'expense:e2', 'bill:b2']);
  });
  it('paginates by offset/limit', () => {
    expect(mergePurchases([e2, b1, e1, b2], 2, 1).map((r) => r.id)).toEqual(['b1', 'e2']);
  });
  it('expense rows carry no badge', () => expect(e1.status).toBeNull());
});
