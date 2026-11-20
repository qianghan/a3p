// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * PR 4e review C1 — a TFN/SIN/SSN typed in Telegram must never be written to
 * AbUserMemory (conversation context), AbConvThread.turns, AbConversation or
 * replayed to the LLM. Two lines of defence, both pinned here:
 *   1. the adapter refuses a checksum-valid personal id BEFORE its first write
 *      (context, thread, memory) or any shortcut/LLM call;
 *   2. the shared turn writers (appendTurn → AbUserMemory, addTurn →
 *      AbConvThread.turns, the brain's updateThreadTurns) redact regardless.
 */

const update = vi.fn(async (_a: any) => ({}));
vi.mock('server-only', () => ({}));
vi.mock('@naap/database', () => ({ prisma: { abConvThread: { update: (a: any) => update(a) } } }));

import { appendTurn } from '@/lib/agentbook-conversation-context';
import { addTurn } from '@/lib/agentbook-thread';

const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('turn writers redact', () => {
  it('appendTurn (AbUserMemory context, replayed to the LLM)', () => {
    const ctx = appendTurn({ recentTurns: [] } as any, 'user', 'my TFN is 123 456 782');
    expect(JSON.stringify(ctx)).not.toContain('782');
    expect(ctx.recentTurns[0].text).toContain('[redacted]');
  });

  it('addTurn (AbConvThread.turns, persisted)', async () => {
    const t = await addTurn({ id: 'th1', turns: [], turnCount: 0, activeEntities: [], parkedFills: [] } as any, 'user', 'SIN 046 454 286 and SSN 219-09-9999');
    const stored = JSON.stringify([t.turns, update.mock.calls]);
    expect(stored).not.toMatch(/454|9999/);
  });

  it('business numbers are left intact', () => {
    const ctx = appendTurn({ recentTurns: [] } as any, 'user', 'INV 123 456 789, ABN 51 824 753 556');
    expect(ctx.recentTurns[0].text).toBe('INV 123 456 789, ABN 51 824 753 556');
  });
});

describe('Telegram adapter refuses before it writes anything', () => {
  const src = read('apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts');
  const handler = src.slice(src.indexOf("bot.on('message:text'"));
  it('the refusal precedes the first context/thread/memory write and brain call', () => {
    const refuse = handler.indexOf('classifySensitiveIds(text).refuse');
    expect(refuse).toBeGreaterThan(0);
    for (const write of ['appendTurnFn(', 'threadMod.addTurn(', 'abUserMemory', 'handleAgentMessage(', 'callGemini']) {
      const at = handler.indexOf(write);
      if (at >= 0) expect(at, write).toBeGreaterThan(refuse);
    }
    // and it returns without storing
    expect(handler.slice(refuse, refuse + 200)).toMatch(/ctx\.reply\(botT\('agent\.employee_sensitive_refused'\)\);\s*return;/);
  });

  it('the brain thread writer and cpa-review history redact', () => {
    const brain = read('plugins/agentbook-core/backend/src/agent-brain.ts');
    expect(brain).toContain("{ role: 'user', text: redactSensitive(userText).slice(0, 300)");
    const core = read('plugins/agentbook-core/backend/src/server.ts');
    expect(core).toContain("question: redactSensitive(text), answer: message, queryType: 'agent', channel, skillUsed: 'cpa-review'");
  });
});
