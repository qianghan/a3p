// Thin app adapter over @agentbook/jurisdictions tax codes (spec §5.1).
// The table and all math live in the package; this only maps a tenant's
// config row onto its inputs. Unsupported jurisdictions (e.g. UK) return null
// so callers fall back to untyped/gross behaviour.
import {
  computeLineTax,
  listTaxCodes,
  defaultTaxCode,
  type LineTaxResult,
  type TaxCodeInfo,
  type TaxJurisdiction,
} from '@agentbook/jurisdictions';

export { TaxCodeError, type LineTaxResult, type TaxCodeInfo } from '@agentbook/jurisdictions';

export interface TenantTaxContext {
  jurisdiction?: string | null;
  region?: string | null;
  gstRegistered?: boolean | null;
  qstRegistered?: boolean | null;
}

const SUPPORTED: readonly TaxJurisdiction[] = ['au', 'ca', 'us'];

export function taxJurisdictionOf(j?: string | null): TaxJurisdiction | null {
  const k = (j ?? '').toLowerCase();
  return (SUPPORTED as readonly string[]).includes(k) ? (k as TaxJurisdiction) : null;
}

export function tenantTaxCodes(t: TenantTaxContext): TaxCodeInfo[] {
  const j = taxJurisdictionOf(t.jurisdiction);
  return j ? listTaxCodes(j, t.region) : [];
}

export function tenantDefaultTaxCode(t: TenantTaxContext): string | null {
  const j = taxJurisdictionOf(t.jurisdiction);
  return j ? defaultTaxCode(j, t.region) : null;
}

export function computeTenantLineTax(
  t: TenantTaxContext,
  line: { taxCode: string; amountCents: number; inclusive: boolean; isMeal?: boolean },
): LineTaxResult | null {
  const j = taxJurisdictionOf(t.jurisdiction);
  if (!j) return null;
  return computeLineTax({
    jurisdiction: j,
    region: t.region,
    taxCode: line.taxCode,
    amountCents: line.amountCents,
    inclusive: line.inclusive,
    isMeal: line.isMeal,
    registration: { gstRegistered: t.gstRegistered ?? null, qstRegistered: t.qstRegistered ?? null },
  });
}
