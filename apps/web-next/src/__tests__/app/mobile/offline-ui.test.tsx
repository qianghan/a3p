import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { ToastHost } from '@/app/app/_kit';
import { fakeServer } from '../../lib/_fake-receipt-server';
import { isOfflineError, queueReceiptForReplay } from '@/app/app/_lib/offline';
import * as q from '@/lib/offline-queue';
import { QueuePill } from '@/app/app/capture/_components/QueuePill';

vi.mock('@/hooks/use-t', async () => (await import('./_i18n-mock')).useTMock);
const setOnline = (v: boolean) => Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => v });

// No vi.resetModules() here: QueuePill and ToastHost must share ONE kit module
// instance, or useToast() reads a different context than the host provides.
// offline-queue opens IndexedDB per call, so a fresh factory per test is enough.
let server: ReturnType<typeof fakeServer>;
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  setOnline(false);
  server = fakeServer();
  vi.stubGlobal('fetch', server.fetchImpl);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('isOfflineError', () => {
  it.each([
    ['fetch TypeError', new TypeError('Failed to fetch'), true],
    ['status 0', Object.assign(new Error('x'), { status: 0 }), true],
    ['code offline', Object.assign(new Error('x'), { status: 503, code: 'offline' }), true],
    ['code network', Object.assign(new Error('x'), { code: 'network' }), true],
    ['SW synthetic 503', Object.assign(new Error('Offline'), { status: 503 }), true],
    ['real 503', Object.assign(new Error('Service Unavailable'), { status: 503 }), false],
    ['413', Object.assign(new Error('Payload Too Large'), { status: 413 }), false],
    ['401', Object.assign(new Error('Unauthorized'), { status: 401 }), false],
    ['null', null, false],
  ])('%s → %s', async (_n, err, want) => {
    setOnline(true);
    expect(isOfflineError(err)).toBe(want);
  });
  it('treats anything as offline when the device says so', async () => {
    setOnline(false);
    expect(isOfflineError(Object.assign(new Error('x'), { status: 500 }))).toBe(true);
  });
});

describe('queueReceiptForReplay', () => {
  it('queues the file with the key and fields', async () => {
    await queueReceiptForReplay(new File([new Uint8Array([1])], 'snap.jpg', { type: 'image/jpeg' }), { idempotencyKey: 'k-1', amountCents: 2500, vendor: 'Cafe', isPersonal: false });
    expect(await q.listQueue()).toEqual([expect.objectContaining({ store: 'receipt', label: 'Cafe', amountCents: 2500 })]);
    setOnline(true);
    await q.replayReceipts();
    expect(server.calls[0]).toMatchObject({ key: 'k-1', fileName: 'snap.jpg', fields: { amountCents: '2500', vendor: 'Cafe', isPersonal: 'false' } });
  });
});

describe('<QueuePill>', () => {
  async function renderPill() {
    return render(<ToastHost><QueuePill currency="CAD" /></ToastHost>);
  }

  it('renders nothing when the queue is empty', async () => {
    await renderPill();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('queue-pill')).toBeNull();
  });

  it('shows "Queued · N waiting", lists entries, and discards one', async () => {
    await queueReceiptForReplay(new File([new Uint8Array([1])], 'a.jpg', { type: 'image/jpeg' }), { idempotencyKey: 'k-a', vendor: 'Alpha', amountCents: 1000 });
    await queueReceiptForReplay(new File([new Uint8Array([1])], 'b.jpg', { type: 'image/jpeg' }), { idempotencyKey: 'k-b', vendor: 'Beta', amountCents: 2000 });
    await renderPill();
    const pill = await screen.findByTestId('queue-pill');
    expect(pill).toHaveTextContent('Queued · 2 waiting');
    fireEvent.click(pill);
    const sheet = await screen.findByRole('dialog', { name: 'Waiting to sync' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Discard Alpha' }));
    await waitFor(() => expect(screen.getByTestId('queue-pill')).toHaveTextContent('Queued · 1 waiting'));
  });

  it('Retry now replays and reports the outcome; the pill disappears when drained', async () => {
    await queueReceiptForReplay(new File([new Uint8Array([1])], 'a.jpg', { type: 'image/jpeg' }), { idempotencyKey: 'k-r', vendor: 'Alpha' });
    await renderPill();
    fireEvent.click(await screen.findByTestId('queue-pill'));
    setOnline(true);
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Waiting to sync' })).getByRole('button', { name: 'Retry now' }));
    expect(await screen.findByText('Sync attempted: 1 sent · 0 waiting')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('queue-pill')).toBeNull());
    expect(server.byKey.size).toBe(1);
  });

  it('shows why an entry is stuck', async () => {
    await queueReceiptForReplay(new File([new Uint8Array([1])], 'a.jpg', { type: 'image/jpeg' }), { idempotencyKey: 'k-s', vendor: 'Alpha' });
    setOnline(true);
    server.setMode('http401');
    await q.replayReceipts();
    setOnline(false);
    await renderPill();
    fireEvent.click(await screen.findByTestId('queue-pill'));
    expect(await screen.findByText('Last attempt failed (401)')).toBeInTheDocument();
  });
});
