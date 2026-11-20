import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * PR 4e (R-EMP-5) — employee / pay-frequency chat skills.
 * Routing, execution with computed values, per-locale labels, refusal of
 * sensitive edits, and that edits go through PUT employees/[id] with ONLY
 * non-sensitive keys. Brain-level confirm + redaction: employee-chat-brain.test.ts.
 */

const mockFindMany = vi.fn();
const mockPayRunFindFirst = vi.fn();
const mockConvCreate = vi.fn(async (_a: any) => ({}));

vi.mock('../db/client.js', () => ({
  db: {
    abEmployee: { findMany: (...a: any[]) => mockFindMany(...a) },
    abPayRun: { findFirst: (...a: any[]) => mockPayRunFindFirst(...a) },
    abConversation: { create: (a: any) => mockConvCreate(a) },
    abSkillRun: { create: vi.fn(async () => ({})) },
  },
}));

const mockFetch = vi.fn();
global.fetch = mockFetch as any;

import { executeClassification } from '../server';
import { BUILT_IN_SKILLS } from '../built-in-skills.js';
import { selectSkillByPatterns } from '../skill-routing.js';
import {
  containsSensitiveTaxId, redactSensitive, parseEmployeeEdit, parseRateCents, matchEmployees, agentFrequencyLabelKey,
} from '../employee-chat.js';

const cls = (name: string, tenantConfig: Record<string, unknown> = {}) => ({
  selectedSkill: { name, endpoint: { method: 'INTERNAL', url: '' }, parameters: {} },
  extractedParams: {}, confidence: 0.9, confirmBefore: false,
  memory: [], skills: [], conversation: [], tenantConfig,
}) as any;

const jane = { id: 'emp-j', name: 'Jane Doe', payRateCents: 8_000_000, payType: 'salary', payFrequency: 'biweekly', jurisdiction: 'au' };
const bob = { id: 'emp-b', name: 'Bob Smith', payRateCents: 4_550, payType: 'hourly', payFrequency: 'weekly', jurisdiction: 'au' };

function route(text: string): string[] {
  const lower = text.toLowerCase();
  return BUILT_IN_SKILLS.filter((s) => selectSkillByPatterns(s as any, text, lower)).map((s) => s.name);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindMany.mockResolvedValue([jane, bob]);
  mockPayRunFindFirst.mockResolvedValue(null);
});

describe('routing', () => {
  it.each([
    ["what's Jane's pay frequency?", 'query-employee'],
    ['what is Jane\'s pay rate', 'query-employee'],
    ["when is Jane's next pay date", 'query-employee'],
    ['list my employees', 'query-employee'],
    ['change Jane to fortnightly', 'update-employee'],
    ["set Jane's rate to $80k", 'update-employee'],
    ["update Jane's SSN", 'update-employee'],
    ['set up next pay runs', 'generate-pay-run-drafts'],
    ['generate draft pay runs', 'generate-pay-run-drafts'],
  ])('%s → %s (and only it)', (text, skill) => {
    expect(route(text)).toEqual([skill]);
  });

  it('leaves neighbouring payroll and budget asks alone', () => {
    expect(route('run payroll')).toEqual(['run-payroll']);
    expect(route('set a monthly budget of $500 for meals')).not.toContain('update-employee');
  });

  it('update-employee is confirm-before-write', () => {
    expect(BUILT_IN_SKILLS.find((s) => s.name === 'update-employee')?.confirmBefore).toBe(true);
  });
});

describe('parsers', () => {
  it('rates', () => {
    expect(parseRateCents('$80k')).toBe(8_000_000);
    expect(parseRateCents('$85,000')).toBe(8_500_000);
    expect(parseRateCents('45.50/hr')).toBe(4_550);
    expect(parseRateCents("set E2EA3 Worker's rate to $60k")).toBe(6_000_000);
    expect(parseRateCents('E2EA3 Worker')).toBeNull();
  });
  it('edits', () => {
    expect(parseEmployeeEdit('change Jane to fortnightly')).toEqual({ kind: 'payFrequency', value: 'biweekly' });
    expect(parseEmployeeEdit('switch Bob to semi-monthly')).toEqual({ kind: 'payFrequency', value: 'semimonthly' });
    expect(parseEmployeeEdit("set Jane's rate to $80k")).toEqual({ kind: 'payRateCents', value: 8_000_000 });
    expect(parseEmployeeEdit("change Jane's bank account").kind).toBe('sensitive');
  });
  it('matches by first name, word-bounded', () => {
    expect(matchEmployees("Jane's rate", [jane, bob]).map((e) => e.id)).toEqual(['emp-j']);
    expect(matchEmployees('janet', [jane, bob])).toEqual([]);
  });
  it('sensitive ids: SSN / SIN / TFN detected, phone and amounts not', () => {
    expect(containsSensitiveTaxId('my SSN is 123-45-6789')).toBe(true);
    expect(containsSensitiveTaxId('SIN 046 454 286')).toBe(true);
    expect(containsSensitiveTaxId('my tfn is 123456782')).toBe(true);
    expect(containsSensitiveTaxId('call 416-555-1234')).toBe(false);
    expect(containsSensitiveTaxId('spent $123.45 on lunch')).toBe(false);
    expect(redactSensitive('my SSN is 123-45-6789 ok')).toBe('my SSN is [redacted] ok');
    expect(redactSensitive('tfn 123456782')).not.toMatch(/\d{6}/);
  });
  it('AU biweekly is Fortnightly, US/CA Bi-weekly', () => {
    expect(agentFrequencyLabelKey('biweekly', 'au')).toBe('agent.fortnightly');
    expect(agentFrequencyLabelKey('biweekly', 'us')).toBe('agent.bi_weekly');
    expect(agentFrequencyLabelKey('semimonthly', 'ca')).toBe('agent.semi_monthly');
  });
});

describe('query-employee', () => {
  it('answers one employee with the market label, money and next pay date', async () => {
    mockPayRunFindFirst.mockResolvedValueOnce({ payDate: new Date('2026-11-27T00:00:00Z') });
    const r = await executeClassification(cls('query-employee', { locale: 'en-AU', currency: 'AUD' }), "what's Jane's pay frequency?", 't1', 'web');
    const m = r.responseData.message as string;
    expect(m).toContain('Jane Doe');
    expect(m).toContain('Fortnightly');
    expect(m).toMatch(/80,000/);
    expect(m).toContain('/yr');
    expect(m).toMatch(/27/);
    // reads never select the sensitive relation
    const args = mockFindMany.mock.calls[0][0];
    expect(args.select).toBeDefined();
    expect(args.select.sensitive).toBeUndefined();
    expect(args.include).toBeUndefined();
  });

  it('US employee reads Bi-weekly', async () => {
    mockFindMany.mockResolvedValueOnce([{ ...jane, jurisdiction: 'us' }]);
    const r = await executeClassification(cls('query-employee'), "what's Jane's pay frequency?", 't1', 'web');
    expect(r.responseData.message).toContain('Bi-weekly');
  });

  it.each([
    ['fr-CA', 'Aux deux semaines (quinzaine)'],
    ['zh-CN', '每两周（澳洲）'],
  ])('localizes the label in %s', async (locale, labelText) => {
    const r = await executeClassification(cls('query-employee', { locale }), 'Jane pay frequency', 't1', 'web');
    expect(r.responseData.message).toContain(labelText);
  });

  it('lists employees', async () => {
    const r = await executeClassification(cls('query-employee'), 'list my employees', 't1', 'web');
    expect(r.responseData.message).toContain('Jane Doe');
    expect(r.responseData.message).toContain('Bob Smith');
    expect(r.responseData.message).toContain('/hr');
  });
});

describe('update-employee', () => {
  it('PUTs only payFrequency and says it applies to the next draft', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true, data: { ...jane, payFrequency: 'weekly' } }) });
    const r = await executeClassification(cls('update-employee'), 'change Jane to weekly', 't1', 'web');
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toMatch(/\/api\/v1\/agentbook-payroll\/employees\/emp-j$/);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ payFrequency: 'weekly' });
    expect(r.responseData.message).toContain('Fortnightly');
    expect(r.responseData.message).toContain('Weekly');
    expect(r.responseData.message).toContain('next draft pay run');
  });

  it('PUTs payRateCents computed from "$80k"', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true, data: { ...bob, payRateCents: 8_000_000, payType: 'hourly' } }) });
    await executeClassification(cls('update-employee'), "set Bob's rate to $80k", 't1', 'web');
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ payRateCents: 8_000_000 });
  });

  it('a validation failure from the route is reported, not claimed as done', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ success: false, error: 'invalid employee update' }) });
    const r = await executeClassification(cls('update-employee'), 'change Jane to weekly', 't1', 'web');
    expect(r.responseData.message).not.toMatch(/^Done/);
  });

  it.each(["change Jane's SSN", "update Jane's TFN", "change Bob's bank account to 12345678"])('refuses sensitive edit: %s', async (text) => {
    const r = await executeClassification(cls('update-employee'), text, 't1', 'web');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(r.responseData.message).toContain('profile screen');
    expect(r.responseData.message).not.toMatch(/12345678/);
    const stored = JSON.stringify(mockConvCreate.mock.calls);
    expect(stored).not.toMatch(/12345678/);
  });
});

describe('generate-pay-run-drafts', () => {
  it('POSTs {generate:"drafts"} and lists runs with pay dates + market labels', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ success: true, data: { runs: [
      { id: 'r1', payFrequency: 'biweekly', periodStart: '2026-11-09T00:00:00Z', periodEnd: '2026-11-22T00:00:00Z', payDate: '2026-11-27T00:00:00Z', stubs: [{}, {}] },
    ] } }) });
    const r = await executeClassification(cls('generate-pay-run-drafts', { jurisdiction: 'au' }), 'set up next pay runs', 't1', 'web');
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ generate: 'drafts' });
    expect(r.responseData.message).toContain('Fortnightly');
    expect(r.responseData.message).toContain('2 employees');
  });
});
