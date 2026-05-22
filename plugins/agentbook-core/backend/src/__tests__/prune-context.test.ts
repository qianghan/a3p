import { describe, it, expect } from 'vitest';
import { pruneContextForQuestion } from '../server';

const fullContext = {
  jurisdiction: 'us',
  currency: 'USD',
  totalRevenueCents: 10_000_00,
  totalExpenseCents: 4_000_00,
  netIncomeCents: 6_000_00,
  cashBalanceCents: 3_500_00,
  expenseCount: 250,
  topVendors: Array.from({ length: 10 }, (_, i) => ({
    name: `Vendor${i}`,
    totalCents: 100_00 * (i + 1),
    count: 5,
  })),
  clients: Array.from({ length: 50 }, (_, i) => ({
    name: `Client${i}`,
    billedCents: 500_00 + i * 10_00,
    paidCents: 400_00 + i * 10_00,
    outstandingCents: 100_00,
  })),
  recentInvoices: Array.from({ length: 20 }, (_, i) => ({
    number: `INV-2026-${i}`,
    amountCents: 1_000_00,
    status: 'sent',
  })),
  taxEstimate: { totalTaxCents: 1_500_00, effectiveRate: 0.25, netIncomeCents: 6_000_00 },
  recurringExpenses: 12,
  monthlyBurnCents: 800_00,
};

describe('pruneContextForQuestion (G-038)', () => {
  it('always includes headline totals regardless of intent', () => {
    const r = pruneContextForQuestion(fullContext, 'random question');
    expect(r.totalRevenueCents).toBe(10_000_00);
    expect(r.totalExpenseCents).toBe(4_000_00);
    expect(r.netIncomeCents).toBe(6_000_00);
    expect(r.cashBalanceCents).toBe(3_500_00);
  });

  it('tax intent: includes taxEstimate, drops heavy arrays', () => {
    const r = pruneContextForQuestion(fullContext, 'how much tax do I owe?');
    expect(r.taxEstimate).toBeDefined();
    expect(r.recurringExpenses).toBe(12);
    expect((r as any).clients).toBeUndefined();
    expect((r as any).recentInvoices).toBeUndefined();
    expect((r as any).topVendors).toBeUndefined();
  });

  it('expense intent: includes topVendors + burn, drops clients/invoices', () => {
    const r = pruneContextForQuestion(fullContext, 'what are my biggest expenses this month?');
    expect((r as any).topVendors).toBeDefined();
    expect(r.monthlyBurnCents).toBe(800_00);
    expect((r as any).clients).toBeUndefined();
    expect((r as any).recentInvoices).toBeUndefined();
  });

  it('client intent: includes clients + invoices, drops topVendors', () => {
    const r = pruneContextForQuestion(fullContext, 'which clients have unpaid invoices?');
    expect((r as any).clients).toBeDefined();
    expect((r as any).recentInvoices).toBeDefined();
    expect((r as any).topVendors).toBeUndefined();
  });

  it('cash intent: minimal payload — burn + recurring only', () => {
    const r = pruneContextForQuestion(fullContext, 'how long will my cash last?');
    expect(r.monthlyBurnCents).toBe(800_00);
    expect(r.cashBalanceCents).toBe(3_500_00);
    expect((r as any).clients).toBeUndefined();
    expect((r as any).topVendors).toBeUndefined();
    expect((r as any).recentInvoices).toBeUndefined();
  });

  it('default (unmatched): modest snapshot — no heavy arrays', () => {
    const r = pruneContextForQuestion(fullContext, 'tell me a joke');
    expect((r as any).clients).toBeUndefined();
    expect((r as any).recentInvoices).toBeUndefined();
    expect((r as any).topVendors).toBeUndefined();
    expect(r.expenseCount).toBe(250);
  });

  it('serialized size is meaningfully smaller than full context', () => {
    const full = JSON.stringify(fullContext);
    const pruned = JSON.stringify(pruneContextForQuestion(fullContext, 'how much tax do I owe?'));
    expect(pruned.length).toBeLessThan(full.length / 3);
  });

  it('case-insensitive intent matching', () => {
    const r1 = pruneContextForQuestion(fullContext, 'HOW MUCH TAX');
    const r2 = pruneContextForQuestion(fullContext, 'how much tax');
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });
});
