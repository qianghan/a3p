/**
 * GET /api/v1/agentbook-payroll/tax-deposits/:id/pdf — serve a real PDF for
 * one tax-deposit record (941/940/t4/paye/bas/sg).
 *
 * No new schema/migration: 941's line-item breakdown (income tax withheld,
 * employee FICA, employer-match FICA) isn't stored on AbPayrollTaxDeposit,
 * so it's re-derived at render time by re-querying AbPayStub for the
 * deposit's period — mirroring computeDeposit's own approximation (employer
 * FICA match == employee FICA match, US only). 940 just needs the total
 * gross wages for the period (no wage-base sub-lines, per the FUTA
 * simplification documented in payroll-deposits.ts). Other forms (t4/paye/
 * bas/sg) render via the generic fallback — no IRS-style breakdown exists
 * for those today.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { render941Pdf, render940Pdf, renderGenericDepositPdf } from '@/lib/payroll-forms-pdf';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface RouteCtx { params: Promise<{ id: string }> }

/** Parse "YYYY-QN" (941/t4/paye/bas/sg) into the quarter's [start, end) date range. */
function quarterRange(periodLabel: string): { start: Date; end: Date } | null {
  const m = periodLabel.match(/^(\d{4})-Q([1-4])$/);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const q = parseInt(m[2], 10);
  const startMonth = (q - 1) * 3;
  return { start: new Date(year, startMonth, 1), end: new Date(year, startMonth + 3, 1) };
}

/** Parse "YYYY" (940) into that calendar year's [start, end) date range. */
function yearRange(periodLabel: string): { start: Date; end: Date } | null {
  const m = periodLabel.match(/^(\d{4})$/);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  return { start: new Date(year, 0, 1), end: new Date(year + 1, 0, 1) };
}

export async function GET(request: NextRequest, ctx: RouteCtx): Promise<Response> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const { id } = await ctx.params;

    const [cfg, deposit] = await Promise.all([
      db.abTenantConfig.findUnique({ where: { userId: tenantId } }),
      db.abPayrollTaxDeposit.findFirst({ where: { id, tenantId } }),
    ]);
    if (!deposit) {
      return NextResponse.json({ success: false, error: 'deposit not found' }, { status: 404 });
    }
    const employerName = cfg?.companyName || 'AgentBook';

    let pdf: Buffer;
    if (deposit.form === '941' || deposit.form === '940') {
      const range = deposit.form === '941' ? quarterRange(deposit.periodLabel) : yearRange(deposit.periodLabel);
      const stubs = range
        ? await db.abPayStub.findMany({
            where: { tenantId, payRun: { periodEnd: { gte: range.start, lt: range.end }, status: 'paid' } },
          })
        : [];

      const grossWagesCents = stubs.length > 0 ? stubs.reduce((sum, s) => sum + s.grossCents, 0) : undefined;

      if (deposit.form === '941') {
        const incomeTaxWithheldCents = stubs.reduce((sum, s) => sum + s.federalTaxCents + s.stateTaxCents, 0);
        const employeeFicaCents = stubs.reduce((sum, s) => sum + s.ficaCents, 0);
        // Employer FICA match approximated as equal to employee FICA — same
        // approximation computeDeposit uses for the US 941 amount.
        const employerFicaCents = employeeFicaCents;
        pdf = await render941Pdf({
          form: deposit.form,
          employerName,
          periodLabel: deposit.periodLabel,
          dueDate: deposit.dueDate.toISOString(),
          amountCents: deposit.amountCents,
          grossWagesCents,
          breakdown: stubs.length > 0 ? { incomeTaxWithheldCents, employeeFicaCents, employerFicaCents } : undefined,
        });
      } else {
        pdf = await render940Pdf({
          form: deposit.form,
          employerName,
          periodLabel: deposit.periodLabel,
          dueDate: deposit.dueDate.toISOString(),
          amountCents: deposit.amountCents,
          grossWagesCents,
        });
      }
    } else {
      pdf = await renderGenericDepositPdf({
        form: deposit.form,
        employerName,
        periodLabel: deposit.periodLabel,
        dueDate: deposit.dueDate.toISOString(),
        amountCents: deposit.amountCents,
      });
    }

    return new Response(pdf as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="form-${deposit.form}-${deposit.periodLabel}.pdf"`,
        'Cache-Control': 'private, max-age=300',
      },
    });
  } catch (err) {
    console.error('[agentbook-payroll/tax-deposits/:id/pdf] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
