/**
 * WhatsApp status — return (creating on first call) the tenant's link code
 * plus the shared AgentBook WhatsApp number to message it to.
 *
 * Unlike Telegram's setup route, there's no per-tenant bot token to verify —
 * WHATSAPP_ACCESS_TOKEN/WHATSAPP_PHONE_NUMBER_ID are platform-wide. This
 * route only manages the per-tenant AbWhatsAppLink row.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function generateLinkCode(): string {
  // 6 chars from an unambiguous alphabet (no 0/O/1/I) — read aloud/typed easily.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  // 256 isn't a multiple of alphabet.length (33), so `byte % alphabet.length`
  // would bias toward the first few letters. Reject bytes above the last full
  // multiple of the alphabet length so every character stays equally likely.
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

    const configured = Boolean(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
    const agentbookWhatsAppNumber = process.env.WHATSAPP_DISPLAY_PHONE_NUMBER || null;

    let link = await db.abWhatsAppLink.findUnique({ where: { tenantId } });
    if (!link) {
      // Retry once on the (very unlikely) unique-code collision.
      for (let attempt = 0; attempt < 2 && !link; attempt++) {
        try {
          link = await db.abWhatsAppLink.create({
            data: { tenantId, linkCode: generateLinkCode(), phoneNumbers: [] },
          });
        } catch (err) {
          if (attempt === 1) throw err;
        }
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        platformConfigured: configured,
        agentbookWhatsAppNumber,
        linkCode: link?.linkCode ?? null,
        phoneNumbers: (link?.phoneNumbers as string[] | null | undefined) ?? [],
        linkedAt: link?.linkedAt ?? null,
      },
    });
  } catch (err) {
    console.error('[agentbook-core/whatsapp/status] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
