/**
 * Account-deletion request endpoint.
 *
 * `DELETE /api/v1/agentbook/me` records an `account.deletion_requested`
 * event for the authenticated tenant. A scheduled job runs the hard delete
 * after a 30-day grace window so users can recover from mistakes or compromised
 * sessions. The endpoint is intentionally NOT self-serve hard-delete: an
 * attacker with a hijacked session must wait 30 days, during which the
 * legitimate owner can cancel via support.
 *
 * To cancel a pending deletion within the grace window, contact support.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const GRACE_PERIOD_DAYS = 30;

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const resolved = await safeResolveAgentbookTenant(request);
  if ('response' in resolved) return resolved.response;
  const { tenantId } = resolved;

  const requestedAt = new Date();
  const scheduledAt = new Date(requestedAt.getTime() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);

  await db.abEvent.create({
    data: {
      tenantId,
      eventType: 'account.deletion_requested',
      actor: 'user',
      action: {
        requestedAt: requestedAt.toISOString(),
        scheduledHardDeleteAt: scheduledAt.toISOString(),
        gracePeriodDays: GRACE_PERIOD_DAYS,
      },
    },
  });

  return NextResponse.json({
    success: true,
    data: {
      tenantId,
      requestedAt: requestedAt.toISOString(),
      scheduledHardDeleteAt: scheduledAt.toISOString(),
      gracePeriodDays: GRACE_PERIOD_DAYS,
      message:
        'Account deletion requested. Your data will be permanently deleted in ' +
        GRACE_PERIOD_DAYS +
        ' days. Contact support to cancel.',
    },
  });
}

/**
 * `GET` returns the current deletion-request state for the authenticated
 * tenant — useful for showing a "deletion pending" banner in the UI.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const resolved = await safeResolveAgentbookTenant(request);
  if ('response' in resolved) return resolved.response;
  const { tenantId } = resolved;

  const latest = await db.abEvent.findFirst({
    where: {
      tenantId,
      eventType: { in: ['account.deletion_requested', 'account.deletion_cancelled'] },
    },
    orderBy: { createdAt: 'desc' },
  });

  const pending = latest?.eventType === 'account.deletion_requested';
  return NextResponse.json({
    success: true,
    data: {
      tenantId,
      deletionPending: pending,
      latestEvent: latest
        ? {
            eventType: latest.eventType,
            createdAt: latest.createdAt,
            action: latest.action,
          }
        : null,
    },
  });
}
