import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * PR 3d.3 — record-bill / pay-bill / query-payables handlers (and the kept
 * manage-bills manifest delegating to them). Every write goes through the
 * Next bills routes; fetch is mocked and each assertion reads the request
 * the handler sent or a figure computed from the route's response.
 */
const billCreate = vi.fn();
vi.mock('../db/client.js', () => ({
  db: {
    abTenantConfig: { findUnique: vi.fn(async () => null), findFirst: vi.fn(async () => null) },
    abBill: { create: (...a: any[]) => billCreate(...a), findMany: vi.fn(async () => []) },
    abAccount: { findMany: vi.fn(async () => []) },
    abConversation: { create: vi.fn(async () => ({})), findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    abSkillRun: { create: vi.fn(async () => ({})) },
    abUserMemory: { findMany: vi.fn(async () => []) },
    abVendor: { findFirst: vi.fn(async () => null) },
    abPattern: { findFirst: vi.fn(async () => null) },
    abEvent: { create: vi.fn(async () => ({})) },
  },
}));

import { executeClassification } from '../server';
import { parseDueDate, parseBillVendor, chooseBillToPay, parseBillAmount } from '../bill-chat';

type Call = { url: string; method: string; body: any };
let calls: Call[] = [];
let routes: Record<string, (c: Call) => any> = {};
const realFetch = globalThis.fetch;
beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  routes = {};
  globalThis.fetch = vi.fn(async (url: any, init: any = {}) => {
    const c = { url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(c);
    const key = Object.keys(routes).find((k) => `${c.method} ${c.url}`.includes(k));
    const out = key ? routes[key](c) : { success: false };
    return { ok: out.success !== false, status: out.success === false ? 500 : 200, json: async () => out } as any;
  }) as any;
});
afterEach(() => { globalThis.fetch = realFetch; });

const cls = (name: string, extractedParams: Record<string, unknown> = {}, tenantConfig: Record<string, unknown> = { currency: 'USD' }) => ({
  selectedSkill: { name, endpoint: { method: 'INTERNAL', url: '' }, parameters: {} },
  extractedParams, confidence: 0.9, confirmBefore: false, memory: [], skills: [], conversation: [], tenantConfig,
}) as any;

const HYDRO = { id: 'b1', vendorName: 'Hydro One', amountCents: 8450, paidCents: 0, dueDate: '2026-12-15T00:00:00.000Z', status: 'open' };
const STAPLES = { id: 'b2', vendorName: 'Staples', amountCents: 23000, paidCents: 3000, dueDate: '2026-10-01T00:00:00.000Z', status: 'partial' };
const PAID = { id: 'b3', vendorName: 'Telus', amountCents: 9500, paidCents: 9500, dueDate: '2026-10-01T00:00:00.000Z', status: 'paid' };

describe('record-bill', () => {
  it('posts vendor, amount and the stated due date to the bills route; replies with the route’s bill', async () => {
    routes['POST http://localhost:4051/api/v1/agentbook-expense/bills'] = (c) => ({ success: true, data: { id: 'n1', ...c.body, dueDate: `${c.body.dueDate}T00:00:00.000Z` } });
    const r = await executeClassification(cls('record-bill'), 'Add a bill from Hydro One $84.50 due 2026-12-15', 't1', 'web');
    const post = calls.find((c) => c.method === 'POST')!;
    expect([post.body.vendorName, post.body.amountCents, post.body.dueDate]).toEqual(['Hydro One', 8450, '2026-12-15']);
    expect(post.body.idempotencyKey).toMatch(/^chat-bill:[0-9a-f]{24}:\d{4}-\d{2}-\d{2}$/);
    expect(r.responseData.message).toContain('**Hydro One** for $84.50');
    expect(r.responseData.message).not.toContain('No due date');
    expect(billCreate).not.toHaveBeenCalled();
  });
  it('no due date → 14 days out and says so', async () => {
    routes['POST http://localhost:4051/api/v1/agentbook-expense/bills'] = (c) => ({ success: true, data: { id: 'n1', ...c.body } });
    await executeClassification(cls('record-bill'), 'add a bill from Staples $230', 't1', 'web');
    const due = calls[0].body.dueDate;
    const want = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
    expect(due).toBe(want);
  });
  it('missing amount → asks, posts nothing', async () => {
    const r = await executeClassification(cls('record-bill'), 'add a bill from Staples', 't1', 'web');
    expect(calls).toHaveLength(0);
    expect(r.responseData.message).toMatch(/vendor and the amount/);
  });
  it('review I3: "I owe the landlord 1200" records a bill to the landlord for 1200 (no $ needed)', async () => {
    routes['POST http://localhost:4051/api/v1/agentbook-expense/bills'] = (c) => ({ success: true, data: { id: 'n1', ...c.body } });
    await executeClassification(cls('record-bill'), 'I owe the landlord 1200', 't1', 'web');
    expect(calls[0].body).toMatchObject({ vendorName: 'landlord', amountCents: 120000 });
  });
  it('review I3: "我欠房东1200元" records a bill to 房东', async () => {
    routes['POST http://localhost:4051/api/v1/agentbook-expense/bills'] = (c) => ({ success: true, data: { id: 'n1', ...c.body } });
    await executeClassification(cls('record-bill', {}, { currency: 'CNY', locale: 'zh-CN' }), '我欠房东1200元', 't1', 'web');
    expect(calls[0].body).toMatchObject({ vendorName: '房东', amountCents: 120000 });
  });
  it('manage-bills create delegates to the route (no direct abBill.create)', async () => {
    routes['POST http://localhost:4051/api/v1/agentbook-expense/bills'] = (c) => ({ success: true, data: { id: 'n1', ...c.body } });
    const r = await executeClassification(cls('manage-bills', { action: 'create', vendorName: 'Rent Co', amountCents: 80000, dueDate: '2026-12-01' }), 'rent bill', 't1', 'web');
    expect(calls[0].body).toMatchObject({ vendorName: 'Rent Co', amountCents: 80000, dueDate: '2026-12-01' });
    expect(billCreate).not.toHaveBeenCalled();
    expect(r.skillUsed).toBe('manage-bills');
  });
  it('replies in fr-CA', async () => {
    routes['POST http://localhost:4051/api/v1/agentbook-expense/bills'] = (c) => ({ success: true, data: { id: 'n1', ...c.body } });
    const r = await executeClassification(cls('record-bill', {}, { currency: 'CAD', locale: 'fr-CA' }), 'Ajouter une facture fournisseur de Bell 120 $ échéance 15 décembre', 't1', 'web');
    expect(calls[0].body).toMatchObject({ vendorName: 'Bell', amountCents: 12000 });
    expect(calls[0].body.dueDate).toMatch(/-12-15$/);
    expect(r.responseData.message).toContain('Facture fournisseur enregistrée : **Bell**');
  });
});

describe('pay-bill', () => {
  const list = (bills: any[]) => () => ({ success: true, data: bills });
  it('full pay of the named bill: POST ?action=pay with no amount; reply from the route', async () => {
    routes['GET http://localhost:4051/api/v1/agentbook-expense/bills?status=all'] = list([HYDRO, STAPLES, PAID]);
    routes['POST http://localhost:4051/api/v1/agentbook-expense/bills/b1?action=pay'] = () => ({ success: true, data: { ...HYDRO, paidCents: 8450, status: 'paid' }, payment: { id: 'p1', amountCents: 8450 } });
    const r = await executeClassification(cls('pay-bill'), 'Pay the Hydro One bill', 't1', 'web');
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toContain('/bills/b1?action=pay');
    expect(post.body.amountCents).toBeUndefined();
    expect(r.responseData.message).toBe('Paid **Hydro One** $84.50 — the bill is now paid in full.');
  });
  it('partial: sends the amount; remaining is the route’s total − paid', async () => {
    routes['GET http://localhost:4051/api/v1/agentbook-expense/bills?status=all'] = list([HYDRO, STAPLES]);
    routes['POST http://localhost:4051/api/v1/agentbook-expense/bills/b2?action=pay'] = (c) => ({ success: true, data: { ...STAPLES, paidCents: 3000 + c.body.amountCents, status: 'partial' }, payment: { id: 'p2', amountCents: c.body.amountCents } });
    const r = await executeClassification(cls('pay-bill'), 'Paid $100 on the Staples bill', 't1', 'web');
    expect(calls.find((c) => c.method === 'POST')!.body.amountCents).toBe(10000);
    expect(r.responseData.message).toBe('Recorded a $100 payment to **Staples**; $100 is still owing.');
  });
  it('review M3: the same pay sentence twice is two payments (different keys), not a replay', async () => {
    routes['GET http://localhost:4051/api/v1/agentbook-expense/bills?status=all'] = list([STAPLES]);
    routes['POST http://localhost:4051/api/v1/agentbook-expense/bills/b2?action=pay'] = (c) => ({ success: true, data: { ...STAPLES, paidCents: 3000 + c.body.amountCents, status: 'partial' }, payment: { id: 'p', amountCents: c.body.amountCents } });
    await executeClassification(cls('pay-bill'), 'Paid $50 on the Staples bill', 't1', 'web');
    await executeClassification(cls('pay-bill'), 'Paid $50 on the Staples bill', 't1', 'web');
    const keys = calls.filter((c) => c.method === 'POST').map((c) => c.body.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });
  it('re-review N3: with a client message id the pay key is derived from it (a resend of the same send replays)', async () => {
    routes['GET http://localhost:4051/api/v1/agentbook-expense/bills?status=all'] = list([STAPLES]);
    routes['POST http://localhost:4051/api/v1/agentbook-expense/bills/b2?action=pay'] = (c) => ({ success: true, data: { ...STAPLES, paidCents: 8000, status: 'partial' }, payment: { id: 'p', amountCents: c.body.amountCents } });
    const withId = { ...cls('pay-bill'), clientMessageId: 'msg-123456789' };
    await executeClassification(withId, 'Paid $50 on the Staples bill', 't1', 'web');
    await executeClassification(withId, 'Paid $50 on the Staples bill', 't1', 'web');
    const keys = calls.filter((c) => c.method === 'POST').map((c) => c.body.idempotencyKey);
    expect(keys).toEqual(['chat-pay:b2:msg-123456789', 'chat-pay:b2:msg-123456789']);
  });
  it('review M3: a 409 payment_voided gets its own message, not "couldn’t load your bills"', async () => {
    routes['GET http://localhost:4051/api/v1/agentbook-expense/bills?status=all'] = list([STAPLES]);
    routes['POST http://localhost:4051/api/v1/agentbook-expense/bills/b2?action=pay'] = () => ({ success: false, code: 'payment_voided' });
    const r = await executeClassification(cls('pay-bill'), 'Paid $50 on the Staples bill', 't1', 'web');
    expect(r.responseData.message).toMatch(/voided/);
  });
  it('overpayment is refused before any write', async () => {
    routes['GET http://localhost:4051/api/v1/agentbook-expense/bills?status=all'] = list([STAPLES]);
    const r = await executeClassification(cls('pay-bill'), 'Paid $500 on the Staples bill', 't1', 'web');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(r.responseData.message).toContain('$200 still owing on **Staples**');
  });
  it('several open bills and none named → asks which, pays nothing', async () => {
    routes['GET http://localhost:4051/api/v1/agentbook-expense/bills?status=all'] = list([HYDRO, STAPLES]);
    const r = await executeClassification(cls('pay-bill'), 'pay the bill', 't1', 'web');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(r.responseData.message).toMatch(/^Which bill did you pay\?/);
    expect(r.responseData.message).toContain('**Staples** — $200');
  });
  it('no open bill for that vendor + an amount → records an expense instead (pre-3d behaviour), no bill payment', async () => {
    routes['GET http://localhost:4051/api/v1/agentbook-expense/bills?status=all'] = list([HYDRO]);
    routes['POST http://localhost:4051/api/v1/agentbook-expense/expenses'] = (c) => ({ success: true, data: { id: 'e1', amountCents: c.body.amountCents, description: c.body.description } });
    await executeClassification(cls('pay-bill'), 'Paid the Rogers bill $80', 't1', 'web');
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => c.url.replace('http://localhost:4051', ''))).toEqual(['/api/v1/agentbook-expense/expenses']);
    expect(posts[0].body.amountCents).toBe(8000);
  });
});

describe('query-payables', () => {
  it('total = Σ outstanding of open+partial; aging from the ap-aging route; paid bills excluded', async () => {
    routes['GET http://localhost:4051/api/v1/agentbook-expense/bills?status=all'] = () => ({ success: true, data: [HYDRO, STAPLES, PAID] });
    routes['GET http://localhost:4053/api/v1/agentbook-tax/reports/ap-aging'] = () => ({ success: true, data: { buckets: { current: { totalCents: 8450 }, d1_30: { totalCents: 0 }, d31_60: { totalCents: 20000 }, d60_plus: { totalCents: 0 } } } });
    const r = await executeClassification(cls('query-payables'), 'What bills are due?', 't1', 'web');
    expect(r.skillResponse.data.totalCents).toBe(8450 + 20000);
    expect(r.skillResponse.data.buckets).toEqual({ current: 8450, d1_30: 0, d31_60: 20000, d60_plus: 0 });
    expect(r.responseData.message).toContain('You owe **$284.50** across 2 open bills');
    expect(r.responseData.message).toContain('31–60 days $200');
    expect(r.responseData.message).not.toContain('Telus');
  });
  it('none open → the empty message; zh-CN catalog', async () => {
    routes['GET http://localhost:4051/api/v1/agentbook-expense/bills?status=all'] = () => ({ success: true, data: [PAID] });
    const r = await executeClassification(cls('query-payables', {}, { currency: 'CNY', locale: 'zh-CN' }), '我的应付账款是多少？', 't1', 'web');
    expect(r.responseData.message).toMatch(/^您没有未付账单/);
  });
  it('manage-bills list delegates to query-payables', async () => {
    routes['GET http://localhost:4051/api/v1/agentbook-expense/bills?status=all'] = () => ({ success: true, data: [STAPLES] });
    const r = await executeClassification(cls('manage-bills'), 'bills', 't1', 'web');
    expect(r.skillResponse.data.totalCents).toBe(20000);
  });
});

describe('parsers', () => {
  const now = new Date('2026-11-23T12:00:00Z');
  const iso = (d: Date | null) => d?.toISOString().slice(0, 10);
  it('parseDueDate', () => {
    expect(iso(parseDueDate('due Dec 15', now))).toBe('2026-12-15');
    expect(iso(parseDueDate('due 3 Jan', now))).toBe('2027-01-03');
    expect(iso(parseDueDate('échéance 15 décembre', now))).toBe('2026-12-15');
    expect(iso(parseDueDate('12月15日到期', now))).toBe('2026-12-15');
    expect(iso(parseDueDate('due in 30 days', now))).toBe('2026-12-23');
    expect(iso(parseDueDate('due Friday', now))).toBe('2026-11-27');
    expect(iso(parseDueDate('周五到期', now))).toBe('2026-11-27');
    expect(parseDueDate('add a bill from Staples $230', now)).toBeNull();
  });
  it('parseBillVendor', () => {
    expect(parseBillVendor('Add a bill from Hydro One $84.50 due Dec 15')).toBe('Hydro One');
    expect(parseBillVendor('Pay the Staples bill')).toBe('Staples');
    expect(parseBillVendor('Ajouter une facture fournisseur de Bell 120 $')).toBe('Bell');
    expect(parseBillVendor('Enregistrer une facture à payer de Hydro-Québec 84 $')).toBe('Hydro-Québec');
    expect(parseBillVendor('记录一笔来自电力公司的账单 300 元')).toBe('电力公司');
    expect(parseBillVendor('添加账单 Telstra 89 元 周五到期')).toBe('Telstra');
  });
  it('parseBillAmount: fr-CA "84,50 $" and "1 200 $"', () => {
    const none = () => null;
    expect(parseBillAmount('facture de Bell 84,50 $', none)).toBe(8450);
    expect(parseBillAmount('facture de Bell 1 200 $', none)).toBe(120000);
  });
  it('chooseBillToPay: a full vendor name beats a prefix; the first-word fallback is whole-word only', () => {
    const mk = (id: string, vendorName: string) => ({ id, vendorName, amountCents: 100, paidCents: 0, dueDate: '2026-12-31', status: 'open' });
    // prod e2e: "Pay the E2EBILMA…CHAT bill" also offered three "E2E F6 Vendor …" bills.
    const tagged = mk('t', 'E2EBILMAZZ9PROBECHAT');
    const others = [mk('o1', 'E2E F6 Vendor 1782848970490'), mk('o2', 'E2E F6 Vendor 1783785029667')];
    expect(chooseBillToPay('Pay the E2EBILMAZZ9PROBECHAT bill', [tagged, ...others]).map((b) => b.id)).toEqual(['t']);
    expect(chooseBillToPay('Pay the Hydro One bill', [mk('h1', 'Hydro One'), mk('h2', 'Hydro Ottawa')]).map((b) => b.id)).toEqual(['h1']);
    expect(chooseBillToPay('pay the hydro bill', [mk('h1', 'Hydro One'), mk('h2', 'Hydro Ottawa')]).map((b) => b.id)).toEqual(['h1', 'h2']);
  });

  it('chooseBillToPay matches by vendor, never a paid bill', () => {
    expect(chooseBillToPay('pay the hydro bill', [HYDRO, STAPLES, PAID]).map((b) => b.id)).toEqual(['b1']);
    expect(chooseBillToPay('pay the telus bill', [HYDRO, PAID])).toEqual([]);
  });
});
