import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import crypto from 'node:crypto';

vi.mock('server-only', () => ({}));

const whatsAppLinkFindMany = vi.fn();
const whatsAppLinkFindUnique = vi.fn();
const whatsAppLinkUpdate = vi.fn();
const skillManifestFindMany = vi.fn();

vi.mock('@naap/database', () => ({
  prisma: {
    abWhatsAppLink: {
      findMany: (...a: unknown[]) => whatsAppLinkFindMany(...a),
      findUnique: (...a: unknown[]) => whatsAppLinkFindUnique(...a),
      update: (...a: unknown[]) => whatsAppLinkUpdate(...a),
    },
    abSkillManifest: {
      findMany: (...a: unknown[]) => skillManifestFindMany(...a),
    },
  },
}));

const handleAgentMessage = vi.fn();
vi.mock('@agentbook-core/agent-brain', () => ({
  handleAgentMessage: (...a: unknown[]) => handleAgentMessage(...a),
}));

vi.mock('@agentbook-core/server', () => ({
  callGemini: vi.fn(),
  classifyAndExecuteV1: vi.fn(),
  classifyOnly: vi.fn(),
  executeClassification: vi.fn(),
  // Mid-review interception for the Tax Review Agent. The route spreads the
  // factory's result into the ctx, so this must return an object even though
  // this file asserts nothing about it.
  buildTaxReviewCtx: vi.fn(() => ({ checkActiveTaxReview: vi.fn(), answerTaxReview: vi.fn() })),
}));

const generateFilingDraftMock = vi.fn();
vi.mock('@/lib/tax-fast-track-draft', () => ({
  generateFilingDraft: (...a: unknown[]) => generateFilingDraftMock(...a),
}));

const sendMessage = vi.fn();
vi.mock('@/lib/agentbook-chat-adapter', () => ({
  WhatsAppAdapter: vi.fn().mockImplementation(function WhatsAppAdapter() {
    return { sendMessage: (...a: unknown[]) => sendMessage(...a) };
  }),
}));

vi.mock('@/lib/agentbook-config', () => ({
  getAppBaseUrl: () => 'https://x.example',
  getPluginBaseUrls: () => ({}),
  AGENTBOOK_CANONICAL_URL: 'https://agentbook.example',
}));

const ingestReceipt = vi.fn();
vi.mock('@/lib/agentbook-receipt-ocr', () => ({
  ingestReceipt: (...a: unknown[]) => ingestReceipt(...a),
}));

import { GET, POST } from '@/app/api/v1/agentbook/whatsapp/webhook/route';

function sign(body: string, secret: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

function postReq(body: string, signature: string | null): NextRequest {
  const headers = new Headers();
  if (signature) headers.set('X-Hub-Signature-256', signature);
  return new NextRequest('http://x/api/v1/agentbook/whatsapp/webhook', {
    method: 'POST',
    headers,
    body,
  });
}

function mediaPayload(from: string, type: 'image' | 'document', id = 'media-1', caption?: string) {
  const media = type === 'image'
    ? { image: { id, mime_type: 'image/jpeg', caption } }
    : { document: { id, mime_type: 'application/pdf', filename: 'receipt.pdf', caption } };
  return JSON.stringify({
    entry: [{ changes: [{ field: 'messages', value: { messages: [{ from, type, ...media }] } }] }],
  });
}

/** Meta's two-hop media fetch: metadata envelope, then the bytes. */
function stubMetaMedia(opts: { fileSize?: number; metaOk?: boolean; binOk?: boolean } = {}) {
  const { fileSize = 12_345, metaOk = true, binOk = true } = opts;
  const fetchMock = vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes('graph.facebook.com')) {
      return metaOk
        ? new Response(JSON.stringify({ url: 'https://lookaside.example/x', mime_type: 'image/jpeg', file_size: fileSize }), { status: 200 })
        : new Response('nope', { status: 404 });
    }
    return binOk ? new Response(Buffer.from('jpegbytes'), { status: 200 }) : new Response('nope', { status: 403 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function messagePayload(from: string, body: string) {
  return JSON.stringify({
    entry: [{ changes: [{ field: 'messages', value: { messages: [{ from, type: 'text', text: { body } }] } } ] }],
  });
}

beforeEach(() => {
  whatsAppLinkFindMany.mockReset();
  whatsAppLinkFindUnique.mockReset();
  whatsAppLinkUpdate.mockReset();
  skillManifestFindMany.mockReset();
  handleAgentMessage.mockReset();
  sendMessage.mockReset();
  ingestReceipt.mockReset();
  vi.unstubAllGlobals();
  process.env.WHATSAPP_APP_SECRET = 'app-secret';
  process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'verify-me';
  process.env.WHATSAPP_ACCESS_TOKEN = 'wa-token';
  process.env.WHATSAPP_PHONE_NUMBER_ID = 'phone-id-123';
});

afterEach(() => {
  delete process.env.WHATSAPP_APP_SECRET;
  delete process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  delete process.env.WHATSAPP_ACCESS_TOKEN;
  delete process.env.WHATSAPP_PHONE_NUMBER_ID;
});

describe('WhatsApp webhook GET (Meta verification handshake)', () => {
  it('echoes hub.challenge when the verify token matches', async () => {
    const req = new NextRequest(
      'http://x/api/v1/agentbook/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=1234',
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('1234');
  });

  it('returns 403 when the verify token does not match', async () => {
    const req = new NextRequest(
      'http://x/api/v1/agentbook/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1234',
    );
    const res = await GET(req);
    expect(res.status).toBe(403);
  });

  it('returns 403 when hub.mode is missing', async () => {
    const req = new NextRequest(
      'http://x/api/v1/agentbook/whatsapp/webhook?hub.verify_token=verify-me&hub.challenge=1234',
    );
    const res = await GET(req);
    expect(res.status).toBe(403);
  });
});

describe('WhatsApp webhook POST — signature verification', () => {
  it('rejects a request with no signature header', async () => {
    const res = await POST(postReq(messagePayload('+1555', 'hi'), null));
    expect(res.status).toBe(401);
  });

  it('rejects a request with a signature computed from the wrong secret', async () => {
    const body = messagePayload('+1555', 'hi');
    const res = await POST(postReq(body, sign(body, 'not-the-real-secret')));
    expect(res.status).toBe(401);
  });

  it('rejects a request whose signature does not match a tampered body', async () => {
    const signature = sign(messagePayload('+1555', 'hi'), 'app-secret');
    const tampered = messagePayload('+1555', 'goodbye');
    const res = await POST(postReq(tampered, signature));
    expect(res.status).toBe(401);
  });

  it('rejects all payloads when WHATSAPP_APP_SECRET is not configured', async () => {
    delete process.env.WHATSAPP_APP_SECRET;
    const body = messagePayload('+1555', 'hi');
    const res = await POST(postReq(body, sign(body, 'app-secret')));
    expect(res.status).toBe(401);
  });

  it('accepts a request with a correctly signed body', async () => {
    whatsAppLinkFindMany.mockResolvedValueOnce([]);
    const body = messagePayload('+1555', 'LINK-A1B2C3');
    whatsAppLinkFindUnique.mockResolvedValueOnce(null);
    const res = await POST(postReq(body, sign(body, 'app-secret')));
    expect(res.status).toBe(200);
  });
});

describe('WhatsApp webhook POST — link-code matching', () => {
  it('links a new phone number when the message body is a valid pending link code', async () => {
    whatsAppLinkFindMany.mockResolvedValueOnce([]);
    whatsAppLinkFindUnique.mockResolvedValueOnce({
      id: 'link-1',
      tenantId: 'tenant-x',
      phoneNumbers: [],
      linkedAt: null,
    });
    whatsAppLinkUpdate.mockResolvedValueOnce({});
    const body = messagePayload('+15551234567', 'link-a1b2c3');
    const res = await POST(postReq(body, sign(body, 'app-secret')));

    expect(res.status).toBe(200);
    expect(whatsAppLinkFindUnique).toHaveBeenCalledWith({ where: { linkCode: 'LINK-A1B2C3' } });
    expect(whatsAppLinkUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'link-1' },
        data: expect.objectContaining({ phoneNumbers: ['+15551234567'] }),
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith('+15551234567', expect.stringContaining("You're connected"));
    expect(handleAgentMessage).not.toHaveBeenCalled();
  });

  it('adds to existing phoneNumbers rather than overwriting when linking a second number', async () => {
    whatsAppLinkFindMany.mockResolvedValueOnce([]);
    whatsAppLinkFindUnique.mockResolvedValueOnce({
      id: 'link-1',
      tenantId: 'tenant-x',
      phoneNumbers: ['+15550000000'],
      linkedAt: new Date('2026-01-01'),
    });
    whatsAppLinkUpdate.mockResolvedValueOnce({});
    const body = messagePayload('+15551234567', 'LINK-A1B2C3');
    await POST(postReq(body, sign(body, 'app-secret')));

    const call = whatsAppLinkUpdate.mock.calls[0][0] as { data: { phoneNumbers: string[] } };
    expect(call.data.phoneNumbers.sort()).toEqual(['+15550000000', '+15551234567']);
  });

  it('does not treat a malformed code as a link code', async () => {
    whatsAppLinkFindMany.mockResolvedValueOnce([]);
    const body = messagePayload('+15551234567', 'LINK-123');
    const res = await POST(postReq(body, sign(body, 'app-secret')));

    expect(res.status).toBe(200);
    expect(whatsAppLinkFindUnique).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith('+15551234567', expect.stringContaining("isn't linked"));
  });

  it('replies "not linked" when the code looks valid but matches no pending link', async () => {
    whatsAppLinkFindMany.mockResolvedValueOnce([]);
    whatsAppLinkFindUnique.mockResolvedValueOnce(null);
    const body = messagePayload('+15551234567', 'LINK-ZZZZZZ');
    const res = await POST(postReq(body, sign(body, 'app-secret')));

    expect(res.status).toBe(200);
    expect(sendMessage).toHaveBeenCalledWith('+15551234567', expect.stringContaining("isn't linked"));
    expect(handleAgentMessage).not.toHaveBeenCalled();
  });

  it('routes to the agent brain for an already-linked phone number, ignoring link-code parsing', async () => {
    whatsAppLinkFindMany.mockResolvedValueOnce([
      { tenantId: 'tenant-x', phoneNumbers: ['+15551234567'] },
    ]);
    skillManifestFindMany.mockResolvedValueOnce([]);
    handleAgentMessage.mockResolvedValueOnce({ success: true, data: { message: 'Logged $12 parking.' } });
    const body = messagePayload('+15551234567', 'log $12 parking');
    const res = await POST(postReq(body, sign(body, 'app-secret')));

    expect(res.status).toBe(200);
    expect(handleAgentMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'log $12 parking', tenantId: 'tenant-x', channel: 'whatsapp', chatId: '+15551234567' }),
      expect.anything(),
    );
    expect(sendMessage).toHaveBeenCalledWith('+15551234567', 'Logged $12 parking.');
    expect(whatsAppLinkFindUnique).not.toHaveBeenCalled();
  });

  it('fetches skills in a deterministic order before routing', async () => {
    // Routing takes the first skill whose triggers match, so an unordered array
    // makes the winner of any pattern collision undefined. This route passes its
    // own `skills`, so agent-brain's internal ordered fetch never runs here —
    // see agentbook-core/skill-manifest-order.test.ts (Launch-gap PR-5).
    whatsAppLinkFindMany.mockResolvedValueOnce([
      { tenantId: 'tenant-x', phoneNumbers: ['+15551234567'] },
    ]);
    skillManifestFindMany.mockResolvedValueOnce([]);
    handleAgentMessage.mockResolvedValueOnce({ success: true, data: { message: 'ok' } });
    const body = messagePayload('+15551234567', 'log $12 parking');
    await POST(postReq(body, sign(body, 'app-secret')));

    expect(skillManifestFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { name: 'asc' } }),
    );
  });

  it('sends a fallback reply when the agent brain throws', async () => {
    whatsAppLinkFindMany.mockResolvedValueOnce([
      { tenantId: 'tenant-x', phoneNumbers: ['+15551234567'] },
    ]);
    skillManifestFindMany.mockResolvedValueOnce([]);
    handleAgentMessage.mockRejectedValueOnce(new Error('boom'));
    const body = messagePayload('+15551234567', 'what did I spend?');
    const res = await POST(postReq(body, sign(body, 'app-secret')));

    expect(res.status).toBe(200);
    expect(sendMessage).toHaveBeenCalledWith('+15551234567', expect.stringContaining('something went wrong'));
  });

  it('rejects a message type it cannot handle, without a tenant lookup', async () => {
    // An 'image' type with no image payload, or an audio note: nothing to
    // read either way. The notice used to say "text messages only", which
    // stopped being true once receipts landed.
    whatsAppLinkFindMany.mockResolvedValueOnce([]);
    const body = JSON.stringify({
      entry: [{ changes: [{ value: { messages: [{ from: '+15551234567', type: 'audio' }] } }] }],
    });
    const res = await POST(postReq(body, sign(body, 'app-secret')));

    expect(res.status).toBe(200);
    expect(sendMessage).toHaveBeenCalledWith('+15551234567', expect.stringContaining('receipt photos'));
    expect(whatsAppLinkFindMany).not.toHaveBeenCalled();
  });
});

describe('WhatsApp receipts', () => {
  const LINKED = [{ tenantId: 't1', phoneNumbers: ['15551234567'] }];

  it('scans a photo from a linked number through the SHARED pipeline', async () => {
    // The point of this test is the call, not the reply: WhatsApp must go
    // through `ingestReceipt` — the same path Telegram uses — rather than a
    // second OCR implementation that would drift from it.
    whatsAppLinkFindMany.mockResolvedValue(LINKED);
    stubMetaMedia();
    ingestReceipt.mockResolvedValue({
      ok: true,
      ocr: { amount_cents: 4_599, vendor: 'Starbucks', currency: 'AUD', confidence: 0.95 },
      expense: { id: 'e1', vendorName: 'Starbucks' },
      receiptUrl: 'https://blob/x.jpg',
    });

    const body = mediaPayload('15551234567', 'image');
    const res = await POST(postReq(body, sign(body, 'app-secret')));

    expect(res.status).toBe(200);
    expect(ingestReceipt).toHaveBeenCalledTimes(1);
    const arg = ingestReceipt.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.tenantId).toBe('t1');
    expect(arg.source).toBe('whatsapp_photo');
    expect(String(arg.fileUrl)).toMatch(/^data:image\/jpeg;base64,/);
    expect(sendMessage.mock.calls[0][1]).toMatch(/45\.99/);
    expect(sendMessage.mock.calls[0][1]).toMatch(/Starbucks/);
  });

  it('tags a PDF as whatsapp_pdf, not whatsapp_photo', async () => {
    whatsAppLinkFindMany.mockResolvedValue(LINKED);
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) =>
      String(url).includes('graph.facebook.com')
        ? new Response(JSON.stringify({ url: 'https://lookaside.example/x', mime_type: 'application/pdf' }), { status: 200 })
        : new Response(Buffer.from('%PDF-1.4'), { status: 200 })));
    ingestReceipt.mockResolvedValue({ ok: true, ocr: { amount_cents: 100, vendor: null, currency: 'AUD', confidence: 1 }, expense: { id: 'e', vendorName: null }, receiptUrl: 'u' });

    const body = mediaPayload('15551234567', 'document');
    await POST(postReq(body, sign(body, 'app-secret')));
    expect((ingestReceipt.mock.calls[0][0] as Record<string, unknown>).source).toBe('whatsapp_pdf');
  });

  it('never scans for an UNLINKED number', async () => {
    // An unlinked sender has no tenant to book against — and must not be able
    // to spend somebody's metered OCR quota by messaging a shared number.
    whatsAppLinkFindMany.mockResolvedValue([]);
    whatsAppLinkFindUnique.mockResolvedValue(null);
    stubMetaMedia();

    const body = mediaPayload('19999999999', 'image');
    await POST(postReq(body, sign(body, 'app-secret')));

    expect(ingestReceipt).not.toHaveBeenCalled();
    expect(sendMessage.mock.calls[0][1]).toMatch(/linked/i);
  });

  it('passes the quota refusal through with the limit, and books nothing', async () => {
    whatsAppLinkFindMany.mockResolvedValue(LINKED);
    stubMetaMedia();
    ingestReceipt.mockResolvedValue({ ok: false, reason: 'quota', limit: 20 });

    const body = mediaPayload('15551234567', 'image');
    await POST(postReq(body, sign(body, 'app-secret')));
    expect(sendMessage.mock.calls[0][1]).toMatch(/all 20 receipt scans/);
  });

  it('distinguishes an unreadable receipt from a failure', async () => {
    // "Something went wrong" sends the user to support; "I couldn't make out
    // the total" sends them back to their camera, which is where the fix is.
    whatsAppLinkFindMany.mockResolvedValue(LINKED);
    stubMetaMedia();
    ingestReceipt.mockResolvedValue({ ok: false, reason: 'unreadable' });

    const body = mediaPayload('15551234567', 'image');
    await POST(postReq(body, sign(body, 'app-secret')));
    expect(sendMessage.mock.calls[0][1]).toMatch(/couldn't make out the total/i);
  });

  it('says so when the media cannot be downloaded, and does not call OCR', async () => {
    whatsAppLinkFindMany.mockResolvedValue(LINKED);
    stubMetaMedia({ metaOk: false });

    const body = mediaPayload('15551234567', 'image');
    await POST(postReq(body, sign(body, 'app-secret')));
    expect(ingestReceipt).not.toHaveBeenCalled();
    expect(sendMessage.mock.calls[0][1]).toMatch(/download/i);
  });

  it('refuses an oversized file before downloading it', async () => {
    whatsAppLinkFindMany.mockResolvedValue(LINKED);
    const fetchMock = stubMetaMedia({ fileSize: 90_000_000 });

    const body = mediaPayload('15551234567', 'image');
    await POST(postReq(body, sign(body, 'app-secret')));

    // Only the metadata hop happened — the 90 MB body was never pulled.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ingestReceipt).not.toHaveBeenCalled();
  });

  it('surfaces low OCR confidence rather than presenting a guess as certain', async () => {
    whatsAppLinkFindMany.mockResolvedValue(LINKED);
    stubMetaMedia();
    ingestReceipt.mockResolvedValue({
      ok: true,
      ocr: { amount_cents: 1_200, vendor: 'Blurry Cafe', currency: 'AUD', confidence: 0.42 },
      expense: { id: 'e1', vendorName: 'Blurry Cafe' },
      receiptUrl: 'u',
    });

    const body = mediaPayload('15551234567', 'image');
    await POST(postReq(body, sign(body, 'app-secret')));
    expect(sendMessage.mock.calls[0][1]).toMatch(/42% sure/);
  });

  it('still routes plain text to the agent brain, unchanged', async () => {
    whatsAppLinkFindMany.mockResolvedValue(LINKED);
    skillManifestFindMany.mockResolvedValue([]);
    handleAgentMessage.mockResolvedValue({ success: true, data: { message: 'sure thing' } });

    const body = messagePayload('15551234567', 'what did I spend on coffee?');
    await POST(postReq(body, sign(body, 'app-secret')));

    expect(ingestReceipt).not.toHaveBeenCalled();
    expect(handleAgentMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][1]).toBe('sure thing');
  });
});
