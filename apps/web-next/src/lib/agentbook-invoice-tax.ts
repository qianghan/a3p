/**
 * Sales-tax computation for invoice creation (Launch-gap PR-6).
 *
 * Single source of truth: every invoice-creation write path (the plain
 * create route, the chat/NL draft helper, the recurring-invoice cron)
 * calls this once and applies the result identically. Scope is AU, CA,
 * and US, per the roadmap — every other jurisdiction returns a zero-tax
 * result (today's behavior, unchanged).
 */
import 'server-only';
import { prisma as db } from '@naap/database';
import { auSalesTax } from '@agentbook/jurisdictions/au/sales-tax';
import { caSalesTax } from '@agentbook/jurisdictions/ca/sales-tax';
import { usSalesTax } from '@agentbook/jurisdictions/us/sales-tax';

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
 * Turn a jurisdiction pack's raw component list into this module's
 * `InvoiceTaxComponent[]` shape, assigning each component's liability
 * account code and dropping any zero-amount component.
 */
function toInvoiceComponents(
  components: { type: string; rate: number; amountCents: number }[],
  accountCodeFor: (type: string) => string,
): InvoiceTaxComponent[] {
  return components
    .filter((c) => c.amountCents > 0)
    .map((c) => ({ type: c.type, rate: c.rate, amountCents: c.amountCents, accountCode: accountCodeFor(c.type) }));
}

/**
 * Scale a jurisdiction's default multi-component breakdown to a caller-
 * supplied override rate, preserving each component's proportional share
 * (e.g. Quebec's GST:PST split of 5:9.975) instead of collapsing the whole
 * override into a single component.
 *
 * Two degenerate cases:
 *   - `overrideRate === 0`: the caller explicitly asked for no tax — always
 *     an empty `components` array, regardless of the jurisdiction's default.
 *   - `defaultTotalRate === 0` with a non-zero `overrideRate`: the tenant's
 *     jurisdiction is AU/CA but has no recognized default breakdown to
 *     scale against (e.g. a CA tenant with an unset/unrecognized province).
 *     There's no proportional split to preserve here, but the override
 *     itself is real money the caller intends to collect — falling back to
 *     zero would silently drop it from the ledger. Attribute the whole
 *     amount to the jurisdiction's primary liability account (GST/HST,
 *     '2100') instead: a coarser attribution than a real per-component
 *     split, but not a money-losing one.
 */
function scaleComponentsToOverride(
  defaultComponents: { type: string; rate: number; amountCents: number }[],
  defaultTotalRate: number,
  overrideRate: number,
  subtotalCents: number,
  accountCodeFor: (type: string) => string,
): InvoiceTaxComponent[] {
  if (overrideRate === 0) return [];
  if (defaultTotalRate === 0) {
    const amountCents = Math.round(subtotalCents * overrideRate);
    return amountCents > 0 ? [{ type: 'GST', rate: overrideRate, amountCents, accountCode: '2100' }] : [];
  }
  const scale = overrideRate / defaultTotalRate;
  const scaled = defaultComponents.map((c) => ({
    type: c.type,
    rate: c.rate * scale,
    amountCents: Math.round(subtotalCents * c.rate * scale),
  }));
  return toInvoiceComponents(scaled, accountCodeFor);
}

/**
 * Compute the tax to apply to a new invoice's subtotal.
 *
 * @param overrideRate - When provided (a fraction, e.g. 0.10), the caller
 *   (a user editing the tax-rate field before submitting) has explicitly
 *   chosen a rate. It's applied by proportionally scaling the tenant's
 *   jurisdiction default component breakdown to the new rate — this
 *   preserves multi-component splits (e.g. Quebec's GST/QST) instead of
 *   collapsing the whole override into a single account. Still requires
 *   an AU/CA jurisdiction; other jurisdictions have no default breakdown
 *   to scale, so an override there degrades to the same zero-tax result
 *   as omitting it (no throw — this function never throws).
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
    const result = auSalesTax.calculateTax(subtotalCents, 'standard');
    if (overrideRate != null) {
      const components = scaleComponentsToOverride(result.components, result.totalRate, overrideRate, subtotalCents, () => '2100');
      return { taxRate: overrideRate, taxCents: components.reduce((s, c) => s + c.amountCents, 0), components };
    }
    return {
      taxRate: result.totalRate,
      taxCents: result.totalCents,
      components: toInvoiceComponents(result.components, () => '2100'),
    };
  }

  if (jurisdiction === 'ca') {
    const region = tenantConfig?.region || '';
    const result = caSalesTax.calculateTax(subtotalCents, region);
    if (overrideRate != null) {
      const components = scaleComponentsToOverride(result.components, result.totalRate, overrideRate, subtotalCents, caAccountCodeFor);
      return { taxRate: overrideRate, taxCents: components.reduce((s, c) => s + c.amountCents, 0), components };
    }
    return {
      taxRate: result.totalRate,
      taxCents: result.totalCents,
      components: toInvoiceComponents(result.components, caAccountCodeFor),
    };
  }

  if (jurisdiction === 'us') {
    const region = tenantConfig?.region || '';
    const result = usSalesTax.calculateTax(subtotalCents, region);
    if (overrideRate != null) {
      const components = scaleComponentsToOverride(result.components, result.totalRate, overrideRate, subtotalCents, () => '2100');
      return { taxRate: overrideRate, taxCents: components.reduce((s, c) => s + c.amountCents, 0), components };
    }
    return {
      taxRate: result.totalRate,
      taxCents: result.totalCents,
      components: toInvoiceComponents(result.components, () => '2100'),
    };
  }

  // UK/other — out of scope for this plan; unchanged zero-tax behavior.
  return ZERO_TAX;
}
