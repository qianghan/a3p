/**
 * Regression coverage for the AU mileage-rate bug (roadmap PR AU-2): the
 * POST /mileage route used to coerce any non-'ca' tenant jurisdiction to
 * 'us' before calling getMileageRate(), silently billing AU tenants at
 * the US 67¢/mi rate instead of the real ATO 88¢/km rate.
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
  it('an AU tenant (jurisdiction resolved from tenant config) books mileage at the ATO 88¢/km rate, not the US 67¢/mi rate', async () => {
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
    expect(body.data.ratePerUnitCents).toBe(88);
    expect(body.data.deductibleAmountCents).toBe(8_800); // 100 km × 88¢
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
    expect(body.data.ratePerUnitCents).toBe(88);
  });
});
