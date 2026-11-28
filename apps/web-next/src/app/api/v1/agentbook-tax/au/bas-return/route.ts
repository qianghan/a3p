/**
 * GET /api/v1/agentbook-tax/au/bas-return?periodStart=&periodEnd=
 *
 * Computes the GST labels of an Australian BAS for the period from the tenant's
 * own booked data — 1A (GST collected) from invoices' persisted taxCents, 1B
 * (ITCs) from expenses' persisted taxAmountCents, G1 (gross sales) from invoice
 * amounts — and returns the labels + sales/purchase working papers.
 *
 * AU-only (422 otherwise). Prep + net-GST computation; electronic lodgment
 * (SBR/ATO) is a separate accreditation step (launch guide §7.1) — not
 * transmitted here. PAYG-withholding labels (W1/W2) are a follow-on.
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { computeBasReturn } from '@agentbook/jurisdictions/au/bas-return';
import { publicErrorMessage } from '@/lib/api-error';
import { payRunStatutoryDateWhere } from '@/lib/payroll-pay-date';
import { liveExpenseWhere } from '@/lib/agentbook-live-expense';
import { loadBillPurchases, gstBasisOf } from '@/lib/tax-return-bills';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;

    const cfg = await db.abTenantConfig.findUnique({ where: { userId: tenantId } });
    if ((cfg?.jurisdiction || 'us') !== 'au') {
      return NextResponse.json(
        { success: false, error: { code: 'unsupported_jurisdiction', message: 'BAS is only available for Australian tenants.' } },
        { status: 422 },
      );
    }

    // Default to the current calendar quarter when no period is given.
    const now = new Date();
    const q = Math.floor(now.getUTCMonth() / 3);
    const defStart = new Date(Date.UTC(now.getUTCFullYear(), q * 3, 1));
    const defEnd = new Date(Date.UTC(now.getUTCFullYear(), q * 3 + 3, 0));
    const periodStart = request.nextUrl.searchParams.get('periodStart') || defStart.toISOString().slice(0, 10);
    const periodEnd = request.nextUrl.searchParams.get('periodEnd') || defEnd.toISOString().slice(0, 10);
    const gte = new Date(`${periodStart}T00:00:00.000Z`);
    const lte = new Date(`${periodEnd}T23:59:59.999Z`);

    const gstBasis = gstBasisOf(cfg);
    const [invoices, expenses, payRuns, billLines] = await Promise.all([
      db.abInvoice.findMany({
        where: { tenantId, issuedDate: { gte, lte }, status: { in: ['sent', 'viewed', 'overdue', 'paid'] } },
        select: { amountCents: true, taxCents: true },
      }),
      db.abExpense.findMany({
        where: { tenantId, isPersonal: false, ...liveExpenseWhere(), date: { gte, lte } },
        select: { amountCents: true, taxAmountCents: true, taxCode: true, recoverableTaxCents: true },
      }),
      // PAYG-W (W1/W2): pay runs paid in the BAS period. federalTaxCents is the
      // AU PAYG amount withheld; grossCents is the wages paid. PR 4d: bucketed
      // by pay date (legacy runs without one keep periodEnd).
      db.abPayRun.findMany({
        where: { tenantId, status: 'paid', ...payRunStatutoryDateWhere({ gte, lte }) }, // drafts never reach W1/W2
        select: { stubs: { select: { grossCents: true, federalTaxCents: true } } },
      }),
      // PR 3bc.6: bills (never AbExpense rows) — accrual by billDate, cash by payment date pro-rata.
      loadBillPurchases(db, tenantId, gte, lte, gstBasis),
    ]);

    const wages = payRuns.flatMap((run) =>
      run.stubs.map((s) => ({ grossCents: s.grossCents, paygWithheldCents: s.federalTaxCents })),
    );

    const result = computeBasReturn({
      periodStart,
      periodEnd,
      sales: invoices.map((i) => ({ grossSalesCents: i.amountCents, gstCollectedCents: i.taxCents ?? 0 })),
      // PR 2b.7: typed rows → recoverableTaxCents (1B) + G10/G11 by code; untyped → taxAmountCents.
      purchases: expenses.map((e) => ({
        gstPaidCents: e.taxAmountCents ?? 0,
        taxCode: e.taxCode,
        recoverableTaxCents: e.recoverableTaxCents,
        grossCents: e.amountCents,
      })).concat(billLines.map((b) => ({
        gstPaidCents: b.taxPaidCents,
        taxCode: b.taxCode,
        recoverableTaxCents: b.recoverableTaxCents,
        grossCents: b.grossCents,
      }))),
      gstRegistered: cfg?.gstRegistered ?? null,
      wages,
    });

    return NextResponse.json({ success: true, data: { ...result, gstReportingBasis: gstBasis, salesBasis: 'invoice_date', wagesBasis: 'pay_date' } }); // M6: sales (1A/105) stay invoice-dated on both bases
  } catch (err) {
    console.error('[agentbook-tax/au/bas-return] failed:', err);
    return NextResponse.json({ success: false, error: publicErrorMessage(err) }, { status: 500 });
  }
}
