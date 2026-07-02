'use client';

/**
 * Offline queue for the mobile PWA's capture flow: if "record expense" or
 * "scan receipt" fails because the device has no connection, the write goes
 * into IndexedDB instead of being lost, and gets replayed once connectivity
 * returns.
 *
 * Two replay paths, because the Background Sync API (the "right" mechanism
 * for this — retry survives even if the tab is closed) isn't supported on
 * iOS Safari at all. Where it exists we register a sync tag and let the
 * service worker handle replay; everywhere else we fall back to replaying
 * on the `online` event and on next app load, which only fires while a tab
 * is open but still covers the common case (retry when you get signal back
 * while still in the app).
 */

const DB_NAME = 'agentbook-offline';
const DB_VERSION = 1;
const EXPENSE_STORE = 'expense-queue';
const RECEIPT_STORE = 'receipt-queue';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(EXPENSE_STORE)) {
        db.createObjectStore(EXPENSE_STORE, { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(RECEIPT_STORE)) {
        db.createObjectStore(RECEIPT_STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function registerSync(tag: string): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return false;
  const reg = await navigator.serviceWorker.ready;
  const syncCapableReg = reg as ServiceWorkerRegistration & { sync?: { register: (tag: string) => Promise<void> } };
  if (!syncCapableReg.sync) return false;
  try {
    await syncCapableReg.sync.register(tag);
    return true;
  } catch {
    return false;
  }
}

/** Queue a failed expense write. Returns once it's durably stored. */
export async function queueExpense(payload: Record<string, unknown>): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(EXPENSE_STORE, 'readwrite');
    tx.objectStore(EXPENSE_STORE).add({ payload, queuedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  const synced = await registerSync('agentbook-expense-sync');
  if (!synced) attachFallbackReplay();
}

/** Queue a failed receipt upload (kept as a Blob — IndexedDB stores these natively). */
export async function queueReceipt(file: File): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(RECEIPT_STORE, 'readwrite');
    tx.objectStore(RECEIPT_STORE).add({ file, fileName: file.name, fileType: file.type, queuedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  const synced = await registerSync('agentbook-receipt-sync');
  if (!synced) attachFallbackReplay();
}

async function countPending(store: string): Promise<number> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Total queued items across both stores — for surfacing a "N pending" indicator. */
export async function pendingCount(): Promise<number> {
  const [expenses, receipts] = await Promise.all([countPending(EXPENSE_STORE), countPending(RECEIPT_STORE)]);
  return expenses + receipts;
}

async function replayExpenses(): Promise<void> {
  const db = await openDb();
  const items: Array<{ id: number; payload: Record<string, unknown> }> = await new Promise((resolve, reject) => {
    const req = db.transaction(EXPENSE_STORE, 'readonly').objectStore(EXPENSE_STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  for (const item of items) {
    try {
      const res = await fetch('/api/v1/agentbook-expense/expenses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(item.payload),
      });
      if (!res.ok) continue; // leave queued — a real server rejection needs user input, not a silent drop
      const tx = db.transaction(EXPENSE_STORE, 'readwrite');
      tx.objectStore(EXPENSE_STORE).delete(item.id);
    } catch {
      break; // still offline — stop and wait for the next trigger
    }
  }
}

async function replayReceipts(): Promise<void> {
  const db = await openDb();
  const items: Array<{ id: number; file: Blob; fileName: string; fileType: string }> = await new Promise((resolve, reject) => {
    const req = db.transaction(RECEIPT_STORE, 'readonly').objectStore(RECEIPT_STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  for (const item of items) {
    try {
      const form = new FormData();
      form.append('file', item.file, item.fileName);
      const res = await fetch('/api/v1/agentbook-expense/receipts/scan', { method: 'POST', body: form });
      if (!res.ok) continue;
      const tx = db.transaction(RECEIPT_STORE, 'readwrite');
      tx.objectStore(RECEIPT_STORE).delete(item.id);
    } catch {
      break;
    }
  }
}

let fallbackAttached = false;

/** Browsers without Background Sync (iOS Safari): retry on `online` and once now. */
function attachFallbackReplay(): void {
  if (fallbackAttached || typeof window === 'undefined') return;
  fallbackAttached = true;
  const replayAll = () => { void replayExpenses(); void replayReceipts(); };
  window.addEventListener('online', replayAll);
  if (navigator.onLine) replayAll();
}

/** Call once on app mount so a queue left over from a previous offline session
 * (e.g. the tab was closed before connectivity returned) gets a chance to drain. */
export function initOfflineQueueReplay(): void {
  attachFallbackReplay();
}
