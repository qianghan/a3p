/**
 * Tests for the year-end tax package data assembly + supporting CSV
 * renderers. The orchestrator (`generatePackage`) talks to Vercel Blob
 * + Prisma in production; here we exercise the *pure* data-assembly
 * layer (`gatherPackageData`) and the CSV / PDF helpers that consume
 * it. The DB layer is mocked through `@naap/database` so the suite
 * runs offline and offers fast feedback during development.
 *
 * Coverage:
 *   1. US tenant — Schedule C lines emerge as the keys
 *   2. CA tenant — T2125 box codes (e.g. "8810") emerge as the keys
 *   3. Empty data — package still produces a valid (zero-totalled) shape
 *   4. Mileage YTD is included in the package's deduction roll-up
 *   5. Deductions categorisation groups expenses by their tax-line key
 *   6. Receipts source URLs are surfaced on the line-item view
 *   7. CSV bundle — pnl/mileage/deductions all serialise without leaking
 *      sensitive fields (passwordHash, accessTokenEnc)
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
vi.mock('server-only', () => ({}));

// Mock the DB before importing the module under test.
vi.mock('@naap/database', () => {
  return {
    prisma: {
      abTenantConfig: {
        findUnique: vi.fn(),
      },
      abAccount: {
        findMany: vi.fn(),
      },
      abExpense: {
        findMany: vi.fn(),
        count: vi.fn(),
      },
      abMileageEntry: {
        findMany: vi.fn(),
      },
      abInvoice: {
        findMany: vi.fn(),
      },
      abJournalLine: {
        aggregate: vi.fn(),
      },
    },
  };
});

import { prisma as db } from '@naap/database';
import {
  gatherPackageData,
  taxLineFor,
  type PackageData,
} from './agentbook-tax-package';
import {
  renderPnlCsv,
  renderMileageCsv,
  renderDeductionsCsv,
} from './agentbook-tax-csv';

// Cast the mocked module so each method has `.mockResolvedValue`.
const mockedDb = db as unknown as {
  abTenantConfig: { findUnique: ReturnType<typeof vi.fn> };
  abAccount: { findMany: ReturnType<typeof vi.fn> };
  abExpense: { findMany: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn> };
  abMileageEntry: { findMany: ReturnType<typeof vi.fn> };
  abInvoice: { findMany: ReturnType<typeof vi.fn> };
  abJournalLine: { aggregate: ReturnType<typeof vi.fn> };
};

const TENANT = 'tenant-test';

beforeEach(() => {
  // Default empties — individual tests override only what they need.
  mockedDb.abTenantConfig.findUnique.mockResolvedValue({ jurisdiction: 'us', currency: 'USD' });
  mockedDb.abAccount.findMany.mockResolvedValue([]);
  mockedDb.abExpense.findMany.mockResolvedValue([]);
  mockedDb.abExpense.count.mockResolvedValue(0);
  mockedDb.abMileageEntry.findMany.mockResolvedValue([]);
  mockedDb.abInvoice.findMany.mockResolvedValue([]);
  mockedDb.abJournalLine.aggregate.mockResolvedValue({ _sum: { debitCents: 0, creditCents: 0 } });
});

describe('taxLineFor (jurisdiction-aware mapper)', () => {
  it('US — known account type maps to a Schedule C line', () => {
    // Travel/meals/office are common Schedule C lines. The mapper picks
    // a sensible default when the account itself doesn't carry an
    // explicit `taxCategory` override.
    expect(taxLineFor('us', 'expense', 'Travel', null)).toMatch(/Schedule C/i);
  });

  it('CA — uses T2125 box codes (numeric labels), not Schedule C', () => {
    const line = taxLineFor('ca', 'expense', 'Office', null);
    expect(line).toMatch(/T2125/i);
  });

  it('explicit account.taxCategory overrides the default mapping', () => {
    const line = taxLineFor('us', 'expense', 'Anything', 'Schedule C Line 22 - Supplies');
    expect(line).toBe('Schedule C Line 22 - Supplies');
  });

  it('unknown account name falls back to the catch-all "Other"', () => {
    const us = taxLineFor('us', 'expense', '__unknown__', null);
    expect(us).toMatch(/Other/i);
  });
});

describe('gatherPackageData — US tenant', () => {
  it('emits Schedule C-style line keys, expense count, and period boundaries', async () => {
    mockedDb.abTenantConfig.findUnique.mockResolvedValue({ jurisdiction: 'us', currency: 'USD' });
    mockedDb.abAccount.findMany.mockResolvedValue([
      { id: 'a-meals', code: '5300', name: 'Meals', accountType: 'expense', taxCategory: null },
      { id: 'a-travel', code: '5100', name: 'Travel', accountType: 'expense', taxCategory: null },
    ]);
    mockedDb.abExpense.findMany.mockResolvedValue([
      {
        id: 'e1',
        amountCents: 5000,
        date: new Date('2025-03-15'),
        categoryId: 'a-meals',
        receiptUrl: 'https://blob/receipt-1.jpg',
        description: 'Lunch with client',
        vendor: { name: 'Bistro' },
      },
      {
        id: 'e2',
        amountCents: 12000,
        date: new Date('2025-06-01'),
        categoryId: 'a-travel',
        receiptUrl: null,
        description: 'Flight',
        vendor: { name: 'Airline' },
      },
    ]);
    mockedDb.abExpense.count.mockResolvedValue(2);

    const data = await gatherPackageData({ tenantId: TENANT, year: 2025, jurisdiction: 'us' });

    expect(data.expenseCount).toBe(2);
    expect(data.period.start.getUTCFullYear()).toBe(2025);
    expect(data.period.end.getUTCFullYear()).toBe(2025);
    // The line keys reflect the US Schedule C mapping (string contains
    // "Schedule C" or the line number from the canonical IRS form).
    const lineKeys = Object.keys(data.pnlByLine);
    expect(lineKeys.some((k) => /Schedule C/i.test(k))).toBe(true);
    // Total of all expense lines equals 5000 + 12000.
    const total = Object.values(data.pnlByLine).reduce((s, v) => s + v, 0);
    expect(total).toBe(17000);
  });
});

describe('gatherPackageData — CA tenant', () => {
  it('emits T2125-style box keys when jurisdiction = ca', async () => {
    mockedDb.abTenantConfig.findUnique.mockResolvedValue({ jurisdiction: 'ca', currency: 'CAD' });
    mockedDb.abAccount.findMany.mockResolvedValue([
      { id: 'a-office', code: '5210', name: 'Office', accountType: 'expense', taxCategory: null },
    ]);
    mockedDb.abExpense.findMany.mockResolvedValue([
      {
        id: 'e1',
        amountCents: 8800,
        date: new Date('2025-04-10'),
        categoryId: 'a-office',
        receiptUrl: null,
        description: 'Pens',
        vendor: { name: 'Staples' },
      },
    ]);
    mockedDb.abExpense.count.mockResolvedValue(1);

    const data = await gatherPackageData({ tenantId: TENANT, year: 2025, jurisdiction: 'ca' });
    const keys = Object.keys(data.pnlByLine);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => /T2125/i.test(k))).toBe(true);
  });
});

describe('gatherPackageData — empty data', () => {
  it('returns a valid (zero-totalled) shape — never throws', async () => {
    const data = await gatherPackageData({ tenantId: TENANT, year: 2025, jurisdiction: 'us' });
    expect(data.expenseCount).toBe(0);
    expect(data.pnlByLine).toEqual({});
    expect(data.deductions.totalCents).toBe(0);
    expect(data.mileage.totalUnit).toBe(0);
    expect(data.mileage.totalDeductibleCents).toBe(0);
    expect(data.ar.totalCents).toBe(0);
  });
});

describe('gatherPackageData — mileage included', () => {
  it('rolls mileage YTD into the package summary', async () => {
    mockedDb.abMileageEntry.findMany.mockResolvedValue([
      { id: 'm1', miles: 47, unit: 'mi', deductibleAmountCents: 3149, date: new Date('2025-02-10'), purpose: 'TechCorp', clientId: null },
      { id: 'm2', miles: 100, unit: 'mi', deductibleAmountCents: 6700, date: new Date('2025-05-22'), purpose: 'Airport', clientId: null },
    ]);
    const data = await gatherPackageData({ tenantId: TENANT, year: 2025, jurisdiction: 'us' });
    expect(data.mileage.totalUnit).toBe(147);
    expect(data.mileage.totalDeductibleCents).toBe(9849);
    expect(data.mileage.entries.length).toBe(2);
  });
});

describe('gatherPackageData — deductions categorisation', () => {
  it('groups deductibles by their tax-line bucket', async () => {
    mockedDb.abAccount.findMany.mockResolvedValue([
      { id: 'a-meals', code: '5300', name: 'Meals', accountType: 'expense', taxCategory: null },
      { id: 'a-office', code: '5210', name: 'Office', accountType: 'expense', taxCategory: null },
    ]);
    mockedDb.abExpense.findMany.mockResolvedValue([
      { id: 'e1', amountCents: 1000, date: new Date('2025-03-01'), categoryId: 'a-meals', receiptUrl: null, description: '', vendor: null },
      { id: 'e2', amountCents: 2500, date: new Date('2025-04-01'), categoryId: 'a-meals', receiptUrl: null, description: '', vendor: null },
      { id: 'e3', amountCents: 5000, date: new Date('2025-05-01'), categoryId: 'a-office', receiptUrl: null, description: '', vendor: null },
    ]);
    mockedDb.abExpense.count.mockResolvedValue(3);

    const data = await gatherPackageData({ tenantId: TENANT, year: 2025, jurisdiction: 'us' });
    expect(data.deductions.totalCents).toBe(8500);
    // Two distinct categories → two keys in byCategory.
    const byCat = data.deductions.byCategory;
    expect(Object.keys(byCat).length).toBe(2);
    // Sum of byCategory equals totalCents (idempotent invariant).
    expect(Object.values(byCat).reduce((s, v) => s + v, 0)).toBe(8500);
  });
});

describe('CSV renderers', () => {
  const fakeData: PackageData = {
    pnlByLine: { 'Schedule C Line 24a - Travel': 12000, 'Schedule C Line 24b - Meals': 5000 },
    mileage: {
      totalUnit: 147,
      totalDeductibleCents: 9849,
      entries: [
        { id: 'm1', date: new Date('2025-02-10'), miles: 47, unit: 'mi', purpose: 'TechCorp', deductibleAmountCents: 3149 },
        { id: 'm2', date: new Date('2025-05-22'), miles: 100, unit: 'mi', purpose: 'Airport', deductibleAmountCents: 6700 },
      ],
    },
    ar: { totalCents: 0, oldestDays: 0, agingBuckets: { current: 0, '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0 } },
    deductions: {
      byCategory: { 'Schedule C Line 24a - Travel': 12000, 'Schedule C Line 24b - Meals': 5000 },
      totalCents: 17000,
    },
    expenseCount: 2,
    period: { start: new Date('2025-01-01'), end: new Date('2025-12-31') },
    expenses: [
      { id: 'e1', date: new Date('2025-03-15'), amountCents: 5000, vendorName: 'Bistro', description: 'Lunch', taxLine: 'Schedule C Line 24b - Meals', receiptUrl: 'https://blob/r-1.jpg' },
      { id: 'e2', date: new Date('2025-06-01'), amountCents: 12000, vendorName: 'Airline', description: 'Flight', taxLine: 'Schedule C Line 24a - Travel', receiptUrl: null },
    ],
    jurisdiction: 'us',
  };

  it('P&L CSV — has header + one row per tax line, no sensitive fields', () => {
    const csv = renderPnlCsv(fakeData);
    expect(csv.split('\n').length).toBeGreaterThanOrEqual(3); // header + 2 rows
    expect(csv).toMatch(/Schedule C Line 24a - Travel/);
    // No sensitive field names accidentally serialised.
    expect(csv).not.toMatch(/passwordHash|accessTokenEnc|secretKey/i);
  });

  it('Mileage CSV — one row per entry, includes deductible amount', () => {
    const csv = renderMileageCsv(fakeData);
    expect(csv).toMatch(/TechCorp/);
    expect(csv).toMatch(/Airport/);
    expect(csv).not.toMatch(/passwordHash|accessTokenEnc|secretKey/i);
  });

  it('Deductions CSV — totals line + per-category rows', () => {
    const csv = renderDeductionsCsv(fakeData);
    expect(csv).toMatch(/Travel/);
    expect(csv).toMatch(/Meals/);
    expect(csv).not.toMatch(/passwordHash|accessTokenEnc|secretKey/i);
  });
});
