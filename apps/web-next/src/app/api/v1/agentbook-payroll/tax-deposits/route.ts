/**
 * Payroll tax deposits — list upcoming/paid (GET) + mark one paid (POST).
 * Marking paid posts Dr Payroll Liabilities (Superannuation Payable for 'sg')
 * / Cr Cash, keyed on the deposit so it clears the liability exactly once.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { publicErrorMessage } from '@/lib/api-error';
import { appendBalancedEntry, assertPeriodOpen, LedgerPeriodClosedError } from '@/lib/ledger-writer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const deposits = await db.abPayrollTaxDeposit.findMany({
      where: { tenantId },
      orderBy: { dueDate: 'asc' },
    });
    return NextResponse.json({ success: true, data: deposits });
  } catch (err) {
    console.error('[agentbook-payroll/tax-deposits GET] failed:', err);
    return NextResponse.json({ success: false, error: publicErrorMessage(err) }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const body = (await request.json().catch(() => ({}))) as { id?: string };
    if (!body.id) return NextResponse.json({ success: false, error: 'id required' }, { status: 400 });
    const dep = await db.abPayrollTaxDeposit.findFirst({ where: { id: body.id, tenantId } });
    if (!dep) return NextResponse.json({ success: false, error: 'deposit not found' }, { status: 404 });
    if (dep.status === 'paid') return NextResponse.json({ success: false, error: 'deposit already paid' }, { status: 409 });
    const paidAt = new Date();
    const [liab, cash] = await Promise.all([
      dep.form === 'sg'
        ? db.abAccount.findFirst({ where: { tenantId, accountType: 'liability', code: '2300' } })
        : db.abAccount.findFirst({ where: { tenantId, accountType: 'liability', isActive: true, name: { contains: 'payroll', mode: 'insensitive' } } }),
      db.abAccount.findFirst({ where: { tenantId, code: '1000' } }),
    ]);
    if (dep.amountCents > 0 && (!liab || !cash)) {
      return NextResponse.json({ success: false, error: 'no payroll liability or cash (1000) account to clear', code: 'no_ledger_accounts' }, { status: 422 });
    }
    await assertPeriodOpen(db, tenantId, paidAt);
    const updated = await db.$transaction(async (tx) => {
      const claim = await tx.abPayrollTaxDeposit.updateMany({ where: { id: dep.id, tenantId, status: { not: 'paid' } }, data: { status: 'paid', paidAt } });
      if (claim.count === 0) throw Object.assign(new Error('deposit already paid'), { code: 'P2002' });
      if (dep.amountCents > 0 && liab && cash) {
        await assertPeriodOpen(tx, tenantId, paidAt);
        await appendBalancedEntry(tx, tenantId, {
          date: paidAt, memo: `Payroll remittance ${dep.form.toUpperCase()} ${dep.periodLabel}`,
          sourceType: 'payroll_deposit', sourceId: dep.id,
        }, [
          { accountId: liab.id, debitCents: dep.amountCents, creditCents: 0, description: 'Payroll liability remitted' },
          { accountId: cash.id, debitCents: 0, creditCents: dep.amountCents, description: 'Payroll remittance paid' },
        ]);
      }
      return tx.abPayrollTaxDeposit.findFirst({ where: { id: dep.id, tenantId } });
    });
    return NextResponse.json({ success: true, data: updated });
  } catch (err) {
    if (err instanceof LedgerPeriodClosedError) {
      return NextResponse.json({ success: false, error: 'this fiscal period is closed — reopen it before posting', code: 'period_closed' }, { status: 422 });
    }
    if ((err as { code?: string })?.code === 'P2002') {
      return NextResponse.json({ success: false, error: 'deposit already paid' }, { status: 409 });
    }
    console.error('[agentbook-payroll/tax-deposits POST] failed:', err);
    return NextResponse.json({ success: false, error: publicErrorMessage(err) }, { status: 500 });
  }
}
