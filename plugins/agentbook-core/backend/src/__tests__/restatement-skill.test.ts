import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * PR 2c — restatement-preview / restatement-apply chat skills: they call the
 * production Next route (GET preview / POST apply), apply is confirmBefore
 * (nothing is fetched until the user confirms), replies go through the
 * catalog in the reply locale.
 */
const conversations = vi.hoisted(() => [] as unknown[]);
vi.mock('../db/client.js', () => {
  const model = new Proxy({}, { get: (_t, m) => async () => (String(m) === 'findMany' ? [] : String(m) === 'count' ? 0 : null) });
  const convo = { create: async (a: unknown) => { conversations.push(a); return {}; } };
  return { db: new Proxy({}, { get: (_t, name) => (name === 'abConversation' ? convo : model) }) };
});

import { executeClassification, classifyAndExecuteV1 } from '../server';
import { BUILT_IN_SKILLS } from '../built-in-skills';
import { reconcileSkills } from '../skill-source.js';
import { restatementChatYear } from '../restatement-chat';

const PREVIEW = {
  year: 2026, from: '2025-07-01', to: '2026-06-30', applicable: true,
  counts: { eligible: 3, skippedClosed: 1, skippedOther: 0, alreadyTyped: 0, noTaxAmount: 0 },
  recoverableTaxCents: 4500, expenseDeltaCents: -4500, netProfitDeltaCents: 4500,
};
let calls: Array<{ url: string; method: string; body?: string }>;
let reply: { status: number; body: unknown };
beforeEach(() => {
  calls = [];
  reply = { status: 200, body: { success: true, data: PREVIEW } };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body as string | undefined });
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.body };
  }));
});
afterEach(() => vi.unstubAllGlobals());

const cls = (name: string, tenantConfig: Record<string, unknown> = {}) => ({
  selectedSkill: { name, endpoint: { method: 'INTERNAL', url: '' }, parameters: {} },
  extractedParams: {}, confidence: 0.9, confirmBefore: name === 'restatement-apply',
  memory: [], skills: [], conversation: [], tenantConfig,
}) as any;

describe('restatement chat skills', () => {
  it('both are registered before general-question; apply is confirmBefore', () => {
    const names = BUILT_IN_SKILLS.map((s: any) => s.name);
    for (const n of ['restatement-preview', 'restatement-apply']) {
      expect(names.indexOf(n)).toBeGreaterThan(-1);
      expect(names.indexOf(n)).toBeLessThan(names.indexOf('general-question'));
    }
    expect((BUILT_IN_SKILLS.find((s: any) => s.name === 'restatement-apply') as any).confirmBefore).toBe(true);
    expect((BUILT_IN_SKILLS.find((s: any) => s.name === 'restatement-preview') as any).confirmBefore).toBeFalsy();
  });

  it('year: the shared helper — AU card label "2025–2026" / "FY2025-26" is 2026; else today in the tenant zone', () => {
    expect(restatementChatYear('restate my 2025-2026 purchases', { jurisdiction: 'au' })).toEqual({ year: 2026, from: '2025-07-01', to: '2026-06-30' });
    expect(restatementChatYear('restate FY2025-26', { jurisdiction: 'au' }).year).toBe(2026);
    expect(restatementChatYear('restate my GST for 2025', { jurisdiction: 'ca' })).toEqual({ year: 2025, from: '2025-01-01', to: '2025-12-31' });
    expect(restatementChatYear('restate', { jurisdiction: 'au', timezone: 'Australia/Sydney' }, new Date('2026-06-30T15:00:00Z')).year).toBe(2027);
  });

  it('I-1: AU apply quoting the card label POSTs the year the card meant', async () => {
    reply = { status: 200, body: { success: true, data: { ...PREVIEW, restated: [{}], failed: [], remaining: 0 } } };
    await executeClassification(cls('restatement-apply', { jurisdiction: 'au' }), 'restate my 2025–2026 purchases', 't1', 'api');
    expect(JSON.parse(calls[0].body!)).toEqual({ year: 2026 });
  });

  it('I-2: a partial apply says what was restated, what failed and what remains', async () => {
    reply = { status: 200, body: { success: true, data: { ...PREVIEW, counts: { ...PREVIEW.counts, skippedClosed: 0 }, recoverableTaxCents: 1000, restated: [{}], failed: [{}], remaining: 40 } } };
    const r = await executeClassification(cls('restatement-apply', { jurisdiction: 'au' }), 'restate my GST for 2026', 't1', 'api');
    expect(r.responseData.message).toBe('Done: restated **1** purchases for tax year 2026; **$10** moved from expenses to your GST/HST account. 1 could not be restated and were left unchanged; try again. 40 more are still to do — say “restate my GST for 2026” again to continue.');
  });

  it('preview: GETs the year and states count, amount, period and closed months', async () => {
    const r = await executeClassification(cls('restatement-preview'), 'preview the restatement for 2026', 't1', 'api');
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toMatch(/\/api\/v1\/agentbook-tax\/restatement\?year=2026$/);
    expect(r.responseData.message).toContain('Tax year 2026 (2025-07-01 – 2026-06-30): **3** older purchases include **$45** of recoverable GST/HST in expense.');
    expect(r.responseData.message).toContain('1 in closed months will stay as they are.');
  });

  it('preview replies in fr-CA through the catalog', async () => {
    const r = await executeClassification(cls('restatement-preview', { locale: 'fr-CA' }), 'aperçu du retraitement', 't1', 'api');
    expect(r.responseData.message).toContain('Année d’imposition 2026 (2025-07-01 – 2026-06-30) : **3** achats antérieurs');
  });

  it('apply: POSTs the year and reports what moved', async () => {
    reply = { status: 200, body: { success: true, data: { ...PREVIEW, counts: { ...PREVIEW.counts, eligible: 2 }, recoverableTaxCents: 3000, restated: [{}, {}] } } };
    const r = await executeClassification(cls('restatement-apply'), 'restate my GST for 2026', 't1', 'api');
    expect(calls[0].method).toBe('POST');
    expect(JSON.parse(calls[0].body!)).toEqual({ year: 2026 });
    expect(r.responseData.message).toContain('Done: restated **2** purchases for tax year 2026; **$30** moved from expenses to your GST/HST account.');
  });

  it('N-2: apply follows the cursor across batches and sums what was committed', async () => {
    const pages = [
      { ...PREVIEW, recoverableTaxCents: 1000, restated: [{}], failed: [{}, {}], remaining: 5, cursor: 'c1' },
      { ...PREVIEW, recoverableTaxCents: 2000, restated: [{}, {}], failed: [], remaining: 0 },
    ];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body as string | undefined });
      return { ok: true, status: 200, json: async () => ({ success: true, data: pages.shift() }) };
    }));
    const r = await executeClassification(cls('restatement-apply', { jurisdiction: 'au' }), 'restate my GST for 2026', 't1', 'api');
    expect(calls.map((c) => JSON.parse(c.body!))).toEqual([{ year: 2026 }, { year: 2026, cursor: 'c1' }]);
    expect(r.responseData.message).toContain('restated **3** purchases for tax year 2026; **$30** moved');
    expect(r.responseData.message).toContain('2 could not be restated');
  });

  it('apply for a non-registrant (422) says restatement does not apply', async () => {
    reply = { status: 422, body: { success: false, error: { code: 'not_registered' } } };
    const r = await executeClassification(cls('restatement-apply'), 'restate my GST', 't1', 'api');
    expect(r.responseData.message).toMatch(/only applies to businesses registered for GST\/HST/);
  });

  it('apply needs confirmation: the classification returns without calling the route', async () => {
    const skills = reconcileSkills([] as any[]);
    const r = await classifyAndExecuteV1('Restate my GST for 2026', 't1', 'web', [], [], skills, [], {});
    expect(r.requiresConfirmation).toBe(true);
    expect(r.skillUsed).toBe('restatement-apply');
    expect(calls).toHaveLength(0);
  });

  it('French retirement talk is not a restatement', async () => {
    const skills = reconcileSkills([] as any[]);
    const { classifyOnly } = await import('../server');
    const c = await classifyOnly('Je prends ma retraite en 2026', 't1', 'web', [], [], skills, [], {});
    expect(['restatement-preview', 'restatement-apply']).not.toContain(c?.selectedSkill?.name);
  });
});

describe('restatement-apply confirm prompt', () => {
  it('names the tax year in the plan the user confirms (en / fr-CA)', async () => {
    const { describeDestructiveAction } = await import('../agent-brain');
    const { replyT } = await import('../reply-locale.js');
    const c = { selectedSkill: { name: 'restatement-apply' }, extractedParams: {}, tenantConfig: { jurisdiction: 'au' } };
    expect(describeDestructiveAction(c, 'restate my 2025-2026 purchases', replyT({ locale: 'en' }) as any))
      .toBe('Restate older purchases for tax year 2026 (2025-07-01 – 2026-06-30): move their recoverable GST/HST out of expenses (closed months are skipped)');
    expect(describeDestructiveAction(c, 'retraiter ma TPS pour 2025', replyT({ locale: 'fr-CA' }) as any))
      .toContain('l’année d’imposition 2025 (du 2024-07-01 au 2025-06-30)');
  });
});

describe('R2-1: chat apply stops starting batches near the turn budget', () => {
  it('a slow route makes it stop after the budget, reply with committed totals and remaining, and still record the turn', async () => {
    const { runRestatementSkill } = await import('../restatement-chat');
    let clock = 0;
    const posts: unknown[] = [];
    const slowFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      posts.push(JSON.parse(String(init?.body)));
      clock += 20_000; // each batch takes 20 s
      return { ok: true, status: 200, json: async () => ({ success: true, data: { ...PREVIEW, counts: { ...PREVIEW.counts, skippedClosed: 0 }, recoverableTaxCents: 1000, restated: [{}], failed: [], remaining: 50, cursor: `c${posts.length}` } }) };
    }) as unknown as typeof fetch;
    const t = (k: string, v?: Record<string, unknown>) => `${k}:${JSON.stringify(v ?? {})}`;
    const r = await runRestatementSkill({
      mode: 'apply', text: 'restate my GST for 2026', tenant: { jurisdiction: 'au' }, baseUrl: 'http://x', headers: {},
      t, money: (c) => `$${c / 100}`, fetchImpl: slowFetch, now: () => clock, startedAt: 0,
    });
    // 0 s → batch 1 (ends 20 s) → batch 2 (ends 40 s) → 40 s > 35 s: stop.
    expect(posts).toEqual([{ year: 2026 }, { year: 2026, cursor: 'c1' }]);
    expect(r.message).toContain('skill.restatement_done:{"count":2');
    expect(r.message).toContain('skill.restatement_remaining:{"count":50');
  });

  it('the handler still writes the conversation record when the loop stops early', async () => {
    conversations.length = 0;
    reply = { status: 200, body: { success: true, data: { ...PREVIEW, restated: [{}], failed: [], remaining: 3 } } };
    await executeClassification(cls('restatement-apply', { jurisdiction: 'au' }), 'restate my GST for 2026', 't1', 'api');
    expect((conversations[0] as any).data.skillUsed).toBe('restatement-apply');
    expect((conversations[0] as any).data.answer).toContain('3 more are still to do');
  });
});
