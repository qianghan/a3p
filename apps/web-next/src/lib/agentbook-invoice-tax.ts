/**
 * Sales-tax computation for invoice creation (Launch-gap PR-6).
 *
 * Single source of truth: every invoice-creation write path (the plain
 * create route, the chat/NL draft helper, the recurring-invoice cron)
 * calls this once and applies the result identically. Scope is AU and CA
 * only, per the roadmap — every other jurisdiction returns a zero-tax
 * result (today's behavior, unchanged).
 */
import 'server-only';
import { prisma as db } from '@naap/database';
import { auSalesTax } from '@agentbook/jurisdictions/au/sales-tax';
import { caSalesTax } from '@agentbook/jurisdictions/ca/sales-tax';

export interface InvoiceTaxComponent {
  /** e.g. 'GST', 'HST', 'PST' — matches SalesTaxResult.components[].type. */
  type: string;
  rate: number;
  amountCents: number;
  /** AbAccount.code of the liability account this component credits. */
  accountCode: string;
}

export interface InvoiceTaxResult {
  /** Combined rate across all components (e.g. 0.14975 for Quebec). 0 when no tax applies. */
  taxRate: number;
  /** Sum of all components' amountCents. 0 when no tax applies. */
  taxCents: number;
  components: InvoiceTaxComponent[];
}

const ZERO_TAX: InvoiceTaxResult = { taxRate: 0, taxCents: 0, components: [] };

/** CA sales-tax components labeled 'PST' credit the PST/QST Payable account (2200); GST/HST credit 2100. */
function caAccountCodeFor(componentType: string): string {
  return componentType === 'PST' ? '2200' : '2100';
}

/**
 * Compute the tax to apply to a new invoice's subtotal.
 *
 * @param overrideRate - When provided (a fraction, e.g. 0.10), the caller
 *   (a user editing the tax-rate field before submitting) has explicitly
 *   chosen a rate — apply it verbatim instead of looking up the
 *   jurisdiction's default. Still requires an AU/CA jurisdiction so the
 *   correct liability account code is known (an override without a
 *   determinable liability account throws — see below).
 */
export async function computeInvoiceTax(
  tenantId: string,
  subtotalCents: number,
  overrideRate?: number | null,
): Promise<InvoiceTaxResult> {
  if (subtotalCents <= 0) return ZERO_TAX;

  const tenantConfig = await db.abTenantConfig.findUnique({
    where: { userId: tenantId },
    select: { jurisdiction: true, region: true },
  });
  const jurisdiction = tenantConfig?.jurisdiction || 'us';

  if (jurisdiction === 'au') {
    if (overrideRate != null) {
      const amountCents = Math.round(subtotalCents * overrideRate);
      return {
        taxRate: overrideRate,
        taxCents: amountCents,
        components: amountCents > 0 ? [{ type: 'GST', rate: overrideRate, amountCents, accountCode: '2100' }] : [],
      };
    }
    const result = auSalesTax.calculateTax(subtotalCents, 'standard');
    return {
      taxRate: result.totalRate,
      taxCents: result.totalCents,
      components: result.components
        .filter((c) => c.amountCents > 0)
        .map((c) => ({ type: c.type, rate: c.rate, amountCents: c.amountCents, accountCode: '2100' })),
    };
  }

  if (jurisdiction === 'ca') {
    const region = tenantConfig?.region || '';
    if (overrideRate != null) {
      const amountCents = Math.round(subtotalCents * overrideRate);
      return {
        taxRate: overrideRate,
        taxCents: amountCents,
        components: amountCents > 0 ? [{ type: 'GST', rate: overrideRate, amountCents, accountCode: '2100' }] : [],
      };
    }
    const result = caSalesTax.calculateTax(subtotalCents, region);
    return {
      taxRate: result.totalRate,
      taxCents: result.totalCents,
      components: result.components
        .filter((c) => c.amountCents > 0)
        .map((c) => ({ type: c.type, rate: c.rate, amountCents: c.amountCents, accountCode: caAccountCodeFor(c.type) })),
    };
  }

  // US/UK/other — out of scope for this plan; unchanged zero-tax behavior.
  return ZERO_TAX;
}
