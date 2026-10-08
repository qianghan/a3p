/**
 * Which ledger accounts are CASH — money the business holds today.
 *
 * Every AgentBook chart (the us / ca / au / uk jurisdiction packs and the
 * student chart in agentbook-chart-of-accounts.ts) numbers its assets the
 * same way:
 *
 *   1000        Cash                                   → cash
 *   1100        Accounts Receivable                    → NOT cash (owed to you; shown as Outstanding)
 *   1200        Business Checking / Chequing /
 *               Transaction / Current account          → cash (bank)
 *   1300        Business Savings                       → cash (bank)
 *   1400        Term Deposits (AU)                     → NOT cash (locked away, not available today)
 *
 * So cash is an ACTIVE asset account whose code is 1000–1099 (cash on hand,
 * plus user-added cash-like accounts such as petty cash) or 1200–1399 (bank
 * and savings). 1100–1199 is the receivables block; 1400 and up are
 * deposits, inventory, prepaid and fixed assets. The schema has no account
 * subtype, so the code range IS the rule; the chart-pack test pins every
 * asset code the packs ship, so a new one forces a decision.
 *
 * Pure (no server-only) so the rule can be tested against the real packs.
 */
export interface CashAccountCandidate {
  code: string;
  accountType: string;
}

const FOUR_DIGITS = /^\d{4}$/;

export function isCashAccount(a: CashAccountCandidate): boolean {
  if (a.accountType !== 'asset' || !FOUR_DIGITS.test(a.code)) return false;
  const n = Number(a.code);
  return (n >= 1000 && n <= 1099) || (n >= 1200 && n <= 1399);
}
