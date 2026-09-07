import { db } from './db/client.js';

/**
 * Cash on hand, from the ledger.
 *
 * "What is my cash balance?" — the most basic question a bookkeeper is asked —
 * was answered on web and MCP with another question: "for a specific bank
 * account, or across all your accounts?". Reproduced on all three regional
 * tenants.
 *
 * The cause was not the prompt. `query-finance` has no endpoint and had no
 * handler in the shared brain path, so the message fell through to the LLM,
 * which sensibly asked for clarification. Meanwhile the TELEGRAM webhook has
 * carried a working implementation all along — so the same question answered
 * correctly on Telegram and evasively everywhere else.
 *
 * That asymmetry is the actual defect: logic that lives in one adapter is
 * absent from every other surface. So the computation lives here, in the
 * package both the brain and the Telegram route can import, and each surface
 * keeps its own presentation.
 */

export interface CashPosition {
  totalCents: number;
  /** Non-zero asset accounts, largest first — the breakdown to offer AFTER the total. */
  accounts: { name: string; balanceCents: number }[];
}

/**
 * Sum of every active asset account, debits less credits.
 *
 * Answer the total first and offer the breakdown; only ask which account when
 * the user actually asks for one. A question in reply to this question is the
 * product declining to do its job.
 */
export async function getCashPosition(tenantId: string): Promise<CashPosition> {
  const accounts = await db.abAccount.findMany({
    where: { tenantId, accountType: 'asset', isActive: true },
    select: { name: true, journalLines: { select: { debitCents: true, creditCents: true } } },
  });

  const balances = accounts.map((a) => ({
    name: a.name,
    balanceCents: a.journalLines.reduce((s, l) => s + l.debitCents - l.creditCents, 0),
  }));

  return {
    totalCents: balances.reduce((s, a) => s + a.balanceCents, 0),
    accounts: balances
      .filter((a) => a.balanceCents !== 0)
      .sort((a, b) => Math.abs(b.balanceCents) - Math.abs(a.balanceCents)),
  };
}

/** Does this message ask what cash is on hand? EN and ZH. */
export function isCashBalanceQuestion(text: string): boolean {
  const t = (text ?? '').trim();
  if (!t) return false;
  return (
    /\b(?:cash (?:balance|on hand|position)|how much (?:cash|money) (?:do i have|have i got|is (?:there|left))|what'?s? in the bank|bank balance)\b/i.test(t)
    || /(?:现金|余额|结余)[^。？?]{0,6}(?:是多少|多少|情况)?/.test(t) && /(?:现金|余额|结余)/.test(t)
  );
}
