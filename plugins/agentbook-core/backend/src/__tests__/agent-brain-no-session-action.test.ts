import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildTestContext } from './helpers/test-context';

/**
 * A bare "yes" / "cancel" / "undo" when NOTHING is pending.
 *
 * The Telegram adapter maps those words to `req.sessionAction`, and the brain
 * honoured the flag only while an AbAgentSession was alive. With no session
 * the word fell through to the classifier as if it were a fresh request, and
 * the low-confidence fallback improvised — "Are you trying to cancel a
 * subscription, an invoice, or something else?" — for a user who had asked
 * nothing of the sort.
 *
 * Two cases have to stay separate:
 *   - the bot's own last turn ended in a question → "yes" ANSWERS it, and the
 *     conversation must continue through normal classification;
 *   - nothing is open at all → one plain line saying so, no classification.
 *
 * The resolution keys on resolveSessionAction(flag, text), not on the flag
 * alone: only Telegram sets the flag, so a typed "cancel" on web / MCP /
 * WhatsApp has to behave identically.
 */

const threadState: { turns: any[] } = { turns: [] };

vi.mock('../db/client.js', () => ({
  db: {
    abConversation: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      create: vi.fn(async () => ({})),
    },
    abConvThread: {
      findFirst: vi.fn(async () => ({
        id: 't',
        lastActiveAt: new Date(),
        activeEntities: [],
        parkedFills: [],
        turns: threadState.turns,
      })),
      create: vi.fn(async (a: any) => ({ id: 't', turns: [], ...a.data })),
      update: vi.fn(async () => ({})),
    },
    abAgentSession: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async (a: any) => ({ ...a.data, id: 's', version: 1 })),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    abTaxQuestionnaireSession: {
      findFirst: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    abTenantConfig: { findFirst: vi.fn(async () => ({ locale: 'en-US' })) },
    abUserMemory: { findMany: vi.fn(async () => []) },
    abSkillManifest: { findMany: vi.fn(async () => []) },
    abEvent: { create: vi.fn(async () => ({})) },
    abAdvisorPersona: { findUnique: vi.fn(async () => null), update: vi.fn(async () => ({})) },
    $executeRaw: vi.fn(async () => 1),
  },
}));

import { handleAgentMessage } from '../agent-brain';

beforeEach(() => {
  threadState.turns = [];
  vi.clearAllMocks();
});

describe('session actions with no active session', () => {
  it('a typed "cancel" (no adapter flag — web/MCP) with nothing pending says so and does not classify', async () => {
    threadState.turns = [];
    const { req, ctx, classifyOnly } = buildTestContext({ text: 'cancel' });
    const res = await handleAgentMessage(req as any, ctx as any);
    expect(res.data.skillUsed).toBe('session');
    expect(res.data.message.toLowerCase()).toContain('nothing');
    expect(classifyOnly).not.toHaveBeenCalled();
  });

  it('"cancel" with the Telegram flag and nothing pending says so and does not classify', async () => {
    threadState.turns = [];
    const { req, ctx, classifyOnly } = buildTestContext({ text: 'cancel', sessionAction: 'cancel' });
    const res = await handleAgentMessage(req as any, ctx as any);
    expect(res.data.skillUsed).toBe('session');
    expect(res.data.message.toLowerCase()).toContain('nothing');
    expect(classifyOnly).not.toHaveBeenCalled();
  });

  it('"yes" with nothing pending and no open question says so', async () => {
    threadState.turns = [
      { role: 'bot', text: 'Recorded: $25.00 — Uber [Travel]', at: new Date().toISOString() },
    ];
    const { req, ctx, classifyOnly } = buildTestContext({ text: 'yes', sessionAction: 'confirm' });
    const res = await handleAgentMessage(req as any, ctx as any);
    expect(res.data.skillUsed).toBe('session');
    expect(classifyOnly).not.toHaveBeenCalled();
  });

  it('"yes" that answers the bot\'s own question continues the conversation', async () => {
    threadState.turns = [
      { role: 'bot', text: 'Is this a contractor or an employee?', at: new Date().toISOString() },
    ];
    const gq = {
      name: 'general-question',
      endpoint: { method: 'INTERNAL', url: '' },
      parameters: { question: 'string' },
    };
    const { req, ctx, classifyOnly } = buildTestContext({
      text: 'yes',
      sessionAction: 'confirm',
      classification: { selectedSkill: gq, extractedParams: { question: 'yes' }, confidence: 0.5 },
      skills: [gq],
      llmFixtures: [{ response: 'Got it — as an employee at $5K/mo…' }],
    });
    const res = await handleAgentMessage(req as any, ctx as any);
    expect(classifyOnly).toHaveBeenCalled();
    expect(res.data.skillUsed).not.toBe('session');
  });
});
