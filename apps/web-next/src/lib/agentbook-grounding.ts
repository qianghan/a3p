/**
 * The facts an advisory answer is allowed to assert.
 *
 * The consultation reviewer blocks any money figure that does not appear in
 * this list, so this is simultaneously the answer's source material and the
 * definition of what counts as grounded. Both roles matter: a thin pack makes
 * the reviewer block good answers, and a pack containing anything unverified
 * makes the reviewer wave through bad ones.
 *
 * Everything here is read from the tenant's own ledger and profile. Nothing is
 * generated, and nothing comes from the model.
 *
 * This is the differentiator no incumbent has. "The instant asset write-off
 * threshold changed" is generic and free. "You bought a $4,200 laptop in
 * March, which now qualifies" needs the books in the room.
 */

import 'server-only';
import { prisma as db } from '@naap/database';
import { buildLedgerHeadline } from '@agentbook-core/server';

/**
 * Cheap, bounded, and safe to call on any consultative turn — a contract, not
 * an aspiration. Every read below is either a single-row lookup or a query
 * whose filter is pushed into the database: the headline figures come from
 * `buildLedgerHeadline`'s three aggregates rather than from
 * `buildFinancialContext`, which reads nine tables (several unbounded, with a
 * vendor join) to answer the same four numbers. That cost is fine once a day
 * in the briefing and not fine on every turn of a conversation.
 */
const MAX_CATEGORY_LINES = 8;

function money(cents: number, currency: string): string {
  const symbols: Record<string, string> = { USD: '$', CAD: 'CA$', AUD: 'A$', GBP: '£', EUR: '€' };
  const sym = symbols[currency] ?? `${currency} `;
  return `${sym}${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Fact lines for one tenant.
 *
 * Deliberately plain text rather than a structured object: the reviewer scans
 * these for numbers, and the model reads them as context. A shared shape means
 * the thing the model was told and the thing the reviewer checks against
 * cannot drift — which is the entire failure mode this guards.
 *
 * Never throws. A consultation with partial grounding is worth having; the
 * reviewer will simply block whatever cannot be supported.
 */
export async function buildGroundingFacts(tenantId: string): Promise<string[]> {
  const facts: string[] = [];

  try {
    const cfg = await db.abTenantConfig.findUnique({ where: { userId: tenantId } });
    const currency = cfg?.currency || 'USD';

    if (cfg) {
      facts.push(
        `Tenant profile: jurisdiction ${cfg.jurisdiction?.toUpperCase() ?? 'unknown'}` +
        `${cfg.region ? `, region ${cfg.region}` : ''}` +
        `, business type ${cfg.businessType ?? 'unknown'}` +
        `${cfg.taxEntityType ? `, tax entity ${cfg.taxEntityType}` : ''}` +
        `, currency ${currency}.`,
      );
    }

    const yearStart = new Date(new Date().getFullYear(), 0, 1);
    // Name the window instead of implying it. "Year to date" means 1 July to
    // 30 June to an Australian sole trader, and this figure is neither — it is
    // a calendar-year running total. A fact the reviewer will let the advisor
    // quote has to say which months it covers.
    const windowLabel = `since 1 January ${yearStart.getFullYear()}`;

    // The headline numbers, derived exactly as the daily briefing derives
    // them. Without these the advisor had no revenue, cash, net income or
    // burn in the pack, so "how is my revenue trending?" was answered "I
    // can't see your revenue directly, I only track expenses and
    // receivables" — while the briefing was printing all four. The advisor
    // was not wrong to disclaim: it is told to assert nothing beyond these
    // facts, and this was not one of them.
    //
    // `currency` is passed in so the helper does not re-read the tenant config
    // loaded three lines above.
    //
    // Its own try/catch: a multi-table ledger read is the most likely thing
    // here to fail, and it must not take the profile/expense/receivable facts
    // down with it.
    try {
      const ledger = await buildLedgerHeadline(tenantId, yearStart, { currency });
      facts.push(
        // "posted to the ledger" is load-bearing: this counts credits to
        // revenue accounts, not invoices issued. Billed-but-unpaid work is
        // the receivables line below, and a user reading one figure as the
        // other would think they had been paid twice or not at all.
        `Revenue ${windowLabel} (posted to the ledger): ${money(ledger.revenueCents, currency)}.`,
        // No window on cash: it is a balance, not a period total.
        `Cash on hand: ${money(ledger.cashBalanceCents, currency)}.`,
        `Net income ${windowLabel}: ${money(ledger.netIncomeCents, currency)}.`,
      );
      if (ledger.monthlyBurnCents > 0) {
        // Only when there is one. "Average monthly burn: CA$0.00" reads as a
        // claim about the tenant's spending rather than as an absence of
        // data — and the reviewer would then wave that zero through.
        facts.push(
          `Average monthly burn (trailing 90 days): ${money(ledger.monthlyBurnCents, currency)}.`,
        );
      }
    } catch (err) {
      console.warn('[grounding] ledger headline figures unavailable for', tenantId, err);
    }

    // Expenses over the same window, and the top categories. This is what turns
    // "meals are 50% deductible" into "your CA$1,240 of meals". Kept as its
    // own query rather than taken from the context above: the category lines
    // need the rows anyway, and deriving the total from the same rows the
    // categories come from means the breakdown always adds up to the total
    // printed beside it. Both apply the same filter, so the two agree.
    const expenses = await db.abExpense.findMany({
      where: { tenantId, isPersonal: false, deletedAt: null, date: { gte: yearStart } },
      select: { amountCents: true, categoryId: true },
    });
    const total = expenses.reduce((s, e) => s + e.amountCents, 0);
    facts.push(
      `Business expenses ${windowLabel}: ${money(total, currency)} across ${expenses.length} transactions.`,
    );

    if (expenses.length > 0) {
      const byCat = new Map<string, number>();
      for (const e of expenses) {
        if (!e.categoryId) continue;
        byCat.set(e.categoryId, (byCat.get(e.categoryId) ?? 0) + e.amountCents);
      }
      const ids = [...byCat.keys()];
      if (ids.length > 0) {
        const accounts = await db.abAccount.findMany({
          where: { id: { in: ids }, tenantId },
          select: { id: true, name: true },
        });
        const names = new Map(accounts.map((a) => [a.id, a.name]));
        const top = [...byCat.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, MAX_CATEGORY_LINES);
        for (const [id, cents] of top) {
          facts.push(`Category ${names.get(id) ?? 'Uncategorized'}: ${money(cents, currency)} ${windowLabel}.`);
        }
      }
    }

    // Receivables — "who owes me" is the most common advisory follow-up.
    const openInvoices = await db.abInvoice.findMany({
      where: { tenantId, status: { in: ['sent', 'overdue'] } },
      select: { amountCents: true, dueDate: true },
    });
    if (openInvoices.length > 0) {
      const ar = openInvoices.reduce((s, i) => s + i.amountCents, 0);
      const overdue = openInvoices.filter((i) => i.dueDate && i.dueDate < new Date());
      facts.push(
        `Outstanding receivables: ${money(ar, currency)} across ${openInvoices.length} invoices` +
        `${overdue.length > 0 ? `, of which ${overdue.length} are overdue` : ''}.`,
      );
    }

    // The most recent tax estimate, if one has been computed. NOT recomputed
    // here — a figure invented for the sake of the context pack would be
    // exactly the kind of unverifiable number the reviewer exists to catch.
    const estimate = await db.abTaxEstimate.findFirst({
      where: { tenantId },
      orderBy: { calculatedAt: 'desc' },
      select: { totalTaxCents: true, netIncomeCents: true, calculatedAt: true },
    });
    if (estimate) {
      facts.push(
        `Most recent tax estimate (${estimate.calculatedAt.toISOString().slice(0, 10)}): ` +
        `total tax ${money(estimate.totalTaxCents, currency)} on net income ` +
        `${money(estimate.netIncomeCents, currency)}.`,
      );
    }
  } catch (err) {
    // Partial grounding beats none: the reviewer blocks whatever cannot be
    // supported, so a failure here degrades the answer rather than breaking it.
    console.warn('[grounding] partial context for', tenantId, err);
  }

  return facts;
}
