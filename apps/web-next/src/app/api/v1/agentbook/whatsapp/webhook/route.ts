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
 * Scope: text and RECEIPTS, both routed through the same shared code
 * Telegram uses — `handleAgentMessage` for text (channel='whatsapp' is just
 * another string to it) and `ingestReceipt` for photos and PDFs. Interactive
 * buttons and the confirm/cancel/undo session commands Telegram has
 * accumulated over many phases remain out of scope.
 *
 * Receipt capture was previously out of scope too, and the reason it could be
 * added cheaply is that the OCR pipeline was lifted out of the Telegram route
 * file first. Writing a second copy here would have been the larger job AND
 * the one that quietly diverges — starting with the metered `ocr_scans`
 * quota, which a from-scratch handler would not have known to check.
 */

import 'server-only';
import { after, NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { prisma as db } from '@naap/database';
import { handleAgentMessage } from '@agentbook-core/agent-brain';
import { buildTaxReviewCtx, callGemini, classifyAndExecuteV1, classifyOnly, executeClassification } from '@agentbook-core/server';
import { reconcileSkills, SKILL_QUERY } from '@agentbook-core/skill-source';
import { WhatsAppAdapter } from '@/lib/agentbook-chat-adapter';
import { getAppBaseUrl, getPluginBaseUrls, AGENTBOOK_CANONICAL_URL } from '@/lib/agentbook-config';
import { generateFilingDraft } from '@/lib/tax-fast-track-draft';
import { ingestReceipt, type ReceiptSource } from '@/lib/agentbook-receipt-ocr';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;

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
          // Media arrives as an id to be exchanged for a short-lived URL, not
          // as a URL — see resolveMediaUrl.
          image?: { id: string; mime_type?: string; caption?: string };
          document?: { id: string; mime_type?: string; filename?: string; caption?: string };
        }>;
      };
      field?: string;
    }>;
  }>;
}

interface IncomingMessage {
  from: string;
  type: string;
  body?: string;
  media?: { id: string; mimeType: string };
}

function extractIncomingMessages(payload: WhatsAppWebhookPayload): IncomingMessage[] {
  const out: IncomingMessage[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const msg of change.value?.messages ?? []) {
        const media = msg.image
          ? { id: msg.image.id, mimeType: msg.image.mime_type || 'image/jpeg' }
          : msg.document
            ? { id: msg.document.id, mimeType: msg.document.mime_type || 'application/pdf' }
            : undefined;
        out.push({
          from: msg.from,
          type: msg.type,
          // A caption on a receipt is the user talking to us — "lunch with
          // Sam" — so it is carried alongside rather than dropped.
          body: msg.text?.body ?? msg.image?.caption ?? msg.document?.caption,
          media,
        });
      }
    }
  }
  return out;
}

/**
 * Exchange a WhatsApp media id for something fetchable.
 *
 * Meta does this in two hops: GET /{media-id} returns a JSON envelope with a
 * `url`, and that url must then be fetched WITH the bearer token — it is not
 * public, and it expires in minutes. So the bytes are pulled here and handed
 * on as a data: URI rather than a link, because whatever consumes it later
 * (OCR, blob storage) would otherwise get a 401 or a dead link depending on
 * how long the queue was.
 */
async function resolveMediaUrl(mediaId: string, accessToken: string): Promise<{ url: string; mimeType: string } | null> {
  try {
    const metaRes = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(mediaId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!metaRes.ok) {
      console.warn('[whatsapp/media] metadata fetch failed:', metaRes.status);
      return null;
    }
    const meta = (await metaRes.json()) as { url?: string; mime_type?: string; file_size?: number };
    if (!meta.url) return null;

    // WhatsApp caps media at 100 MB; Gemini inline input is far smaller than
    // that, and a phone photo of a receipt is under 5 MB. Refuse the outliers
    // before spending the download.
    if (typeof meta.file_size === 'number' && meta.file_size > 20_000_000) {
      console.warn('[whatsapp/media] file too large:', meta.file_size);
      return null;
    }

    const binRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!binRes.ok) {
      console.warn('[whatsapp/media] binary fetch failed:', binRes.status);
      return null;
    }
    const buf = Buffer.from(await binRes.arrayBuffer());
    const mimeType = meta.mime_type || binRes.headers.get('content-type') || 'image/jpeg';
    return { url: `data:${mimeType};base64,${buf.toString('base64')}`, mimeType };
  } catch (err) {
    console.warn('[whatsapp/media] resolve failed:', err);
    return null;
  }
}

const LINK_CODE_PATTERN = /^LINK-[A-Z0-9]{6}$/;

/** Run the agent-brain pipeline for a WhatsApp message — same pipeline Telegram uses. */
async function callAgentBrain(tenantId: string, phoneNumber: string, text: string): Promise<string> {
  try {
    // ctx.skills feeds plan execution only — the classifier routes against
    // the array agent-brain builds itself. reconcileSkills keeps the two in
    // agreement so a code-only built-in is executable as well as routable.
    const skills = reconcileSkills(await db.abSkillManifest.findMany(SKILL_QUERY(tenantId)));
    const baseUrls = getPluginBaseUrls(getAppBaseUrl());
    const result = await handleAgentMessage(
      { text, tenantId, channel: 'whatsapp', chatId: phoneNumber },
      // buildTaxReviewCtx: mid-review interception for the Tax Review Agent.
      // Shared factory rather than an inline copy — this ctx is built in four
      // places (here, web chat, Telegram, the dev Express route) and the
      // feature was originally wired only in the last of those.
      { skills, callGemini, baseUrls, classifyAndExecuteV1, classifyOnly, executeClassification, ...buildTaxReviewCtx(baseUrls) },
    );
    if (result?.data?.taxDraftReady && result.data?.sessionId) {
      const completedSessionId = result.data.sessionId;
      after(() => generateFilingDraft(completedSessionId, callGemini).catch((err) => {
        console.error('[whatsapp/agent-brain] generateFilingDraft failed:', err);
      }));
    }

    if (result?.success && result.data?.message) {
      return result.data.message;
    }
    return "Sorry, I couldn't process that — please try again.";
  } catch (err) {
    console.error('[whatsapp/webhook] agent brain failed:', err);
    return "Sorry, something went wrong on our end — please try again in a moment.";
  }
}

/**
 * A receipt arrived. Fetch it, run the shared pipeline, and describe the
 * result in plain text — WhatsApp has no inline keyboards here, so the reply
 * has to stand on its own rather than lean on a button.
 */
async function handleReceipt(
  tenantId: string,
  media: { id: string; mimeType: string },
  accessToken: string | undefined,
  type: string,
): Promise<string> {
  if (!accessToken) {
    console.warn('[whatsapp/receipt] WHATSAPP_ACCESS_TOKEN unset — cannot fetch media');
    return "I couldn't download that just now — please try again in a moment.";
  }

  const resolved = await resolveMediaUrl(media.id, accessToken);
  if (!resolved) return "I couldn't download that image — could you send it again?";

  const isPdf = resolved.mimeType.includes('pdf');
  const source: ReceiptSource = isPdf ? 'whatsapp_pdf' : 'whatsapp_photo';
  const result = await ingestReceipt({ tenantId, fileUrl: resolved.url, mimeType: resolved.mimeType, source });

  if (!result.ok) {
    switch (result.reason) {
      case 'quota':
        return `You've used all ${result.limit} receipt scans on your plan this month. Upgrade at ${AGENTBOOK_CANONICAL_URL} to keep scanning, or add this one by hand — just tell me the amount and vendor.`;
      case 'unreadable':
        // Distinct from a failure: we read it and could not find a total.
        // Telling the user "something went wrong" when the photo is simply
        // blurry sends them to support instead of to their camera.
        return "I could see the receipt but couldn't make out the total. Try a straighter photo with the whole receipt in frame — or just tell me the amount and I'll log it.";
      default:
        return "I couldn't read that one — please try again, or tell me the amount and vendor and I'll log it.";
    }
  }

  const { ocr, expense } = result;
  const amount = (ocr.amount_cents / 100).toFixed(2);
  const vendor = expense.vendorName || ocr.vendor || 'that purchase';
  const lines = [`Got it — ${ocr.currency} ${amount} at ${vendor}, logged as a draft.`];
  // Say the confidence out loud when it is low, rather than presenting a
  // guess with the same certainty as a clean read.
  if (ocr.confidence > 0 && ocr.confidence < 0.8) {
    lines.push(`I'm only about ${Math.round(ocr.confidence * 100)}% sure I read that correctly — worth a check.`);
  }
  lines.push('Reply with a correction if anything is off, or "confirm" to book it.');
  return lines.join(' ');
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
    const { from, type, body, media } = message;

    const isReceipt = (type === 'image' || type === 'document') && !!media;
    if (!isReceipt && (type !== 'text' || !body)) {
      await adapter?.sendMessage(
        from,
        "I can read text and receipt photos or PDFs. I can't do anything with that one yet.",
      );
      continue;
    }

    // Small tenant count expected on this channel — same findMany-then-filter
    // pattern the Telegram webhook uses for its bot→chatIds lookup, rather
    // than a JSONB array-containment query.
    const links = await db.abWhatsAppLink.findMany();
    const existingLink = links.find((l) => (l.phoneNumbers as string[]).includes(from));

    if (existingLink && isReceipt) {
      // Link check FIRST. An unlinked number must not be able to spend a
      // tenant's metered OCR quota, and it has no tenant to book against.
      await adapter?.sendMessage(from, await handleReceipt(existingLink.tenantId, media!, accessToken, type));
      continue;
    }

    if (existingLink) {
      const reply = await callAgentBrain(existingLink.tenantId, from, body!);
      await adapter?.sendMessage(from, reply);
      continue;
    }

    // Unlinked, and they sent a photo. There is no tenant to book it against
    // and no link code to find in an image, so say so rather than falling
    // through to the code path with an undefined body.
    if (isReceipt) {
      await adapter?.sendMessage(
        from,
        "I can scan that once this number is linked to an AgentBook account. Get your code from Settings → Chatbots → WhatsApp, send it here, then send the receipt again.",
      );
      continue;
    }

    const candidateCode = (body ?? '').trim().toUpperCase();
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
