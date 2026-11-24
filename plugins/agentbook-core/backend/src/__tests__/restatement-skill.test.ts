import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * PR 2c — restatement-preview / restatement-apply chat skills: they call the
 * production Next route (GET preview / POST apply), apply is confirmBefore
 * (nothing is fetched until the user confirms), replies go through the
 * catalog in the reply locale.
 */
vi.mock('../db/client.js', () => {
  const model = new Proxy({}, { get: (_t, m) => async () => (String(m) === 'findMany' ? [] : String(m) === 'count' ? 0 : null) });
  return { db: new Proxy({}, { get: () => model }) };
});

import { executeClassification, classifyAndExecuteV1 } from '../server';
import { BUILT_IN_SKILLS } from '../built-in-skills';
import { reconcileSkills } from '../skill-source.js';
import { restatementYearFromText, restatementDisplayYear } from '../restatement-chat';

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

  it('year: explicit 20xx, else the current tax year (AU by its ending year)', () => {
    expect(restatementYearFromText('restate my GST for 2025')).toBe(2025);
    expect(restatementYearFromText('restate my GST')).toBeNull();
    expect(restatementDisplayYear('restate', 'au', new Date('2026-08-01T00:00:00Z'))).toBe(2027);
    expect(restatementDisplayYear('restate', 'ca', new Date('2026-08-01T00:00:00Z'))).toBe(2026);
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
    expect(describeDestructiveAction(c, 'restate my GST for 2026', replyT({ locale: 'en' }) as any))
      .toBe('Restate older purchases for tax year 2026: move their recoverable GST/HST out of expenses (closed months are skipped)');
    expect(describeDestructiveAction(c, 'retraiter ma TPS pour 2025', replyT({ locale: 'fr-CA' }) as any))
      .toContain('l’année d’imposition 2025');
  });
});
