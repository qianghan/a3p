import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));

// Mock Prisma before importing the module under test so the WebAdapter's
// AbEvent insert is a spy rather than a live DB write.
const mockAbEventCreate = vi.fn();
const mockTelegramBotFindFirst = vi.fn();
const mockUserFindUnique = vi.fn();
vi.mock('@naap/database', () => ({
  prisma: {
    abEvent: { create: (...args: unknown[]) => mockAbEventCreate(...args) },
    abTelegramBot: { findFirst: (...args: unknown[]) => mockTelegramBotFindFirst(...args) },
    user: { findUnique: (...args: unknown[]) => mockUserFindUnique(...args) },
  },
}));

// Mock the email module so EmailAdapter tests don't try to call Resend.
const mockSendAgentMessageEmail = vi.fn();
vi.mock('../email', () => ({
  sendAgentMessageEmail: (...args: unknown[]) => mockSendAgentMessageEmail(...args),
}));

import {
  TelegramAdapter,
  WebAdapter,
  EmailAdapter,
  resolveAdaptersForTenant,
  sendToAllChannels,
} from '../agentbook-chat-adapter';

const realFetch = globalThis.fetch;

describe('ChatAdapter — Tier 5 #17 abstraction', () => {
  beforeEach(() => {
    mockAbEventCreate.mockReset();
    mockTelegramBotFindFirst.mockReset();
    mockUserFindUnique.mockReset();
    mockSendAgentMessageEmail.mockReset();
    delete (process.env as Record<string, string | undefined>).TELEGRAM_BOT_TOKEN;
    delete (process.env as Record<string, string | undefined>).RESEND_API_KEY;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  // Type helper for vi.fn() — TS narrows the mock's call signature too
  // aggressively in this version; widen to unknown[] so we can read calls
  // without the empty-tuple complaint.
  type AnyMock = { mock: { calls: unknown[][] } };

  describe('TelegramAdapter', () => {
    it('sends a message with Markdown by default', async () => {
      const fetchSpy = vi.fn(async () =>
        new Response(JSON.stringify({ result: { message_id: 42 } }), { status: 200 }),
      );
      globalThis.fetch = fetchSpy as typeof fetch;

      const adapter = new TelegramAdapter('test-token');
      const result = await adapter.sendMessage('1234', 'hello');

      expect(result.delivered).toBe(true);
      expect(result.channel).toBe('telegram');
      expect(result.messageId).toBe('42');
      expect(fetchSpy).toHaveBeenCalledOnce();
      const call = (fetchSpy as unknown as AnyMock).mock.calls[0];
      const url = call[0] as string;
      const init = call[1] as { body: string };
      expect(url).toBe('https://api.telegram.org/bottest-token/sendMessage');
      const body = JSON.parse(init.body);
      expect(body.chat_id).toBe('1234');
      expect(body.text).toBe('hello');
      expect(body.parse_mode).toBe('Markdown');
    });

    it('omits parse_mode when plainText:true', async () => {
      const fetchSpy = vi.fn(async () =>
        new Response(JSON.stringify({ result: { message_id: 1 } }), { status: 200 }),
      );
      globalThis.fetch = fetchSpy as typeof fetch;
      await new TelegramAdapter('t').sendMessage('c', 'plain', { plainText: true });
      const init = (fetchSpy as unknown as AnyMock).mock.calls[0][1] as { body: string };
      const body = JSON.parse(init.body);
      expect(body.parse_mode).toBeUndefined();
    });

    it('returns delivered:false on HTTP error', async () => {
      globalThis.fetch = vi.fn(async () => new Response('boom', { status: 500 })) as typeof fetch;
      const r = await new TelegramAdapter('t').sendMessage('c', 'x');
      expect(r.delivered).toBe(false);
      expect(r.error).toBe('HTTP 500');
    });

    it('returns delivered:false on network throw', async () => {
      globalThis.fetch = vi.fn(async () => {
        throw new Error('econnreset');
      }) as typeof fetch;
      const r = await new TelegramAdapter('t').sendMessage('c', 'x');
      expect(r.delivered).toBe(false);
      expect(r.error).toBe('econnreset');
    });

    it('encodes inline buttons in reply_markup', async () => {
      const fetchSpy = vi.fn(async () =>
        new Response(JSON.stringify({ result: { message_id: 7 } }), { status: 200 }),
      );
      globalThis.fetch = fetchSpy as typeof fetch;

      await new TelegramAdapter('t').sendMessage('c', 'pick', {
        buttons: [[{ text: 'Yes', callbackData: 'y' }, { text: 'No', callbackData: 'n' }]],
      });
      const init = (fetchSpy as unknown as AnyMock).mock.calls[0][1] as { body: string };
      const body = JSON.parse(init.body);
      expect(body.reply_markup.inline_keyboard).toEqual([
        [{ text: 'Yes', callback_data: 'y' }, { text: 'No', callback_data: 'n' }],
      ]);
    });
  });

  describe('EmailAdapter', () => {
    it('delivers via the email helper using the first line as subject', async () => {
      mockSendAgentMessageEmail.mockResolvedValueOnce({ success: true, messageId: 'em-1' });
      const r = await new EmailAdapter().sendMessage('alice@example.com', 'Backup ready\nLink: https://x');
      expect(r.delivered).toBe(true);
      expect(r.channel).toBe('email');
      expect(r.messageId).toBe('em-1');
      const [to, subject, text] = mockSendAgentMessageEmail.mock.calls[0] as [string, string, string];
      expect(to).toBe('alice@example.com');
      expect(subject).toBe('Backup ready');
      expect(text).toContain('Link: https://x');
    });

    it('respects opts.subject when provided', async () => {
      mockSendAgentMessageEmail.mockResolvedValueOnce({ success: true });
      await new EmailAdapter().sendMessage('a@b.c', 'body', { subject: 'Custom subject' } as never);
      const [, subject] = mockSendAgentMessageEmail.mock.calls[0] as [string, string];
      expect(subject).toBe('Custom subject');
    });

    it('returns delivered:false when sendAgentMessageEmail reports failure', async () => {
      mockSendAgentMessageEmail.mockResolvedValueOnce({ success: false, error: 'no api key' });
      const r = await new EmailAdapter().sendMessage('a@b.c', 'x');
      expect(r.delivered).toBe(false);
      expect(r.error).toBe('no api key');
    });
  });

  describe('WebAdapter', () => {
    it('writes an AbEvent so the next /events/since poll surfaces the message', async () => {
      mockAbEventCreate.mockResolvedValueOnce({ id: 'evt-1' });
      const r = await new WebAdapter().sendMessage('tenant-x', 'hi via web');
      expect(r.delivered).toBe(true);
      expect(r.channel).toBe('web');
      expect(mockAbEventCreate).toHaveBeenCalledOnce();
      const [{ data }] = mockAbEventCreate.mock.calls[0] as unknown as [
        { data: { tenantId: string; eventType: string; action: { text: string } } },
      ];
      expect(data.tenantId).toBe('tenant-x');
      expect(data.eventType).toBe('agent.message_for_user');
      expect(data.action.text).toBe('hi via web');
    });

    it('returns delivered:false when AbEvent insert fails', async () => {
      mockAbEventCreate.mockRejectedValueOnce(new Error('db down'));
      const r = await new WebAdapter().sendMessage('tenant-x', 'x');
      expect(r.delivered).toBe(false);
      expect(r.error).toBe('db down');
    });
  });

  describe('resolveAdaptersForTenant', () => {
    it('returns just the web adapter when no telegram bot, no email config', async () => {
      mockTelegramBotFindFirst.mockResolvedValueOnce(null);
      // No RESEND_API_KEY → user.findUnique should not be called.
      const adapters = await resolveAdaptersForTenant('tenant-x');
      expect(adapters).toHaveLength(1);
      expect(adapters[0].adapter.channel).toBe('web');
      expect(adapters[0].chatId).toBe('tenant-x');
      expect(mockUserFindUnique).not.toHaveBeenCalled();
    });

    it('includes telegram adapter when bot + token + chat ids are present', async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'env-token';
      mockTelegramBotFindFirst.mockResolvedValueOnce({ chatIds: ['111', '222'] });
      const adapters = await resolveAdaptersForTenant('tenant-x');
      // 1 web + 2 telegram (one per chat id)
      expect(adapters).toHaveLength(3);
      expect(adapters[0].adapter.channel).toBe('web');
      expect(adapters[1].adapter.channel).toBe('telegram');
      expect(adapters[1].chatId).toBe('111');
      expect(adapters[2].chatId).toBe('222');
    });

    it('skips telegram when the bot row has an empty chatIds list', async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'env-token';
      mockTelegramBotFindFirst.mockResolvedValueOnce({ chatIds: [] });
      const adapters = await resolveAdaptersForTenant('tenant-x');
      expect(adapters).toHaveLength(1);
      expect(adapters[0].adapter.channel).toBe('web');
    });

    it('includes email adapter when RESEND_API_KEY + verified email are present', async () => {
      process.env.RESEND_API_KEY = 'resend-key';
      mockTelegramBotFindFirst.mockResolvedValueOnce(null);
      mockUserFindUnique.mockResolvedValueOnce({ email: 'alice@x.io', emailVerified: new Date() });
      const adapters = await resolveAdaptersForTenant('tenant-x');
      expect(adapters).toHaveLength(2);
      expect(adapters[1].adapter.channel).toBe('email');
      expect(adapters[1].chatId).toBe('alice@x.io');
    });

    it('skips email adapter when email is unverified', async () => {
      process.env.RESEND_API_KEY = 'resend-key';
      mockTelegramBotFindFirst.mockResolvedValueOnce(null);
      mockUserFindUnique.mockResolvedValueOnce({ email: 'alice@x.io', emailVerified: null });
      const adapters = await resolveAdaptersForTenant('tenant-x');
      expect(adapters).toHaveLength(1);
      expect(adapters[0].adapter.channel).toBe('web');
    });

    it('all three channels can coexist', async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'env-token';
      process.env.RESEND_API_KEY = 'resend-key';
      mockTelegramBotFindFirst.mockResolvedValueOnce({ chatIds: ['111'] });
      mockUserFindUnique.mockResolvedValueOnce({ email: 'a@b.c', emailVerified: new Date() });
      const adapters = await resolveAdaptersForTenant('tenant-x');
      expect(adapters.map((a) => a.adapter.channel)).toEqual(['web', 'telegram', 'email']);
    });
  });

  describe('sendToAllChannels', () => {
    it('fans out to every adapter and collects results', async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'env-token';
      mockTelegramBotFindFirst.mockResolvedValueOnce({ chatIds: ['111'] });
      mockAbEventCreate.mockResolvedValueOnce({ id: 'evt-1' });
      globalThis.fetch = vi.fn(async () =>
        new Response(JSON.stringify({ result: { message_id: 9 } }), { status: 200 }),
      ) as typeof fetch;

      const results = await sendToAllChannels('tenant-x', 'hello');
      expect(results).toHaveLength(2);
      expect(results[0].channel).toBe('web');
      expect(results[0].delivered).toBe(true);
      expect(results[1].channel).toBe('telegram');
      expect(results[1].delivered).toBe(true);
    });
  });
});
