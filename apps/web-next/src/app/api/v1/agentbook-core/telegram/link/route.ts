/**
 * Telegram one-click link status — return (creating on first call) the
 * tenant's link code plus the official AgentBook Telegram bot to message.
 *
 * P0-4: tenants connect by opening t.me/<official-bot>?start=<linkCode>
 * instead of creating their own bot via @BotFather. The webhook binds the
 * chat on `/start <linkCode>`. The BYO-bot path (telegram/setup) remains
 * as the advanced option.
 *
 * Env (owner-configured, see .env.example):
 *   TELEGRAM_OFFICIAL_BOT_USERNAME — e.g. "AgentbookBot" (no @). Until set,
 *   one-click connect reports platformConfigured: false and the UI falls
 *   back to the BYO-bot flow.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { publicErrorMessage } from '@/lib/api-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function generateLinkCode(): string {
  // Same unambiguous alphabet as the WhatsApp link codes (no 0/O/1/I) —
  // 6 chars, rejection-sampled for uniformity. Telegram deep-link start
  // params allow [A-Za-z0-9_-] up to 64 chars; "LINK-XXXXXX" fits.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const maxValid = 256 - (256 % alphabet.length);
  let code = '';
  while (code.length < 6) {
    const byte = crypto.randomBytes(1)[0];
    if (byte < maxValid) code += alphabet[byte % alphabet.length];
  }
  return `LINK-${code}`;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;

    const botUsername = process.env.TELEGRAM_OFFICIAL_BOT_USERNAME || null;
    const platformConfigured = Boolean(botUsername);

    let link = await db.abTelegramLink.findUnique({ where: { tenantId } });
    if (!link) {
      // Retry once on the (very unlikely) unique-code collision.
      for (let attempt = 0; attempt < 2 && !link; attempt++) {
        try {
          link = await db.abTelegramLink.create({
            data: { tenantId, linkCode: generateLinkCode(), chatIds: [] },
          });
        } catch (err) {
          if (attempt === 1) throw err;
        }
      }
    }

    const chatIds = (link?.chatIds as string[] | null | undefined) ?? [];

    return NextResponse.json({
      success: true,
      data: {
        platformConfigured,
        botUsername,
        deepLink:
          botUsername && link ? `https://t.me/${botUsername}?start=${link.linkCode}` : null,
        linkCode: link?.linkCode ?? null,
        chatIds,
        linkedAt: link?.linkedAt ?? null,
      },
    });
  } catch (err) {
    console.error('[agentbook-core/telegram/link] failed:', err);
    return NextResponse.json(
      { success: false, error: publicErrorMessage(err) },
      { status: 500 },
    );
  }
}
