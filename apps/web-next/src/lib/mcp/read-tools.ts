import 'server-only';
import { prisma as db } from '@naap/database';
import { getCashPosition } from '@agentbook-core/cash-position';
import { defaultCurrencyFor } from '@/lib/jurisdiction-currency';

/**
 * Structured, read-only data for the MCP connector.
 *
 * WHY THESE EXIST WHEN `ask_agentbook` ALREADY ANSWERS QUESTIONS
 *
 * `ask_agentbook` proxies the agent brain and returns prose. That is the right
 * shape for "what should I do about X", and the wrong shape for a model that
 * wants to compute something: it cannot filter, sort, or join a sentence, and
 * it cannot tell whether "$4,200" was revenue or expenses without re-reading
 * English. A connector exposing exactly one opaque tool also gives the client
 * nothing to discover — every capability has to be guessed at in natural
 * language and hopefully routed.
 *
 * So these return numbers with their units attached, and they are all
 * read-only: no confirmation round-trip, no elicitation capability required,
 * nothing a client can call that changes the books. Writes stay behind
 * `ask_agentbook`, which asks first.
 *
 * THREE RULES EVERY TOOL HERE FOLLOWS
 *
 *  1. `tenantId` is a required first argument and every query filters on it.
 *     The MCP transport is long-lived and one server instance serves one
 *     tenant, so a query that forgets the filter would read another customer's
 *     books rather than simply returning nothing. Asserted in the tests.
 *  2. Results are bounded. A tool that can return ten thousand rows will,
 *     and the caller pays for every token of it.
 *  3. Amounts carry their currency. This product has shipped bugs where a
 *     Canadian tenant was shown US dollars; a bare number crossing a tool
 *     boundary is the same mistake with more steps.
 */

/** Hard ceiling on rows any single call can return. */
export const MAX_ROWS = 100;
const DEFAULT_ROWS = 25;

export interface Money {
  cents: number;
  currency: string;
}

async function tenantCurrency(tenantId: string): Promise<string> {
  // AbTenantConfig keys on `userId`, and the tenant id IS the user id here —
  // every other caller in the repo does exactly this. Getting it wrong throws
  // rather than returning the wrong tenant, but it is worth naming.
  const cfg = await db.abTenantConfig
    .findUnique({ where: { userId: tenantId }, select: { defaultCurrency: true, jurisdiction: true } })
    .catch(() => null);
  // The stored default wins; jurisdiction is the fallback, and USD only when
  // neither is known — never a silent guess at the tenant's own currency.
  return cfg?.defaultCurrency || defaultCurrencyFor(cfg?.jurisdiction);
}

const money = (cents: number, currency: string): Money => ({ cents, currency });

/**
 * A period, resolved once so every tool reads the same window.
 *
 * Defaults to the current calendar year rather than "all time": an unbounded
 * scan is both the slowest query and the least useful answer.
 */
export function resolvePeriod(from?: string, to?: string): { from: Date; to: Date } {
  const now = new Date();
  const start = from ? new Date(from) : new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const end = to ? new Date(to) : now;
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error('Dates must be ISO (YYYY-MM-DD).');
  }
  if (start > end) throw new Error('`from` is after `to`.');
  return { from: start, to: end };
}

export interface CashPositionResult {
  total: Money;
  accounts: { name: string; balance: Money }[];
}

export async function readCashPosition(tenantId: string): Promise<CashPositionResult> {
  const [pos, currency] = await Promise.all([getCashPosition(tenantId), tenantCurrency(tenantId)]);
  return {
    total: money(pos.totalCents, currency),
    accounts: pos.accounts.map((a) => ({ name: a.name, balance: money(a.balanceCents, currency) })),
  };
}

export interface ExpenseRow {
  id: string;
  date: string;
  vendor: string | null;
  description: string | null;
  amount: Money;
  category: string | null;
}

export async function readExpenses(
  tenantId: string,
  opts: { from?: string; to?: string; vendor?: string; limit?: number } = {},
): Promise<{ period: { from: string; to: string }; count: number; total: Money; expenses: ExpenseRow[] }> {
  const { from, to } = resolvePeriod(opts.from, opts.to);
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_ROWS, 1), MAX_ROWS);
  const currency = await tenantCurrency(tenantId);

  const where = {
    tenantId,
    date: { gte: from, lte: to },
    ...(opts.vendor ? { vendor: { name: { contains: opts.vendor, mode: 'insensitive' as const } } } : {}),
  };

  const [rows, agg] = await Promise.all([
    db.abExpense.findMany({
      where,
      orderBy: { date: 'desc' },
      take: limit,
      select: {
        id: true, date: true, description: true, amountCents: true, categoryId: true,
        vendor: { select: { name: true } },
      },
    }),
    // The total is over the WHOLE period, not just the returned page — a
    // caller summing the rows would otherwise silently under-report whenever
    // the result was truncated.
    db.abExpense.aggregate({ where, _sum: { amountCents: true }, _count: true }),
  ]);

  const accountIds = [...new Set(rows.map((r) => r.categoryId).filter((v): v is string => Boolean(v)))];
  const accounts = accountIds.length
    ? await db.abAccount.findMany({ where: { id: { in: accountIds } }, select: { id: true, name: true } })
    : [];
  const nameById = new Map(accounts.map((a) => [a.id, a.name]));

  return {
    period: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
    count: agg._count,
    total: money(agg._sum.amountCents ?? 0, currency),
    expenses: rows.map((r) => ({
      id: r.id,
      date: r.date.toISOString().slice(0, 10),
      vendor: r.vendor?.name ?? null,
      description: r.description,
      amount: money(r.amountCents, currency),
      category: r.categoryId ? nameById.get(r.categoryId) ?? null : null,
    })),
  };
}

export async function readExpenseBreakdown(
  tenantId: string,
  opts: { from?: string; to?: string } = {},
): Promise<{ period: { from: string; to: string }; total: Money; categories: { category: string; amount: Money; share: number }[] }> {
  const { from, to } = resolvePeriod(opts.from, opts.to);
  const currency = await tenantCurrency(tenantId);

  const grouped = await db.abExpense.groupBy({
    by: ['categoryId'],
    where: { tenantId, date: { gte: from, lte: to } },
    _sum: { amountCents: true },
  });

  const ids = grouped.map((g) => g.categoryId).filter((v): v is string => Boolean(v));
  const accounts = ids.length
    ? await db.abAccount.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
    : [];
  const nameById = new Map(accounts.map((a) => [a.id, a.name]));

  const total = grouped.reduce((n, g) => n + (g._sum.amountCents ?? 0), 0);
  const categories = grouped
    .map((g) => {
      const cents = g._sum.amountCents ?? 0;
      return {
        // A null category is shown as "Uncategorised" rather than dropped:
        // silently omitting it makes the shares add to less than 100% with no
        // indication why.
        category: g.categoryId ? nameById.get(g.categoryId) ?? 'Unknown account' : 'Uncategorised',
        amount: money(cents, currency),
        share: total > 0 ? Math.round((cents / total) * 1000) / 10 : 0,
      };
    })
    .sort((a, b) => b.amount.cents - a.amount.cents);

  return {
    period: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
    total: money(total, currency),
    categories,
  };
}

export interface InvoiceRow {
  id: string;
  number: string;
  client: string;
  issued: string;
  due: string;
  status: string;
  amount: Money;
  daysOverdue: number | null;
}

export async function readInvoices(
  tenantId: string,
  opts: { status?: string; limit?: number } = {},
): Promise<{ count: number; outstanding: Money; overdue: Money; invoices: InvoiceRow[] }> {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_ROWS, 1), MAX_ROWS);
  const currency = await tenantCurrency(tenantId);
  const where = { tenantId, ...(opts.status ? { status: opts.status } : {}) };

  const rows = await db.abInvoice.findMany({
    where,
    orderBy: { dueDate: 'asc' },
    take: limit,
    select: {
      id: true, number: true, issuedDate: true, dueDate: true, status: true,
      amountCents: true, currency: true, client: { select: { name: true } },
    },
  });

  const today = new Date();
  const invoices = rows.map((r) => {
    const overdueDays = Math.floor((today.getTime() - r.dueDate.getTime()) / 86_400_000);
    return {
      id: r.id,
      number: r.number,
      client: r.client?.name ?? 'Unknown client',
      issued: r.issuedDate.toISOString().slice(0, 10),
      due: r.dueDate.toISOString().slice(0, 10),
      status: r.status,
      // The invoice's OWN currency, which can differ from the tenant default
      // on a cross-border invoice. Falling back to the tenant's would restate
      // the amount in a currency it was never issued in.
      amount: money(r.amountCents, r.currency || currency),
      daysOverdue: r.status !== 'paid' && overdueDays > 0 ? overdueDays : null,
    };
  });

  // Totals are over unpaid invoices across the whole book, not the page.
  const unpaid = await db.abInvoice.aggregate({
    where: { tenantId, status: { notIn: ['paid', 'void', 'cancelled'] } },
    _sum: { amountCents: true },
  });
  const overdue = await db.abInvoice.aggregate({
    where: { tenantId, status: { notIn: ['paid', 'void', 'cancelled'] }, dueDate: { lt: today } },
    _sum: { amountCents: true },
  });

  return {
    count: rows.length,
    outstanding: money(unpaid._sum.amountCents ?? 0, currency),
    overdue: money(overdue._sum.amountCents ?? 0, currency),
    invoices,
  };
}
