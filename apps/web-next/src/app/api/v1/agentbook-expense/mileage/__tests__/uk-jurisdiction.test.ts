/**
 * Regression coverage for the UK mileage-rate gap: the POST /mileage route
 * hard-typed jurisdiction to 'us' | 'ca' | 'au', silently coercing any UK
 * tenant to 'us' before calling getMileageRate(), billing UK tenants at the
 * US 67¢/mi IRS rate instead of the real HMRC AMAP 45p/mile rate (which
 * already existed, unused, in packages/agentbook-jurisdictions/src/uk/
 * mileage-rate.ts).
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

describe('POST /agentbook-expense/mileage — UK jurisdiction', () => {
  it('a UK tenant (jurisdiction resolved from tenant config) books mileage at the HMRC AMAP 45p/mile rate, not the US 67¢/mi rate', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'uk' });
    mileageEntryCreate.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
      id: 'entry-uk-1',
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
    expect(body.data.jurisdiction).toBe('uk');
    expect(body.data.unit).toBe('mi');
    expect(body.data.ratePerUnitCents).toBe(45);
    expect(body.data.deductibleAmountCents).toBe(4_500); // 100 mi × 45p
  });

  it('a UK tenant passing jurisdictionOverride is honored the same as us/ca/au', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'us' }); // config says US...
    mileageEntryCreate.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
      id: 'entry-uk-2',
      ...data,
    }));

    const { POST } = await import('../route');
    const req = new NextRequest('http://x/mileage', {
      method: 'POST',
      // ...but the caller (bot) explicitly overrides to UK.
      body: JSON.stringify({ miles: 50, purpose: 'Depot run', jurisdictionOverride: 'uk' }),
    });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data.jurisdiction).toBe('uk');
    expect(body.data.ratePerUnitCents).toBe(45);
  });

  it('a UK tenant past the 10,000-mile AMAP threshold gets the flat 25p/mile second-tier rate for the whole trip, not the 45p first-tier rate', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'uk' });
    // 10,500 miles already booked this calendar year before this trip —
    // past the 10,000-mile AMAP threshold, so this whole new trip uses the
    // flat second-tier rate (same "whichever tier YTD-before-trip lands
    // in" boundary policy this file already applies to CA — see
    // agentbook-mileage-rates.ts's documented Boundary policy).
    mileageEntryFindMany.mockResolvedValue([{ miles: 10_500 }]);
    mileageEntryCreate.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
      id: 'entry-uk-3',
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
    expect(body.data.ratePerUnitCents).toBe(25);
    expect(body.data.deductibleAmountCents).toBe(2_500); // 100 mi × 25p
  });
});
