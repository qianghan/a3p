import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * PR 3d.2 — the Capture "Pay later" client: createBill (in _lib/api.ts, the
 * only fetch layer) sends the idempotency key in the header AND the body, and
 * maps server codes; the offline queue replays a queued bill to /bills with
 * the SAME key, so a replay after a lost response is one bill.
 */
const setOnline = (v: boolean) => Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => v });
type Call = { url: string; init: RequestInit };
let calls: Call[];
let responder: (c: Call) => Response;
const KEY = '0f8b6c1e-6a1d-4c8e-9a43-5d6c1b2a3e4f';

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
  calls = [];
  responder = () => new Response(JSON.stringify({ success: true, data: { id: 'bill-1', vendorName: 'Hydro', amountCents: 8450, dueDate: '2026-12-15', status: 'open' } }), { status: 201 });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => { const c = { url, init }; calls.push(c); return responder(c); }));
  setOnline(true);
});
afterEach(() => vi.unstubAllGlobals());

describe('createBill (_lib/api.ts)', () => {
  it('POSTs /bills with the key in the Idempotency-Key header and the body; returns the bill', async () => {
    const { createBill } = await import('@/app/app/_lib/api');
    const out = await createBill({ vendorName: 'Hydro', amountCents: 8450, dueDate: '2026-12-15', billDate: '2026-11-23', categoryId: 'acct-util', currency: 'CAD' }, KEY);
    expect(out.id).toBe('bill-1');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/v1/agentbook-expense/bills');
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>)['Idempotency-Key']).toBe(KEY);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ vendorName: 'Hydro', amountCents: 8450, dueDate: '2026-12-15', billDate: '2026-11-23', categoryId: 'acct-util', currency: 'CAD', idempotencyKey: KEY });
  });
  it('a closed period / conflict surfaces the server status and code', async () => {
    const { createBill } = await import('@/app/app/_lib/api');
    responder = () => new Response(JSON.stringify({ success: false, code: 'period_closed', error: 'Period closed' }), { status: 422 });
    await expect(createBill({ vendorName: 'Hydro', amountCents: 100, dueDate: '2026-12-15' }, KEY)).rejects.toMatchObject({ status: 422, code: 'period_closed' });
  });
  it('a network failure is an offline error (the page queues it)', async () => {
    const { createBill } = await import('@/app/app/_lib/api');
    const { isOfflineError } = await import('@/app/app/_lib/offline');
    responder = () => { throw new TypeError('Failed to fetch'); };
    const err = await createBill({ vendorName: 'Hydro', amountCents: 100, dueDate: '2026-12-15' }, KEY).catch((e) => e);
    expect(isOfflineError(err)).toBe(true);
  });
  it('refuses a bad key or amount without a request', async () => {
    const { createBill } = await import('@/app/app/_lib/api');
    await expect(createBill({ vendorName: 'H', amountCents: 0, dueDate: '2026-12-15' }, KEY)).rejects.toMatchObject({ code: 'amount_invalid' });
    await expect(createBill({ vendorName: 'H', amountCents: 5, dueDate: '2026-12-15' }, 'x')).rejects.toMatchObject({ code: 'invalid_request' });
    expect(calls).toHaveLength(0);
  });
});

describe('offline queue: a queued bill replays to /bills with its key', () => {
  it('page replay: POST /bills, same key in header + body, entry removed; listed by vendor', async () => {
    setOnline(false);
    const q = await import('@/lib/offline-queue');
    await q.queueBill({ vendorName: 'Hydro', amountCents: 8450, dueDate: '2026-12-15' }, KEY);
    expect(await q.listQueue()).toEqual([expect.objectContaining({ store: 'expense', label: 'Hydro', amountCents: 8450 })]);
    setOnline(true);
    expect(await q.replayAll()).toEqual({ sent: 1, remaining: 0 });
    const posts = calls.filter((c) => c.init.method === 'POST');
    expect(posts.map((c) => c.url)).toEqual(['/api/v1/agentbook-expense/bills']);
    expect((posts[0].init.headers as Record<string, string>)['Idempotency-Key']).toBe(KEY);
    expect(JSON.parse(posts[0].init.body as string)).toEqual({ vendorName: 'Hydro', amountCents: 8450, dueDate: '2026-12-15', idempotencyKey: KEY });
  });
  it('a server rejection keeps it queued; the retry re-sends the SAME key', async () => {
    setOnline(false);
    const q = await import('@/lib/offline-queue');
    await q.queueBill({ vendorName: 'Hydro', amountCents: 8450, dueDate: '2026-12-15' }, KEY);
    setOnline(true);
    responder = () => new Response(JSON.stringify({ success: false }), { status: 500 });
    expect((await q.replayAll()).remaining).toBe(1);
    responder = () => new Response(JSON.stringify({ success: true, data: { id: 'bill-1' } }), { status: 200 });
    expect((await q.replayAll()).remaining).toBe(0);
    const keys = calls.filter((c) => c.init.method === 'POST').map((c) => JSON.parse(c.init.body as string).idempotencyKey);
    expect(keys).toEqual([KEY, KEY]);
  });
  it('a legacy expense record (no path) still replays to /expenses with no key', async () => {
    setOnline(false);
    const q = await import('@/lib/offline-queue');
    await q.queueExpense({ amountCents: 700, vendor: 'Taxi' });
    setOnline(true);
    await q.replayAll();
    const post = calls.find((c) => c.init.method === 'POST')!;
    expect([post.url, (post.init.headers as Record<string, string>)['Idempotency-Key']]).toEqual(['/api/v1/agentbook-expense/expenses', undefined]);
  });
});
