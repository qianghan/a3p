/**
 * Mirrors the seed dataset in scripts/seed-e2e-user.ts. Tests refer to
 * these constants instead of hardcoding magic strings/numbers.
 */

export const SEED = {
  cashOpeningCents: 500_000,
  expenses: { count: 5, missingReceiptCount: 1 },
  invoices: {
    count: 5,
    draft: 'INV-E2E-DRAFT',
    sent: 'INV-E2E-SENT',
    overdue: 'INV-E2E-OVERDUE',
    paid: 'INV-E2E-PAID',
    // Open receivable for BigCo, so the canonical eval's "got $7500 payment
    // from BigCo" has an invoice to settle against.
    bigco: 'INV-E2E-BIGCO',
  },
  clients: { count: 4, names: ['Acme Corp', 'Beta Inc', 'Gamma LLC', 'BigCo'] },
};

/**
 * Generate a unique tag for entities created during a test run, so
 * teardown can find them. Format: `e2e-{phase}-{ts}`.
 */
export function tag(phase: string): string {
  return `e2e-${phase}-${Date.now()}`;
}
