'use client';

/**
 * Offline queue for the mobile PWA's capture flow: if "record expense" or
 * "save receipt" fails because the device has no connection, the write goes
 * into IndexedDB instead of being lost, and gets replayed once connectivity
 * returns.
 *
 * Two replay paths, because the Background Sync API isn't supported on iOS
 * Safari at all. Where it exists we register a sync tag and let the service
 * worker (public/sw.js) replay; everywhere we also replay on the `online`
 * event and on app load. Both paths can run for the same receipt — that is
 * safe ONLY because every receipt carries an idempotency key the server
 * dedupes on (POST /expenses/from-receipt: same key → same expense).
 *
 * History: receipts used to replay to /receipts/scan, which stores + OCRs a
 * photo but never creates an expense — every offline capture was silently
 * orphaned. The record shape and replay below are mirrored in sw.js; the
 * field names are pinned by __tests__/architecture/service-worker-replay.test.ts.
 */

const DB_NAME = 'agentbook-offline';
const DB_VERSION = 1;
const EXPENSE_STORE = 'expense-queue';
const RECEIPT_STORE = 'receipt-queue';

export const FROM_RECEIPT_PATH = '/api/v1/agentbook-expense/expenses/from-receipt';
export const QUEUE_CHANGED_EVENT = 'agentbook:offline-queue-changed';
export const SYNC_READY_TIMEOUT_MS = 1500;

export interface ReceiptFields { amountCents?: number; vendor?: string; date?: string; categoryId?: string; isPersonal?: boolean }

interface ReceiptRecord {
  id?: number;
  /** v2: raw bytes — ArrayBuffers clone into IndexedDB reliably everywhere. */
  bytes?: ArrayBuffer;
  /** v1 (legacy): the Blob the old capture page stored. */
  file?: Blob;
  fileName: string;
  fileType: string;
  /** Absent on v1 records — minted and persisted at first replay (ensureReceiptKey). */
  idempotencyKey?: string;
  fields?: ReceiptFields;
  queuedAt: number;
  attempts?: number;
  lastError?: string | null;
}
interface ExpenseRecord { id?: number; payload: Record<string, unknown>; queuedAt: number }

export interface QueueEntry { store: 'receipt' | 'expense'; id: number; label: string | null; amountCents: number | null; queuedAt: number; attempts: number; lastError: string | null }
export interface ReplaySummary { sent: number; failed: number; remaining: number }

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(EXPENSE_STORE)) db.createObjectStore(EXPENSE_STORE, { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains(RECEIPT_STORE)) db.createObjectStore(RECEIPT_STORE, { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDb();
  return new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = run(tx.objectStore(store));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function notifyQueueChanged(): void {
  try {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(QUEUE_CHANGED_EVENT));
  } catch { /* non-DOM context */ }
}

export function newIdempotencyKey(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  const b = blob as Blob & { arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof b.arrayBuffer === 'function') return b.arrayBuffer();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as ArrayBuffer);
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(blob);
  });
}

/** Field names MUST match sw.js buildReceiptForm and the from-receipt route (C3). */
export function buildFromReceiptForm(blob: Blob, fileName: string, idempotencyKey: string, fields: ReceiptFields = {}): FormData {
  const form = new FormData();
  form.append('file', blob, fileName || 'receipt.jpg');
  form.append('idempotencyKey', idempotencyKey);
  if (fields.amountCents != null) form.append('amountCents', String(fields.amountCents));
  if (fields.vendor) form.append('vendor', fields.vendor);
  if (fields.date) form.append('date', fields.date);
  if (fields.categoryId) form.append('categoryId', fields.categoryId);
  if (fields.isPersonal != null) form.append('isPersonal', String(fields.isPersonal));
  return form;
}

async function registerSync(tag: string): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false;
    // `ready` never settles when no worker is registered — awaiting it bare
    // hung every queue call with the capture UI stuck mid-save.
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SYNC_READY_TIMEOUT_MS)),
    ]);
    const syncable = reg as (ServiceWorkerRegistration & { sync?: { register: (t: string) => Promise<void> } }) | null;
    if (!syncable?.sync) return false;
    await syncable.sync.register(tag);
    return true;
  } catch {
    return false;
  }
}

/** Queue a failed manual expense write. Behaviour unchanged (no idempotency key on this path). */
export async function queueExpense(payload: Record<string, unknown>): Promise<void> {
  await withStore(EXPENSE_STORE, 'readwrite', (s) => s.add({ payload, queuedAt: Date.now() } as ExpenseRecord));
  notifyQueueChanged();
  const synced = await registerSync('agentbook-expense-sync');
  if (!synced) attachFallbackReplay();
}

/** Queue a receipt for replay to from-receipt. Returns the queue entry id. */
export async function queueReceipt(
  file: Blob,
  opts: { fileName?: string; idempotencyKey?: string; fields?: ReceiptFields } = {},
): Promise<number> {
  const record: ReceiptRecord = {
    bytes: await blobToArrayBuffer(file),
    fileName: opts.fileName || (file as File).name || 'receipt.jpg',
    fileType: file.type || 'image/jpeg',
    idempotencyKey: opts.idempotencyKey || newIdempotencyKey(),
    fields: opts.fields ?? {},
    queuedAt: Date.now(),
    attempts: 0,
    lastError: null,
  };
  const id = (await withStore<IDBValidKey>(RECEIPT_STORE, 'readwrite', (s) => s.add(record))) as number;
  notifyQueueChanged();
  const synced = await registerSync('agentbook-receipt-sync');
  if (!synced) attachFallbackReplay();
  return id;
}

async function countPending(store: string): Promise<number> {
  return (await withStore<number>(store, 'readonly', (s) => s.count())) ?? 0;
}

/** Total queued items across both stores — for the "Queued · N waiting" pill. */
export async function pendingCount(): Promise<number> {
  const [e, r] = await Promise.all([countPending(EXPENSE_STORE), countPending(RECEIPT_STORE)]);
  return e + r;
}

export async function listQueue(): Promise<QueueEntry[]> {
  const [receipts, expenses] = await Promise.all([
    withStore<ReceiptRecord[]>(RECEIPT_STORE, 'readonly', (s) => s.getAll()),
    withStore<ExpenseRecord[]>(EXPENSE_STORE, 'readonly', (s) => s.getAll()),
  ]);
  const r: QueueEntry[] = (receipts ?? []).map((x) => ({
    store: 'receipt', id: x.id as number, label: x.fields?.vendor ?? null, amountCents: x.fields?.amountCents ?? null,
    queuedAt: x.queuedAt, attempts: x.attempts ?? 0, lastError: x.lastError ?? null,
  }));
  const e: QueueEntry[] = (expenses ?? []).map((x) => ({
    store: 'expense', id: x.id as number,
    label: typeof x.payload.vendor === 'string' ? x.payload.vendor : null,
    amountCents: typeof x.payload.amountCents === 'number' ? x.payload.amountCents : null,
    queuedAt: x.queuedAt, attempts: 0, lastError: null,
  }));
  return [...r, ...e].sort((a, b) => a.queuedAt - b.queuedAt);
}

export async function discardQueueEntry(store: 'receipt' | 'expense', id: number): Promise<void> {
  await withStore(store === 'receipt' ? RECEIPT_STORE : EXPENSE_STORE, 'readwrite', (s) => { s.delete(id); });
  notifyQueueChanged();
}

async function replayExpenses(): Promise<{ sent: number }> {
  const items = (await withStore<ExpenseRecord[]>(EXPENSE_STORE, 'readonly', (s) => s.getAll())) ?? [];
  let sent = 0;
  for (const item of items) {
    try {
      const res = await fetch('/api/v1/agentbook-expense/expenses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(item.payload),
      });
      if (!res.ok) continue; // leave queued — a real server rejection needs user input, not a silent drop
      await withStore(EXPENSE_STORE, 'readwrite', (s) => { s.delete(item.id as number); });
      sent += 1;
    } catch {
      break; // still offline — stop and wait for the next trigger
    }
  }
  if (sent) notifyQueueChanged();
  return { sent };
}

/**
 * Mint + persist a key for a legacy record inside ONE readwrite transaction.
 * IndexedDB serialises readwrite transactions on a store across connections,
 * so the page and the service worker replaying at the same instant cannot mint
 * two different keys for one photo. Returns null if the record is gone.
 */
async function ensureReceiptKey(id: number): Promise<string | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(RECEIPT_STORE, 'readwrite');
    const store = tx.objectStore(RECEIPT_STORE);
    let key: string | null = null;
    const req = store.get(id);
    req.onsuccess = () => {
      const rec = req.result as ReceiptRecord | undefined;
      if (!rec) return;
      if (!rec.idempotencyKey) {
        rec.idempotencyKey = newIdempotencyKey();
        store.put(rec);
      }
      key = rec.idempotencyKey;
    };
    tx.oncomplete = () => resolve(key);
    tx.onerror = () => reject(tx.error);
  });
}

async function markFailed(item: ReceiptRecord, key: string, reason: string): Promise<void> {
  await withStore(RECEIPT_STORE, 'readwrite', (s) => {
    s.put({ ...item, idempotencyKey: key, attempts: (item.attempts ?? 0) + 1, lastError: reason });
  });
}

async function doReplayReceipts(): Promise<ReplaySummary> {
  const items = (await withStore<ReceiptRecord[]>(RECEIPT_STORE, 'readonly', (s) => s.getAll())) ?? [];
  let sent = 0;
  let failed = 0;
  for (const item of items) {
    const key = await ensureReceiptKey(item.id as number);
    if (!key) continue; // drained by the service worker meanwhile
    let blob: Blob;
    try {
      const type = item.fileType || item.file?.type || 'image/jpeg';
      blob = new Blob([item.bytes ?? (await blobToArrayBuffer(item.file as Blob))], { type });
    } catch {
      failed += 1;
      await markFailed(item, key, 'unreadable');
      continue;
    }
    let res: Response;
    try {
      res = await fetch(FROM_RECEIPT_PATH, {
        method: 'POST',
        credentials: 'include',
        body: buildFromReceiptForm(blob, item.fileName, key, item.fields),
      });
    } catch {
      break; // still offline
    }
    if (res.headers?.get?.('X-Agentbook-Offline') === '1') break; // the service worker answered for the network
    if (res.ok) {
      await withStore(RECEIPT_STORE, 'readwrite', (s) => { s.delete(item.id as number); });
      sent += 1;
      continue;
    }
    // A considered server answer (auth expired, validation) needs the user — keep it and say why.
    failed += 1;
    await markFailed(item, key, `http_${res.status}`);
  }
  const remaining = await countPending(RECEIPT_STORE);
  notifyQueueChanged();
  return { sent, failed, remaining };
}

let receiptReplay: Promise<ReplaySummary> | null = null;

/** Single-flight: overlapping triggers (online event + app load + Retry tap) share one pass. */
export function replayReceipts(): Promise<ReplaySummary> {
  if (!receiptReplay) receiptReplay = doReplayReceipts().finally(() => { receiptReplay = null; });
  return receiptReplay;
}

export async function replayAll(): Promise<{ sent: number; remaining: number }> {
  const e = await replayExpenses();
  const r = await replayReceipts();
  return { sent: e.sent + r.sent, remaining: await pendingCount() };
}

let fallbackAttached = false;

/** Browsers without Background Sync (iOS Safari): retry on `online` and once now. */
function attachFallbackReplay(): void {
  if (fallbackAttached || typeof window === 'undefined') return;
  fallbackAttached = true;
  const run = () => { void replayAll().catch(() => { /* next trigger retries */ }); };
  window.addEventListener('online', run);
  if (navigator.onLine) run();
}

/** Call once on app mount so a queue left over from a previous offline session gets a chance to drain. */
export function initOfflineQueueReplay(): void {
  attachFallbackReplay();
}
