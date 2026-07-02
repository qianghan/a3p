/**
 * Admin notifications — compose/list.
 *
 * GET  — log of past + pending broadcasts, with per-notification delivery counts.
 * POST — create a notification. Sends immediately unless `scheduledFor` is set,
 * in which case the notifications-dispatch cron picks it up when it arrives.
 *
 * Gated by requireAdmin (role 'admin'/'system:admin' OR ADMIN_EMAILS allowlist).
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { requireAdmin } from '@/lib/admin-guard';
import { createNotification, NOTIFICATION_CATEGORIES } from '@/lib/notifications';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<Response> {
  const guard = await requireAdmin(request);
  if ('response' in guard) return guard.response;

  const notifications = await db.abNotification.findMany({
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: { recipients: { select: { channel: true, deliveredAt: true, readAt: true, actedAt: true, emailStatus: true } } },
  });

  const items = notifications.map((n) => {
    const inApp = n.recipients.filter((r) => r.channel === 'in_app');
    const email = n.recipients.filter((r) => r.channel === 'email');
    return {
      id: n.id,
      category: n.category,
      severity: n.severity,
      title: n.title,
      body: n.body,
      ctaLabel: n.ctaLabel,
      ctaUrl: n.ctaUrl,
      audienceType: n.audienceType,
      audienceFilter: n.audienceFilter,
      status: n.status,
      scheduledFor: n.scheduledFor,
      dispatchedAt: n.dispatchedAt,
      createdAt: n.createdAt,
      stats: {
        delivered: inApp.length,
        read: inApp.filter((r) => r.readAt).length,
        acted: inApp.filter((r) => r.actedAt).length,
        emailSent: email.filter((r) => r.emailStatus === 'sent').length,
        emailFailed: email.filter((r) => r.emailStatus === 'failed').length,
        emailSkipped: email.filter((r) => r.emailStatus === 'skipped_opted_out').length,
      },
    };
  });

  return NextResponse.json({ success: true, data: { notifications: items } });
}

export async function POST(request: NextRequest): Promise<Response> {
  const guard = await requireAdmin(request);
  if ('response' in guard) return guard.response;

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });

  const { category, severity, title, bodyText, ctaLabel, ctaUrl, audienceType, audienceFilter, scheduledFor } = body;

  if (!NOTIFICATION_CATEGORIES.includes(category)) {
    return NextResponse.json({ success: false, error: `category must be one of: ${NOTIFICATION_CATEGORIES.join(', ')}` }, { status: 400 });
  }
  if (!title || !bodyText) {
    return NextResponse.json({ success: false, error: 'title and bodyText are required' }, { status: 400 });
  }
  if (!['all', 'plan', 'segment', 'list', 'single'].includes(audienceType)) {
    return NextResponse.json({ success: false, error: 'invalid audienceType' }, { status: 400 });
  }

  const notification = await createNotification({
    category,
    severity,
    title,
    body: bodyText,
    ctaLabel,
    ctaUrl,
    createdByType: 'admin',
    createdBy: guard.user.id,
    audienceType,
    audienceFilter,
    scheduledFor: scheduledFor ? new Date(scheduledFor) : null,
  });

  return NextResponse.json({ success: true, data: { notification } }, { status: 201 });
}
