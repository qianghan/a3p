/**
 * Telegram one-click unlink — clear linked chat IDs. Keeps the row (and its
 * linkCode) so the tenant can relink with the same code later. Does not
 * touch the BYO-bot config (AbTelegramBot / telegram/disconnect).
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { publicErrorMessage } from '@/lib/api-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;

    await db.abTelegramLink.updateMany({
      where: { tenantId },
      data: { chatIds: [], linkedAt: null },
    });

    return NextResponse.json({ success: true, data: { disconnected: true } });
  } catch (err) {
    console.error('[agentbook-core/telegram/unlink] failed:', err);
    return NextResponse.json(
      { success: false, error: publicErrorMessage(err) },
      { status: 500 },
    );
  }
}
