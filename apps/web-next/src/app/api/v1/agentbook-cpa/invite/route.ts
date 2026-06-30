/**
 * CPA invites — list (GET) + create (POST). The owner invites a named
 * accountant by email; we mint a magic-link token and return the portal URL.
 * (Email delivery is a follow-on — for now the owner shares the link.)
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { sendCpaInviteEmail } from '@/lib/email';
import { joinUrl } from '@/lib/abs-url';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const invites = await db.abCpaInvite.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' } });
    return NextResponse.json({ success: true, data: invites });
  } catch (err) {
    console.error('[agentbook-cpa/invite GET] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const body = (await request.json().catch(() => ({}))) as { cpaEmail?: string; cpaName?: string; validityDays?: number };
    if (!body.cpaEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.cpaEmail)) {
      return NextResponse.json({ success: false, error: 'a valid cpaEmail is required' }, { status: 400 });
    }
    const days = typeof body.validityDays === 'number' && body.validityDays > 0 && body.validityDays <= 365 ? Math.floor(body.validityDays) : 30;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + days);

    const invite = await db.abCpaInvite.create({
      data: { tenantId, cpaEmail: body.cpaEmail, cpaName: body.cpaName || null, expiresAt },
    });

    // Best-effort email delivery — the invite (and its manual link) stands even
    // if sending fails (e.g. before a sending domain is verified in Resend).
    const portalPath = `/cpa-portal/${invite.token}`;
    const base = process.env.NEXT_PUBLIC_APP_URL || 'https://agentbook.brainliber.com';
    const sent = await sendCpaInviteEmail(invite.cpaEmail, joinUrl(base, portalPath), invite.cpaName || undefined);

    return NextResponse.json(
      { success: true, data: { ...invite, url: portalPath, emailSent: sent.success, emailError: sent.success ? undefined : sent.error } },
      { status: 201 },
    );
  } catch (err) {
    console.error('[agentbook-cpa/invite POST] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
