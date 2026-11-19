import { describe, it, expect } from 'vitest';
import { computeTenantLineTax, tenantDefaultTaxCode, tenantTaxCodes, taxJurisdictionOf } from '../tax-codes';

describe('lib/tax-codes adapter', () => {
  it('sydney-shaped AU registrant: $110 incl GST -> net 10000, recoverable 1000', () => {
    const r = computeTenantLineTax({ jurisdiction: 'AU', gstRegistered: true }, { taxCode: 'GST', amountCents: 11000, inclusive: true });
    expect([r?.netCents, r?.recoverableTaxCents]).toEqual([10000, 1000]);
  });
  it('maps missing registration to null -> recoverable 0', () => {
    const r = computeTenantLineTax({ jurisdiction: 'au' }, { taxCode: 'GST', amountCents: 11000, inclusive: true });
    expect([r?.taxCents, r?.recoverableTaxCents]).toEqual([1000, 0]);
  });
  it('passes qstRegistered and region through (QC)', () => {
    const t = { jurisdiction: 'ca', region: 'QC', gstRegistered: true, qstRegistered: true };
    expect(tenantDefaultTaxCode(t)).toBe('GST_QST');
    expect(computeTenantLineTax(t, { taxCode: 'GST_QST', amountCents: 11498, inclusive: true })?.recoverableTaxCents).toBe(1498);
    expect(computeTenantLineTax({ ...t, qstRegistered: null }, { taxCode: 'GST_QST', amountCents: 11498, inclusive: true })?.recoverableTaxCents).toBe(500);
  });
  it('unsupported jurisdiction (uk) -> null / empty, never throws', () => {
    expect(taxJurisdictionOf('uk')).toBeNull();
    expect(computeTenantLineTax({ jurisdiction: 'uk' }, { taxCode: 'GST', amountCents: 100, inclusive: true })).toBeNull();
    expect(tenantTaxCodes({ jurisdiction: 'uk' })).toEqual([]);
    expect(tenantDefaultTaxCode({ jurisdiction: null })).toBeNull();
  });
});
