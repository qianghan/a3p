/**
 * Multi-platform chat adapter (Tier 5 #17).
 *
 * The agent brain produces a string reply plus optional structured actions
 * (PlanPreview steps, inline buttons, etc.). To deliver the reply we must
 * call platform-specific APIs — Telegram's HTTP endpoint, a WebSocket push
 * for the web client, future Slack/WhatsApp/Discord. Without this
 * abstraction, every caller (cron jobs, webhook handlers, the agent brain
 * itself) hand-rolls a Telegram fetch and couples the codebase to one
 * channel.
 *
 * This module defines the `ChatAdapter` interface that all channels
 * implement, ships a `TelegramAdapter`, and provides a `getAdapterForTenant`
 * resolver so callers can `await getAdapterForTenant(tenantId).sendMessage(...)`
 * without knowing which channel will be used.
 *
 * The web channel uses a pull model (the UI polls /events/since via
 * useAgentEvents — PR 28+30). `WebAdapter.sendMessage` therefore writes an
 * AbEvent the next poll surfaces, instead of pushing.
 *
 * Adding a new platform is now: implement `ChatAdapter`, register it in
 * `resolveAdaptersForTenant`. No changes to crons or agent brain.
 */

import 'server-only';
import { prisma as db } from '@naap/database';
import { sendAgentMessageEmail } from './email';

export interface ChatMessageOptions {
  /** Disable Markdown / formatting parsing on the target platform. */
  plainText?: boolean;
  /** Inline buttons: each button row is a list of { text, callbackData }. */
  buttons?: Array<Array<{ text: string; callbackData: string }>>;
  /** Idempotency key to prevent duplicate sends from cron retries. */
  idempotencyKey?: string;
}

export interface ChatSendResult {
  delivered: boolean;
  channel: string;
  /** Platform-specific message id, if known. */
  messageId?: string;
  /** Error string if delivery failed. */
  error?: string;
}

export interface ChatAdapter {
  /** Stable identifier for the channel: 'telegram', 'web', 'whatsapp', ... */
  readonly channel: string;
  /**
   * Send a message to the given destination. For Telegram, destination is
   * the chat id (string). For Web, it's the tenant id. Future platforms
   * define their own conventions but should accept a string.
   */
  sendMessage(destination: string, text: string, opts?: ChatMessageOptions): Promise<ChatSendResult>;
}

// =========================================================================
// Telegram adapter — primary channel for AgentBook
// =========================================================================

class TelegramAdapter implements ChatAdapter {
  readonly channel = 'telegram';
  constructor(private readonly botToken: string) {}

  async sendMessage(chatId: string, text: string, opts?: ChatMessageOptions): Promise<ChatSendResult> {
    try {
      const body: Record<string, unknown> = { chat_id: chatId, text };
      if (!opts?.plainText) body.parse_mode = 'Markdown';
      if (opts?.buttons && opts.buttons.length > 0) {
        body.reply_markup = {
          inline_keyboard: opts.buttons.map((row) =>
            row.map((b) => ({ text: b.text, callback_data: b.callbackData })),
          ),
        };
      }
      const res = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        return { delivered: false, channel: 'telegram', error: `HTTP ${res.status}` };
      }
      const data = (await res.json()) as { result?: { message_id?: number } };
      return {
        delivered: true,
        channel: 'telegram',
        messageId: data.result?.message_id?.toString(),
      };
    } catch (err) {
      return {
        delivered: false,
        channel: 'telegram',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

// =========================================================================
// Web adapter — pull model via /events/since polling (PR 28+30)
// =========================================================================
//
// Web doesn't have a server→browser push. The UI polls /events/since every
// ~10s via useAgentEvents. To deliver an agent-initiated message we insert
// an AbEvent with eventType='agent.message_for_user'. The Chat page renders
// these as incoming messages on the next poll.

class WebAdapter implements ChatAdapter {
  readonly channel = 'web';

  async sendMessage(tenantId: string, text: string, opts?: ChatMessageOptions): Promise<ChatSendResult> {
    try {
      await db.abEvent.create({
        data: {
          tenantId,
          eventType: 'agent.message_for_user',
          actor: 'agent',
          action: {
            text,
            buttons: opts?.buttons ?? null,
            idempotencyKey: opts?.idempotencyKey ?? null,
          },
        },
      });
      return { delivered: true, channel: 'web' };
    } catch (err) {
      return {
        delivered: false,
        channel: 'web',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

// =========================================================================
// Email adapter — second concrete channel beyond Telegram (PR 39)
// =========================================================================
//
// The agent uses email as a fallback / parallel channel when the tenant has
// a verified email but no Telegram connected — or simply prefers email.
// Falls back gracefully (delivered:false) if RESEND_API_KEY isn't set or the
// sender bounces. Delegates the actual SMTP work to email.ts so this module
// stays adapter-only.

class EmailAdapter implements ChatAdapter {
  readonly channel = 'email';

  async sendMessage(toEmail: string, text: string, opts?: ChatMessageOptions): Promise<ChatSendResult> {
    // First line of the message becomes the subject when no explicit subject
    // is supplied via opts — common pattern for chat→email bridges so the
    // recipient sees a meaningful preview in their inbox.
    const firstLine = text.split('\n')[0].slice(0, 120);
    const subject = (opts && (opts as { subject?: string }).subject) || firstLine || 'AgentBook update';
    const r = await sendAgentMessageEmail(toEmail, subject, text);
    return r.success
      ? { delivered: true, channel: 'email', messageId: r.messageId }
      : { delivered: false, channel: 'email', error: r.error ?? 'unknown' };
  }
}

// =========================================================================
// Resolution
// =========================================================================

/**
 * Returns all adapters configured for a tenant. A tenant always has the
 * Web adapter (pull-via-polling). Telegram is included only if the tenant
 * has connected a bot and TELEGRAM_BOT_TOKEN is set.
 *
 * The returned `chatId` field tells callers which destination string to
 * pass to each adapter's sendMessage (Telegram → chat id, Web → tenant id).
 */
export async function resolveAdaptersForTenant(
  tenantId: string,
): Promise<Array<{ adapter: ChatAdapter; chatId: string }>> {
  const out: Array<{ adapter: ChatAdapter; chatId: string }> = [];

  out.push({ adapter: new WebAdapter(), chatId: tenantId });

  // Telegram is opt-in per tenant: only included if a bot is connected and
  // the bot token is available.
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (token) {
    const bot = await db.abTelegramBot.findFirst({ where: { tenantId } });
    const chatIds = (bot?.chatIds as string[] | null | undefined) ?? [];
    if (chatIds.length > 0) {
      const adapter = new TelegramAdapter(token);
      for (const chatId of chatIds) {
        out.push({ adapter, chatId });
      }
    }
  }

  // PR 39: include the Email adapter when the tenant has a verified email
  // and RESEND_API_KEY is configured. The verified-only gate avoids
  // accidental delivery to a typo-address that the user hasn't proven they
  // own.
  if (process.env.RESEND_API_KEY) {
    const user = await db.user.findUnique({
      where: { id: tenantId },
      select: { email: true, emailVerified: true },
    });
    if (user?.email && user.emailVerified) {
      out.push({ adapter: new EmailAdapter(), chatId: user.email });
    }
  }

  return out;
}

/**
 * Convenience: send the same message to every adapter for the tenant.
 * Returns one result per adapter. Used by crons (digest, proactive alerts,
 * home-office reminders) that want to reach the user on whichever channel
 * is configured.
 */
export async function sendToAllChannels(
  tenantId: string,
  text: string,
  opts?: ChatMessageOptions,
): Promise<ChatSendResult[]> {
  const adapters = await resolveAdaptersForTenant(tenantId);
  return Promise.all(adapters.map(({ adapter, chatId }) => adapter.sendMessage(chatId, text, opts)));
}

// Exposed for tests / advanced callers that need a specific channel.
export { TelegramAdapter, WebAdapter, EmailAdapter };
