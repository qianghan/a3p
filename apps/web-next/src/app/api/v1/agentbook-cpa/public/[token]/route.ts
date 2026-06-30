/**
 * Public, token-gated read-only books view for an accountant — no AgentBook
 * session required. Returns a YTD P&L summary, the latest AI-CPA review
 * report, existing comments, and any sign-off. 404s on an invalid, revoked,
 * or expired token (never leaks which).
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { resolveActiveLink } from '@/lib/cpa-link';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface RouteCtx { params: Promise<{ token: string }> }

export async function GET(_request: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  try {
    const { token } = await ctx.params;
    const link = await resolveActiveLink(token);
    if (!link) {
      return NextResponse.json({ success: false, error: 'this link is no longer active' }, { status: 404 });
    }
    const { tenantId } = link;
    const yearStart = new Date(new Date().getFullYear(), 0, 1);
    const now = new Date();

    const [cfg, revenueAccounts, expenseAccounts, latestReport, comments, signoff] = await Promise.all([
      db.abTenantConfig.findUnique({ where: { userId: tenantId }, select: { companyName: true, jurisdiction: true } }),
      db.abAccount.findMany({ where: { tenantId, accountType: 'revenue', isActive: true }, select: { id: true } }),
      db.abAccount.findMany({ where: { tenantId, accountType: 'expense', isActive: true }, select: { id: true } }),
      db.abCpaReviewReport.findFirst({ where: { tenantId, status: 'published' }, orderBy: { period: 'desc' } }),
      db.abCpaComment.findMany({ where: { linkId: link.id }, orderBy: { createdAt: 'asc' } }),
      db.abBookSignoff.findFirst({ where: { tenantId }, orderBy: { signedAt: 'desc' } }),
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
        jurisdiction: cfg?.jurisdiction || 'us',
        period: `${yearStart.getFullYear()} YTD`,
        pnl: { revenueCents, expensesCents, netIncomeCents: revenueCents - expensesCents },
        review: latestReport ? { period: latestReport.period, score: latestReport.score, findings: latestReport.findings } : null,
        comments,
        signoff: signoff ? { period: signoff.period, cpaName: signoff.cpaName, signedAt: signoff.signedAt } : null,
      },
    });
  } catch (err) {
    console.error('[agentbook-cpa/public GET] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
