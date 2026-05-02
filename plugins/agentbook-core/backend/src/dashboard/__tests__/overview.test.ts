import { describe, it, expect } from 'vitest';
import { rankAttention, buildNextMoments, deriveMoodLabel } from '../overview.js';

describe('rankAttention', () => {
  it('orders overdue invoices first, then tax-within-14d, then unbilled, then balance, then receipts', () => {
    const ranked = rankAttention({
      overdue: [{ id: 'i1', client: 'Acme', daysOverdue: 32, amountCents: 450000 }],
      taxQuarterly: { dueDate: '2026-05-14', amountCents: 320000, daysOut: 12 },
      unbilled: { hours: 12, amountCents: 240000 },
      booksOutOfBalance: true,
      missingReceiptsCount: 4,
    });

    expect(ranked[0].id).toBe('overdue:i1');
    expect(ranked[1].id).toBe('tax');
    expect(ranked[2].id).toBe('unbilled');
    expect(ranked[3].id).toBe('balance');
    expect(ranked[4].id).toBe('receipts');
    expect(ranked).toHaveLength(5);
  });

  it('omits tax callout when daysOut > 14', () => {
    const ranked = rankAttention({
      overdue: [],
      taxQuarterly: { dueDate: '2026-06-01', amountCents: 320000, daysOut: 30 },
      unbilled: null,
      booksOutOfBalance: false,
      missingReceiptsCount: 0,
    });
    expect(ranked).toHaveLength(0);
  });

  it('omits missingReceipts when count < 3', () => {
    const ranked = rankAttention({
      overdue: [],
      taxQuarterly: null,
      unbilled: null,
      booksOutOfBalance: false,
      missingReceiptsCount: 2,
    });
    expect(ranked).toHaveLength(0);
  });

  it('caps at 5 items even when more inputs exist', () => {
    const overdue = Array.from({ length: 10 }, (_, i) => ({
      id: `i${i}`, client: `Client${i}`, daysOverdue: 30 + i, amountCents: 100000,
    }));
    const ranked = rankAttention({
      overdue,
      taxQuarterly: { dueDate: '2026-05-14', amountCents: 320000, daysOut: 12 },
      unbilled: null,
      booksOutOfBalance: false,
      missingReceiptsCount: 0,
    });
    expect(ranked).toHaveLength(5);
    expect(ranked.slice(0, 4).every(r => r.id.startsWith('overdue:'))).toBe(true);
    expect(ranked[4].id).toBe('tax');
  });
});

describe('buildNextMoments', () => {
  it('orders by daysOut asc; ties broken by absolute amount desc; cap 4', () => {
    const moments = buildNextMoments({
      upcomingInvoices: [
        { client: 'Acme', amountCents: 450000, daysOut: 7 },
        { client: 'Beta', amountCents: 280000, daysOut: 14 },
      ],
      tax: { amountCents: 320000, daysOut: 14 },
      recurring: [
        { vendor: 'Rent', amountCents: 180000, daysOut: 5 },
        { vendor: 'AWS', amountCents: 34000, daysOut: 12 },
      ],
    });

    expect(moments).toHaveLength(4);
    expect(moments[0].label).toMatch(/Rent/);
    expect(moments[0].kind).toBe('rent');
    expect(moments[1].label).toMatch(/Acme/);
    expect(moments[2].label).toMatch(/AWS/);
    expect(moments[3].label).toMatch(/Tax/);
  });

  it('returns empty when no inputs', () => {
    expect(buildNextMoments({ upcomingInvoices: [], tax: null, recurring: [] })).toEqual([]);
  });
});

describe('deriveMoodLabel', () => {
  it('critical when any day in window is ≤ 0', () => {
    const days = Array.from({ length: 30 }, (_, i) => ({
      date: '2026-05-' + String(i + 1).padStart(2, '0'),
      cents: i === 15 ? -1000 : 100000,
    }));
    expect(deriveMoodLabel(days, 200000)).toBe('critical');
  });

  it('tight when min < 0.5 × monthly burn', () => {
    const days = Array.from({ length: 30 }, () => ({ date: '', cents: 50000 }));
    expect(deriveMoodLabel(days, 200000)).toBe('tight');
  });

  it('healthy otherwise', () => {
    const days = Array.from({ length: 30 }, () => ({ date: '', cents: 500000 }));
    expect(deriveMoodLabel(days, 200000)).toBe('healthy');
  });
});
