/**
 * What-If cashflow scenario — calculate tax impact of adding an expense or income.
 *
 * POST { changeAmountCents: number }
 *   positive → additional expense (reduces net income → reduces tax)
 *   negative → additional income (increases net income → increases tax)
 *
 * Returns: { scenario, currentTaxCents, projectedTaxCents, savingsCents, explanation }
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const US_FEDERAL_BRACKETS = [
  { upTo: 11_600_00, rate: 0.10 },
  { upTo: 47_150_00, rate: 0.12 },
  { upTo: 100_525_00, rate: 0.22 },
  { upTo: 191_950_00, rate: 0.24 },
  { upTo: 243_725_00, rate: 0.32 },
  { upTo: 609_350_00, rate: 0.35 },
  { upTo: Infinity, rate: 0.37 },
];

const CA_FEDERAL_BRACKETS = [
  { upTo: 57_375_00, rate: 0.15 },
  { upTo: 114_750_00, rate: 0.205 },
  { upTo: 158_468_00, rate: 0.26 },
  { upTo: 221_708_00, rate: 0.29 },
  { upTo: Infinity, rate: 0.33 },
];

function calcProgressiveTax(incomeCents: number, brackets: { upTo: number; rate: number }[]): number {
  if (incomeCents <= 0) return 0;
  let remaining = incomeCents;
  let tax = 0;
  let prev = 0;
  for (const bracket of brackets) {
    const width = bracket.upTo === Infinity ? remaining : bracket.upTo - prev;
    const taxable = Math.min(remaining, width);
    tax += Math.round(taxable * bracket.rate);
    remaining -= taxable;
    prev = bracket.upTo;
    if (remaining <= 0) break;
  }
  return tax;
}

function calcTotalTax(netIncomeCents: number, jurisdiction: string): number {
  if (netIncomeCents <= 0) return 0;
  const seTax = jurisdiction === 'us'
    ? Math.round(netIncomeCents * 0.9235 * 0.153)
    : jurisdiction === 'ca'
    ? Math.round(netIncomeCents * 0.119)
    : 0;
  const seDeduction = jurisdiction === 'us' ? Math.round(seTax / 2) : 0;
  const taxable = Math.max(0, netIncomeCents - seDeduction);
  const brackets = jurisdiction === 'ca' ? CA_FEDERAL_BRACKETS : US_FEDERAL_BRACKETS;
  return seTax + calcProgressiveTax(taxable, brackets);
}

function fmt(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Math.abs(cents) / 100);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;

    const body = await request.json() as { changeAmountCents?: number };
    const changeAmountCents = Number(body.changeAmountCents ?? 0);
    if (!Number.isFinite(changeAmountCents)) {
      return NextResponse.json({ success: false, error: 'changeAmountCents must be a number' }, { status: 400 });
    }

    const tenantConfig = await db.abTenantConfig.findUnique({ where: { userId: tenantId } });
    const jurisdiction = tenantConfig?.jurisdiction || 'us';
    const yearStart = new Date(new Date().getFullYear(), 0, 1);
    const now = new Date();

    const [revenueAccounts, expenseAccounts] = await Promise.all([
      db.abAccount.findMany({ where: { tenantId, accountType: 'revenue', isActive: true }, select: { id: true } }),
      db.abAccount.findMany({ where: { tenantId, accountType: 'expense', isActive: true }, select: { id: true } }),
    ]);

    const [revenueAgg, expenseAgg] = await Promise.all([
      revenueAccounts.length > 0
        ? db.abJournalLine.aggregate({
            where: { accountId: { in: revenueAccounts.map((a) => a.id) }, entry: { tenantId, date: { gte: yearStart, lte: now } } },
            _sum: { creditCents: true, debitCents: true },
          })
        : { _sum: { creditCents: 0, debitCents: 0 } },
      expenseAccounts.length > 0
        ? db.abJournalLine.aggregate({
            where: { accountId: { in: expenseAccounts.map((a) => a.id) }, entry: { tenantId, date: { gte: yearStart, lte: now } } },
            _sum: { creditCents: true, debitCents: true },
          })
        : { _sum: { creditCents: 0, debitCents: 0 } },
    ]);

    const grossRevenueCents = (revenueAgg._sum.creditCents || 0) - (revenueAgg._sum.debitCents || 0);
    const expensesCents = (expenseAgg._sum.debitCents || 0) - (expenseAgg._sum.creditCents || 0);
    const netIncomeCents = grossRevenueCents - expensesCents;

    const currentTaxCents = calcTotalTax(netIncomeCents, jurisdiction);

    // Apply scenario: positive changeAmountCents = add expense (lowers net), negative = add income (raises net)
    const projectedNetIncome = netIncomeCents - changeAmountCents;
    const projectedTaxCents = calcTotalTax(projectedNetIncome, jurisdiction);

    const savingsCents = currentTaxCents - projectedTaxCents;
    const isExpense = changeAmountCents > 0;
    const scenario = isExpense
      ? `Adding ${fmt(changeAmountCents)} in expenses`
      : `Adding ${fmt(Math.abs(changeAmountCents))} in income`;

    let explanation: string;
    if (savingsCents > 0) {
      explanation = `Tax savings of ${fmt(savingsCents)} — deductible expenses reduce your taxable income.`;
    } else if (savingsCents < 0) {
      explanation = `Tax increase of ${fmt(Math.abs(savingsCents))} — additional income raises your tax liability.`;
    } else {
      explanation = 'No tax impact — income below the taxable threshold.';
    }

    return NextResponse.json({
      success: true,
      data: { scenario, currentTaxCents, projectedTaxCents, savingsCents, explanation },
    });
  } catch (err) {
    console.error('[cashflow/scenario] error:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
