// Purchase tax-code table + computeLineTax (spec §5.1) — the single source
// that routes, chat, OCR post-processing and returns call.
import {
  TaxCodeError,
  type LineTaxInput, type LineTaxResult, type TaxCodeInfo, type TaxJurisdiction,
} from './tax-codes-core.js';
import { computeAuLineTax, listAuTaxCodes, defaultAuTaxCode } from './au/tax-codes.js';
import { computeCaLineTax, listCaTaxCodes, defaultCaTaxCode } from './ca/tax-codes.js';
import { computeUsLineTax, listUsTaxCodes, defaultUsTaxCode } from './us/tax-codes.js';

export {
  TaxCodeError,
  type LineTaxInput, type LineTaxResult, type LineTaxComponent, type TaxCodeInfo,
  type TaxJurisdiction, type TaxRegistration,
} from './tax-codes-core.js';
export { CA_MEALS_RECOVERABLE_FRACTION } from './ca/tax-codes.js';

function unsupported(j: string): never {
  throw new TaxCodeError('unsupported_jurisdiction', `No tax-code table for jurisdiction ${j}`);
}

export function computeLineTax(input: LineTaxInput): LineTaxResult {
  switch (input.jurisdiction) {
    case 'au': return computeAuLineTax(input);
    case 'ca': return computeCaLineTax(input);
    case 'us': return computeUsLineTax(input);
    default: return unsupported(String(input.jurisdiction));
  }
}

export function listTaxCodes(jurisdiction: TaxJurisdiction, region?: string | null): TaxCodeInfo[] {
  switch (jurisdiction) {
    case 'au': return listAuTaxCodes();
    case 'ca': return listCaTaxCodes(region);
    case 'us': return listUsTaxCodes();
    default: return unsupported(String(jurisdiction));
  }
}

export function defaultTaxCode(jurisdiction: TaxJurisdiction, region?: string | null): string {
  switch (jurisdiction) {
    case 'au': return defaultAuTaxCode();
    case 'ca': return defaultCaTaxCode(region);
    case 'us': return defaultUsTaxCode();
    default: return unsupported(String(jurisdiction));
  }
}
