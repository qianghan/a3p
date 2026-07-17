/**
 * Unit tests for the multi-currency leg of `createInvoiceDraft` (PR 13).
 *
 * The classic "$5K consulting" path is covered by the e2e suite. Here we
 * focus on the conversion math:
 *
 *   • USD-quoted invoice for a USD tenant → no original* fields set.
 *   • EUR-quoted invoice for a USD tenant @ rate 1.08 → booked in USD,
 *     original* fields populated.
 *   • EUR-quoted invoice for a USD tenant where the rate is unavailable
 *     → booked in EUR (graceful degradation), original* fields NOT set.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

vi.mock('@naap/database', () => {
  return {
    prisma: {
      abTenantConfig: { findUnique: vi.fn() },
      abInvoice: { findFirst: vi.fn(), create: vi.fn() },
      abEvent: { create: vi.fn() },
      abSalesTaxCollected: { createMany: vi.fn() },
      abFxRate: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        upsert: vi.fn(),
      },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          abInvoice: {
            findFirst: vi.fn().mockResolvedValue(null),
            create: vi.fn(async (args: { data: Record<string, unknown> }) => ({
              id: 'inv-1',
              number: 'INV-2026-0001',
              ...args.data,
              lines: (args.data.lines as { create: unknown[] } | undefined)?.create ?? [],
            })),
          },
        }),
      ),
    },
  };
});

import { prisma as db } from '@naap/database';
import { createInvoiceDraft } from './agentbook-invoice-draft';

const mockedDb = db as unknown as {
  abTenantConfig: { findUnique: ReturnType<typeof vi.fn> };
  abEvent: { create: ReturnType<typeof vi.fn> };
  abSalesTaxCollected: { createMany: ReturnType<typeof vi.fn> };
  abFxRate: {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
  };
  $transaction: ReturnType<typeof vi.fn>;
};

const fetchMock = vi.fn();
global.fetch = fetchMock as unknown as typeof fetch;

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  mockedDb.abTenantConfig.findUnique.mockResolvedValue({ currency: 'USD' });
  mockedDb.abEvent.create.mockResolvedValue({});
  mockedDb.abSalesTaxCollected.createMany.mockResolvedValue({});
  mockedDb.abFxRate.findUnique.mockResolvedValue(null);
  mockedDb.abFxRate.findFirst.mockResolvedValue(null);
  mockedDb.abFxRate.upsert.mockResolvedValue({});
});

const baseInput = {
  tenantId: 'tenant-1',
  client: { id: 'c1', name: 'Beta', email: 'b@x.com' },
};

describe('createInvoiceDraft — multi-currency', () => {
  it('USD invoice for a USD tenant: no original* fields', async () => {
    const result = await createInvoiceDraft({
      ...baseInput,
      parsed: {
        currencyHint: 'USD',
        lines: [{ description: 'consulting', rateCents: 500_000, quantity: 1 }],
      },
    });

    expect(result.currency).toBe('USD');
    expect(result.totalCents).toBe(500_000);
    expect(result.originalCurrency).toBeUndefined();
    expect(result.fxRate).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('EUR invoice for a USD tenant: converts at fetched rate, populates original*', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ amount: 1, base: 'EUR', date: '2026-05-06', rates: { USD: 1.08 } }),
    });

    const result = await createInvoiceDraft({
      ...baseInput,
      parsed: {
        currencyHint: 'EUR',
        lines: [{ description: 'design', rateCents: 50_000, quantity: 1 }], // €500.00
      },
    });

    // Booked in tenant currency (USD)
    expect(result.currency).toBe('USD');
    expect(result.totalCents).toBe(54_000); // $540.00
    // Original currency tracking
    expect(result.originalCurrency).toBe('EUR');
    expect(result.originalAmountCents).toBe(50_000);
    expect(result.fxRate).toBeCloseTo(1.08, 4);
    expect(result.fxRateSource).toBe('ecb');
  });

  it('falls back to booking in quoted currency when no rate available', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    mockedDb.abFxRate.findFirst.mockResolvedValue(null);

    const result = await createInvoiceDraft({
      ...baseInput,
      parsed: {
        currencyHint: 'EUR',
        lines: [{ description: 'design', rateCents: 50_000, quantity: 1 }],
      },
    });

    // No conversion possible — book in tenant currency *amount* anyway,
    // do NOT lie about an FX rate. original* must remain unset.
    expect(result.currency).toBe('USD');
    expect(result.totalCents).toBe(50_000);
    expect(result.originalCurrency).toBeUndefined();
    expect(result.fxRate).toBeUndefined();
  });
});

describe('createInvoiceDraft — sales tax (Launch-gap PR-6)', () => {
  it('US tenant: taxCents 0, taxRate null, no AbSalesTaxCollected write', async () => {
    mockedDb.abTenantConfig.findUnique.mockResolvedValue({ currency: 'USD', jurisdiction: 'us', region: '' });

    const result = await createInvoiceDraft({
      ...baseInput,
      parsed: {
        currencyHint: 'USD',
        lines: [{ description: 'consulting', rateCents: 500_000, quantity: 1 }],
      },
    });

    expect(result.totalCents).toBe(500_000);
    expect(result.taxCents).toBe(0);
    expect(result.taxRate).toBeNull();
    expect(mockedDb.abSalesTaxCollected.createMany).not.toHaveBeenCalled();
  });

  it('AU tenant: correct taxCents/taxRate, grand total as amountCents/totalCents, one AbSalesTaxCollected row', async () => {
    mockedDb.abTenantConfig.findUnique.mockResolvedValue({ currency: 'USD', jurisdiction: 'au', region: '' });

    const result = await createInvoiceDraft({
      ...baseInput,
      parsed: {
        currencyHint: 'USD',
        lines: [{ description: 'consulting', rateCents: 500_000, quantity: 1 }],
      },
    });

    // 10% flat GST on a 500,000¢ subtotal.
    expect(result.taxRate).toBe(0.10);
    expect(result.taxCents).toBe(50_000);
    expect(result.totalCents).toBe(550_000); // subtotal + tax

    expect(mockedDb.abSalesTaxCollected.createMany).toHaveBeenCalledTimes(1);
    const call = mockedDb.abSalesTaxCollected.createMany.mock.calls[0][0] as {
      data: Array<{ tenantId: string; invoiceId: string; jurisdiction: string; region: string; taxType: string; rate: number; amountCents: number }>;
    };
    expect(call.data).toEqual([
      { tenantId: 'tenant-1', invoiceId: 'inv-1', jurisdiction: 'au', region: '', taxType: 'GST', rate: 0.10, amountCents: 50_000 },
    ]);
  });

  it('FX path: tax is computed on the converted (booked) total, not the original quoted total', async () => {
    mockedDb.abTenantConfig.findUnique.mockResolvedValue({ currency: 'USD', jurisdiction: 'au', region: '' });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ amount: 1, base: 'EUR', date: '2026-05-06', rates: { USD: 1.08 } }),
    });

    const result = await createInvoiceDraft({
      ...baseInput,
      parsed: {
        currencyHint: 'EUR',
        lines: [{ description: 'design', rateCents: 50_000, quantity: 1 }], // €500.00
      },
    });

    // Booked (converted) total is $540.00 (54,000¢); tax must be 10% of
    // *that*, not of the €500.00 (50,000¢) quoted total.
    expect(result.currency).toBe('USD');
    expect(result.originalAmountCents).toBe(50_000);
    expect(result.taxRate).toBe(0.10);
    expect(result.taxCents).toBe(5_400); // 10% of 54,000, not of 50,000
    expect(result.totalCents).toBe(59_400); // 54,000 + 5,400
  });
});
