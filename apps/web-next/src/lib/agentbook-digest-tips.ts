/**
 * Generate contextual, actionable tax-planning + cash-flow tips for the
 * morning digest. Tips MUST reference a specific number from the
 * tenant's data and end with something the user can act on. Generic
 * platitudes are dropped at parse time.
 *
 * Backed by Gemini, with a deterministic fallback so the digest never
 * goes empty even when the LLM key isn't configured.
 */

import 'server-only';
import { prisma as db } from '@naap/database';
import { usPack, caPack, auPack, ukPack, type JurisdictionPack } from '@agentbook/jurisdictions';
import { formatCurrencyCents } from './jurisdiction-currency';

// Per-jurisdiction labels so digest tax tips never show US-specific agencies,
// forms, or tax-type names to CA/AU/UK tenants (H6). Unknown → US.
const TAX_AGENCY: Record<string, string> = { us: 'IRS', ca: 'CRA', au: 'ATO', uk: 'HMRC' };
const SET_ASIDE_LABEL: Record<string, string> = {
  us: 'federal + SE tax', ca: 'income tax + CPP', au: 'income tax', uk: 'income tax + NI',
};
// Jurisdictions where business meals are 50% deductible (US Schedule C 24b /
// CA T2125). AU meal entertainment is generally non-deductible, so the
// 50%-meals tip is suppressed there rather than asserting a wrong rule.
const MEALS_50_FORM: Record<string, string> = { us: 'Schedule C line 24b', ca: 'T2125' };

const CALENDAR_PACKS: Record<string, JurisdictionPack> = { us: usPack, ca: caPack, au: auPack, uk: ukPack };

/**
 * Days until the next quarterly estimated-tax/instalment deadline, read
 * from the real jurisdiction-pack calendar data (not a hardcoded date
 * array) — each jurisdiction's own pack already contains the correct
 * quarterly cadence (US: `..._estimated_tax_due`, CA: `..._instalment_due`,
 * AU: `payg_..._instalment`). Filtering by titleKey substring instead of a
 * shared `recurrence` tag, since the packs don't tag these consistently
 * (some are 'annual', some 'quarterly') but the titleKey naming is
 * consistent across every pack that has this concept.
 */
export function nextQuarterlyTaxDeadline(
  jurisdiction: string,
  region: string,
  now: Date,
): number | null {
  const pack = CALENDAR_PACKS[jurisdiction] ?? CALENDAR_PACKS.us;
  const year = now.getUTCFullYear();
  const candidates = [
    ...pack.calendarDeadlines.getDeadlines(year, region),
    ...pack.calendarDeadlines.getDeadlines(year + 1, region),
  ].filter((d) => /instalment|estimated_tax/i.test(d.titleKey));

  let closest: Date | null = null;
  for (const c of candidates) {
    const d = new Date(`${c.date}T00:00:00.000Z`);
    if (d > now && (!closest || d < closest)) closest = d;
  }
  return closest ? Math.round((closest.getTime() - now.getTime()) / 86_400_000) : null;
}

export interface TipContext {
  jurisdiction: string;
  currency: string;
  cashTodayCents: number;
  monthlyBurnCents: number;
  monthlyRevenueCents: number;
  ytdRevenueCents: number;
  ytdExpensesCents: number;
  ytdNetIncomeCents: number;
  taxDaysUntilQ: number | null;
  taxQuarterlyEstimateCents: number | null;
  topCategoriesYtd: { category: string; amountCents: number }[];
  outstandingInvoiceCents: number;
  upcomingInvoiceCents: number;
  pastDueInvoiceCount: number;
  recurringMonthlyCents: number;
  receiptCoveragePct: number;
}

export interface DigestTip {
  text: string;          // 1-2 sentences, references concrete numbers
  source: 'llm' | 'rule';
}

/**
 * Pull the data the tip generator needs in one query batch.
 */
export async function buildTipContext(tenantId: string): Promise<TipContext> {
  const now = new Date();
  const yearStart = new Date(now.getFullYear(), 0, 1);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 86_400_000);

  const tenantConfig = await db.abTenantConfig.findUnique({ where: { userId: tenantId } });

  const [revenueAccts, expenseAccts] = await Promise.all([
    db.abAccount.findMany({ where: { tenantId, accountType: 'revenue' }, select: { id: true } }),
    db.abAccount.findMany({ where: { tenantId, accountType: 'expense' }, select: { id: true, name: true, taxCategory: true } }),
  ]);
  const revIds = revenueAccts.map((a) => a.id);

  const [revYtdAgg, revMonthAgg, ninetyDayExpenseAgg] = await Promise.all([
    revIds.length > 0
      ? db.abJournalLine.aggregate({
          where: { accountId: { in: revIds }, entry: { tenantId, date: { gte: yearStart } } },
          _sum: { creditCents: true, debitCents: true },
        })
      : Promise.resolve({ _sum: { creditCents: 0, debitCents: 0 } } as const),
    revIds.length > 0
      ? db.abJournalLine.aggregate({
          where: { accountId: { in: revIds }, entry: { tenantId, date: { gte: monthStart } } },
          _sum: { creditCents: true, debitCents: true },
        })
      : Promise.resolve({ _sum: { creditCents: 0, debitCents: 0 } } as const),
    db.abExpense.aggregate({
      where: { tenantId, isPersonal: false, date: { gte: ninetyDaysAgo } },
      _sum: { amountCents: true },
    }),
  ]);

  const ytdRevenueCents = (revYtdAgg._sum.creditCents || 0) - (revYtdAgg._sum.debitCents || 0);
  const monthlyRevenueCents = (revMonthAgg._sum.creditCents || 0) - (revMonthAgg._sum.debitCents || 0);
  const ninetyDayExpensesCents = ninetyDayExpenseAgg._sum.amountCents || 0;
  const monthlyBurnCents = Math.round(ninetyDayExpensesCents / 3);

  // Per-expense-account YTD for top-categories report
  const topCategoriesYtd: { category: string; amountCents: number }[] = [];
  let ytdExpensesCents = 0;
  for (const acct of expenseAccts) {
    const lines = await db.abJournalLine.findMany({
      where: { accountId: acct.id, entry: { tenantId, date: { gte: yearStart } } },
      select: { debitCents: true, creditCents: true },
    });
    const total = lines.reduce((s, l) => s + l.debitCents - l.creditCents, 0);
    if (total > 0) {
      topCategoriesYtd.push({ category: acct.name, amountCents: total });
      ytdExpensesCents += total;
    }
  }
  topCategoriesYtd.sort((a, b) => b.amountCents - a.amountCents);

  // Cash on hand from asset accounts
  const assetAccounts = await db.abAccount.findMany({
    where: { tenantId, accountType: 'asset', isActive: true },
    select: { journalLines: { select: { debitCents: true, creditCents: true } } },
  });
  const cashTodayCents = assetAccounts.reduce(
    (sum, a) => sum + a.journalLines.reduce((s, l) => s + l.debitCents - l.creditCents, 0),
    0,
  );

  // Outstanding invoices
  const outstandingInvoices = await db.abInvoice.findMany({
    where: { tenantId, status: { in: ['sent', 'viewed', 'overdue'] } },
    include: { payments: true },
  });
  const outstandingInvoiceCents = outstandingInvoices.reduce((s, inv) => {
    const paid = inv.payments.reduce((p, pay) => p + pay.amountCents, 0);
    return s + (inv.amountCents - paid);
  }, 0);
  const pastDueInvoiceCount = outstandingInvoices.filter((inv) => inv.dueDate < now).length;
  const upcomingInvoiceCents = outstandingInvoices
    .filter((inv) => inv.dueDate >= now)
    .reduce((s, inv) => {
      const paid = inv.payments.reduce((p, pay) => p + pay.amountCents, 0);
      return s + (inv.amountCents - paid);
    }, 0);

  // Recurring monthly outflows
  const recurringRules = await db.abRecurringRule.findMany({
    where: { tenantId, active: true },
    select: { amountCents: true, frequency: true },
  });
  const recurringMonthlyCents = recurringRules.reduce((s, r) => {
    const factor =
      r.frequency === 'weekly' ? 4.33 :
      r.frequency === 'biweekly' ? 2.17 :
      r.frequency === 'quarterly' ? 1 / 3 :
      r.frequency === 'annual' ? 1 / 12 :
      1; // monthly
    return s + Math.round(r.amountCents * factor);
  }, 0);

  // Tax deadline countdown — reads real per-jurisdiction quarterly
  // deadline data instead of a hardcoded US/CA-only date array.
  const jurisdiction = tenantConfig?.jurisdiction || 'us';
  const taxDaysUntilQ = nextQuarterlyTaxDeadline(jurisdiction, tenantConfig?.region || '', now);
  const latestEstimate = await db.abTaxEstimate.findFirst({
    where: { tenantId },
    orderBy: { calculatedAt: 'desc' },
  });
  const taxQuarterlyEstimateCents = latestEstimate
    ? Math.ceil(latestEstimate.totalTaxCents / 4)
    : null;

  // Receipt coverage (business expenses YTD with receipt URLs / total)
  const [withReceipts, totalExpenses] = await Promise.all([
    db.abExpense.count({
      where: { tenantId, isPersonal: false, date: { gte: yearStart }, receiptUrl: { not: null } },
    }),
    db.abExpense.count({
      where: { tenantId, isPersonal: false, date: { gte: yearStart } },
    }),
  ]);
  const receiptCoveragePct = totalExpenses > 0 ? Math.round((withReceipts / totalExpenses) * 100) : 100;

  return {
    jurisdiction,
    currency: tenantConfig?.currency || 'USD',
    cashTodayCents,
    monthlyBurnCents,
    monthlyRevenueCents,
    ytdRevenueCents,
    ytdExpensesCents,
    ytdNetIncomeCents: ytdRevenueCents - ytdExpensesCents,
    taxDaysUntilQ,
    taxQuarterlyEstimateCents,
    topCategoriesYtd: topCategoriesYtd.slice(0, 5),
    outstandingInvoiceCents,
    upcomingInvoiceCents,
    pastDueInvoiceCount,
    recurringMonthlyCents,
    receiptCoveragePct,
  };
}

/**
 * Generate one tax-planning tip. Gemini first; a rule-based fallback
 * runs through the same context if the LLM is unavailable. Both paths
 * produce a single tip that names a specific number and ends with an
 * action.
 */
export async function generateTaxTip(ctx: TipContext): Promise<DigestTip | null> {
  const llm = await generateTipWithGemini('tax-planning', ctx);
  if (llm) return { text: llm, source: 'llm' };
  return generateTaxTipDeterministic(ctx);
}

export async function generateCashFlowTip(ctx: TipContext): Promise<DigestTip | null> {
  const llm = await generateTipWithGemini('cash-flow', ctx);
  if (llm) return { text: llm, source: 'llm' };
  return generateCashFlowTipDeterministic(ctx);
}

async function generateTipWithGemini(
  topic: 'tax-planning' | 'cash-flow',
  ctx: TipContext,
): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  const model = process.env.GEMINI_MODEL_FAST || 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const systemPrompt = `You are a senior CPA writing a one-line tip for a freelancer's morning briefing.

RULES:
   • Maximum two sentences, total length ≤ 220 characters.
   • MUST reference at least one specific number from the context.
   • MUST end with a verb the reader can act on (e.g., "claim it",
     "chase the overdue", "set aside", "review").
   • NO generic platitudes ("save more!", "review your spending").
   • Plain text — no markdown, no asterisks, no emojis.
   • If there is genuinely nothing useful to say given the data,
     return the literal string "SKIP".

Topic: ${topic === 'tax-planning' ? 'tax planning (deductions, deadlines, withholding, brackets)' : 'cash flow (runway, AR, recurring outflows, near-term liquidity)'}

Tenant context:
${JSON.stringify(ctx, null, 2)}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: 'Generate the tip.' }] }],
        // Higher ceiling + disabled thinking so Gemini 2.5 doesn't spend the
        // budget on reasoning and return a mid-sentence truncated tip.
        generationConfig: { maxOutputTokens: 512, temperature: 0.4, thinkingConfig: { thinkingBudget: 0 } },
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[] };
    const candidate = data.candidates?.[0];
    const raw = (candidate?.content?.parts?.[0]?.text || '').trim();
    if (!raw || raw === 'SKIP') return null;
    // Drop truncated output (hit the token cap mid-sentence) rather than ship
    // a tip that ends like "…until your".
    if (candidate?.finishReason && candidate.finishReason !== 'STOP') return null;
    const cleaned = raw.replace(/^[*•\-]\s*/, '').trim();
    // Tips must reference a number AND read as a complete sentence.
    if (!/\d/.test(cleaned)) return null;
    if (!/[.!?]$/.test(cleaned)) return null;
    return cleaned;
  } catch {
    return null;
  }
}

export function generateTaxTipDeterministic(ctx: TipContext): DigestTip | null {
  const money = (cents: number) => formatCurrencyCents(cents, ctx.currency);
  const agency = TAX_AGENCY[ctx.jurisdiction] ?? 'IRS';

  // Quarterly/instalment deadline takes priority when close. (Amounts are
  // jurisdiction-neutral; only the currency label changes.)
  if (ctx.taxDaysUntilQ !== null && ctx.taxDaysUntilQ <= 21 && ctx.taxQuarterlyEstimateCents) {
    const cashCovers = ctx.cashTodayCents >= ctx.taxQuarterlyEstimateCents;
    const action = cashCovers ? 'set it aside today.' : 'start moving funds now.';
    return {
      text: `Estimated tax instalment of ${money(ctx.taxQuarterlyEstimateCents)} is due in ${ctx.taxDaysUntilQ} days. Cash on hand ${cashCovers ? 'covers it' : `(${money(ctx.cashTodayCents)}) doesn't cover it yet`} — ${action}`,
      source: 'rule',
    };
  }

  // Meals: 50% deductible in the US (Schedule C 24b) and CA (T2125). AU meal
  // entertainment is generally non-deductible, so this tip is suppressed there
  // rather than asserting a rule that doesn't apply.
  const mealsForm = MEALS_50_FORM[ctx.jurisdiction];
  const mealsCat = ctx.topCategoriesYtd.find((c) => /meals?/i.test(c.category));
  if (mealsForm && mealsCat && mealsCat.amountCents > 50_000) {
    const deductible = Math.round(mealsCat.amountCents * 0.5);
    return {
      text: `Meals YTD: ${money(mealsCat.amountCents)} → ${money(deductible)} deductible at the 50% rule (${mealsForm}). Document the business purpose on each receipt to lock it in.`,
      source: 'rule',
    };
  }

  // Receipt coverage gap. The US names a specific $75 threshold; other
  // jurisdictions get the agency-neutral record-keeping nudge.
  if (ctx.receiptCoveragePct < 80) {
    const backup = ctx.jurisdiction === 'us'
      ? `The ${agency} expects backup for any expense over $75`
      : `The ${agency} expects documentation to back your claimed expenses`;
    return {
      text: `Receipt coverage is at ${ctx.receiptCoveragePct}%. ${backup} — sweep through "missing receipts" and snap photos before your filing deadline.`,
      source: 'rule',
    };
  }

  // Net income running high — set-aside nudge, labeled per jurisdiction.
  if (ctx.ytdNetIncomeCents > 5_000_000) {
    const setAside = Math.round(ctx.ytdNetIncomeCents * 0.27);
    const label = SET_ASIDE_LABEL[ctx.jurisdiction] ?? 'income tax';
    return {
      text: `Net income YTD is ${money(ctx.ytdNetIncomeCents)}. Plan to set aside ~27% (≈ ${money(setAside)}) for ${label} — confirm your instalments are on track.`,
      source: 'rule',
    };
  }

  return null;
}

function generateCashFlowTipDeterministic(ctx: TipContext): DigestTip | null {
  const money = (cents: number) => formatCurrencyCents(cents, ctx.currency);
  // Runway warning.
  if (ctx.monthlyBurnCents > 0) {
    const months = ctx.cashTodayCents / ctx.monthlyBurnCents;
    if (months < 2) {
      return {
        text: `Cash on hand ${money(ctx.cashTodayCents)} = ${months.toFixed(1)} months at current burn (${money(ctx.monthlyBurnCents)}/mo). ${ctx.outstandingInvoiceCents > 0 ? `Chase ${money(ctx.outstandingInvoiceCents)} in outstanding AR to extend runway.` : 'Cut a recurring or accelerate AR to extend runway.'}`,
        source: 'rule',
      };
    }
  }

  // Past-due invoices.
  if (ctx.pastDueInvoiceCount > 0) {
    return {
      text: `${ctx.pastDueInvoiceCount} invoice${ctx.pastDueInvoiceCount === 1 ? '' : 's'} past due — that's ${money(ctx.outstandingInvoiceCents - ctx.upcomingInvoiceCents)} you've already earned. Send a reminder today.`,
      source: 'rule',
    };
  }

  // High recurring share.
  if (ctx.recurringMonthlyCents > 0 && ctx.monthlyBurnCents > 0) {
    const pct = Math.round((ctx.recurringMonthlyCents / ctx.monthlyBurnCents) * 100);
    if (pct >= 40) {
      return {
        text: `Recurring outflows are ${money(ctx.recurringMonthlyCents)}/mo — ${pct}% of total burn. Review for unused subscriptions you can cancel.`,
        source: 'rule',
      };
    }
  }

  // Healthy cash but inactive AR push.
  if (ctx.upcomingInvoiceCents > 0 && ctx.upcomingInvoiceCents > ctx.cashTodayCents) {
    return {
      text: `${money(ctx.upcomingInvoiceCents)} in invoices comes due over the next 30 days — confirm with the biggest clients that they're on track to pay.`,
      source: 'rule',
    };
  }

  return null;
}
