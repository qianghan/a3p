/**
 * Two things the POST route has to get right about WHERE the tenant is.
 *
 * 1. The CRA's extra 4c/km in NT, YT and NU. The route is the write path the
 *    app itself uses, so a region it fails to read means a territories tenant
 *    under-claims on every trip logged through the UI.
 *
 * 2. `jurisdictionOverride` means what it says, for all four values. The
 *    config is now read unconditionally (region has no override), and the
 *    obvious way to write that resolution drops 'us' on the floor: a caller
 *    that explicitly asked for US treatment silently gets the tenant's own
 *    jurisdiction instead, at a different rate in a different unit.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const tenantConfigFindUnique = vi.fn();
const mileageEntryCreate = vi.fn();
const mileageEntryFindMany = vi.fn();
const journalEntryUpdate = vi.fn();
const eventCreate = vi.fn();

vi.mock('@naap/database', () => ({
  prisma: {
    abTenantConfig: { findUnique: (...a: unknown[]) => tenantConfigFindUnique(...a) },
    abMileageEntry: {
      create: (...a: unknown[]) => mileageEntryCreate(...a),
      findMany: (...a: unknown[]) => mileageEntryFindMany(...a),
    },
    abJournalEntry: { update: (...a: unknown[]) => journalEntryUpdate(...a) },
    abEvent: { create: (...a: unknown[]) => eventCreate(...a) },
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        abJournalEntry: { update: (...a: unknown[]) => journalEntryUpdate(...a) },
        abMileageEntry: { create: (...a: unknown[]) => mileageEntryCreate(...a) },
        abEvent: { create: (...a: unknown[]) => eventCreate(...a) },
      }),
  },
}));

const safeResolveAgentbookTenant = vi.fn();
vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: (...a: unknown[]) => safeResolveAgentbookTenant(...a),
}));

const resolveVehicleAccounts = vi.fn();
vi.mock('@/lib/agentbook-account-resolver', () => ({
  resolveVehicleAccounts: (...a: unknown[]) => resolveVehicleAccounts(...a),
}));

beforeEach(() => {
  vi.clearAllMocks();
  safeResolveAgentbookTenant.mockResolvedValue({ tenantId: 'tenant-1' });
  resolveVehicleAccounts.mockResolvedValue(null);
  eventCreate.mockResolvedValue({});
  mileageEntryFindMany.mockResolvedValue([]);
  mileageEntryCreate.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
    id: 'entry-1', ...data,
  }));
});

async function post(body: Record<string, unknown>) {
  const { POST } = await import('../route');
  const res = await POST(new NextRequest('http://x/mileage', {
    method: 'POST', body: JSON.stringify(body),
  }));
  return { res, body: await res.json() };
}

/** The CA tiers for the trip's own year, read from the table not written here. */
async function craFirstTierCents() {
  const { getMileageRate } = await import('@/lib/agentbook-mileage-rates');
  return getMileageRate('ca', new Date().getUTCFullYear(), 0).ratePerUnitCents;
}

describe('POST /agentbook-expense/mileage — the tenant region reaches the rate', () => {
  it('a Yukon tenant is billed the territorial rate, not the provincial one', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'ca', region: 'YT' });

    const { res, body } = await post({ miles: 100, purpose: 'Client site visit' });
    const provincial = await craFirstTierCents();

    expect(res.status).toBe(201);
    expect(body.data.jurisdiction).toBe('ca');
    expect(body.data.unit).toBe('km');
    expect(body.data.ratePerUnitCents).toBe(provincial + 4);
    expect(body.data.deductibleAmountCents).toBe(100 * (provincial + 4));
    // The bug: the provincial rate, 4c/km short on every kilometre.
    expect(body.data.ratePerUnitCents).not.toBe(provincial);
  });

  it('an Ontario tenant is unaffected', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'ca', region: 'ON' });
    const { body } = await post({ miles: 100, purpose: 'Client site visit' });
    expect(body.data.ratePerUnitCents).toBe(await craFirstTierCents());
  });

  it('reads the region even for a config row that predates code normalization', async () => {
    // `normalizeRegionCode` maps YUKON -> YT on write, but only on write, and
    // there was no backfill. An older row can still hold the full name.
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'ca', region: 'Yukon' });
    const { body } = await post({ miles: 100, purpose: 'Client site visit' });
    expect(body.data.ratePerUnitCents).toBe((await craFirstTierCents()) + 4);
  });

  it('does not read a region left over from a different country', async () => {
    // NT is Australia's Northern Territory too. A tenant whose config says AU
    // must not pick up a CRA top-up when a caller bills the trip as CA.
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'au', region: 'NT' });
    const { body } = await post({ miles: 100, purpose: 'x', jurisdictionOverride: 'ca' });
    expect(body.data.jurisdiction).toBe('ca');
    expect(body.data.ratePerUnitCents).toBe(await craFirstTierCents());
  });
});

describe('POST /agentbook-expense/mileage — jurisdictionOverride wins, all four values', () => {
  it("honours an explicit 'us' override against a CA tenant config", async () => {
    // The regression this guards: 'us' is a declared value of
    // `jurisdictionOverride`, and dropping it means the caller gets km at a
    // CRA rate when it asked for miles at the IRS rate.
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'ca', region: 'YT' });

    const { res, body } = await post({ miles: 100, purpose: 'x', jurisdictionOverride: 'us' });
    expect(res.status).toBe(201);
    expect(body.data.jurisdiction).toBe('us');
    expect(body.data.unit).toBe('mi');

    const { usMileageRate } = await import('@agentbook/jurisdictions');
    const now = new Date();
    expect(body.data.ratePerUnitCents).toBe(usMileageRate.getRate(now.getUTCFullYear(), 0, now).rate * 100);
  });

  it.each(['us', 'ca', 'au', 'uk'] as const)("an override of '%s' is the booked jurisdiction", async (j) => {
    // Config deliberately disagrees with every one of them in turn.
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: j === 'uk' ? 'us' : 'uk', region: '' });
    const { body } = await post({ miles: 10, purpose: 'x', jurisdictionOverride: j });
    expect(body.data.jurisdiction).toBe(j);
  });
});
