/**
 * Regression coverage for the AU mileage-rate bug (roadmap PR AU-2): the
 * POST /mileage route used to coerce any non-'ca' tenant jurisdiction to
 * 'us' before calling getMileageRate(), silently billing AU tenants at
 * the US rate instead of the real ATO cents-per-km rate.
 *
 * The expected rate is read from the jurisdictions pack for the trip's own
 * income year rather than written here as a literal. It was `88`, which broke
 * on 1 July 2026 when the ATO moved to 91c — a date-dependent assertion that
 * fails annually tells you nothing about jurisdiction routing, which is what
 * this file is for.
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
});

describe('POST /agentbook-expense/mileage — AU jurisdiction', () => {
  it('an AU tenant (jurisdiction resolved from tenant config) books mileage at the ATO cents-per-km rate, not the US per-mile rate', async () => {
    // Arrange: tenant config resolves to AU jurisdiction, no override passed.
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'au' });
    mileageEntryCreate.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
      id: 'entry-au-1',
      ...data,
    }));

    const { POST } = await import('../route');
    const req = new NextRequest('http://x/mileage', {
      method: 'POST',
      body: JSON.stringify({ miles: 100, purpose: 'Client site visit' }),
    });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data.jurisdiction).toBe('au');
    expect(body.data.unit).toBe('km');
    const { auMileageRate, auFinancialYearOf, usMileageRate } = await import('@agentbook/jurisdictions');
    const now = new Date();
    const atoCents = Math.round(auMileageRate.getRate(auFinancialYearOf(now), 0).rate * 100);
    expect(body.data.ratePerUnitCents).toBe(atoCents);
    expect(body.data.deductibleAmountCents).toBe(100 * atoCents);
    // The point of the test: not the US rate.
    expect(body.data.ratePerUnitCents).not.toBe(usMileageRate.getRate(now.getUTCFullYear(), 0, now).rate * 100);
  });

  it('an AU tenant passing jurisdictionOverride is honored the same as us/ca', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'us' }); // config says US...
    mileageEntryCreate.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
      id: 'entry-au-2',
      ...data,
    }));

    const { POST } = await import('../route');
    const req = new NextRequest('http://x/mileage', {
      method: 'POST',
      // ...but the caller (bot) explicitly overrides to AU, e.g. after
      // looking up the tenant's real jurisdiction itself.
      body: JSON.stringify({ miles: 50, purpose: 'Depot run', jurisdictionOverride: 'au' }),
    });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data.jurisdiction).toBe('au');
    const { auMileageRate, auFinancialYearOf } = await import('@agentbook/jurisdictions');
    expect(body.data.ratePerUnitCents).toBe(
      Math.round(auMileageRate.getRate(auFinancialYearOf(new Date()), 0).rate * 100),
    );
  });
});
