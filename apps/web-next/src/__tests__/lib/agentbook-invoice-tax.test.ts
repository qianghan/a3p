import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const tenantConfigFindUnique = vi.fn();
vi.mock('@naap/database', () => ({
  prisma: { abTenantConfig: { findUnique: (...a: unknown[]) => tenantConfigFindUnique(...a) } },
}));

import { computeInvoiceTax } from '@/lib/agentbook-invoice-tax';

beforeEach(() => {
  tenantConfigFindUnique.mockReset();
});

describe('computeInvoiceTax', () => {
  it('returns zero tax for a zero or negative subtotal without querying tenant config', async () => {
    const result = await computeInvoiceTax('t1', 0);
    expect(result).toEqual({ taxRate: 0, taxCents: 0, components: [] });
    expect(tenantConfigFindUnique).not.toHaveBeenCalled();
  });

  it('applies flat 10% GST for an AU tenant', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'au', region: '' });
    const result = await computeInvoiceTax('t1', 10000);
    expect(result.taxRate).toBe(0.10);
    expect(result.taxCents).toBe(1000);
    expect(result.components).toEqual([{ type: 'GST', rate: 0.10, amountCents: 1000, accountCode: '2100' }]);
  });

  it('applies a single GST/HST component for an ON (HST) tenant, crediting account 2100', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'ca', region: 'ON' });
    const result = await computeInvoiceTax('t1', 10000);
    expect(result.taxRate).toBe(0.13);
    expect(result.taxCents).toBe(1300);
    expect(result.components).toEqual([{ type: 'HST', rate: 0.13, amountCents: 1300, accountCode: '2100' }]);
  });

  it('splits GST and QST into two components with different liability account codes for a QC tenant', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'ca', region: 'QC' });
    const result = await computeInvoiceTax('t1', 10000);
    expect(result.taxRate).toBeCloseTo(0.14975);
    expect(result.taxCents).toBe(1498); // 500 (GST) + 998 (QST), matches ca-pack.test.ts's own fixture
    expect(result.components).toEqual([
      { type: 'GST', rate: 0.05, amountCents: 500, accountCode: '2100' },
      { type: 'PST', rate: 0.09975, amountCents: 998, accountCode: '2200' },
    ]);
  });

  it('applies a single state-tax component for a US tenant in California (7.25%), crediting account 2100', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'us', region: 'CA' });
    const result = await computeInvoiceTax('t1', 10000);
    expect(result.taxRate).toBe(0.0725);
    expect(result.taxCents).toBe(725);
    expect(result.components).toEqual([{ type: 'state', rate: 0.0725, amountCents: 725, accountCode: '2100' }]);
  });

  it('returns zero tax for a US tenant in a no-sales-tax state (Oregon)', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'us', region: 'OR' });
    const result = await computeInvoiceTax('t1', 10000);
    expect(result).toEqual({ taxRate: 0, taxCents: 0, components: [] });
  });

  it('returns zero tax for a US tenant with no region set', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'us', region: '' });
    const result = await computeInvoiceTax('t1', 10000);
    expect(result).toEqual({ taxRate: 0, taxCents: 0, components: [] });
  });

  it('respects an explicit overrideRate for a US tenant with a recognized state instead of the jurisdiction default', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'us', region: 'CA' });
    const result = await computeInvoiceTax('t1', 10000, 0.05);
    expect(result.taxRate).toBe(0.05);
    expect(result.taxCents).toBe(500);
    expect(result.components).toEqual([{ type: 'state', rate: 0.05, amountCents: 500, accountCode: '2100' }]);
  });

  it('defaults to us (zero tax) when the tenant has no config row at all', async () => {
    tenantConfigFindUnique.mockResolvedValue(null);
    const result = await computeInvoiceTax('t1', 10000);
    expect(result).toEqual({ taxRate: 0, taxCents: 0, components: [] });
  });

  it('respects an explicit overrideRate for an AU tenant instead of the jurisdiction default', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'au', region: '' });
    const result = await computeInvoiceTax('t1', 10000, 0.05);
    expect(result.taxRate).toBe(0.05);
    expect(result.taxCents).toBe(500);
    expect(result.components).toEqual([{ type: 'GST', rate: 0.05, amountCents: 500, accountCode: '2100' }]);
  });

  it('overrideRate of 0 produces zero tax with no components', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'au', region: '' });
    const result = await computeInvoiceTax('t1', 10000, 0);
    expect(result.taxCents).toBe(0);
    expect(result.components).toEqual([]);
  });

  it('scales a QC tenant\'s GST/QST split proportionally under an overrideRate, instead of collapsing it into one component', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'ca', region: 'QC' });
    // QC's default combined rate is 0.14975 (0.05 GST + 0.09975 QST). Override
    // to exactly half that (0.074875) and confirm both components scale by
    // the same 0.5 factor, preserving the split rather than dumping the
    // whole override into a single GST/HST (2100) line.
    const result = await computeInvoiceTax('t1', 10000, 0.074875);
    expect(result.taxRate).toBe(0.074875);
    expect(result.components).toEqual([
      { type: 'GST', rate: 0.025, amountCents: 250, accountCode: '2100' },
      { type: 'PST', rate: 0.049875, amountCents: 499, accountCode: '2200' },
    ]);
    expect(result.taxCents).toBe(749); // 250 + 499
  });

  it('falls back to a single GST/HST (2100) component for an override on a CA tenant with no recognized province, rather than silently dropping the tax', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'ca', region: 'ZZ' });
    const result = await computeInvoiceTax('t1', 10000, 0.05);
    expect(result.taxRate).toBe(0.05);
    expect(result.taxCents).toBe(500);
    expect(result.components).toEqual([{ type: 'GST', rate: 0.05, amountCents: 500, accountCode: '2100' }]);
  });
});
