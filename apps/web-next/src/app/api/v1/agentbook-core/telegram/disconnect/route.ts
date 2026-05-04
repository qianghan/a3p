/**
 * Telegram bot disconnect — remove webhook + delete AbTelegramBot row.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { resolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  try {
    const tenantId = await resolveAgentbookTenant(request);
    const botConfig = await db.abTelegramBot.findUnique({ where: { tenantId } });
    if (botConfig) {
      try {
        await fetch(`https://api.telegram.org/bot${botConfig.botToken}/deleteWebhook`);
      } catch {
        // best effort
      }
      await db.abTelegramBot.delete({ where: { tenantId } });
    }
    return NextResponse.json({ success: true, data: { disconnected: true } });
  } catch (err) {
    console.error('[agentbook-core/telegram/disconnect] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
