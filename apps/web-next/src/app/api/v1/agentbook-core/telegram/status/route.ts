/**
 * Telegram bot status — saved config + live webhook info, and a repair action.
 *
 * GET reports health. POST re-registers the webhook.
 *
 * Written up after the bot went silent for a day. The cause was that
 * @Agentbookdev_bot's webhook had been registered WITHOUT a secret_token, so
 * the moment TELEGRAM_WEBHOOK_SECRET was set on the deployment every update
 * from it began returning 401. Telegram reported it faithfully —
 * `last_error_message: "Wrong response from the webhook: 401 Unauthorized"` —
 * and this route already surfaced that string. Nothing consumed it.
 *
 * Two things are added:
 *
 *  1. GET now also reports which bot THIS SERVER REPLIES AS
 *     (process.env.TELEGRAM_BOT_TOKEN), which is a different question from
 *     which bot the tenant has configured, and was the half nobody could see.
 *     A second bot pointed at this deployment gets answered by this one, into
 *     a chat window the user is not looking at — silence, with no error
 *     anywhere. That happened too.
 *
 *  2. POST re-registers the stored bot's webhook using the secret the webhook
 *     actually validates. Recovering previously meant hand-running curl with a
 *     live bot token, which is how the registration drifted in the first place.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface WebhookInfo {
  url?: string;
  last_error_message?: string;
  pending_update_count?: number;
}

/** Which bot this deployment sends replies as. Never returns the token. */
async function outboundBotIdentity(): Promise<{
  configured: boolean;
  username?: string;
  id?: number;
  error?: string;
}> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { configured: false, error: 'TELEGRAM_BOT_TOKEN is not set — this server cannot reply to anything.' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const json = (await res.json()) as {
      ok: boolean; result?: { id: number; username?: string }; description?: string;
    };
    if (!json.ok || !json.result) {
      return { configured: true, error: json.description ?? 'Telegram rejected getMe' };
    }
    return { configured: true, id: json.result.id, username: json.result.username };
  } catch (err) {
    return { configured: true, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
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

    const outbound = await outboundBotIdentity();
    const lastError = webhookInfo?.last_error_message || null;

    // Say what to DO, not just what is broken. Each of these was a real state
    // that produced total silence with no error surfaced anywhere.
    const problems: string[] = [];
    if (lastError) {
      const is401 = /401|unauthor/i.test(lastError);
      problems.push(
        `Telegram's last delivery failed: "${lastError}".` +
        (is401
          ? ' A 401 means the webhook was registered WITHOUT a secret_token matching' +
            ' TELEGRAM_WEBHOOK_SECRET. POST to this endpoint to re-register it.'
          : ''),
      );
    }
    if (outbound.error) problems.push(outbound.error);
    if (
      outbound.username &&
      botConfig.botUsername &&
      outbound.username !== botConfig.botUsername
    ) {
      // Inbound and outbound being different bots is silent by construction:
      // updates arrive, get answered, and the reply lands in the OTHER bot's
      // chat window.
      problems.push(
        `This server replies as @${outbound.username}, but the configured bot is ` +
        `@${botConfig.botUsername}. Replies are going to a different chat window.`,
      );
    }
    if (!process.env.TELEGRAM_WEBHOOK_SECRET) {
      problems.push('TELEGRAM_WEBHOOK_SECRET is not set — the webhook cannot tell Telegram from anyone else.');
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
        lastError,
        pendingUpdates: webhookInfo?.pending_update_count ?? null,
        /** Who this deployment REPLIES as — the half that was invisible. */
        repliesAs: outbound.username ? `@${outbound.username}` : null,
        healthy: problems.length === 0,
        problems,
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

/**
 * POST — re-register this tenant's bot webhook with the secret the webhook
 * ACTUALLY validates.
 *
 * The outage this exists for: the webhook had been registered without a
 * secret_token, so setting TELEGRAM_WEBHOOK_SECRET on the deployment turned
 * every inbound update into a 401 and the bot went silent for a day. Nothing
 * failed loudly — Telegram recorded the error and kept retrying, and the
 * server, correctly, said nothing to an unauthenticated caller.
 *
 * Recovery previously meant hand-running curl with a live bot token, which is
 * both how the registration drifted originally and a good way to leak the
 * token into a shell history. This does it server-side from the token already
 * stored for the tenant; nothing secret crosses the wire in either direction.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;

    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!secret) {
      // Registering without one would "work" and silently leave the endpoint
      // open to anyone — the hole that was closed on 31 July. Refuse instead.
      return NextResponse.json(
        {
          success: false,
          error:
            'TELEGRAM_WEBHOOK_SECRET is not set on this deployment. Registering a webhook ' +
            'without a secret would leave the endpoint accepting unauthenticated writes.',
        },
        { status: 409 },
      );
    }

    const botConfig = await db.abTelegramBot.findUnique({ where: { tenantId } });
    if (!botConfig?.botToken) {
      return NextResponse.json(
        { success: false, error: 'No Telegram bot is connected for this tenant.' },
        { status: 404 },
      );
    }

    const webhookUrl =
      botConfig.webhookUrl || `${request.nextUrl.origin}/api/v1/agentbook/telegram/webhook`;

    const params = new URLSearchParams({
      url: webhookUrl,
      secret_token: secret,
      allowed_updates: JSON.stringify(['message', 'callback_query']),
    });

    const res = await fetch(
      `https://api.telegram.org/bot${botConfig.botToken}/setWebhook`,
      { method: 'POST', body: params },
    );
    const json = (await res.json()) as { ok: boolean; description?: string };

    if (!json.ok) {
      return NextResponse.json(
        { success: false, error: `Telegram refused setWebhook: ${json.description ?? 'unknown'}` },
        { status: 502 },
      );
    }

    await db.abTelegramBot.update({
      where: { tenantId },
      data: { webhookUrl },
    });

    return NextResponse.json({
      success: true,
      data: {
        registered: true,
        webhookUrl,
        botUsername: botConfig.botUsername,
        note: 'Re-registered with the deployment secret. Send the bot a message to confirm.',
      },
    });
  } catch (err) {
    console.error('[agentbook-core/telegram/status POST] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
