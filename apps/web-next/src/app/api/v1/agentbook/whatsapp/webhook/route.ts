/**
 * WhatsApp Business Cloud API webhook — text-only MVP.
 *
 * Unlike Telegram (each tenant brings their own bot), WhatsApp Business
 * numbers are centrally owned: one AgentBook number, shared by every
 * tenant. A first-time sender is resolved to a tenant via a one-time
 * `linkCode` (see AbWhatsAppLink) rather than Telegram's "auto-add on
 * first message" — there's no other signal for which tenant a brand new
 * phone number belongs to.
 *
 * Scope: plain text messages only, routed through the exact same
 * `handleAgentMessage` pipeline Telegram uses (channel='whatsapp' is just
 * another string to it — see agentbook-chat-adapter.ts's ChatAdapter
 * doc comment). Interactive buttons, receipt-photo capture, and the
 * confirm/cancel/undo session commands Telegram has accumulated over many
 * phases are deliberately out of scope for this first pass.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { prisma as db } from '@naap/database';
import { handleAgentMessage } from '@agentbook-core/agent-brain';
import { callGemini, classifyAndExecuteV1, classifyOnly, executeClassification } from '@agentbook-core/server';
import { WhatsAppAdapter } from '@/lib/agentbook-chat-adapter';
import { getAppBaseUrl, getPluginBaseUrls } from '@/lib/agentbook-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** Meta's one-time webhook verification handshake (Meta App Dashboard → Webhooks → Verify and save). */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get('hub.mode');
  const token = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token && token === process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN && challenge) {
    return new NextResponse(challenge, { status: 200 });
  }
  return new NextResponse('Forbidden', { status: 403 });
}

/** Verify Meta's X-Hub-Signature-256 (HMAC-SHA256 of the raw body, keyed with the app secret). */
function verifySignature(rawBody: string, signatureHeader: string | null): boolean {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) return false; // never accept unsigned payloads once configured
  if (!signatureHeader?.startsWith('sha256=')) return false;

  const expected = crypto.createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');
  const provided = signatureHeader.slice('sha256='.length);
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'));
}

interface WhatsAppWebhookPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: Array<{
          from: string;
          type: string;
          text?: { body: string };
        }>;
      };
      field?: string;
    }>;
  }>;
}

function extractIncomingMessages(payload: WhatsAppWebhookPayload): Array<{ from: string; type: string; body?: string }> {
  const out: Array<{ from: string; type: string; body?: string }> = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const msg of change.value?.messages ?? []) {
        out.push({ from: msg.from, type: msg.type, body: msg.text?.body });
      }
    }
  }
  return out;
}

const LINK_CODE_PATTERN = /^LINK-[A-Z0-9]{6}$/;

/** Run the agent-brain pipeline for a WhatsApp message — same pipeline Telegram uses. */
async function callAgentBrain(tenantId: string, phoneNumber: string, text: string): Promise<string> {
  try {
    const skills = await db.abSkillManifest.findMany({
      where: { enabled: true, OR: [{ tenantId: null }, { tenantId }] },
    });
    const baseUrls = getPluginBaseUrls(getAppBaseUrl());
    const result = await handleAgentMessage(
      { text, tenantId, channel: 'whatsapp', chatId: phoneNumber },
      { skills, callGemini, baseUrls, classifyAndExecuteV1, classifyOnly, executeClassification },
    );
    if (result?.success && result.data?.message) {
      return result.data.message;
    }
    return "Sorry, I couldn't process that — please try again.";
  } catch (err) {
    console.error('[whatsapp/webhook] agent brain failed:', err);
    return "Sorry, something went wrong on our end — please try again in a moment.";
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const rawBody = await request.text();

  if (!verifySignature(rawBody, request.headers.get('X-Hub-Signature-256'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const payload = JSON.parse(rawBody) as WhatsAppWebhookPayload;
  const messages = extractIncomingMessages(payload);

  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const adapter = accessToken && phoneNumberId ? new WhatsAppAdapter(accessToken, phoneNumberId) : null;

  for (const message of messages) {
    const { from, type, body } = message;

    if (type !== 'text' || !body) {
      await adapter?.sendMessage(from, 'AgentBook over WhatsApp currently supports text messages only.');
      continue;
    }

    // Small tenant count expected on this channel — same findMany-then-filter
    // pattern the Telegram webhook uses for its bot→chatIds lookup, rather
    // than a JSONB array-containment query.
    const links = await db.abWhatsAppLink.findMany();
    const existingLink = links.find((l) => (l.phoneNumbers as string[]).includes(from));

    if (existingLink) {
      const reply = await callAgentBrain(existingLink.tenantId, from, body);
      await adapter?.sendMessage(from, reply);
      continue;
    }

    const candidateCode = body.trim().toUpperCase();
    if (LINK_CODE_PATTERN.test(candidateCode)) {
      const pendingLink = await db.abWhatsAppLink.findUnique({ where: { linkCode: candidateCode } });
      if (pendingLink) {
        const phoneNumbers = new Set((pendingLink.phoneNumbers as string[]) ?? []);
        phoneNumbers.add(from);
        await db.abWhatsAppLink.update({
          where: { id: pendingLink.id },
          data: {
            phoneNumbers: Array.from(phoneNumbers),
            linkedAt: pendingLink.linkedAt ?? new Date(),
          },
        });
        await adapter?.sendMessage(from, "You're connected! Try \"log $12 parking\" or ask a question about your books.");
        continue;
      }
    }

    await adapter?.sendMessage(
      from,
      "This number isn't linked to an AgentBook account yet. Get your code from Settings → Chatbots → WhatsApp, then send it here.",
    );
  }

  return NextResponse.json({ success: true });
}
