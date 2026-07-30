/**
 * Validation for client-supplied money values.
 *
 * Invoice/estimate amounts arrive from the client and flow straight into the
 * ledger via a balanced journal entry. Unvalidated, they poison the books:
 *   • a missing/non-numeric rateCents made `Math.round(qty * rateCents)` NaN,
 *   • a negative rateCents produced a negative "invoice" (a backdoor credit),
 *   • a huge value overflows the Int (4-byte) money columns.
 * Reject at the edge instead — a bad request is a 400, never a bad entry.
 *
 * Discounts/refunds have their own path (credit notes), so invoice lines are
 * strictly non-negative here.
 */

/**
 * Per-line and per-invoice ceiling in cents. The money columns are Postgres
 * Int (max 2,147,483,647 ≈ $21.47M); we cap a document total at $10M so that
 * even a 100%-tax grand total stays comfortably inside the column.
 */
export const MAX_MONEY_CENTS = 1_000_000_000; // $10,000,000.00
/** Sane upper bound for a line quantity (hours/units). Fractional is allowed. */
export const MAX_QUANTITY = 1_000_000;
/** Tax-rate override ceiling: a fraction, so 1 = 100%. */
export const MAX_TAX_RATE = 1;

/** True for a value usable as a cents amount: an integer in [0, MAX_MONEY_CENTS]. */
export function isValidMoneyCents(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 0
    && value <= MAX_MONEY_CENTS;
}

export interface RawLine {
  description?: string;
  quantity?: number;
  rateCents?: number;
}

export interface NormalizedLine {
  description: string;
  quantity: number;
  rateCents: number;
  amountCents: number;
}

export type LineValidation =
  | { ok: true; lines: NormalizedLine[]; subtotalCents: number }
  | { ok: false; error: string };

/**
 * Validate + normalize client line items and compute the subtotal. Every line
 * must have an integer rateCents in range and (if given) a finite, positive
 * quantity; the resulting amounts and their sum must fit the money columns.
 */
export function validateInvoiceLines(lines: RawLine[]): LineValidation {
  const normalized: NormalizedLine[] = [];
  let subtotalCents = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? {};
    const label = `line ${i + 1}`;

    if (!isValidMoneyCents(line.rateCents)) {
      return {
        ok: false,
        error: `${label}: rateCents must be a whole number of cents between 0 and ${MAX_MONEY_CENTS}`,
      };
    }

    // quantity is a Float column — fractional hours/units are legitimate — but
    // it must be a real, positive, bounded number.
    let quantity = 1;
    if (line.quantity !== undefined && line.quantity !== null) {
      if (typeof line.quantity !== 'number' || !Number.isFinite(line.quantity)
        || line.quantity <= 0 || line.quantity > MAX_QUANTITY) {
        return {
          ok: false,
          error: `${label}: quantity must be a positive number no greater than ${MAX_QUANTITY}`,
        };
      }
      quantity = line.quantity;
    }

    const amountCents = Math.round(quantity * line.rateCents);
    if (!isValidMoneyCents(amountCents)) {
      return { ok: false, error: `${label}: amount is out of range` };
    }

    subtotalCents += amountCents;
    if (subtotalCents > MAX_MONEY_CENTS) {
      return { ok: false, error: `total amount exceeds the ${MAX_MONEY_CENTS}-cent maximum` };
    }

    normalized.push({
      description: line.description || '',
      quantity,
      rateCents: line.rateCents,
      amountCents,
    });
  }

  return { ok: true, lines: normalized, subtotalCents };
}

export type TaxRateValidation =
  | { ok: true; rate: number | null }
  | { ok: false; error: string };

/**
 * Validate an optional tax-rate override (a fraction, e.g. 0.10 for 10%).
 * Absent/null means "use the jurisdiction default" and is returned as null.
 */
export function validateTaxRateOverride(value: unknown): TaxRateValidation {
  if (value === undefined || value === null) return { ok: true, rate: null };
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_TAX_RATE) {
    return { ok: false, error: `taxRate must be a fraction between 0 and ${MAX_TAX_RATE}` };
  }
  return { ok: true, rate: value };
}
