/**
 * The tax row of the expense entry UIs (PR 2b.8): mobile capture review and
 * the web New Expense form both render from this one view, fetched from
 * GET /api/v1/agentbook-expense/tax-codes. Server-side so the plugin UMD (which
 * cannot import apps/web-next/src/lib) and /app share the engine's arithmetic,
 * and an exclusive entry converts to exactly the gross the posting route books.
 *
 * Visibility: AU/CA only; hidden for gstRegistered === false (anti-goal: a
 * non-registrant is never shown input tax). US: hidden — sales tax is never
 * recoverable, the engine books it as cost either way. Unknown registration
 * (null) shows the row plus the Business Profile prompt.
 */
import {
  computeTenantLineTax,
  taxJurisdictionOf,
  tenantDefaultTaxCode,
  tenantTaxCodes,
  type TenantTaxContext,
} from '@/lib/tax-codes';

export interface TaxRowPreview {
  taxCode: string;
  inclusive: boolean;
  grossCents: number;
  netCents: number;
  taxCents: number;
}

export interface TaxRowView {
  visible: boolean;
  codes: Array<{ code: string; recoverable: boolean }>;
  defaultCode: string | null;
  registrationPrompt: boolean;
  preview: TaxRowPreview | null;
  /** Tenant currency (ISO 4217): the preview amounts are in it; UIs format with it. */
  currency: string | null;
  /** Which pack the codes belong to; 'GST' means different things in au and ca, so UIs localize by this + code. */
  jurisdiction: 'au' | 'ca' | null;
}

export interface TaxRowQuery {
  amountCents?: number;
  inclusive?: boolean;
  taxCode?: string;
}

const HIDDEN: TaxRowView = { visible: false, codes: [], defaultCode: null, registrationPrompt: false, preview: null, currency: null, jurisdiction: null };

export function buildTaxRowView(t: (TenantTaxContext & { currency?: string | null }) | null, q: TaxRowQuery): TaxRowView {
  const j = taxJurisdictionOf(t?.jurisdiction);
  if (!t || (j !== 'au' && j !== 'ca') || t.gstRegistered === false) return HIDDEN;
  const codes = tenantTaxCodes(t).map((c) => ({ code: c.code, recoverable: c.recoverable }));
  const defaultCode = tenantDefaultTaxCode(t);
  const registrationPrompt = (t.gstRegistered ?? null) === null;
  let preview: TaxRowPreview | null = null;
  const code = (q.taxCode ?? defaultCode ?? '').toUpperCase();
  if (code && typeof q.amountCents === 'number' && Number.isSafeInteger(q.amountCents) && q.amountCents > 0
    && codes.some((c) => c.code === code)) {
    const inclusive = q.inclusive !== false;
    try {
      const r = computeTenantLineTax(t, { taxCode: code, amountCents: q.amountCents, inclusive });
      if (r) preview = { taxCode: code, inclusive, grossCents: r.grossCents, netCents: r.netCents, taxCents: r.taxCents };
    } catch {
      preview = null;
    }
  }
  return { visible: true, codes, defaultCode, registrationPrompt, preview, currency: t.currency ?? null, jurisdiction: j };
}
