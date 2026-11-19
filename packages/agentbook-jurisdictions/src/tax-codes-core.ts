// Shared, jurisdiction-agnostic tax-code math (spec §5.1). Pure integer-cent
// arithmetic; rates are always supplied by the caller from the sales-tax.ts
// providers — this file must never contain a rate literal (guarded by test).

export type TaxJurisdiction = 'au' | 'ca' | 'us';

export interface TaxRegistration {
  /** Tri-state, mirrors AbTenantConfig.gstRegistered. Only `true` earns a credit. */
  gstRegistered: boolean | null;
  /** CA/QC only, mirrors AbTenantConfig.qstRegistered. Only `true` earns a QST credit. */
  qstRegistered?: boolean | null;
}

export interface LineTaxInput {
  jurisdiction: TaxJurisdiction;
  /** AU: ignored. CA: province code. US: state code. */
  region?: string | null;
  taxCode: string;
  /** Integer cents. Gross when `inclusive`, net (pre-tax) otherwise. Negative = refund/credit. */
  amountCents: number;
  /** Input mode only (UI flag): is `amountCents` tax-inclusive? */
  inclusive: boolean;
  registration: TaxRegistration;
  /** Meals & entertainment: CA ITC recoverable fraction 0.5. */
  isMeal?: boolean;
  /** Reserved: rates are not date-versioned in the providers yet. */
  date?: Date;
}

export interface LineTaxComponent {
  type: string;
  rate: number;
  cents: number;
  recoverableCents: number;
}

export interface LineTaxResult {
  grossCents: number;
  netCents: number;
  taxCents: number;
  recoverableTaxCents: number;
  nonRecoverableTaxCents: number;
  components: LineTaxComponent[];
}

export interface TaxCodeInfo {
  code: string;
  label: string;
  /** Whether this code can ever yield an input-tax credit (given registration). */
  recoverable: boolean;
}

/** A resolved component prior to amounts: rate + whether a credit applies. */
export interface ResolvedComponent {
  type: string;
  rate: number;
  recoverable: boolean;
}

export class TaxCodeError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'TaxCodeError';
  }
}

/** Half-away-from-zero for a non-negative value; toFixed defuses float noise (e.g. 997.4999999). */
function roundHalfUp(x: number): number {
  return Math.round(Number(x.toFixed(6)));
}

/** Full-precision fraction for meals is applied per component, half-away-from-zero. */
export function computeFromComponents(
  amountCents: number,
  inclusive: boolean,
  comps: ResolvedComponent[],
  recoverableFraction: number,
): LineTaxResult {
  if (!Number.isInteger(amountCents)) {
    throw new TaxCodeError('non_integer_cents', `amountCents must be an integer, got ${amountCents}`);
  }
  const sign = amountCents < 0 ? -1 : 1;
  const a = Math.abs(amountCents);
  const active = comps.filter((c) => c.rate > 0);
  const totalRate = active.reduce((s, c) => s + c.rate, 0);

  let cents: number[];
  if (active.length === 0) {
    cents = [];
  } else if (!inclusive) {
    cents = active.map((c) => roundHalfUp(a * c.rate));
  } else if (active.length === 1) {
    // Single component: back the tax out of the gross directly (AU: gross/11).
    cents = [roundHalfUp((a * totalRate) / (1 + totalRate))];
  } else {
    // Multi-component (CA GST+PST/QST): net from the combined rate, then each
    // component rounded on that net, as ca/sales-tax.ts calculateTax does.
    const net0 = roundHalfUp(a / (1 + totalRate));
    cents = active.map((c) => roundHalfUp(net0 * c.rate));
  }

  const components: LineTaxComponent[] = active.map((c, i) => ({
    type: c.type,
    rate: c.rate,
    cents: sign * cents[i] || 0,
    recoverableCents: c.recoverable ? sign * roundHalfUp(cents[i] * recoverableFraction) || 0 : 0,
  }));
  const tax = cents.reduce((s, x) => s + x, 0);
  const gross = inclusive ? a : a + tax;
  const net = gross - tax;
  const recoverable = components.reduce((s, c) => s + c.recoverableCents, 0);
  const taxCents = sign * tax || 0;
  return {
    grossCents: sign * gross || 0,
    netCents: sign * net || 0,
    taxCents,
    recoverableTaxCents: recoverable,
    nonRecoverableTaxCents: taxCents - recoverable,
    components,
  };
}
