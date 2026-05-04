/**
 * Telegram bot status — return saved config + live webhook info.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { resolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface WebhookInfo {
  url?: string;
  last_error_message?: string;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const tenantId = await resolveAgentbookTenant(request);
    const botConfig = await db.abTelegramBot.findUnique({ where: { tenantId } });
    if (!botConfig) {
      return NextResponse.json({
        success: true,
        data: {
          configured: false,
          instructions: 'Send your Telegram bot token to connect. Get one from @BotFather.',
        },
      });
    }

    let webhookInfo: WebhookInfo | null = null;
    try {
      const infoRes = await fetch(`https://api.telegram.org/bot${botConfig.botToken}/getWebhookInfo`);
      const data = (await infoRes.json()) as { result?: WebhookInfo };
      webhookInfo = data.result ?? null;
    } catch {
      // can't reach Telegram — return what we have
    }

    return NextResponse.json({
      success: true,
      data: {
        configured: true,
        enabled: botConfig.enabled,
        botUsername: botConfig.botUsername,
        chatIds: botConfig.chatIds,
        webhookUrl: webhookInfo?.url || botConfig.webhookUrl,
        webhookActive: webhookInfo ? !webhookInfo.last_error_message : null,
        lastError: webhookInfo?.last_error_message || null,
      },
    });
  } catch (err) {
    console.error('[agentbook-core/telegram/status] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
