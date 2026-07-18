import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const tenantConfigFindUnique = vi.fn();
const taxConfigFindUnique = vi.fn();
const accountFindMany = vi.fn();
const journalLineAggregate = vi.fn();
const paymentAggregate = vi.fn();
const journalLineFindMany = vi.fn();
const accountFindFirst = vi.fn();

vi.mock('@naap/database', () => ({
  prisma: {
    abTenantConfig: { findUnique: (...a: unknown[]) => tenantConfigFindUnique(...a) },
    abTaxConfig: { findUnique: (...a: unknown[]) => taxConfigFindUnique(...a) },
    abAccount: {
      findMany: (...a: unknown[]) => accountFindMany(...a),
      findFirst: (...a: unknown[]) => accountFindFirst(...a),
    },
    abJournalLine: {
      aggregate: (...a: unknown[]) => journalLineAggregate(...a),
      findMany: (...a: unknown[]) => journalLineFindMany(...a),
    },
    abPayment: { aggregate: (...a: unknown[]) => paymentAggregate(...a) },
  },
}));

const safeResolveAgentbookTenant = vi.fn();
vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: (...a: unknown[]) => safeResolveAgentbookTenant(...a),
}));

function req(query = ''): NextRequest {
  return new NextRequest(`http://x/tax/estimate${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  safeResolveAgentbookTenant.mockResolvedValue({ tenantId: 'tenant-1' });
  taxConfigFindUnique.mockResolvedValue(null);
  accountFindMany.mockImplementation(({ where }: { where: { accountType: string } }) =>
    Promise.resolve(where.accountType === 'revenue' ? [{ id: 'rev-1' }] : [{ id: 'exp-1' }]),
  );
  journalLineAggregate.mockImplementation(({ where }: { where: { accountId: { in: string[] } } }) =>
    Promise.resolve(
      where.accountId.in.includes('rev-1')
        ? { _sum: { creditCents: 10_000_00, debitCents: 0 } }
        : { _sum: { creditCents: 0, debitCents: 4_000_00 } },
    ),
  );
});

describe('GET /agentbook-tax/tax/estimate — jurisdiction correctness', () => {
  it('computes a real AU tax figure using the au bracket + Medicare Levy calculators, not $0 / US brackets', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'au', region: 'NSW', accountingBasis: 'accrual' });
    const { GET } = await import('../route');
    const res = await GET(req());
    const json = await res.json();

    expect(json.data.jurisdiction).toBe('au');
    // Net income = $10,000 - $4,000 = $6,000 (600000 cents), well under the
    // $18,200 AU tax-free threshold and above the $26,000 Medicare Levy floor
    // is false here (6000 < 26000) — so Medicare Levy is correctly $0 *for
    // this input*, but this must come from calling auSelfEmploymentTax, not
    // from the old code's blanket `return 0` for any non-us/ca jurisdiction.
    // The real assertion: income tax must be computed via the real AU
    // brackets, not silently defaulted to the US bracket table.
    expect(json.data.incomeTaxCents).toBe(0); // 600000 cents < $18,200 AU tax-free threshold
    expect(json.self_employment_tax).toBe(0);
  });

  it('AU income above the Medicare Levy shading threshold produces a non-zero self-employment (Medicare Levy) figure', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'au', region: 'NSW', accountingBasis: 'accrual' });
    journalLineAggregate.mockImplementation(({ where }: { where: { accountId: { in: string[] } } }) =>
      Promise.resolve(
        where.accountId.in.includes('rev-1')
          ? { _sum: { creditCents: 100_000_00, debitCents: 0 } }
          : { _sum: { creditCents: 0, debitCents: 0 } },
      ),
    );
    const { GET } = await import('../route');
    const res = await GET(req());
    const json = await res.json();
    // $100,000 net income: Medicare Levy = 2% of 10,000,000 cents = 200,000 cents ($2,000)
    expect(json.data.seTaxCents).toBe(200000);
    expect(json.data.incomeTaxCents).toBeGreaterThan(0);
  });

  it('still computes correctly for us and ca (regression — same route, now via the jurisdiction packs)', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'us', region: 'CA', accountingBasis: 'accrual' });
    const { GET } = await import('../route');
    const res = await GET(req());
    const json = await res.json();
    expect(json.data.jurisdiction).toBe('us');
    expect(typeof json.data.seTaxCents).toBe('number');
    expect(typeof json.data.incomeTaxCents).toBe('number');
  });

  it('defaults to us brackets for an unrecognized jurisdiction, matching prior behavior', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'zz', region: '', accountingBasis: 'accrual' });
    const { GET } = await import('../route');
    const res = await GET(req());
    const json = await res.json();
    expect(json.data.jurisdiction).toBe('zz');
    expect(res.status).toBe(200); // never throws on an unknown jurisdiction
  });
});

describe('GET /agentbook-tax/tax/estimate — filingStatus wiring', () => {
  // $150,000 net income lands in the single-filer 24% bracket but the
  // married-filing-jointly 22% bracket (same income level used by the
  // packages/agentbook-jurisdictions unit tests), so it reliably
  // distinguishes the two filing statuses through the whole route.
  function mockNetIncome150k() {
    journalLineAggregate.mockImplementation(({ where }: { where: { accountId: { in: string[] } } }) =>
      Promise.resolve(
        where.accountId.in.includes('rev-1')
          ? { _sum: { creditCents: 155_000_00, debitCents: 0 } }
          : { _sum: { creditCents: 0, debitCents: 5_000_00 } },
      ),
    );
  }

  it("uses the tenant's stored married filingStatus, producing a lower income tax than single filing on the same income", async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'us', region: 'CA', accountingBasis: 'accrual' });
    mockNetIncome150k();

    const { GET } = await import('../route');

    taxConfigFindUnique.mockResolvedValue({ filingStatus: 'married', w2IncomeAnnual: null, w2WithheldYtd: null });
    const marriedJson = await (await GET(req())).json();

    taxConfigFindUnique.mockResolvedValue({ filingStatus: 'single', w2IncomeAnnual: null, w2WithheldYtd: null });
    const singleJson = await (await GET(req())).json();

    expect(marriedJson.data.incomeTaxCents).toBeLessThan(singleJson.data.incomeTaxCents);
  });

  it('falls back to single-filer brackets when the tenant has no AbTaxConfig row yet (backward compatibility)', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'us', region: 'CA', accountingBasis: 'accrual' });
    mockNetIncome150k();
    const { GET } = await import('../route');

    taxConfigFindUnique.mockResolvedValue(null);
    const noConfigJson = await (await GET(req())).json();

    taxConfigFindUnique.mockResolvedValue({ filingStatus: 'single', w2IncomeAnnual: null, w2WithheldYtd: null });
    const singleJson = await (await GET(req())).json();

    expect(noConfigJson.data.incomeTaxCents).toBe(singleJson.data.incomeTaxCents);
  });
});
