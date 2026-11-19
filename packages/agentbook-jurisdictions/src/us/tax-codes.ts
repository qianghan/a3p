// US purchase tax codes (spec §5.1). Sales tax is a cost, never recoverable.
// State rate from usSalesTax — never duplicated.
import { usSalesTax } from './sales-tax.js';
import {
  computeFromComponents, TaxCodeError,
  type LineTaxInput, type LineTaxResult, type TaxCodeInfo,
} from '../tax-codes-core.js';

export const US_TAX_CODES: readonly TaxCodeInfo[] = [
  { code: 'SALES_TAX', label: 'Sales tax (added to cost)', recoverable: false },
  { code: 'NONE', label: 'No sales tax', recoverable: false },
];

export function listUsTaxCodes(): TaxCodeInfo[] {
  return [...US_TAX_CODES];
}

export function defaultUsTaxCode(): string {
  return 'NONE';
}

export function computeUsLineTax(input: LineTaxInput): LineTaxResult {
  if (!US_TAX_CODES.some((c) => c.code === input.taxCode)) {
    throw new TaxCodeError('unknown_tax_code', `Unknown US tax code ${input.taxCode}`);
  }
  const comps = input.taxCode === 'SALES_TAX' && input.region
    ? usSalesTax.getRates(input.region).map((r) => ({ type: 'SALES_TAX', rate: r.rate, recoverable: false }))
    : [];
  return computeFromComponents(input.amountCents, input.inclusive, comps, 1);
}
