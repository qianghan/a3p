// AU purchase tax codes (spec §5.1). GST rate from auSalesTax — never duplicated.
import { auSalesTax } from './sales-tax.js';
import {
  computeFromComponents, TaxCodeError,
  type LineTaxInput, type LineTaxResult, type TaxCodeInfo, type ResolvedComponent,
} from '../tax-codes-core.js';

export const AU_TAX_CODES: readonly TaxCodeInfo[] = [
  { code: 'GST', label: 'GST (taxable purchase)', recoverable: true },
  { code: 'CAP', label: 'Capital purchase (BAS G10)', recoverable: true },
  { code: 'FRE', label: 'GST-free', recoverable: false },
  { code: 'INP', label: 'Input-taxed', recoverable: false },
  { code: 'NTR', label: 'No GST / outside scope', recoverable: false },
];

/** Provider category each code draws its rate from (null = no GST at all). */
const PROVIDER_CATEGORY: Record<string, string | null> = {
  GST: 'standard', CAP: 'standard', FRE: 'gst-free', INP: 'input-taxed', NTR: null,
};

export function listAuTaxCodes(): TaxCodeInfo[] {
  return [...AU_TAX_CODES];
}

export function defaultAuTaxCode(): string {
  return 'GST';
}

export function computeAuLineTax(input: LineTaxInput): LineTaxResult {
  const info = AU_TAX_CODES.find((c) => c.code === input.taxCode);
  if (!info) throw new TaxCodeError('unknown_tax_code', `Unknown AU tax code ${input.taxCode}`);
  const category = PROVIDER_CATEGORY[info.code];
  const credit = info.recoverable && input.registration.gstRegistered === true;
  const comps: ResolvedComponent[] = category
    ? auSalesTax.getRates(category).map((r) => ({ type: r.taxType, rate: r.rate, recoverable: credit }))
    : [];
  return computeFromComponents(input.amountCents, input.inclusive, comps, 1);
}
