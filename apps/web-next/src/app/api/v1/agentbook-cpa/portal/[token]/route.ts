/**
 * Named-CPA portal data (token-gated, no AgentBook session). Validates the
 * invite, marks it accepted on first view, and returns a YTD P&L summary plus
 * the open/fulfilled document requests for this tenant. 404 on bad/expired token.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { resolveActiveInvite } from '@/lib/cpa-link';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface RouteCtx { params: Promise<{ token: string }> }

export async function GET(_request: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  try {
    const { token } = await ctx.params;
    const invite = await resolveActiveInvite(token);
    if (!invite) return NextResponse.json({ success: false, error: 'this invite is no longer active' }, { status: 404 });
    const { tenantId } = invite;

    // Accept on first view.
    await db.abCpaInvite.updateMany({ where: { id: invite.id, status: 'pending' }, data: { status: 'accepted' } });

    const yearStart = new Date(new Date().getFullYear(), 0, 1);
    const now = new Date();
    const [cfg, revenueAccounts, expenseAccounts, docRequests] = await Promise.all([
      db.abTenantConfig.findUnique({ where: { userId: tenantId }, select: { companyName: true } }),
      db.abAccount.findMany({ where: { tenantId, accountType: 'revenue', isActive: true }, select: { id: true } }),
      db.abAccount.findMany({ where: { tenantId, accountType: 'expense', isActive: true }, select: { id: true } }),
      db.abDocumentRequest.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take: 50 }),
    ]);

    const [revAgg, expAgg] = await Promise.all([
      revenueAccounts.length
        ? db.abJournalLine.aggregate({ where: { accountId: { in: revenueAccounts.map((a) => a.id) }, entry: { tenantId, date: { gte: yearStart, lte: now } } }, _sum: { creditCents: true, debitCents: true } })
        : Promise.resolve({ _sum: { creditCents: 0, debitCents: 0 } } as const),
      expenseAccounts.length
        ? db.abJournalLine.aggregate({ where: { accountId: { in: expenseAccounts.map((a) => a.id) }, entry: { tenantId, date: { gte: yearStart, lte: now } } }, _sum: { creditCents: true, debitCents: true } })
        : Promise.resolve({ _sum: { creditCents: 0, debitCents: 0 } } as const),
    ]);
    const revenueCents = (revAgg._sum.creditCents || 0) - (revAgg._sum.debitCents || 0);
    const expensesCents = (expAgg._sum.debitCents || 0) - (expAgg._sum.creditCents || 0);

    return NextResponse.json({
      success: true,
      data: {
        companyName: cfg?.companyName || 'AgentBook user',
        cpaName: invite.cpaName,
        period: `${yearStart.getFullYear()} YTD`,
        pnl: { revenueCents, expensesCents, netIncomeCents: revenueCents - expensesCents },
        documentRequests: docRequests,
      },
    });
  } catch (err) {
    console.error('[agentbook-cpa/portal GET] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
