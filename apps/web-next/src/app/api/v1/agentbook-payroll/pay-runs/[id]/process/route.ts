/**
 * Process a pay run — mark it paid and post to the ledger.
 *
 * Ledger entry (MVP, balanced): Dr Salary Expense (total gross) / Cr Cash
 * (total gross). Withholdings are remitted to the tax authorities separately;
 * a future iteration can split the credit into Cash (net) + Payroll Liabilities
 * (withheld). Idempotent: a run already processed returns 409.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

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

    const totalGrossCents = run.stubs.reduce((s, st) => s + st.grossCents, 0);

    const [salaryAccount, cashAccount] = await Promise.all([
      db.abAccount.findFirst({ where: { tenantId, accountType: 'expense', isActive: true, name: { contains: 'salar', mode: 'insensitive' } } })
        .then((a) => a || db.abAccount.findFirst({ where: { tenantId, accountType: 'expense', isActive: true, name: { contains: 'wage', mode: 'insensitive' } } }))
        .then((a) => a || db.abAccount.findFirst({ where: { tenantId, accountType: 'expense', isActive: true }, orderBy: { code: 'asc' } })),
      db.abAccount.findFirst({ where: { tenantId, code: '1000' } }),
    ]);

    const updated = await db.$transaction(async (tx) => {
      let journalEntryId: string | null = null;
      if (salaryAccount && cashAccount && totalGrossCents > 0) {
        const je = await tx.abJournalEntry.create({
          data: {
            tenantId,
            date: run.periodEnd,
            memo: `Payroll ${run.periodStart.toISOString().slice(0, 10)}–${run.periodEnd.toISOString().slice(0, 10)}`,
            sourceType: 'payroll',
            verified: true,
            lines: {
              create: [
                { tenantId, accountId: salaryAccount.id, debitCents: totalGrossCents, creditCents: 0, description: 'Payroll — salaries' },
                { tenantId, accountId: cashAccount.id, debitCents: 0, creditCents: totalGrossCents, description: 'Payroll — cash' },
              ],
            },
          },
        });
        journalEntryId = je.id;
      }
      return tx.abPayRun.update({
        where: { id },
        data: { status: 'paid', processedAt: new Date(), journalEntryId },
        include: { stubs: true },
      });
    });

    return NextResponse.json({ success: true, data: updated });
  } catch (err) {
    console.error('[agentbook-payroll/pay-runs/:id/process] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
