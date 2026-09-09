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

  it('falls back to a "state" (not "GST") component for an override on a US tenant with an unlisted/unrecognized state, since GST is a CA/AU-specific label', async () => {
    // 'ZZ' is not a real US state code — every real state now has an
    // explicit STATE_RATES entry (US-GATE remediation), so a genuinely
    // unrecognized code is needed here to still exercise the fallback path.
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'us', region: 'ZZ' });
    const result = await computeInvoiceTax('t1', 10000, 0.06625);
    expect(result.taxRate).toBe(0.06625);
    expect(result.taxCents).toBe(663);
    expect(result.components).toEqual([{ type: 'state', rate: 0.06625, amountCents: 663, accountCode: '2100' }]);
  });
});

describe('computeInvoiceTax — AU GST registration', () => {
  /**
   * The wiring layer. `auGstApplies` being correct in the jurisdictions pack
   * proves nothing on its own: the bug was that nothing consulted it, and a
   * test of the helper alone would have passed throughout.
   */
  it('charges NO GST once the tenant says they are not registered', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'au', region: '', gstRegistered: false });
    const result = await computeInvoiceTax('t1', 10000);
    expect(result.taxCents).toBe(0);
    expect(result.taxRate).toBe(0);
    expect(result.components).toEqual([]);
  });

  it('charges GST for a registered tenant', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'au', region: '', gstRegistered: true });
    expect((await computeInvoiceTax('t1', 10000)).taxCents).toBe(1000);
  });

  it('leaves the unanswered case charging GST, exactly as before', async () => {
    // The no-silent-change guarantee, asserted rather than assumed: an
    // existing AU tenant's invoices must not change under them on deploy.
    for (const cfg of [{ gstRegistered: null }, {}]) {
      tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'au', region: '', ...cfg });
      expect((await computeInvoiceTax('t1', 10000)).taxCents).toBe(1000);
    }
  });

  it('reads the registration flag at all', async () => {
    // A `select` that forgets the column returns undefined for it, which
    // reads as "unknown" and silently restores the old behaviour for
    // everyone — a failure mode with no other visible symptom.
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'au', region: '', gstRegistered: false });
    await computeInvoiceTax('t1', 10000);
    expect(tenantConfigFindUnique.mock.calls[0][0].select).toHaveProperty('gstRegistered', true);
  });

  it('still honours an explicit non-zero override from an unregistered tenant', async () => {
    // Per-invoice override is the user overriding us, not us overriding them.
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'au', region: '', gstRegistered: false });
    const result = await computeInvoiceTax('t1', 10000, 0.10);
    expect(result.taxCents).toBe(1000);
  });

  it('does not touch CA or US, which have no registration gate here', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'ca', region: 'ON', gstRegistered: false });
    expect((await computeInvoiceTax('t1', 10000)).taxCents).toBe(1300);
  });
});
