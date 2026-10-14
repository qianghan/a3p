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
  server = fakeServer();
  vi.stubGlobal('fetch', server.fetchImpl);
});
afterEach(() => { vi.unstubAllGlobals(); });

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
    expect((await q.listQueue())[0]).toMatchObject({ attempts: 1, lastError: 'http_401' });
  });

  it('treats the service worker synthetic offline 503 as offline: rejects, keeps the record, records no error', async () => {
    await seed({ bytes: new Uint8Array([1]).buffer, fileName: 's.jpg', fileType: 'image/jpeg', idempotencyKey: 'k-s', fields: {}, queuedAt: 1, attempts: 0, lastError: null });
    server.setMode('sw-offline');
    await expect(loadSw(server.fetchImpl, idb).sync('agentbook-receipt-sync')).rejects.toThrow(/offline/);
    const q = await import('@/lib/offline-queue');
    expect((await q.listQueue())[0]).toMatchObject({ attempts: 0, lastError: null });
  });
});
