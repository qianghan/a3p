/**
 * Tax on a purchase being POSTED (spec §5.1, PR 2b.5): which tax code applies,
 * how much of the document's tax is recoverable, and whether a human should
 * look at it. Pure — the routes load the inputs and write the outputs.
 *
 * Rules:
 *   - amountCents is always the document GROSS, so the engine is called
 *     inclusive:true (a stored row, a typed amount and an OCR read alike).
 *   - Code: the caller's explicit taxCode, else the vendor's defaultTaxCode,
 *     else the jurisdiction default — the last ONLY for a tenant with
 *     gstRegistered === true. A non-registrant or unknown-registration tenant
 *     with no code stays untyped (legacy gross posting, nothing reinterpreted).
 *   - An explicit code the engine rejects is the caller's error (thrown); a
 *     remembered/default code that no longer applies (region changed, etc.)
 *     degrades to untyped rather than blocking the expense.
 *   - Printed tax (OCR / the entry form) wins when within 2¢ of the computed
 *     TAX (compare tax, not net: CA inclusive net can be 1¢ off); otherwise the
 *     computed figure is kept and `taxReview` is raised.
 *   - registrationPrompt: an AU/CA tenant whose gstRegistered is null — the
 *     engine posts gross (recoverable 0) until they answer.
 */
import {
  computeTenantLineTax,
  taxJurisdictionOf,
  tenantDefaultTaxCode,
  TaxCodeError,
  type TenantTaxContext,
} from '@/lib/tax-codes';

export const PRINTED_TAX_TOLERANCE_CENTS = 2;

export interface ExpenseTaxInput {
  tenant: TenantTaxContext | null;
  /** Explicit code from the caller; null = explicitly untyped; undefined = not given. */
  taxCode?: string | null;
  vendorDefaultTaxCode?: string | null;
  amountCents: number;
  isMeal?: boolean;
  /** Tax printed on the document (OCR tax_cents or the form); null/undefined = not known. */
  printedTaxCents?: number | null;
}

export interface ResolvedExpenseTax {
  taxCode: string | null;
  /** null = untyped: the caller keeps whatever taxAmountCents it had. */
  taxAmountCents: number | null;
  recoverableTaxCents: number;
  taxReview: boolean;
  registrationPrompt: boolean;
}

/** Name or tax category of an expense account marks it meals & entertainment (CA ITC 50%). */
export function isMealsAccount(acct: { name?: string | null; taxCategory?: string | null } | null | undefined): boolean {
  if (!acct) return false;
  return /meal|entertain/i.test(`${acct.name ?? ''} ${acct.taxCategory ?? ''}`);
}

export function resolveExpenseTax(input: ExpenseTaxInput): ResolvedExpenseTax {
  const t = input.tenant;
  const j = taxJurisdictionOf(t?.jurisdiction);
  const registrationPrompt = (j === 'au' || j === 'ca') && (t?.gstRegistered ?? null) === null;
  const untyped: ResolvedExpenseTax = {
    taxCode: null, taxAmountCents: null, recoverableTaxCents: 0, taxReview: false, registrationPrompt,
  };
  if (!t || !j) return untyped;

  const explicit = typeof input.taxCode === 'string' && input.taxCode.trim() !== '' ? input.taxCode.trim().toUpperCase() : null;
  if (input.taxCode === null) return untyped;
  const fallback =
    (input.vendorDefaultTaxCode && input.vendorDefaultTaxCode.trim().toUpperCase()) ||
    (t.gstRegistered === true ? tenantDefaultTaxCode(t) : null);
  const code = explicit ?? fallback;
  if (!code) return untyped;

  let r;
  try {
    r = computeTenantLineTax(t, { taxCode: code, amountCents: input.amountCents, inclusive: true, isMeal: input.isMeal });
  } catch (err) {
    if (explicit || !(err instanceof TaxCodeError)) throw err;
    return untyped;
  }
  if (!r) return untyped;

  let taxAmountCents = r.taxCents;
  let recoverableTaxCents = r.recoverableTaxCents;
  let taxReview = false;
  const printed = input.printedTaxCents;
  if (typeof printed === 'number' && Number.isInteger(printed) && printed >= 0) {
    if (Math.abs(printed - r.taxCents) <= PRINTED_TAX_TOLERANCE_CENTS) {
      taxAmountCents = printed;
      // Fully recoverable tax follows the printed figure; a partial recovery
      // (QST unregistered, meals 50%) keeps its computed share, capped at it.
      recoverableTaxCents = r.recoverableTaxCents === r.taxCents ? printed : Math.min(r.recoverableTaxCents, printed);
    } else {
      taxReview = true;
    }
  }
  if (recoverableTaxCents >= input.amountCents) recoverableTaxCents = 0; // never a zero/negative category debit
  return { taxCode: code, taxAmountCents, recoverableTaxCents, taxReview, registrationPrompt };
}
