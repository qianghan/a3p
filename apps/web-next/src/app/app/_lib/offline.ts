'use client';

/**
 * Mobile-facing offline API (contract C4). Storage + replay live in
 * src/lib/offline-queue.ts (shared with the service worker's record shape).
 */
import { useCallback, useEffect, useState } from 'react';
import {
  queueReceipt, listQueue, discardQueueEntry, replayAll, initOfflineQueueReplay, newIdempotencyKey,
  QUEUE_CHANGED_EVENT, type QueueEntry, type ReceiptFields,
} from '@/lib/offline-queue';

export { newIdempotencyKey };
export type { QueueEntry };

export interface QueueReceiptFields extends ReceiptFields { idempotencyKey: string }

/** Queue a receipt for replay to /expenses/from-receipt with THIS key — the same key the online attempt used. */
export async function queueReceiptForReplay(file: Blob, fields: QueueReceiptFields): Promise<void> {
  const { idempotencyKey, ...rest } = fields;
  await queueReceipt(file, { fileName: (file as File).name || 'receipt.jpg', idempotencyKey, fields: rest });
}

/** True when a request never reached the server — whatever shape the client normalised it to. */
export function isOfflineError(e: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  if (e instanceof TypeError) return true;
  if (!e || typeof e !== 'object') return false;
  const x = e as { status?: number; code?: string; message?: string };
  if (x.code === 'offline' || x.code === 'network') return true;
  if (x.status === 0) return true;
  // The service worker's synthetic answer: 503 with body error 'Offline'.
  return x.status === 503 && /^offline$/i.test(String(x.message ?? '').trim());
}

/** The service worker drains the queue out-of-page (Background Sync), so poll while mounted. */
export const QUEUE_POLL_MS = 5000;

export function useOfflineQueue() {
  const [items, setItems] = useState<QueueEntry[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setItems(await listQueue());
    } catch {
      setItems([]); // IndexedDB unavailable (private mode) — nothing can be queued either
    }
  }, []);

  useEffect(() => {
    initOfflineQueueReplay();
    void refresh();
    const on = () => { void refresh(); };
    window.addEventListener(QUEUE_CHANGED_EVENT, on);
    window.addEventListener('online', on);
    const timer = window.setInterval(on, QUEUE_POLL_MS);
    return () => {
      window.removeEventListener(QUEUE_CHANGED_EVENT, on);
      window.removeEventListener('online', on);
      window.clearInterval(timer);
    };
  }, [refresh]);

  const retry = useCallback(async () => {
    setBusy(true);
    try {
      return await replayAll();
    } finally {
      setBusy(false);
      void refresh();
    }
  }, [refresh]);

  const discard = useCallback(async (store: 'receipt' | 'expense', id: number) => {
    await discardQueueEntry(store, id);
    await refresh();
  }, [refresh]);

  return { count: items.length, items, busy, retry, discard, refresh };
}
