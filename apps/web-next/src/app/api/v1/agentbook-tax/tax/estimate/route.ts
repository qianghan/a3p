/**
 * Tax estimate — native Next.js route.
 *
 * Computes self-employment tax + progressive income tax for the
 * tenant's revenue and expense journal-line aggregates. Read-only:
 * the AbTaxEstimate / AbEvent writes from the legacy handler are
 * intentionally omitted here to keep the function bundle minimal.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { usTaxBrackets } from '@agentbook/jurisdictions/us/tax-brackets';
import { caTaxBrackets } from '@agentbook/jurisdictions/ca/tax-brackets';
import { auTaxBrackets } from '@agentbook/jurisdictions/au/tax-brackets';
import { usSelfEmploymentTax } from '@agentbook/jurisdictions/us/self-employment-tax';
import { caSelfEmploymentTax } from '@agentbook/jurisdictions/ca/self-employment-tax';
import { auSelfEmploymentTax } from '@agentbook/jurisdictions/au/self-employment-tax';
import type { TaxBracketProvider, SelfEmploymentTaxCalculator } from '@agentbook/jurisdictions/interfaces';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// Real, tested jurisdiction-pack logic — replaces the previously duplicated,
// less-accurate inline US/CA-only calculations (no SS wage cap, no
// Additional Medicare Tax, no CPP basic exemption/CPP2 ceiling) and the
// silent "$0 self-employment tax, US brackets" fallback for every other
// jurisdiction, including au.
const BRACKET_PROVIDERS: Record<string, TaxBracketProvider> = {
  us: usTaxBrackets,
  ca: caTaxBrackets,
  au: auTaxBrackets,
};
const SE_TAX_CALCULATORS: Record<string, SelfEmploymentTaxCalculator> = {
  us: usSelfEmploymentTax,
  ca: caSelfEmploymentTax,
  au: auSelfEmploymentTax,
};

function calcSelfEmploymentTax(netIncomeCents: number, jurisdiction: string, taxYear: number): { amountCents: number; deductiblePortionCents: number } {
  if (netIncomeCents <= 0) return { amountCents: 0, deductiblePortionCents: 0 };
  const calculator = SE_TAX_CALCULATORS[jurisdiction];
  if (!calculator) return { amountCents: 0, deductiblePortionCents: 0 };
  const result = calculator.calculate(netIncomeCents, taxYear);
  return { amountCents: result.amountCents, deductiblePortionCents: result.deductiblePortionCents };
}

function parseDate(val: string | null, fallback: Date): Date {
  if (!val) return fallback;
  const d = new Date(val);
  return isNaN(d.getTime()) ? fallback : d;
}

function currentPeriod(): string {
  const now = new Date();
  const q = Math.ceil((now.getMonth() + 1) / 3);
  return `${now.getFullYear()}-Q${q}`;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const params = request.nextUrl.searchParams;

    const tenantConfig = await db.abTenantConfig.findUnique({ where: { userId: tenantId } });
    const jurisdiction = tenantConfig?.jurisdiction || 'us';
    const region = tenantConfig?.region || '';

    // Accounting basis: explicit ?basis= → tenant config → accrual (mirrors the P&L route).
    const basisParam = (params.get('basis') || '').toLowerCase();
    const accountingBasis =
      basisParam === 'cash' || basisParam === 'accrual'
        ? basisParam
        : tenantConfig?.accountingBasis === 'cash'
          ? 'cash'
          : 'accrual';

    // W-2 (employed) income alongside self-employment, from tax config.
    // Stacks on income-tax brackets; withholding already paid is credited.
    const taxConfig = await db.abTaxConfig.findUnique({ where: { tenantId } });
    const w2IncomeCents = taxConfig?.w2IncomeAnnual ?? 0;
    const w2WithheldCents = taxConfig?.w2WithheldYtd ?? 0;
    const combinedMode = w2IncomeCents > 0 || w2WithheldCents > 0;

    const yearStart = new Date(new Date().getFullYear(), 0, 1);
    const startDate = parseDate(params.get('startDate'), yearStart);
    const endDate = parseDate(params.get('endDate'), new Date());

    const [revenueAccounts, expenseAccounts] = await Promise.all([
      db.abAccount.findMany({ where: { tenantId, accountType: 'revenue', isActive: true }, select: { id: true } }),
      db.abAccount.findMany({ where: { tenantId, accountType: 'expense', isActive: true }, select: { id: true } }),
    ]);

    const revenueIds = revenueAccounts.map((a) => a.id);
    const expenseIds = expenseAccounts.map((a) => a.id);

    let grossRevenueCents: number;
    let expensesCents: number;

    if (accountingBasis === 'cash') {
      // Cash basis: revenue = customer payments received in the period; expenses =
      // expense-account debits whose journal entry also credits the cash account
      // (1000) — i.e. cash that actually left. Unpaid invoices/bills are excluded.
      const cashAccount = await db.abAccount.findFirst({
        where: { tenantId, code: '1000' },
        select: { id: true },
      });
      const paymentsAgg = await db.abPayment.aggregate({
        where: { tenantId, date: { gte: startDate, lte: endDate } },
        _sum: { amountCents: true },
      });
      grossRevenueCents = paymentsAgg._sum.amountCents || 0;

      if (cashAccount && expenseIds.length > 0) {
        const debitLines = await db.abJournalLine.findMany({
          where: {
            accountId: { in: expenseIds },
            entry: {
              tenantId,
              date: { gte: startDate, lte: endDate },
              lines: { some: { accountId: cashAccount.id, creditCents: { gt: 0 } } },
            },
          },
          select: { debitCents: true, creditCents: true },
        });
        expensesCents = debitLines.reduce((s, l) => s + (l.debitCents - l.creditCents), 0);
      } else {
        // No cash account configured — fall back to the accrual expense view.
        const expenseAgg =
          expenseIds.length > 0
            ? await db.abJournalLine.aggregate({
                where: { accountId: { in: expenseIds }, entry: { tenantId, date: { gte: startDate, lte: endDate } } },
                _sum: { creditCents: true, debitCents: true },
              })
            : { _sum: { creditCents: 0, debitCents: 0 } };
        expensesCents = (expenseAgg._sum.debitCents || 0) - (expenseAgg._sum.creditCents || 0);
      }
    } else {
      // Accrual (default): journal-line aggregates over revenue/expense accounts.
      const [revenueAgg, expenseAgg] = await Promise.all([
        revenueIds.length > 0
          ? db.abJournalLine.aggregate({
              where: {
                accountId: { in: revenueIds },
                entry: { tenantId, date: { gte: startDate, lte: endDate } },
              },
              _sum: { creditCents: true, debitCents: true },
            })
          : Promise.resolve({ _sum: { creditCents: 0, debitCents: 0 } } as const),
        expenseIds.length > 0
          ? db.abJournalLine.aggregate({
              where: {
                accountId: { in: expenseIds },
                entry: { tenantId, date: { gte: startDate, lte: endDate } },
              },
              _sum: { creditCents: true, debitCents: true },
            })
          : Promise.resolve({ _sum: { creditCents: 0, debitCents: 0 } } as const),
      ]);
      grossRevenueCents = (revenueAgg._sum.creditCents || 0) - (revenueAgg._sum.debitCents || 0);
      expensesCents = (expenseAgg._sum.debitCents || 0) - (expenseAgg._sum.creditCents || 0);
    }

    const netIncomeCents = grossRevenueCents - expensesCents;

    const taxYear = startDate.getFullYear();
    const seTax = calcSelfEmploymentTax(netIncomeCents, jurisdiction, taxYear);
    const seTaxCents = seTax.amountCents;
    // Each jurisdiction's calculator already knows its own deductible
    // portion (half of US SE tax, the employer-equivalent CPP portion,
    // none for AU's non-deductible Medicare Levy) — no more us-only ternary.
    const seDeduction = seTax.deductiblePortionCents;
    const taxableIncomeCents = Math.max(0, netIncomeCents - seDeduction);
    const bracketProvider = BRACKET_PROVIDERS[jurisdiction] ?? usTaxBrackets;
    // W-2 wages stack on top of self-employment income for bracket placement.
    // filingStatus (already stored per-tenant, default 'single') selects the
    // married-filing-jointly bracket table for US tenants; other jurisdiction
    // packs ignore the extra argument.
    const incomeTaxCents = bracketProvider.calculateTax(taxableIncomeCents + w2IncomeCents, taxYear, taxConfig?.filingStatus).taxCents;
    const totalTaxCents = seTaxCents + incomeTaxCents;
    // What is still owed after crediting W-2 tax already withheld this year.
    const amountOwedCents = Math.max(0, totalTaxCents - w2WithheldCents);
    const period = params.get('period') || currentPeriod();
    const incomeBaseCents = netIncomeCents + w2IncomeCents;
    const effectiveRate = incomeBaseCents > 0
      ? parseFloat((totalTaxCents / incomeBaseCents * 100).toFixed(2))
      : 0;

    // The legacy plugin frontend reads top-level snake_case dollar fields
    // (data.total_estimated_tax etc.); the new dashboard reads the cents
    // values under `data`. Emit both shapes to keep both consumers happy.
    return NextResponse.json({
      success: true,
      data: {
        period,
        jurisdiction,
        region,
        accountingBasis,
        grossRevenueCents,
        expensesCents,
        netIncomeCents,
        seTaxCents,
        incomeTaxCents,
        totalTaxCents,
        // Combined business + W-2 context (zeros/false when no W-2 configured)
        combinedMode,
        w2IncomeCents,
        w2WithheldCents,
        amountOwedCents,
        effectiveRate,
        calculatedAt: new Date().toISOString(),
        dateRange: { startDate: startDate.toISOString(), endDate: endDate.toISOString() },
      },
      total_estimated_tax: totalTaxCents / 100,
      income_tax: incomeTaxCents / 100,
      self_employment_tax: seTaxCents / 100,
      effective_rate: effectiveRate,
      total_revenue: grossRevenueCents / 100,
      total_expenses: expensesCents / 100,
      net_income: netIncomeCents / 100,
      combined_mode: combinedMode,
      w2_income: w2IncomeCents / 100,
      w2_withheld: w2WithheldCents / 100,
      amount_owed: amountOwedCents / 100,
      quarterly_payments: [],
    });
  } catch (err) {
    console.error('[agentbook-tax/tax/estimate] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
