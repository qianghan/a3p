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
 * income and burn straight out of the ledger. The pack simply never carried
 * them, so the reviewer would have blocked any figure the model quoted and the
 * model, told to assert nothing beyond the facts, correctly disclaimed.
 *
 * These assert the headline figures are IN the pack and are the ledger's own
 * numbers — not re-derived here, which is how the grounding facts and the
 * briefing drift apart in the first place.
 */

vi.mock('server-only', () => ({}));

const buildLedgerHeadline = vi.fn();
vi.mock('@agentbook-core/server', () => ({
  buildLedgerHeadline: (...args: unknown[]) => buildLedgerHeadline(...args),
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
  revenueCents: 29_250_000,
  expenseCents: 5_000_000,
  netIncomeCents: 24_250_000,
  cashBalanceCents: 1_692_610,
  monthlyBurnCents: 123_456,
};

const YEAR = new Date().getFullYear();

async function facts(): Promise<string[]> {
  const { buildGroundingFacts } = await import('@/lib/agentbook-grounding');
  return buildGroundingFacts('tenant-maya');
}

beforeEach(() => {
  vi.clearAllMocks();
  buildLedgerHeadline.mockResolvedValue({ ...LEDGER });
});

describe('the grounding pack carries the ledger headline numbers', () => {
  it('names the window on revenue rather than saying "year to date"', async () => {
    // "Year to date" is 1 July to 30 June for an Australian sole trader, and
    // this figure is a calendar-year total. Same string, two windows, one of
    // them wrong — so the fact states the date it counts from.
    const out = (await facts()).join('\n');
    expect(out).toContain(`Revenue since 1 January ${YEAR} (posted to the ledger): CA$292,500.00.`);
    expect(out).not.toContain('year to date');
  });

  it('states cash on hand', async () => {
    expect((await facts()).join('\n')).toContain('Cash on hand: CA$16,926.10.');
  });

  it('names the window on net income', async () => {
    expect((await facts()).join('\n')).toContain(`Net income since 1 January ${YEAR}: CA$242,500.00.`);
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
    buildLedgerHeadline.mockResolvedValue({ ...LEDGER, monthlyBurnCents: 0 });
    expect((await facts()).join('\n')).not.toContain('Average monthly burn');
  });

  it('asks the ledger for exactly the window it then labels the facts with', async () => {
    // `expect.anything()` here would pass on a call that fetched all-time
    // figures and printed them under a dated label — the defect this whole
    // file exists to catch. Assert the date itself.
    await facts();
    expect(buildLedgerHeadline).toHaveBeenCalledWith(
      'tenant-maya',
      new Date(new Date().getFullYear(), 0, 1),
      { currency: 'CAD' },
    );
  });

  it('still grounds the rest of the pack when the ledger read fails', async () => {
    // Partial grounding beats none: a consultation that can still cite the
    // tenant's expenses is worth having.
    buildLedgerHeadline.mockRejectedValue(new Error('ledger unavailable'));
    const out = (await facts()).join('\n');
    expect(out).toContain('Tenant profile');
    expect(out).toContain(`Business expenses since 1 January ${YEAR}`);
  });
});
