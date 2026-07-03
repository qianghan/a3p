/**
 * GET   /api/v1/admin/sales-reps/payouts/[id] — payout detail + the rep's
 *   Stripe Connect payout readiness (replaces the old plaintext bank-details
 *   exposure — admin never sees raw bank data now, Stripe holds it).
 * PATCH /api/v1/admin/sales-reps/payouts/[id] — mark paid (via a real Stripe
 *   transfer when the rep is Connect-ready, or a manual fallback otherwise)
 *   or reject. Only touches status/paidAt/paidBy/paymentReference/
 *   rejectionReason/payoutMethod/stripeTransferId — never totalCents/
 *   invoiceNumber/period, which stay immutable after submission for audit
 *   purposes.
 * Admin-only.
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { validateSession } from '@/lib/api/auth';
import { errors, success, getAuthToken } from '@/lib/api/response';
import { connectStatus } from '@/lib/billing/sales-rep';
import { payRepViaStripeTransfer, StripePayoutError } from '@/lib/billing/sales-rep-connect';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ADMIN_ROLE = 'system:admin';

async function requireAdmin(request: NextRequest) {
  const token = getAuthToken(request);
  if (!token) return { error: errors.unauthorized('No auth token provided') };
  const sessionUser = await validateSession(token);
  if (!sessionUser) return { error: errors.unauthorized('Invalid or expired session') };
  if (!sessionUser.roles.includes(ADMIN_ROLE)) return { error: errors.forbidden('Admin permission required') };
  return { sessionUser };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await requireAdmin(request);
  if (auth.error) return auth.error;

  const { id } = await params;
  const payout = await prisma.salesRepPayout.findUnique({ where: { id } });
  if (!payout) return errors.notFound('Payout');

  const profile = await prisma.salesRepProfile.findUnique({ where: { tenantId: payout.salesRepId } });
  const user = await prisma.user.findUnique({ where: { id: payout.salesRepId }, select: { email: true, displayName: true } });

  return success({
    payout: {
      id: payout.id,
      invoiceNumber: payout.invoiceNumber,
      periodLabel: payout.periodLabel,
      totalCents: payout.totalCents,
      status: payout.status,
      submittedAt: payout.submittedAt.toISOString(),
    },
    salesRep: { email: user?.email ?? null, displayName: user?.displayName ?? null },
    payoutStatus: profile ? connectStatus(profile) : 'not_started',
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await requireAdmin(request);
  if (auth.error) return auth.error;
  const { sessionUser } = auth;

  const { id } = await params;
  const body = await request.json().catch(() => null);
  const action = body?.action;

  const payout = await prisma.salesRepPayout.findUnique({ where: { id } });
  if (!payout) return errors.notFound('Payout');
  if (payout.status === 'paid') return errors.badRequest('Payout is already marked paid');

  if (action === 'markPaid') {
    // Default to a real Stripe transfer. 'manual' is an explicit admin
    // escape hatch for the rare case Connect isn't viable for a given rep.
    const payoutMethod = body?.payoutMethod === 'manual' ? 'manual' : 'stripe';

    if (payoutMethod === 'manual') {
      const paymentReference = typeof body?.paymentReference === 'string' ? body.paymentReference : null;
      await prisma.salesRepPayout.update({
        where: { id },
        data: { status: 'paid', paidAt: new Date(), paidBy: sessionUser.id, paymentReference, payoutMethod: 'manual' },
      });
    } else {
      try {
        await payRepViaStripeTransfer(id, sessionUser.id);
      } catch (err) {
        if (err instanceof StripePayoutError) return errors.badRequest(err.message);
        throw err;
      }
    }
  } else if (action === 'reject') {
    const rejectionReason = typeof body?.rejectionReason === 'string' ? body.rejectionReason : 'No reason given';
    await prisma.salesRepPayout.update({
      where: { id },
      data: { status: 'rejected', reviewedAt: new Date(), reviewedBy: sessionUser.id, rejectionReason },
    });
  } else {
    return errors.badRequest("action must be one of: 'markPaid', 'reject'");
  }

  return success({ id, action });
}
