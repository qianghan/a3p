import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('server-only', () => ({}));

// NOTE: a plain top-level `const dbMock = {...}; vi.mock(..., () => ({ prisma: dbMock }))`
// throws "Cannot access 'dbMock' before initialization" — vi.mock's factory is
// invoked eagerly (before later top-level `const` statements execute), so a
// direct reference to an object literal declared further down is a genuine
// TDZ error, not a lint nit. Following this directory's established
// convention (see reports/contractor-1099-route.test.ts): declare each
// vi.fn() first, then wrap each in a lazy closure inside the mock factory so
// the outer variable is only read when actually invoked (during the test),
// by which point every top-level declaration has run.
const tenantConfigFindUnique = vi.fn();
const taxConfigFindUnique = vi.fn();
const accountFindMany = vi.fn();
const journalLineAggregate = vi.fn();
const journalLineFindMany = vi.fn();
const paymentAggregate = vi.fn();

vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: vi.fn(async () => ({ tenantId: 'test-tenant' })),
}));

vi.mock('@naap/database', () => ({
  prisma: {
    abTenantConfig: { findUnique: (...a: unknown[]) => tenantConfigFindUnique(...a) },
    abTaxConfig: { findUnique: (...a: unknown[]) => taxConfigFindUnique(...a) },
    abAccount: { findMany: (...a: unknown[]) => accountFindMany(...a) },
    abJournalLine: {
      aggregate: (...a: unknown[]) => journalLineAggregate(...a),
      findMany: (...a: unknown[]) => journalLineFindMany(...a),
    },
    abPayment: { aggregate: (...a: unknown[]) => paymentAggregate(...a) },
  },
}));

import { GET } from '@/app/api/v1/agentbook-tax/tax/estimate/route';
import { NextRequest } from 'next/server';

function makeRequest(query: string = ''): NextRequest {
  return new NextRequest(`https://example.com/api/v1/agentbook-tax/tax/estimate${query}`);
}

describe('GET /api/v1/agentbook-tax/tax/estimate — CA provincial tax (PARITY-1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    taxConfigFindUnique.mockResolvedValue(null);
    accountFindMany.mockResolvedValue([]);
    journalLineAggregate.mockResolvedValue({ _sum: { creditCents: 0, debitCents: 0 } });
  });

  it('includes Ontario provincial tax for a CA/ON tenant with $80,000 net income', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'ca', region: 'ON', accountingBasis: 'accrual' });
    // Net income = revenue - expenses = 8,000,000 cents ($80,000)
    accountFindMany
      .mockResolvedValueOnce([{ id: 'rev-1' }]) // revenueAccounts
      .mockResolvedValueOnce([{ id: 'exp-1' }]); // expenseAccounts
    journalLineAggregate
      .mockResolvedValueOnce({ _sum: { creditCents: 8000000, debitCents: 0 } }) // revenue
      .mockResolvedValueOnce({ _sum: { creditCents: 0, debitCents: 0 } }); // expenses

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.data.jurisdiction).toBe('ca');
    expect(body.data.region).toBe('ON');
    // NOTE: this is NOT the plan's originally-stated 1,846,756 (federal
    // 1,324,438 + ON provincial 522,318 on a flat $8,000,000 taxable base).
    // The real route also computes CA self-employment tax (CPP) on the same
    // $8,000,000 net income and deducts its employer-equivalent half BEFORE
    // computing income tax (see route.ts: `taxableIncomeCents = netIncomeCents
    // - seDeduction`), so the actual base fed into calculateTax() is
    // 7,561,790, not 8,000,000. Federal-only on that base is 1,234,604
    // (not 1,324,438), and Ontario provincial on that base is 482,222 (not
    // 522,318) — independently hand-verified against caTaxBrackets'
    // calcProvincialTax algorithm. Combined: 1,234,604 + 482,222 = 1,716,826.
    expect(body.data.incomeTaxCents).toBe(1716826);
  });

  it('includes Quebec provincial tax for a CA/QC tenant with $80,000 net income', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'ca', region: 'QC', accountingBasis: 'accrual' });
    accountFindMany
      .mockResolvedValueOnce([{ id: 'rev-1' }])
      .mockResolvedValueOnce([{ id: 'exp-1' }]);
    journalLineAggregate
      .mockResolvedValueOnce({ _sum: { creditCents: 8000000, debitCents: 0 } })
      .mockResolvedValueOnce({ _sum: { creditCents: 0, debitCents: 0 } });

    const res = await GET(makeRequest());
    const body = await res.json();

    // NOTE: not the plan's originally-stated 2,578,163 — same CPP-deduction
    // adjustment as the ON test above (real taxable base is 7,561,790, not
    // 8,000,000). Federal-only on that base is 1,234,604; Quebec provincial
    // on that base is 1,170,465 (hand-verified). Combined: 2,405,069.
    expect(body.data.incomeTaxCents).toBe(2405069);
  });

  it('US tenant behavior is unchanged (no region argument affects US brackets)', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'us', region: 'CA', accountingBasis: 'accrual' });
    accountFindMany
      .mockResolvedValueOnce([{ id: 'rev-1' }])
      .mockResolvedValueOnce([{ id: 'exp-1' }]);
    journalLineAggregate
      .mockResolvedValueOnce({ _sum: { creditCents: 8000000, debitCents: 0 } })
      .mockResolvedValueOnce({ _sum: { creditCents: 0, debitCents: 0 } });

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.data.jurisdiction).toBe('us');
    // Just confirm it's a plain number and not NaN/thrown — exact US bracket
    // math is already covered by us-tax-brackets.test.ts; this test's job is
    // only to prove the extra `region` argument doesn't break US.
    expect(typeof body.data.incomeTaxCents).toBe('number');
    expect(Number.isNaN(body.data.incomeTaxCents)).toBe(false);
  });
});
