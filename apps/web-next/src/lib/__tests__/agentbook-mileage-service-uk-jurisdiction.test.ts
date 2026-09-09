/**
 * Regression coverage for the UK jurisdiction gap in updateMileageEntry
 * (shared by the PATCH /mileage/[id] route and the Telegram "Edit miles"
 * flow — see agentbook-mileage-service.ts's own header comment). The tier
 * recompute only checked `existing.jurisdiction === 'ca' | 'au'`, so editing
 * a correctly-booked UK mileage entry silently repriced it at the flat US
 * rate via the `else` branch's hardcoded `getMileageRate('us', ...)`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const mileageEntryFindFirst = vi.fn();
const mileageEntryFindMany = vi.fn();
const mileageEntryUpdate = vi.fn();
const eventCreate = vi.fn();

vi.mock('@naap/database', () => ({
  prisma: {
    abMileageEntry: {
      findFirst: (...a: unknown[]) => mileageEntryFindFirst(...a),
      findMany: (...a: unknown[]) => mileageEntryFindMany(...a),
      update: (...a: unknown[]) => mileageEntryUpdate(...a),
    },
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        abMileageEntry: { update: (...a: unknown[]) => mileageEntryUpdate(...a) },
        abEvent: { create: (...a: unknown[]) => eventCreate(...a) },
        abJournalEntry: { findUnique: vi.fn(), create: vi.fn() },
      }),
  },
}));

vi.mock('../agentbook-account-resolver', () => ({
  resolveVehicleAccounts: vi.fn(async () => null),
}));

import { updateMileageEntry } from '../agentbook-mileage-service';

beforeEach(() => {
  vi.clearAllMocks();
  mileageEntryFindMany.mockResolvedValue([]);
  eventCreate.mockResolvedValue({});
});

describe('updateMileageEntry — UK jurisdiction', () => {
  it('recomputes a UK entry at the HMRC AMAP rate on edit, not the flat US rate', async () => {
    mileageEntryFindFirst.mockResolvedValue({
      id: 'entry-1',
      tenantId: 'tenant-1',
      date: new Date('2026-03-01T00:00:00.000Z'),
      miles: 100,
      unit: 'mi',
      purpose: 'Client visit',
      clientId: null,
      jurisdiction: 'uk',
      ratePerUnitCents: 45,
      deductibleAmountCents: 4_500,
      journalEntryId: null,
      deletedAt: null,
    });
    mileageEntryUpdate.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
      id: 'entry-1',
      ...data,
    }));

    const result = await updateMileageEntry('tenant-1', 'entry-1', { miles: 200 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.ratePerUnitCents).toBe(45);
      expect(result.entry.deductibleAmountCents).toBe(9_000); // 200 mi × 45p
    }
  });
});

describe('updateMileageEntry — AU cap', () => {
  /**
   * The create path refuses to book more than 5,000 km under the ATO
   * cents-per-km method. The edit path has to refuse it too, or the cap is
   * one PATCH away from being bypassed entirely.
   */
  it('caps an AU entry edited up past 5,000 km', async () => {
    mileageEntryFindFirst.mockResolvedValue({
      id: 'entry-au',
      tenantId: 'tenant-1',
      date: new Date('2025-08-15T00:00:00.000Z'), // FY2025-26
      miles: 4_000,
      unit: 'km',
      purpose: 'Site visits',
      clientId: null,
      jurisdiction: 'au',
      ratePerUnitCents: 88,
      deductibleAmountCents: 352_000,
      journalEntryId: null,
      deletedAt: null,
    });
    mileageEntryUpdate.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
      id: 'entry-au',
      ...data,
    }));

    const result = await updateMileageEntry('tenant-1', 'entry-au', { miles: 12_000 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // 5,000 km x 88c = A$4,400, not 12,000 x 88c = A$10,560.
      expect(result.entry.deductibleAmountCents).toBe(440_000);
      // The distance the user actually drove is still recorded.
      expect(result.entry.miles).toBe(12_000);
    }
  });

  it('looks back to 1 July, not 1 January, when summing the year so far', async () => {
    mileageEntryFindFirst.mockResolvedValue({
      id: 'entry-au2',
      tenantId: 'tenant-1',
      date: new Date('2026-03-01T00:00:00.000Z'), // still FY2025-26
      miles: 100,
      unit: 'km',
      purpose: 'Site visits',
      clientId: null,
      jurisdiction: 'au',
      ratePerUnitCents: 88,
      deductibleAmountCents: 8_800,
      journalEntryId: null,
      deletedAt: null,
    });
    mileageEntryUpdate.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
      id: 'entry-au2', ...data,
    }));

    await updateMileageEntry('tenant-1', 'entry-au2', { miles: 200 });

    // Asserted on the query, not the result: a calendar-year window would ask
    // for 1 Jan 2026 and miss the 5,000 km already claimed in Jul-Dec 2025,
    // handing the taxpayer a second allowance mid-year.
    const where = mileageEntryFindMany.mock.calls[0][0].where;
    expect(where.date.gte.toISOString()).toBe('2025-07-01T00:00:00.000Z');
  });
});
