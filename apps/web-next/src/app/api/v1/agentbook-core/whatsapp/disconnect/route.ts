/**
 * WhatsApp disconnect — clear linked phone numbers. Keeps the row (and its
 * linkCode) around so the tenant can relink with the same code later,
 * mirroring how a paused Telegram bot can be reconnected.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;

    await db.abWhatsAppLink.updateMany({
      where: { tenantId },
      data: { phoneNumbers: [], linkedAt: null },
    });

    return NextResponse.json({ success: true, data: { disconnected: true } });
  } catch (err) {
    console.error('[agentbook-core/whatsapp/disconnect] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
