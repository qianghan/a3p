// CA purchase tax codes (spec §5.1). Province rates from caSalesTax.getRates —
// never duplicated. No per-province codes: province resolves the rates.
import { caSalesTax } from './sales-tax.js';
import {
  computeFromComponents, TaxCodeError,
  type LineTaxInput, type LineTaxResult, type TaxCodeInfo, type ResolvedComponent,
} from '../tax-codes-core.js';

export const CA_TAX_CODES: readonly TaxCodeInfo[] = [
  { code: 'GST', label: 'GST', recoverable: true },
  { code: 'HST', label: 'HST', recoverable: true },
  { code: 'GST_PST', label: 'GST + PST', recoverable: true },
  { code: 'GST_QST', label: 'GST + QST', recoverable: true },
  { code: 'ZERO', label: 'Zero-rated', recoverable: false },
  { code: 'EXEMPT', label: 'Exempt', recoverable: false },
  { code: 'OUT_OF_SCOPE', label: 'Out of scope', recoverable: false },
];

/** Meals & entertainment ITC: 50% (ETA s.67.1). */
export const CA_MEALS_RECOVERABLE_FRACTION = 0.5;

/** Province with a federal-GST-only schedule, used to read the GST rate in HST provinces. */
const FEDERAL_GST_REFERENCE_PROVINCE = 'AB';

function provinceRates(region?: string | null) {
  return region ? caSalesTax.getRates(region) : [];
}

function federalGstRate(region?: string | null): number {
  const own = provinceRates(region).find((r) => r.taxType === 'GST');
  const ref = own ?? caSalesTax.getRates(FEDERAL_GST_REFERENCE_PROVINCE).find((r) => r.taxType === 'GST');
  if (!ref) throw new TaxCodeError('rate_unavailable', 'Federal GST rate unavailable');
  return ref.rate;
}

function isQuebec(region?: string | null) {
  return (region ?? '').toUpperCase() === 'QC';
}

/** Codes valid for a province (all codes when the province is unknown). */
function codesFor(region?: string | null): string[] {
  const rates = provinceRates(region);
  if (!region || rates.length === 0) return CA_TAX_CODES.map((c) => c.code);
  const zero = ['ZERO', 'EXEMPT', 'OUT_OF_SCOPE'];
  if (rates.some((r) => r.taxType === 'HST')) return ['HST', ...zero];
  if (rates.some((r) => r.taxType === 'PST')) return [isQuebec(region) ? 'GST_QST' : 'GST_PST', 'GST', ...zero];
  return ['GST', ...zero];
}

export function listCaTaxCodes(region?: string | null): TaxCodeInfo[] {
  const allowed = codesFor(region);
  return CA_TAX_CODES.filter((c) => allowed.includes(c.code));
}

export function defaultCaTaxCode(region?: string | null): string {
  return codesFor(region)[0];
}

export function computeCaLineTax(input: LineTaxInput): LineTaxResult {
  const { taxCode, region, registration } = input;
  if (!CA_TAX_CODES.some((c) => c.code === taxCode)) {
    throw new TaxCodeError('unknown_tax_code', `Unknown CA tax code ${taxCode}`);
  }
  if (region && provinceRates(region).length > 0 && !codesFor(region).includes(taxCode)) {
    throw new TaxCodeError('tax_code_region_mismatch', `${taxCode} does not apply in ${region}`);
  }
  const gstCredit = registration.gstRegistered === true;
  const qstCredit = registration.qstRegistered === true;
  const rates = provinceRates(region);
  const pst = rates.find((r) => r.taxType === 'PST');
  const need = (cond: unknown, what: string) => {
    if (!cond) throw new TaxCodeError('tax_code_region_mismatch', `${taxCode} needs ${what} (region ${region ?? 'unset'})`);
  };

  let comps: ResolvedComponent[] = [];
  switch (taxCode) {
    case 'GST':
      comps = [{ type: 'GST', rate: federalGstRate(region), recoverable: gstCredit }];
      break;
    case 'HST': {
      const hst = rates.find((r) => r.taxType === 'HST');
      need(hst, 'an HST province');
      comps = [{ type: 'HST', rate: hst!.rate, recoverable: gstCredit }];
      break;
    }
    case 'GST_PST':
      need(pst && !isQuebec(region), 'a PST province');
      comps = [
        { type: 'GST', rate: federalGstRate(region), recoverable: gstCredit },
        { type: 'PST', rate: pst!.rate, recoverable: false },
      ];
      break;
    case 'GST_QST':
      need(pst && isQuebec(region), 'region QC');
      comps = [
        { type: 'GST', rate: federalGstRate(region), recoverable: gstCredit },
        { type: 'QST', rate: pst!.rate, recoverable: qstCredit },
      ];
      break;
    default:
      comps = [];
  }
  const fraction = input.isMeal ? CA_MEALS_RECOVERABLE_FRACTION : 1;
  return computeFromComponents(input.amountCents, input.inclusive, comps, fraction);
}
