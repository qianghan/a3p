/**
 * User-controlled notification preferences — Settings > Notifications.
 * Absence of a row means "on" for both channels (matches the implicit
 * default resolvePreference() in lib/notifications.ts already assumes).
 * The three compliance-locked categories (tax_deadline/invoice_due/
 * expense_review) are always-on regardless of what's stored here — the
 * toggles for those are shown disabled in the UI rather than hidden, so
 * the reason is visible rather than the option just not existing.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { NOTIFICATION_CATEGORIES, COMPLIANCE_LOCKED_CATEGORIES } from '@/lib/notifications';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;

  const rows = await db.abNotificationPreference.findMany({ where: { tenantId } });
  const byCategory = new Map(rows.map((r) => [r.category, r]));

  const preferences = NOTIFICATION_CATEGORIES.map((category) => {
    const row = byCategory.get(category);
    const locked = COMPLIANCE_LOCKED_CATEGORIES.has(category);
    return {
      category,
      locked,
      inAppEnabled: locked ? true : (row?.inAppEnabled ?? true),
      emailEnabled: locked ? true : (row?.emailEnabled ?? true),
    };
  });

  return NextResponse.json({ success: true, data: { preferences } });
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;

  const body = await request.json().catch(() => null);
  const { category, inAppEnabled, emailEnabled } = body || {};

  if (!NOTIFICATION_CATEGORIES.includes(category)) {
    return NextResponse.json({ success: false, error: 'Invalid category' }, { status: 400 });
  }
  if (COMPLIANCE_LOCKED_CATEGORIES.has(category)) {
    return NextResponse.json({ success: false, error: 'This category cannot be turned off' }, { status: 400 });
  }

  const updated = await db.abNotificationPreference.upsert({
    where: { tenantId_category: { tenantId, category } },
    create: { tenantId, category, inAppEnabled: inAppEnabled ?? true, emailEnabled: emailEnabled ?? true },
    update: {
      ...(typeof inAppEnabled === 'boolean' ? { inAppEnabled } : {}),
      ...(typeof emailEnabled === 'boolean' ? { emailEnabled } : {}),
    },
  });

  return NextResponse.json({ success: true, data: { preference: updated } });
}
