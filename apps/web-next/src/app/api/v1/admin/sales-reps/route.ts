/**
 * GET /api/v1/admin/sales-reps — all promoted sales reps with their profile,
 * user info, and a lifetime-paid total (for the 1099-NEC $600/year badge,
 * computed per calendar year on the frontend from payout history).
 * Admin-only.
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { validateSession } from '@/lib/api/auth';
import { errors, success, getAuthToken } from '@/lib/api/response';
import { connectStatus } from '@/lib/billing/sales-rep';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ADMIN_ROLE = 'system:admin';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const token = getAuthToken(request);
  if (!token) return errors.unauthorized('No auth token provided');
  const sessionUser = await validateSession(token);
  if (!sessionUser) return errors.unauthorized('Invalid or expired session');
  if (!sessionUser.roles.includes(ADMIN_ROLE)) return errors.forbidden('Admin permission required');

  const profiles = await prisma.salesRepProfile.findMany({ orderBy: { promotedAt: 'desc' } });
  const userIds = profiles.map((p) => p.tenantId);
  const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true, displayName: true } });
  const userMap = new Map(users.map((u) => [u.id, u]));

  // planCode lets the admin UI prefill an "edit" form with the rep's current
  // comped tier instead of defaulting back to Pro every time.
  const subs = await prisma.billSubscription.findMany({
    where: { accountId: { in: userIds } },
    include: { plan: { select: { code: true } } },
  });
  const planCodeByRep = new Map(subs.map((s) => [s.accountId, s.plan.code]));

  const payoutTotals = await prisma.salesRepPayout.groupBy({
    by: ['salesRepId', 'status'],
    _sum: { totalCents: true },
    where: { salesRepId: { in: userIds } },
  });
  const paidByRep = new Map<string, number>();
  const pendingByRep = new Map<string, number>();
  for (const row of payoutTotals) {
    const target = row.status === 'paid' ? paidByRep : row.status === 'submitted' ? pendingByRep : null;
    if (target) target.set(row.salesRepId, (target.get(row.salesRepId) ?? 0) + (row._sum.totalCents ?? 0));
  }

  // 1099-NEC threshold: US non-employee compensation >= $600/year needs tax
  // reporting. Display-only badge — no automated form generation/W-9 flow.
  const year = new Date().getUTCFullYear();
  const paidThisYear = await prisma.salesRepPayout.groupBy({
    by: ['salesRepId'],
    _sum: { totalCents: true },
    where: {
      salesRepId: { in: userIds },
      status: 'paid',
      paidAt: { gte: new Date(Date.UTC(year, 0, 1)), lt: new Date(Date.UTC(year + 1, 0, 1)) },
    },
  });
  const paidThisYearByRep = new Map(paidThisYear.map((row) => [row.salesRepId, row._sum.totalCents ?? 0]));
  const NEC_1099_THRESHOLD_CENTS = 60_000; // $600

  const reps = profiles.map((p) => {
    const paidThisYearCents = paidThisYearByRep.get(p.tenantId) ?? 0;
    return {
      tenantId: p.tenantId,
      email: userMap.get(p.tenantId)?.email ?? null,
      displayName: userMap.get(p.tenantId)?.displayName ?? null,
      status: p.status,
      commissionBps: p.commissionBps,
      payoutFrequency: p.payoutFrequency,
      planCode: planCodeByRep.get(p.tenantId) ?? 'pro',
      payoutStatus: connectStatus(p),
      promotedAt: p.promotedAt.toISOString(),
      lifetimePaidCents: paidByRep.get(p.tenantId) ?? 0,
      pendingSubmittedCents: pendingByRep.get(p.tenantId) ?? 0,
      paidThisYearCents,
      crossed1099Threshold: paidThisYearCents >= NEC_1099_THRESHOLD_CENTS,
    };
  });

  return success({ reps });
}
