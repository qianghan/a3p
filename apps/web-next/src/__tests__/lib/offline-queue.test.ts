import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { Blob as NodeBlob } from 'node:buffer';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fakeServer } from './_fake-receipt-server';

type Mod = typeof import('@/lib/offline-queue');
const load = async (): Promise<Mod> => import('@/lib/offline-queue');
const setOnline = (v: boolean) => Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => v });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let server: ReturnType<typeof fakeServer>;
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
  setOnline(false); // queueing while offline must not trigger an immediate replay
  server = fakeServer();
  vi.stubGlobal('fetch', server.fetchImpl);
});
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

const photo = () => new File([new Uint8Array([1, 2, 3, 4, 5])], 'receipt.jpg', { type: 'image/jpeg' });

async function seedLegacy(record: Record<string, unknown>) {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open('agentbook-offline', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('expense-queue', { keyPath: 'id', autoIncrement: true });
      req.result.createObjectStore('receipt-queue', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => {
      const tx = req.result.transaction('receipt-queue', 'readwrite');
      tx.objectStore('receipt-queue').add(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
  });
}

describe('receipt queue → replay → from-receipt', () => {
  it('stores bytes, a uuid key and the typed fields; lists it', async () => {
    const q = await load();
    await q.queueReceipt(photo(), { fileName: 'receipt.jpg', idempotencyKey: 'k-1', fields: { amountCents: 1234, vendor: 'Cafe' } });
    expect(await q.pendingCount()).toBe(1);
    expect(await q.listQueue()).toEqual([expect.objectContaining({ store: 'receipt', label: 'Cafe', amountCents: 1234, attempts: 0, lastError: null })]);
  });

  it('replays to from-receipt (never receipts/scan) with the stored key and fields, then removes it', async () => {
    const q = await load();
    await q.queueReceipt(photo(), { fileName: 'receipt.jpg', idempotencyKey: 'k-1', fields: { amountCents: 1234, vendor: 'Cafe', date: '2026-10-01', categoryId: 'c1', isPersonal: false } });
    setOnline(true);
    expect(await q.replayReceipts()).toEqual({ sent: 1, failed: 0, remaining: 0 });
    expect(server.calls).toEqual([{ url: '/api/v1/agentbook-expense/expenses/from-receipt', key: 'k-1', fileName: 'receipt.jpg', fileSize: 5,
      fields: { amountCents: '1234', vendor: 'Cafe', date: '2026-10-01', categoryId: 'c1', isPersonal: 'false' } }]);
    expect(server.byKey.size).toBe(1);
    expect(await q.pendingCount()).toBe(0);
  });

  it('generates a key when the caller does not pass one', async () => {
    const q = await load();
    await q.queueReceipt(photo());
    await q.replayReceipts();
    expect(server.calls[0].key).toMatch(UUID);
  });

  it('survives a reload: a fresh module instance still sees and drains the queue', async () => {
    const first = await load();
    await first.queueReceipt(photo(), { idempotencyKey: 'k-reload' });
    vi.resetModules();
    const second = await load();
    expect(await second.pendingCount()).toBe(1);
    await second.replayReceipts();
    expect(server.byKey.size).toBe(1);
    expect(await second.pendingCount()).toBe(0);
  });

  it('concurrent replays are single-flight (one POST)', async () => {
    const q = await load();
    await q.queueReceipt(photo(), { idempotencyKey: 'k-x' });
    const [a, b] = await Promise.all([q.replayReceipts(), q.replayReceipts()]);
    expect(a).toEqual(b);
    expect(server.calls).toHaveLength(1);
  });

  it('a retry after a server error re-sends the SAME key, so the server books exactly one expense', async () => {
    const q = await load();
    await q.queueReceipt(photo(), { idempotencyKey: 'k-retry' });
    server.setMode('http500');
    expect(await q.replayReceipts()).toEqual({ sent: 0, failed: 1, remaining: 1 });
    expect(await q.listQueue()).toEqual([expect.objectContaining({ attempts: 1, lastError: 'http_500' })]);
    server.setMode('ok');
    await q.replayReceipts();
    await q.replayReceipts();
    expect(server.calls.map((c) => c.key)).toEqual(['k-retry', 'k-retry']);
    expect(server.byKey.size).toBe(1);
  });

  it('a network failure stops the replay and records no error', async () => {
    const q = await load();
    await q.queueReceipt(photo(), { idempotencyKey: 'k-net' });
    server.setMode('throw');
    expect(await q.replayReceipts()).toEqual({ sent: 0, failed: 0, remaining: 1 });
    expect(await q.listQueue()).toEqual([expect.objectContaining({ attempts: 0, lastError: null })]);
  });

  it('the service worker synthetic offline 503 is treated as offline, not as a failure', async () => {
    const q = await load();
    await q.queueReceipt(photo(), { idempotencyKey: 'k-sw' });
    server.setMode('sw-offline');
    expect(await q.replayReceipts()).toEqual({ sent: 0, failed: 0, remaining: 1 });
    expect((await q.listQueue())[0].lastError).toBeNull();
  });

  it('keeps an auth failure queued with a reason the UI can show', async () => {
    const q = await load();
    await q.queueReceipt(photo(), { idempotencyKey: 'k-401' });
    server.setMode('http401');
    await q.replayReceipts();
    expect((await q.listQueue())[0]).toMatchObject({ attempts: 1, lastError: 'unauthorized', permanent: false });
  });
});

describe('legacy records (queued by the old capture page, no key)', () => {
  it('get a key generated and PERSISTED before the first POST, reused on retry', async () => {
    await seedLegacy({ file: new NodeBlob([new Uint8Array([9, 9, 9])], { type: 'image/jpeg' }), fileName: 'old.jpg', fileType: 'image/jpeg', queuedAt: 1 });
    const q = await load();
    server.setMode('http500');
    await q.replayReceipts();
    const minted = server.calls[0].key;
    expect(minted).toMatch(UUID);
    expect(server.calls[0]).toMatchObject({ fileName: 'old.jpg', fileSize: 3, fields: {} });
    server.setMode('ok');
    await q.replayReceipts();
    expect(server.calls[1].key).toBe(minted);
    expect(server.byKey.size).toBe(1);
    expect(await q.pendingCount()).toBe(0);
  });
});

describe('queue management', () => {
  it('discards a receipt and an expense, and announces each change', async () => {
    const q = await load();
    const seen = vi.fn();
    window.addEventListener(q.QUEUE_CHANGED_EVENT, seen);
    const id = await q.queueReceipt(photo(), { idempotencyKey: 'k-d' });
    await q.queueExpense({ amountCents: 500, vendor: 'Bus' });
    const entries = await q.listQueue();
    expect(entries.map((e) => e.store).sort()).toEqual(['expense', 'receipt']);
    await q.discardQueueEntry('receipt', id);
    await q.discardQueueEntry('expense', entries.find((e) => e.store === 'expense')!.id);
    expect(await q.pendingCount()).toBe(0);
    expect(seen.mock.calls.length).toBeGreaterThanOrEqual(4);
    window.removeEventListener(q.QUEUE_CHANGED_EVENT, seen);
  });

  it('does not hang when no service worker is registered (ready never settles)', async () => {
    Object.defineProperty(window.navigator, 'serviceWorker', { configurable: true, value: { ready: new Promise(() => {}) } });
    const q = await load();
    const started = Date.now();
    await q.queueReceipt(photo(), { idempotencyKey: 'k-hang' });
    expect(Date.now() - started).toBeLessThan(q.SYNC_READY_TIMEOUT_MS + 1000);
    Reflect.deleteProperty(window.navigator, 'serviceWorker');
  });
});

describe('manual-expense queue is unchanged', () => {
  it('replays JSON to /expenses and removes the entry', async () => {
    const q = await load();
    await q.queueExpense({ amountCents: 700, vendor: 'Taxi' });
    setOnline(true);
    const r = await q.replayAll();
    expect(r).toEqual({ sent: 1, remaining: 0 });
    const [url, init] = server.fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/agentbook-expense/expenses');
    expect(JSON.parse(init.body as string)).toEqual({ amountCents: 700, vendor: 'Taxi' });
  });
});

const OWNER = 'ab:mobile-owner';
const setOwner = (id: string | null) => { if (id) localStorage.setItem(OWNER, id); else localStorage.removeItem(OWNER); };
async function rawReceipts(): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('agentbook-offline', 1);
    req.onsuccess = () => {
      const r = req.result.transaction('receipt-queue', 'readonly').objectStore('receipt-queue').getAll();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    };
    req.onerror = () => reject(req.error);
  });
}

describe('failure classification', () => {
  it.each([[413, 'http413', 'file_too_large'], [400, 'http400', 'http_400']] as const)('%i is permanent: kept, never re-POSTed, still listed', async (_s, mode, reason) => {
    const q = await load();
    await q.queueReceipt(photo(), { idempotencyKey: 'k-perm' });
    server.setMode(mode);
    expect(await q.replayReceipts()).toEqual({ sent: 0, failed: 1, remaining: 1 });
    expect(server.calls).toHaveLength(1);
    expect(await q.listQueue()).toEqual([expect.objectContaining({ attempts: 1, lastError: reason, permanent: true })]);
    server.setMode('ok');
    expect(await q.replayReceipts()).toEqual({ sent: 0, failed: 0, remaining: 1 });
    expect(server.calls).toHaveLength(1);
    expect(await q.listQueue()).toEqual([expect.objectContaining({ attempts: 1, lastError: reason, permanent: true })]);
    await q.discardQueueEntry('receipt', (await q.listQueue())[0].id);
    expect(await q.pendingCount()).toBe(0);
  });

  it.each([['http408', 'http_408'], ['http409', 'http_409'], ['http429', 'http_429'], ['http500', 'http_500']] as const)('%s is transient: kept, not permanent, re-POSTed next pass', async (mode, reason) => {
    const q = await load();
    await q.queueReceipt(photo(), { idempotencyKey: 'k-tr' });
    server.setMode(mode);
    await q.replayReceipts();
    expect(await q.listQueue()).toEqual([expect.objectContaining({ attempts: 1, lastError: reason, permanent: false })]);
    await q.replayReceipts();
    expect(server.calls).toHaveLength(2);
    expect(await q.listQueue()).toEqual([expect.objectContaining({ attempts: 2, permanent: false })]);
  });

  it('401 keeps the record (not permanent), stops the pass, and succeeds after sign-in', async () => {
    const q = await load();
    await q.queueReceipt(photo(), { idempotencyKey: 'k-a' });
    await q.queueReceipt(photo(), { idempotencyKey: 'k-b' });
    server.setMode('http401');
    await q.replayReceipts();
    expect(server.calls).toHaveLength(1);
    expect(await q.listQueue()).toEqual([
      expect.objectContaining({ attempts: 1, lastError: 'unauthorized', permanent: false }),
      expect.objectContaining({ attempts: 0, lastError: null, permanent: false }),
    ]);
    server.setMode('ok');
    expect(await q.replayReceipts()).toEqual({ sent: 2, failed: 0, remaining: 0 });
    expect(server.byKey.size).toBe(2);
  });
});

describe('queue owner (tag + hold)', () => {
  it('stamps the signed-in owner; another user does not see, send or alter it; the owner gets it back', async () => {
    setOwner('user-A');
    const q = await load();
    await q.queueReceipt(photo(), { idempotencyKey: 'k-own', fields: { vendor: 'Secret Cafe', amountCents: 500 } });
    expect((await rawReceipts())[0]).toMatchObject({ ownerId: 'user-A' });
    setOwner('user-B');
    expect(await q.replayReceipts()).toEqual({ sent: 0, failed: 0, remaining: 0 });
    expect(server.calls).toHaveLength(0);
    expect(await q.listQueue()).toEqual([]);
    expect(await q.pendingCount()).toBe(0);
    const held = (await rawReceipts())[0];
    expect(held).toMatchObject({ ownerId: 'user-A', attempts: 0, lastError: null });
    setOwner(null);
    await q.replayReceipts();
    expect(server.calls).toHaveLength(0);
    setOwner('user-A');
    expect(await q.pendingCount()).toBe(1);
    expect(await q.replayReceipts()).toEqual({ sent: 1, failed: 0, remaining: 0 });
    expect(await q.pendingCount()).toBe(0);
    expect(await rawReceipts()).toEqual([]);
  });

  it('a legacy unowned record replays under the signed-in user and is stamped with that owner', async () => {
    await seedLegacy({ file: new NodeBlob([new Uint8Array([9])], { type: 'image/jpeg' }), fileName: 'old.jpg', fileType: 'image/jpeg', queuedAt: 1 });
    setOwner('user-A');
    const q = await load();
    server.setMode('http500');
    await q.replayReceipts();
    expect(server.calls).toHaveLength(1);
    expect(await rawReceipts()).toEqual([expect.objectContaining({ ownerId: 'user-A', attempts: 1, lastError: 'http_500' })]);
    setOwner('user-B');
    server.setMode('ok');
    await q.replayReceipts();
    expect(server.calls).toHaveLength(1);
    setOwner('user-A');
    await q.replayReceipts();
    expect(server.byKey.size).toBe(1);
  });

  it('a legacy unowned record still replays when nobody is known (no stamp)', async () => {
    await seedLegacy({ file: new NodeBlob([new Uint8Array([9])], { type: 'image/jpeg' }), fileName: 'old.jpg', fileType: 'image/jpeg', queuedAt: 1 });
    const q = await load();
    expect(await q.pendingCount()).toBe(1);
    server.setMode('http500');
    await q.replayReceipts();
    expect((await rawReceipts())[0].ownerId).toBeUndefined();
  });
});
