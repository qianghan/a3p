/**
 * Telegram bot setup — verify token + upsert bot config + register webhook.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface SetupBody {
  botToken?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const body = (await request.json().catch(() => ({}))) as SetupBody;
    const { botToken } = body;

    if (!botToken || !botToken.includes(':')) {
      return NextResponse.json(
        { success: false, error: 'Valid Telegram bot token required (format: 123456:ABC...)' },
        { status: 400 },
      );
    }

    let botInfo: { id: number; username?: string; first_name?: string };
    try {
      const verifyRes = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
      const verifyData = (await verifyRes.json()) as { ok: boolean; result?: typeof botInfo };
      if (!verifyData.ok || !verifyData.result) {
        return NextResponse.json(
          { success: false, error: 'Invalid bot token — Telegram rejected it. Get a valid token from @BotFather.' },
          { status: 400 },
        );
      }
      botInfo = verifyData.result;
    } catch {
      return NextResponse.json(
        { success: false, error: 'Could not verify token with Telegram. Check your internet connection.' },
        { status: 400 },
      );
    }

    // The secret the WEBHOOK ACTUALLY VALIDATES — not a freshly minted one.
    //
    // This was `crypto.randomUUID()`, stored per tenant and handed to
    // setWebhook. But the webhook handler only ever compares against
    // process.env.TELEGRAM_WEBHOOK_SECRET, and nothing anywhere reads the
    // stored value back — it was write-only. So every bot connected through
    // this self-serve flow presented a secret the server had never heard of
    // and 401'd on every update, forever, in silence.
    //
    // Same two-copies-that-must-agree shape as the e2e password (#403) and the
    // CRON_SECRET drift, except here the second copy was never consulted at
    // all. Fixed the same way: delete the second copy.
    const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!webhookSecret) {
      return NextResponse.json(
        {
          success: false,
          error:
            'TELEGRAM_WEBHOOK_SECRET is not configured on this deployment. Connecting a bot ' +
            'without it would register a secret the server cannot verify, and the bot would ' +
            'never receive a message.',
        },
        { status: 409 },
      );
    }
    const baseUrl = process.env.TELEGRAM_WEBHOOK_BASE_URL || process.env.NEXTAUTH_URL || '';
    const webhookUrl = baseUrl ? `${baseUrl}/api/v1/agentbook/telegram/webhook` : '';

    await db.abTelegramBot.upsert({
      where: { tenantId },
      update: {
        botToken,
        botUsername: botInfo.username || null,
        webhookSecret,
        webhookUrl,
        enabled: true,
      },
      create: {
        tenantId,
        botToken,
        botUsername: botInfo.username || null,
        webhookSecret,
        webhookUrl,
        chatIds: [],
        enabled: true,
      },
    });

    let webhookRegistered = false;
    if (webhookUrl) {
      try {
        const regRes = await fetch(
          `https://api.telegram.org/bot${botToken}/setWebhook?url=${encodeURIComponent(webhookUrl)}&secret_token=${webhookSecret}&allowed_updates=${encodeURIComponent(JSON.stringify(['message', 'callback_query']))}`,
        );
        const regData = (await regRes.json()) as { ok: boolean };
        webhookRegistered = regData.ok;
      } catch {
        // best effort — user can register manually
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        botUsername: botInfo.username,
        botName: botInfo.first_name,
        webhookRegistered,
        webhookUrl: webhookUrl || 'Not configured — set TELEGRAM_WEBHOOK_BASE_URL env var or register manually',
        instructions: webhookRegistered
          ? `Your bot @${botInfo.username} is connected! Send it a message to start.`
          : `Bot @${botInfo.username} saved. Set TELEGRAM_WEBHOOK_BASE_URL and re-run, or register the webhook manually.`,
      },
    });
  } catch (err) {
    console.error('[agentbook-core/telegram/setup] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
