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
