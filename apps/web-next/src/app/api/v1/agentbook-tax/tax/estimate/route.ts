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

function calcSelfEmploymentTax(netIncomeCents: number, jurisdiction: string): number {
  if (netIncomeCents <= 0) return 0;
  if (jurisdiction === 'us') return Math.round(netIncomeCents * 0.9235 * 0.153);
  if (jurisdiction === 'ca') return Math.round(netIncomeCents * 0.119);
  return 0;
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

    const seTaxCents = calcSelfEmploymentTax(netIncomeCents, jurisdiction);
    const seDeduction = jurisdiction === 'us' ? Math.round(seTaxCents / 2) : 0;
    const taxableIncomeCents = Math.max(0, netIncomeCents - seDeduction);
    const brackets = jurisdiction === 'ca' ? CA_FEDERAL_BRACKETS : US_FEDERAL_BRACKETS;
    // W-2 wages stack on top of self-employment income for bracket placement.
    const incomeTaxCents = calcProgressiveTax(taxableIncomeCents + w2IncomeCents, brackets);
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
