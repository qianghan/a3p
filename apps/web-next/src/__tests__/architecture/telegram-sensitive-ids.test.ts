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
const voiceUpsert = vi.fn(async (_a: any) => ({}));
vi.mock('server-only', () => ({}));
vi.mock('@naap/database', () => ({ prisma: {
  abConvThread: { update: (a: any) => update(a) },
  abVoiceTranscript: { findUnique: vi.fn(async () => null), upsert: (a: any) => voiceUpsert(a) },
} }));

import { appendTurn } from '@/lib/agentbook-conversation-context';
import { addTurn } from '@/lib/agentbook-thread';
import { getOrTranscribeVoice } from '@/lib/agentbook-voice-cache';
import { redactSensitiveDeep } from '@agentbook-core/sensitive-ids';

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

const src = read('apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts');

describe('Telegram adapter refuses before it writes anything', () => {
  const _src = read('apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts');
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

describe('voice transcript path', () => {
  it('a spoken TFN/SIN/SSN is flagged and NOT cached or returned', async () => {
    voiceUpsert.mockClear();
    const r = await getOrTranscribeVoice({ tenantId: 't', fileId: 'f1', model: 'm', transcribe: async () => 'my social insurance number is 046 454 286' });
    expect(r).toEqual({ transcript: null, cached: false, sensitive: true });
    expect(voiceUpsert).not.toHaveBeenCalled();
  });

  it('an ordinary transcript is cached and returned redacted (broad) — business numbers intact', async () => {
    voiceUpsert.mockClear();
    const r = await getOrTranscribeVoice({ tenantId: 't', fileId: 'f2', model: 'm', transcribe: async () => 'invoice 046 454 286 and INV 123 456 789 paid' });
    expect(r.sensitive).toBeFalsy();
    expect(r.transcript).toBe('invoice [redacted] and INV 123 456 789 paid');
    expect(JSON.stringify(voiceUpsert.mock.calls)).not.toContain('454 286');
  });

  it('the voice handler refuses before the echo, the agent loop and the brain', () => {
    const v = src.slice(src.indexOf("bot.on('message:voice'"), src.indexOf("bot.on('message:voice'") + 6000);
    const refuse = v.indexOf('cacheResult.sensitive');
    expect(refuse).toBeGreaterThan(0);
    for (const later of ["botT('bot.i_heard'", 'runAgentLoop(', 'callAgentBrain(']) expect(v.indexOf(later), later).toBeGreaterThan(refuse);
  });
});

describe('caption path', () => {
  it.each(["bot.on('message:photo'", "bot.on('message:document'"])('%s gates the caption before batching/OCR', (h) => {
    const body = src.slice(src.indexOf(h), src.indexOf(h) + 4000);
    const refuse = body.indexOf('classifySensitiveIds(');
    expect(refuse).toBeGreaterThan(0);
    for (const later of ['saveBatchState(', 'addPhotoToBatch(', 'getFile(', 'abUserMemory']) {
      const at = body.indexOf(later);
      if (at >= 0) expect(at, later).toBeGreaterThan(refuse);
    }
  });

  it('dead-letter payloads are deep-redacted (strings only, numeric ids intact)', () => {
    expect(src).toContain('payload: redactSensitiveDeep(update) as never');
    const out = redactSensitiveDeep({ update_id: 123456782, message: { caption: 'TFN 123 456 782', chat: { id: 46454286 } } });
    expect(out).toEqual({ update_id: 123456782, message: { caption: 'TFN [redacted]', chat: { id: 46454286 } } });
  });
});
