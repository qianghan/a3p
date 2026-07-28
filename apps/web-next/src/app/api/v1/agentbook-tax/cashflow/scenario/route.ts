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
import { formatCurrencyCents } from '@/lib/jurisdiction-currency';
import { estimateTotalIncomeTax } from '@agentbook/jurisdictions/total-tax';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// One canonical composer (SE + federal + sub-national) shared with the chat
// What-If simulator and the estimate route — includes US-state / CA-provincial
// tax (previously omitted here, which under-estimated the scenario) with no
// double-count.
function calcTotalTax(netIncomeCents: number, jurisdiction: string, region: string | null | undefined, taxYear: number): number {
  return estimateTotalIncomeTax(netIncomeCents, jurisdiction, region, taxYear).totalTaxCents;
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
    const region = tenantConfig?.region || '';
    const currency = tenantConfig?.currency || 'USD';
    const locale = tenantConfig?.locale || 'en-US';
    const yearStart = new Date(new Date().getFullYear(), 0, 1);
    const now = new Date();
    const taxYear = now.getFullYear();
    const fmt = (cents: number): string => formatCurrencyCents(cents, currency, locale);

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

    const currentTaxCents = calcTotalTax(netIncomeCents, jurisdiction, region, taxYear);

    // Apply scenario: positive changeAmountCents = add expense (lowers net), negative = add income (raises net)
    const projectedNetIncome = netIncomeCents - changeAmountCents;
    const projectedTaxCents = calcTotalTax(projectedNetIncome, jurisdiction, region, taxYear);

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
