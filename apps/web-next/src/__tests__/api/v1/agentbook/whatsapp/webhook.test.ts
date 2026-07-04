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

  it('rejects non-text message types with a text-only notice', async () => {
    whatsAppLinkFindMany.mockResolvedValueOnce([]);
    const body = JSON.stringify({
      entry: [{ changes: [{ value: { messages: [{ from: '+15551234567', type: 'image' }] } }] }],
    });
    const res = await POST(postReq(body, sign(body, 'app-secret')));

    expect(res.status).toBe(200);
    expect(sendMessage).toHaveBeenCalledWith('+15551234567', expect.stringContaining('text messages only'));
    expect(whatsAppLinkFindMany).not.toHaveBeenCalled();
  });
});
