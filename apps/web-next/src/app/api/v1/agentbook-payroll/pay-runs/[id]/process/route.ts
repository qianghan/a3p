/**
 * Process a pay run — mark it paid and post a balanced journal entry:
 *   Dr Salary Expense (gross) / Cr Cash (net) / Cr Payroll Liabilities (withheld),
 *   plus (AU only, when sgCents > 0) Dr Superannuation Expense / Cr
 *   Superannuation Payable — additive on top of gross, not part of the
 *   withheld/net split above.
 * Falls back to crediting cash for the full gross if no liability account is
 * available. Idempotent: a run already processed returns 409.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { splitPayrollEntry } from '@/lib/payroll-ledger';
import { computeDeposit, computeSgDeposit, computeFutaDeposit } from '@/lib/payroll-deposits';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface RouteCtx { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const { id } = await ctx.params;

    const run = await db.abPayRun.findFirst({ where: { id, tenantId }, include: { stubs: true } });
    if (!run) return NextResponse.json({ success: false, error: 'pay run not found' }, { status: 404 });
    if (run.status === 'processed' || run.status === 'paid') {
      return NextResponse.json({ success: false, error: 'pay run already processed' }, { status: 409 });
    }

    const split = splitPayrollEntry(run.stubs);

    const [salaryAccount, cashAccount] = await Promise.all([
      db.abAccount.findFirst({ where: { tenantId, accountType: 'expense', isActive: true, name: { contains: 'salar', mode: 'insensitive' } } })
        .then((a) => a || db.abAccount.findFirst({ where: { tenantId, accountType: 'expense', isActive: true, name: { contains: 'wage', mode: 'insensitive' } } }))
        .then((a) => a || db.abAccount.findFirst({ where: { tenantId, accountType: 'expense', isActive: true }, orderBy: { code: 'asc' } })),
      db.abAccount.findFirst({ where: { tenantId, code: '1000' } }),
    ]);

    // Resolve jurisdiction + period for the tax-deposit obligation.
    const cfg = await db.abTenantConfig.findUnique({ where: { userId: tenantId } });
    const jurisdiction = cfg?.jurisdiction || 'us';

    const updated = await db.$transaction(async (tx) => {
      let journalEntryId: string | null = null;
      if (salaryAccount && cashAccount && split.grossCents > 0) {
        let liabAccount = await tx.abAccount.findFirst({
          where: { tenantId, accountType: 'liability', isActive: true, name: { contains: 'payroll', mode: 'insensitive' } },
        });
        if (!liabAccount && split.withheldCents > 0) {
          liabAccount = await tx.abAccount.create({
            data: { tenantId, code: '2400', name: 'Payroll Liabilities', accountType: 'liability', isActive: true },
          });
        }
        const lines = [
          { tenantId, accountId: salaryAccount.id, debitCents: split.grossCents, creditCents: 0, description: 'Payroll — salaries (gross)' },
          { tenantId, accountId: cashAccount.id, debitCents: 0, creditCents: liabAccount && split.withheldCents > 0 ? split.netCents : split.grossCents, description: 'Payroll — net pay' },
        ];
        if (liabAccount && split.withheldCents > 0) {
          lines.push({ tenantId, accountId: liabAccount.id, debitCents: 0, creditCents: split.withheldCents, description: 'Payroll — taxes withheld' });
        }
        if (split.sgCents > 0) {
          const [superExpenseAccount, superPayableAccount] = await Promise.all([
            tx.abAccount.findFirst({ where: { tenantId, accountType: 'expense', isActive: true, code: '6200' } })
              .then((a) => a || tx.abAccount.create({ data: { tenantId, code: '6200', name: 'Superannuation', accountType: 'expense', isActive: true } })),
            tx.abAccount.findFirst({ where: { tenantId, accountType: 'liability', isActive: true, code: '2300' } })
              .then((a) => a || tx.abAccount.create({ data: { tenantId, code: '2300', name: 'Superannuation Payable', accountType: 'liability', isActive: true } })),
          ]);
          // Additional debit + credit pair on top of the split above — sg is
          // never subtracted from net or included in withheldCents, so this
          // doesn't disturb the net + withheld === gross invariant.
          lines.push(
            { tenantId, accountId: superExpenseAccount.id, debitCents: split.sgCents, creditCents: 0, description: 'Payroll — superannuation guarantee (expense)' },
            { tenantId, accountId: superPayableAccount.id, debitCents: 0, creditCents: split.sgCents, description: 'Payroll — superannuation guarantee (payable)' },
          );
        }
        const je = await tx.abJournalEntry.create({
          data: {
            tenantId,
            date: run.periodEnd,
            memo: `Payroll ${run.periodStart.toISOString().slice(0, 10)}–${run.periodEnd.toISOString().slice(0, 10)}`,
            sourceType: 'payroll',
            verified: true,
            lines: { create: lines },
          },
        });
        journalEntryId = je.id;
      }

      // Accrue the quarterly tax-deposit obligation for this run.
      if (split.withheldCents > 0) {
        const dep = computeDeposit(run.stubs, jurisdiction, run.periodEnd);
        const existing = await tx.abPayrollTaxDeposit.findUnique({
          where: { tenantId_form_periodLabel: { tenantId, form: dep.form, periodLabel: dep.periodLabel } },
        });
        if (existing) {
          await tx.abPayrollTaxDeposit.update({ where: { id: existing.id }, data: { amountCents: existing.amountCents + dep.amountCents } });
        } else {
          await tx.abPayrollTaxDeposit.create({
            data: { tenantId, form: dep.form, periodLabel: dep.periodLabel, amountCents: dep.amountCents, dueDate: new Date(dep.dueDate), status: 'pending' },
          });
        }
      }

      // Superannuation Guarantee is a separate remittance obligation (to super
      // funds, not the ATO) with its own due-date rule — accrued independently
      // of the BAS/PAYG deposit above, never folded into it.
      if (split.sgCents > 0) {
        const sgDep = computeSgDeposit(run.stubs, run.periodEnd);
        const existingSg = await tx.abPayrollTaxDeposit.findUnique({
          where: { tenantId_form_periodLabel: { tenantId, form: sgDep.form, periodLabel: sgDep.periodLabel } },
        });
        if (existingSg) {
          await tx.abPayrollTaxDeposit.update({ where: { id: existingSg.id }, data: { amountCents: existingSg.amountCents + sgDep.amountCents } });
        } else {
          await tx.abPayrollTaxDeposit.create({
            data: { tenantId, form: sgDep.form, periodLabel: sgDep.periodLabel, amountCents: sgDep.amountCents, dueDate: new Date(sgDep.dueDate), status: 'pending' },
          });
        }
      }

      // Form 940 (FUTA) — US only, accrued annually (see computeFutaDeposit
      // for the wage-base simplification this uses).
      if (jurisdiction === 'us' && split.grossCents > 0) {
        const futaDep = computeFutaDeposit(run.stubs, run.periodEnd);
        const existingFuta = await tx.abPayrollTaxDeposit.findUnique({
          where: { tenantId_form_periodLabel: { tenantId, form: futaDep.form, periodLabel: futaDep.periodLabel } },
        });
        if (existingFuta) {
          await tx.abPayrollTaxDeposit.update({ where: { id: existingFuta.id }, data: { amountCents: existingFuta.amountCents + futaDep.amountCents } });
        } else {
          await tx.abPayrollTaxDeposit.create({
            data: { tenantId, form: futaDep.form, periodLabel: futaDep.periodLabel, amountCents: futaDep.amountCents, dueDate: new Date(futaDep.dueDate), status: 'pending' },
          });
        }
      }

      return tx.abPayRun.update({
        where: { id },
        data: { status: 'paid', processedAt: new Date(), journalEntryId },
        include: { stubs: true },
      });
    });

    return NextResponse.json({ success: true, data: { ...updated, ledger: split } });
  } catch (err) {
    console.error('[agentbook-payroll/pay-runs/:id/process] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
