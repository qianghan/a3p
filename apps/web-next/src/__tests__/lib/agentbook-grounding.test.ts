import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The grounding pack is the ONLY thing an advisory answer may assert, so a
 * number missing from it is a number the advisor will tell the user it cannot
 * see. Production, on the Maya account:
 *
 *   "How is my revenue trending this year?"
 *   → "I can't see your revenue trends directly, as I only track your
 *      expenses and receivables."
 *
 * That was false. The same request's daily briefing read revenue, cash, net
 * income and burn straight out of the ledger via `buildFinancialContext`.
 * The pack simply never carried them, so the reviewer would have blocked any
 * figure the model quoted and the model, told to assert nothing beyond the
 * facts, correctly disclaimed.
 *
 * These assert the headline figures are IN the pack and are the ledger's own
 * numbers — not re-derived here, which is how the grounding facts and the
 * briefing drift apart in the first place.
 */

vi.mock('server-only', () => ({}));

const buildFinancialContext = vi.fn();
vi.mock('@agentbook-core/server', () => ({
  buildFinancialContext: (...args: unknown[]) => buildFinancialContext(...args),
}));

vi.mock('@naap/database', () => ({
  prisma: {
    abTenantConfig: { findUnique: vi.fn(async () => ({
      userId: 'tenant-maya', jurisdiction: 'ca', region: 'ON',
      businessType: 'sole_prop', taxEntityType: 'sole_prop', currency: 'CAD',
    })) },
    abExpense: { findMany: vi.fn(async () => []) },
    abAccount: { findMany: vi.fn(async () => []) },
    abInvoice: { findMany: vi.fn(async () => []) },
    abTaxEstimate: { findFirst: vi.fn(async () => null) },
  },
}));

const LEDGER = {
  currency: 'CAD',
  businessName: 'Maya Consulting',
  totalRevenueCents: 29_250_000,
  totalExpenseCents: 5_000_000,
  netIncomeCents: 24_250_000,
  cashBalanceCents: 1_692_610,
  monthlyBurnCents: 123_456,
  expenseCount: 42,
};

async function facts(): Promise<string[]> {
  const { buildGroundingFacts } = await import('@/lib/agentbook-grounding');
  return buildGroundingFacts('tenant-maya');
}

beforeEach(() => {
  vi.clearAllMocks();
  buildFinancialContext.mockResolvedValue({ ...LEDGER });
});

describe('the grounding pack carries the ledger headline numbers', () => {
  it('states revenue year to date', async () => {
    expect((await facts()).join('\n')).toContain('Revenue year to date');
    expect((await facts()).join('\n')).toContain('CA$292,500.00');
  });

  it('states cash on hand', async () => {
    expect((await facts()).join('\n')).toContain('Cash on hand: CA$16,926.10.');
  });

  it('states net income year to date', async () => {
    expect((await facts()).join('\n')).toContain('Net income year to date: CA$242,500.00.');
  });

  it('states average monthly burn', async () => {
    const out = (await facts()).join('\n');
    expect(out).toContain('Average monthly burn');
    expect(out).toContain('CA$1,234.56');
  });

  it('omits burn rather than asserting a zero the ledger cannot support', async () => {
    // A fact reads as a claim. "Average monthly burn: CA$0.00" on a tenant
    // with no recent expenses is a claim about their spending, not an absence
    // of data — and the reviewer would then wave that figure through.
    buildFinancialContext.mockResolvedValue({ ...LEDGER, monthlyBurnCents: 0 });
    expect((await facts()).join('\n')).not.toContain('Average monthly burn');
  });

  it('reads the figures from buildFinancialContext, not from its own queries', async () => {
    await facts();
    expect(buildFinancialContext).toHaveBeenCalledWith('tenant-maya', expect.anything());
  });

  it('still grounds the rest of the pack when the ledger read fails', async () => {
    // Partial grounding beats none: a consultation that can still cite the
    // tenant's expenses is worth having.
    buildFinancialContext.mockRejectedValue(new Error('ledger unavailable'));
    const out = (await facts()).join('\n');
    expect(out).toContain('Tenant profile');
    expect(out).toContain('Business expenses year to date');
  });
});
