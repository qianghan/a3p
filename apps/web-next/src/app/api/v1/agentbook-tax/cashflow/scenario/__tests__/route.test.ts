import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const tenantConfigFindUnique = vi.fn();
const accountFindMany = vi.fn();
const journalLineAggregate = vi.fn();

vi.mock('@naap/database', () => ({
  prisma: {
    abTenantConfig: { findUnique: (...a: unknown[]) => tenantConfigFindUnique(...a) },
    abAccount: { findMany: (...a: unknown[]) => accountFindMany(...a) },
    abJournalLine: { aggregate: (...a: unknown[]) => journalLineAggregate(...a) },
  },
}));

const safeResolveAgentbookTenant = vi.fn();
vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: (...a: unknown[]) => safeResolveAgentbookTenant(...a),
}));

function postReq(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://x/cashflow/scenario', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  safeResolveAgentbookTenant.mockResolvedValue({ tenantId: 'tenant-1' });
  accountFindMany.mockImplementation(({ where }: { where: { accountType: string } }) =>
    Promise.resolve(where.accountType === 'revenue' ? [{ id: 'rev-1' }] : [{ id: 'exp-1' }]),
  );
});

describe('POST /agentbook-tax/cashflow/scenario — AU tax correctness', () => {
  it('an AU tenant with $80,000 net income gets real ATO bracket + Medicare Levy tax, not $0 / US brackets', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'au', currency: 'AUD', locale: 'en-AU' });
    journalLineAggregate.mockImplementation(({ where }: { where: { accountId: { in: string[] } } }) =>
      Promise.resolve(
        where.accountId.in.includes('rev-1')
          ? { _sum: { creditCents: 80_000_00, debitCents: 0 } }
          : { _sum: { creditCents: 0, debitCents: 0 } },
      ),
    );

    const { POST } = await import('../route');
    const res = await POST(postReq({ changeAmountCents: 0 }));
    const json = await res.json();

    // $80,000 AUD net income:
    //   Medicare Levy (SE tax) = 2% of 8,000,000 cents = 160,000 cents ($1,600)
    //     — well above the $32,500 shading-out threshold, so full 2% applies.
    //   Income tax (2024-25 ATO brackets): $0 on the first $18,200 (0%),
    //     16% on $18,201–$45,000 ($26,800 × 16% = $4,288 = 428,800 cents),
    //     30% on $45,001–$80,000 ($35,000 × 30% = $10,500 = 1,050,000 cents)
    //     = 1,478,800 cents total.
    //   Total tax = 160,000 + 1,478,800 = 1,638,800 cents.
    expect(json.data.currentTaxCents).toBe(1_638_800);
  });

  it('an AU tenant with net income below the Medicare Levy low-income threshold pays $0 self-employment tax but still real income tax', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'au', currency: 'AUD', locale: 'en-AU' });
    journalLineAggregate.mockImplementation(({ where }: { where: { accountId: { in: string[] } } }) =>
      Promise.resolve(
        where.accountId.in.includes('rev-1')
          ? { _sum: { creditCents: 20_000_00, debitCents: 0 } }
          : { _sum: { creditCents: 0, debitCents: 0 } },
      ),
    );

    const { POST } = await import('../route');
    const res = await POST(postReq({ changeAmountCents: 0 }));
    const json = await res.json();

    // $20,000 net income is below the $26,000 Medicare Levy low-income
    // threshold → Medicare Levy = $0. Income tax: $0 on first $18,200,
    // 16% on the remaining $1,800 = $288 = 28,800 cents.
    expect(json.data.currentTaxCents).toBe(28_800);
  });

  it('scenario/explanation strings use the tenant\'s configured currency, not a hardcoded USD "$"', async () => {
    // Note: AUD formatted with an 'en-AU' locale renders as a plain "$",
    // visually identical to USD — that's correct `Intl` behavior, not a
    // bug, so it's not a useful discriminating check. GBP/en-GB renders
    // as "£", which unambiguously proves the tenant's real currency/
    // locale reached `fmt()` instead of a hardcoded 'USD'/'en-US'.
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'us', currency: 'GBP', locale: 'en-GB' });
    journalLineAggregate.mockImplementation(({ where }: { where: { accountId: { in: string[] } } }) =>
      Promise.resolve(
        where.accountId.in.includes('rev-1')
          ? { _sum: { creditCents: 80_000_00, debitCents: 0 } }
          : { _sum: { creditCents: 0, debitCents: 0 } },
      ),
    );

    const { POST } = await import('../route');
    // Add a £10,000 deductible expense — should read "Adding £10,000 ..." not "Adding $10,000.00 ...".
    const res = await POST(postReq({ changeAmountCents: 10_000_00 }));
    const json = await res.json();

    expect(json.data.scenario).toMatch(/£10,000/);
    expect(json.data.scenario).not.toMatch(/\$/);
  });

  it('US and CA scenarios still compute a positive, real tax figure (no jurisdiction lost a working calculation)', async () => {
    journalLineAggregate.mockImplementation(({ where }: { where: { accountId: { in: string[] } } }) =>
      Promise.resolve(
        where.accountId.in.includes('rev-1')
          ? { _sum: { creditCents: 80_000_00, debitCents: 0 } }
          : { _sum: { creditCents: 0, debitCents: 0 } },
      ),
    );

    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'us', currency: 'USD', locale: 'en-US' });
    const { POST } = await import('../route');
    const resUs = await POST(postReq({ changeAmountCents: 0 }));
    const jsonUs = await resUs.json();
    expect(jsonUs.data.currentTaxCents).toBeGreaterThan(0);

    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'ca', currency: 'CAD', locale: 'en-CA' });
    const resCa = await POST(postReq({ changeAmountCents: 0 }));
    const jsonCa = await resCa.json();
    expect(jsonCa.data.currentTaxCents).toBeGreaterThan(0);
  });
});
