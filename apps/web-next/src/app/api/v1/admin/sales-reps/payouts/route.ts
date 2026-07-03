/**
 * GET /api/v1/admin/sales-reps/payouts?status=submitted&salesRepId=... — all
 * commission invoices, optionally filtered by status and/or a specific rep
 * (the latter powers the roster's per-rep payout history drill-down).
 * Admin-only.
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { validateSession } from '@/lib/api/auth';
import { errors, success, getAuthToken } from '@/lib/api/response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ADMIN_ROLE = 'system:admin';
const VALID_STATUSES = new Set(['submitted', 'approved', 'paid', 'rejected']);

export async function GET(request: NextRequest): Promise<NextResponse> {
  const token = getAuthToken(request);
  if (!token) return errors.unauthorized('No auth token provided');
  const sessionUser = await validateSession(token);
  if (!sessionUser) return errors.unauthorized('Invalid or expired session');
  if (!sessionUser.roles.includes(ADMIN_ROLE)) return errors.forbidden('Admin permission required');

  const status = request.nextUrl.searchParams.get('status');
  const salesRepId = request.nextUrl.searchParams.get('salesRepId');
  const where = {
    ...(status && VALID_STATUSES.has(status) ? { status } : {}),
    ...(salesRepId ? { salesRepId } : {}),
  };

  const payouts = await prisma.salesRepPayout.findMany({ where, orderBy: { submittedAt: 'desc' } });
  const repIds = [...new Set(payouts.map((p) => p.salesRepId))];
  const users = await prisma.user.findMany({ where: { id: { in: repIds } }, select: { id: true, email: true, displayName: true } });
  const userMap = new Map(users.map((u) => [u.id, u]));

  return success({
    payouts: payouts.map((p) => ({
      id: p.id,
      salesRepId: p.salesRepId,
      salesRepEmail: userMap.get(p.salesRepId)?.email ?? null,
      salesRepName: userMap.get(p.salesRepId)?.displayName ?? null,
      invoiceNumber: p.invoiceNumber,
      periodLabel: p.periodLabel,
      totalCents: p.totalCents,
      status: p.status,
      submittedAt: p.submittedAt.toISOString(),
      paidAt: p.paidAt ? p.paidAt.toISOString() : null,
      paymentReference: p.paymentReference,
    })),
  });
}
