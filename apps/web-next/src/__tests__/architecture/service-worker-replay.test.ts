import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { Blob as NodeBlob } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fakeServer } from '../lib/_fake-receipt-server';

/**
 * Executes the SHIPPED public/sw.js — not a copy — against a fake IndexedDB
 * shared with the page-side queue, so both replay paths are proven to target
 * from-receipt with the same stored key.
 */
const SW_SOURCE = readFileSync(join(__dirname, '..', '..', '..', 'public', 'sw.js'), 'utf8');
const setOnline = (v: boolean) => Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => v });

function loadSw(fetchImpl: unknown, idb: IDBFactory) {
  const handlers: Record<string, (e: unknown) => void> = {};
  const self = {
    addEventListener: (type: string, fn: (e: unknown) => void) => { handlers[type] = fn; },
    skipWaiting: () => undefined,
    clients: { claim: () => undefined, openWindow: () => undefined },
    registration: { showNotification: () => undefined },
    crypto: globalThis.crypto,
  };
  const context = vm.createContext({
    self, fetch: fetchImpl, indexedDB: idb, FormData, Blob, Response, URL, console, setTimeout,
    caches: { open: async () => ({ addAll: async () => undefined, put: async () => undefined }), keys: async () => [], match: async () => undefined, delete: async () => true },
  });
  vm.runInContext(SW_SOURCE, context);
  return {
    sync(tag: string): Promise<unknown> {
      let p: Promise<unknown> = Promise.resolve();
      handlers.sync({ tag, waitUntil: (x: Promise<unknown>) => { p = x; } });
      return p;
    },
  };
}

async function seed(record: Record<string, unknown>) {
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

let idb: IDBFactory;
let server: ReturnType<typeof fakeServer>;
beforeEach(() => {
  idb = new IDBFactory();
  globalThis.indexedDB = idb;
  vi.resetModules();
  setOnline(false);
  server = fakeServer(); // /auth/me answers 'user-1' by default
  vi.stubGlobal('fetch', server.fetchImpl);
  // The page user is the same person the worker's /auth/me reports, so records the worker stamps stay visible to listQueue().
  localStorage.setItem('ab:mobile-owner', 'user-1');
});
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

describe('sw.js receipt replay', () => {
  it('never targets /receipts/scan (the orphaning endpoint)', () => {
    expect(SW_SOURCE).not.toMatch(/receipts\/scan/);
    expect(SW_SOURCE).toMatch(/\/api\/v1\/agentbook-expense\/expenses\/from-receipt/);
  });

  it('replays a v2 record with its stored key and fields, then deletes it', async () => {
    await seed({ bytes: new Uint8Array([1, 2, 3]).buffer, fileName: 'r.jpg', fileType: 'image/jpeg', idempotencyKey: 'k-sw', fields: { amountCents: 990, vendor: 'Deli', isPersonal: true }, queuedAt: 1, attempts: 0, lastError: null });
    await loadSw(server.fetchImpl, idb).sync('agentbook-receipt-sync');
    expect(server.calls).toEqual([{ url: '/api/v1/agentbook-expense/expenses/from-receipt', key: 'k-sw', fileName: 'r.jpg', fileSize: 3, fields: { amountCents: '990', vendor: 'Deli', isPersonal: 'true' } }]);
    const q = await import('@/lib/offline-queue');
    expect(await q.pendingCount()).toBe(0);
  });

  it('sends exactly the same multipart field names as the page replay', async () => {
    const fields = { amountCents: 1, vendor: 'V', date: '2026-10-01', categoryId: 'c', isPersonal: false };
    await seed({ bytes: new Uint8Array([1]).buffer, fileName: 'a.jpg', fileType: 'image/jpeg', idempotencyKey: 'k-a', fields, queuedAt: 1 });
    server.setMode('http500');
    await loadSw(server.fetchImpl, idb).sync('agentbook-receipt-sync');
    const q = await import('@/lib/offline-queue');
    await q.replayReceipts();
    expect(server.calls).toHaveLength(2);
    expect(Object.keys(server.calls[0].fields).sort()).toEqual(Object.keys(server.calls[1].fields).sort());
    expect(server.calls[0].key).toBe(server.calls[1].key);
  });

  it('mints and persists a key for a legacy record; the page later re-sends that same key', async () => {
    await seed({ file: new NodeBlob([new Uint8Array([7, 7])], { type: 'image/jpeg' }), fileName: 'legacy.jpg', fileType: 'image/jpeg', queuedAt: 1 });
    server.setMode('http500');
    await loadSw(server.fetchImpl, idb).sync('agentbook-receipt-sync');
    const minted = server.calls[0].key;
    expect(minted).toMatch(/^[0-9a-f-]{36}$/);
    server.setMode('ok');
    const q = await import('@/lib/offline-queue');
    await q.replayReceipts();
    expect(server.calls[1].key).toBe(minted);
    expect(server.byKey.size).toBe(1);
  });

  it('page + worker replaying the same legacy record AT ONCE still book exactly one expense', async () => {
    await seed({ file: new NodeBlob([new Uint8Array([5])], { type: 'image/jpeg' }), fileName: 'race.jpg', fileType: 'image/jpeg', queuedAt: 1 });
    const q = await import('@/lib/offline-queue');
    await Promise.all([loadSw(server.fetchImpl, idb).sync('agentbook-receipt-sync'), q.replayReceipts()]);
    expect(new Set(server.calls.map((c) => c.key)).size).toBe(1);
    expect(server.byKey.size).toBe(1);
    expect(await q.pendingCount()).toBe(0);
  });

  it('rejects while offline so Background Sync retries, and keeps the record', async () => {
    await seed({ bytes: new Uint8Array([1]).buffer, fileName: 'o.jpg', fileType: 'image/jpeg', idempotencyKey: 'k-o', fields: {}, queuedAt: 1 });
    server.setMode('throw');
    await expect(loadSw(server.fetchImpl, idb).sync('agentbook-receipt-sync')).rejects.toThrow(/offline/);
    const q = await import('@/lib/offline-queue');
    expect(await q.pendingCount()).toBe(1);
  });

  it('records an HTTP failure on the record for the queue sheet', async () => {
    await seed({ bytes: new Uint8Array([1]).buffer, fileName: 'f.jpg', fileType: 'image/jpeg', idempotencyKey: 'k-f', fields: {}, queuedAt: 1 });
    server.setMode('http401');
    await loadSw(server.fetchImpl, idb).sync('agentbook-receipt-sync');
    const q = await import('@/lib/offline-queue');
    expect((await q.listQueue())[0]).toMatchObject({ attempts: 1, lastError: 'unauthorized', permanent: false });
  });

  it('treats the service worker synthetic offline 503 as offline: rejects, keeps the record, records no error', async () => {
    await seed({ bytes: new Uint8Array([1]).buffer, fileName: 's.jpg', fileType: 'image/jpeg', idempotencyKey: 'k-s', fields: {}, queuedAt: 1, attempts: 0, lastError: null });
    server.setMode('sw-offline');
    await expect(loadSw(server.fetchImpl, idb).sync('agentbook-receipt-sync')).rejects.toThrow(/offline/);
    const q = await import('@/lib/offline-queue');
    expect((await q.listQueue())[0]).toMatchObject({ attempts: 0, lastError: null });
  });
});

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
const rec = (key: string, extra: Record<string, unknown> = {}) => ({ bytes: new Uint8Array([1, 2]).buffer, fileName: key + '.jpg', fileType: 'image/jpeg', idempotencyKey: key, fields: {}, queuedAt: 1, attempts: 0, lastError: null, ...extra });
const sync = () => loadSw(server.fetchImpl, idb).sync('agentbook-receipt-sync');

describe('sw.js failure classification (mirrors the page)', () => {
  it.each([[413, 'http413', 'file_too_large'], [400, 'http400', 'http_400']] as const)('%i is permanent: kept, never re-POSTed, still listed', async (_s, mode, reason) => {
    await seed(rec('k-perm'));
    server.setMode(mode);
    await sync();
    expect(server.calls).toHaveLength(1);
    const q = await import('@/lib/offline-queue');
    expect(await q.listQueue()).toEqual([expect.objectContaining({ attempts: 1, lastError: reason, permanent: true })]);
    server.setMode('ok');
    await sync();
    expect(server.calls).toHaveLength(1);
    expect(await q.listQueue()).toEqual([expect.objectContaining({ attempts: 1, lastError: reason, permanent: true })]);
    // the page honours the same flag
    await q.replayReceipts();
    expect(server.calls).toHaveLength(1);
  });

  it.each([['http408', 'http_408'], ['http409', 'http_409'], ['http429', 'http_429'], ['http500', 'http_500']] as const)('%s is transient: kept, not permanent, re-POSTed next pass', async (mode, reason) => {
    await seed(rec('k-tr'));
    server.setMode(mode);
    await sync();
    const q = await import('@/lib/offline-queue');
    expect(await q.listQueue()).toEqual([expect.objectContaining({ attempts: 1, lastError: reason, permanent: false })]);
    await sync();
    expect(server.calls).toHaveLength(2);
  });

  it('401 keeps the record (not permanent), stops the pass, and succeeds after sign-in', async () => {
    await seed(rec('k-a'));
    await seed(rec('k-b'));
    server.setMode('http401');
    await sync();
    expect(server.calls).toHaveLength(1);
    const q = await import('@/lib/offline-queue');
    expect(await q.listQueue()).toEqual([
      expect.objectContaining({ attempts: 1, lastError: 'unauthorized', permanent: false }),
      expect.objectContaining({ attempts: 0, lastError: null, permanent: false }),
    ]);
    server.setMode('ok');
    await sync();
    expect(server.byKey.size).toBe(2);
    expect(await q.pendingCount()).toBe(0);
  });
});

describe('sw.js queue owner (asks /auth/me once per pass)', () => {
  it('holds a record owned by someone else untouched, then replays for the owner', async () => {
    await seed(rec('k-own', { ownerId: 'user-A' }));
    server.setUser('user-B');
    await sync();
    expect(server.calls).toHaveLength(0);
    expect(await rawReceipts()).toEqual([expect.objectContaining({ ownerId: 'user-A', attempts: 0, lastError: null })]);
    server.setUser('user-A');
    await sync();
    expect(server.calls).toHaveLength(1);
    expect(await rawReceipts()).toEqual([]);
  });

  it('asks who is signed in once per pass, not once per record', async () => {
    await seed(rec('k-1', { ownerId: 'user-1' }));
    await seed(rec('k-2', { ownerId: 'user-1' }));
    await sync();
    expect(server.meCalls).toBe(1);
    expect(server.calls).toHaveLength(2);
  });

  it('does not call /auth/me when the queue is empty', async () => {
    await sync();
    expect(server.meCalls).toBe(0);
  });

  it('/auth/me 401 holds every record (owned and legacy) without rejecting', async () => {
    await seed(rec('k-own', { ownerId: 'user-A' }));
    await seed(rec('k-legacy'));
    server.setUser(null);
    await expect(sync()).resolves.toBeUndefined();
    expect(server.calls).toHaveLength(0);
    const raw = await rawReceipts();
    expect(raw).toHaveLength(2);
    expect(raw.every((r) => r.attempts === 0 && r.lastError === null)).toBe(true);
  });

  it('a network failure on /auth/me is offline: rejects so Background Sync retries', async () => {
    await seed(rec('k-own', { ownerId: 'user-A' }));
    server.setMode('throw');
    await expect(sync()).rejects.toThrow(/offline/);
    expect(await rawReceipts()).toHaveLength(1);
  });

  // Only a revoked/absent session (401/403) means "nobody is signed in". A server hiccup or a captive-portal page
  // is not a verdict: resolving there would make Background Sync give up until the next page load.
  it('a 5xx from /auth/me is "cannot tell": rejects so Background Sync retries, sends nothing, keeps the record', async () => {
    await seed(rec('k-own', { ownerId: 'user-1' }));
    server.setMeFailure('http503');
    await expect(sync()).rejects.toThrow(/offline/);
    expect(server.calls).toHaveLength(0);
    expect(await rawReceipts()).toEqual([expect.objectContaining({ attempts: 0, lastError: null })]);
  });

  it('a 200 non-JSON answer from /auth/me (captive portal) is "cannot tell": rejects, sends nothing', async () => {
    await seed(rec('k-own', { ownerId: 'user-1' }));
    server.setMeFailure('html200');
    await expect(sync()).rejects.toThrow(/offline/);
    expect(server.calls).toHaveLength(0);
    expect(await rawReceipts()).toHaveLength(1);
  });

  it('/auth/me 403 means nobody is signed in: holds without rejecting', async () => {
    await seed(rec('k-own', { ownerId: 'user-1' }));
    server.setMeFailure('http403');
    await expect(sync()).resolves.toBeUndefined();
    expect(server.calls).toHaveLength(0);
    expect(await rawReceipts()).toHaveLength(1);
  });

  it('replays a legacy unowned record under the signed-in user and stamps that owner', async () => {
    await seed({ file: new NodeBlob([new Uint8Array([7])], { type: 'image/jpeg' }), fileName: 'legacy.jpg', fileType: 'image/jpeg', queuedAt: 1 });
    server.setMode('http500');
    server.setUser('user-L');
    await sync();
    expect(server.calls).toHaveLength(1);
    expect(await rawReceipts()).toEqual([expect.objectContaining({ ownerId: 'user-L', lastError: 'http_500' })]);
  });

  it('page + worker AT ONCE on the same owned record still book exactly one expense', async () => {
    await seed(rec('k-race', { ownerId: 'user-1' }));
    const q = await import('@/lib/offline-queue');
    await Promise.all([sync(), q.replayReceipts()]);
    expect(new Set(server.calls.map((c) => c.key))).toEqual(new Set(['k-race']));
    expect(server.byKey.size).toBe(1);
    expect(await q.pendingCount()).toBe(0);
  });
});
