/**
 * PR 3d.2 — Capture "Pay later": manual entry can be saved as a bill due on
 * a chosen date (POST /bills through _lib/api createBill, with the attempt key);
 * offline it is queued for /bills with the SAME key; never an expense.
 */import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react';
import type { MobileDoc, FromReceiptResult } from '@/lib/mobile/types';
import { ToastHost } from '@/app/app/_kit';
import { RECENTS_KEY } from '@/app/app/_lib/category-recents';

vi.mock('@/hooks/use-t', async () => (await import('./mobile/_i18n-mock')).useTMock);
const api = vi.hoisted(() => ({ uploadReceipt: vi.fn(), patchDoc: vi.fn(), categorizeDoc: vi.fn(), deleteDoc: vi.fn(), listExpenseCategories: vi.fn(), createBill: vi.fn() }));
vi.mock('@/app/app/_lib/api', async (orig) => ({ ...(await orig<object>()), ...api }));
const extra = vi.hoisted(() => ({ confirmDoc: vi.fn(), createExpense: vi.fn(), getTenantCurrency: vi.fn(), suggestCategoryFor: vi.fn() }));
vi.mock('@/app/app/_lib/api-extra', async (orig) => ({ ...(await orig<object>()), ...extra }));

import MobileCapture from '../../app/app/capture/page';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const setOnline = (v: boolean) => Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => v });
const makeFile = (name = 'receipt.jpg', type = 'image/jpeg') => new File(['fake-image-bytes'], name, { type });
const doc = (o: Partial<MobileDoc> = {}): MobileDoc => ({
  id: 'd1', date: '2026-10-01', amountCents: 4250, vendorName: 'Test Cafe', description: null,
  categoryId: null, categoryName: null, categorySource: null, confidence: null, status: 'pending_review',
  isPersonal: false, receiptUrl: 'https://a.public.blob.vercel-storage.com/r/1.jpg', receiptStatus: 'attached', archivedAt: null, suggestion: null, ...o,
} as MobileDoc);
const result = (o: Partial<MobileDoc> = {}, ocr: Partial<FromReceiptResult['ocr']> = {}): FromReceiptResult => ({
  doc: doc(o), duplicate: false, ocr: { amountCents: 4250, vendor: 'Test Cafe', date: '2026-10-01', ...ocr },
});
const err = (status: number, message = 'x', code?: string) => Object.assign(new Error(message), { status, code });

async function selectPhoto(file: File) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => { fireEvent.change(input); });
}
const renderPage = () => render(<ToastHost><MobileCapture /></ToastHost>);

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  setOnline(true);
  Object.values(api).forEach((f) => f.mockReset());
  Object.values(extra).forEach((f) => f.mockReset());
  extra.getTenantCurrency.mockResolvedValue('CAD');
  extra.confirmDoc.mockResolvedValue(undefined);
  extra.suggestCategoryFor.mockResolvedValue(null);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch not expected in this test')));
});

const startManual = () => fireEvent.click(screen.getByRole('button', { name: 'Enter without a photo' }));
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('Capture "Pay later"', () => {
  it('the switch is off by default and reveals a due date defaulting to 14 days after the bill date', () => {
    renderPage();
    startManual();
    const sw = screen.getByRole('switch', { name: 'Pay later' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByLabelText('Due date')).not.toBeInTheDocument();
    fireEvent.click(sw);
    expect(sw).toHaveAttribute('aria-checked', 'true');
    const today = (screen.getByLabelText('Date') as HTMLInputElement).value;
    const want = new Date(new Date(`${today}T12:00:00Z`).getTime() + 14 * 86_400_000).toISOString().slice(0, 10);
    expect(screen.getByLabelText('Due date')).toHaveValue(want);
  });

  it('online: creates a bill (not an expense) with vendor, amount, dates, currency and the attempt key', async () => {
    api.createBill.mockResolvedValue({ id: 'bill-1' });
    renderPage();
    startManual();
    type('Amount', '84.50');
    type('Vendor', 'Hydro One');
    type('Date', '2026-11-20');
    fireEvent.click(screen.getByRole('switch', { name: 'Pay later' }));
    type('Due date', '2026-12-15');
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await waitFor(() => expect(api.createBill).toHaveBeenCalled());
    const [body, key] = api.createBill.mock.calls[0];
    expect(body).toEqual({ vendorName: 'Hydro One', amountCents: 8450, dueDate: '2026-12-15', billDate: '2026-11-20', currency: 'CAD' });
    expect(key).toMatch(UUID);
    expect(extra.createExpense).not.toHaveBeenCalled();
    expect(await screen.findByText('Bill saved')).toBeInTheDocument();
  });

  it('offline: queued for /bills with the same key; no request, no expense', async () => {
    setOnline(false);
    renderPage();
    startManual();
    type('Amount', '120');
    type('Vendor', 'Bell');
    fireEvent.click(screen.getByRole('switch', { name: 'Pay later' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    expect(await screen.findByText(/Saved offline/)).toBeInTheDocument();
    expect([api.createBill.mock.calls.length, extra.createExpense.mock.calls.length]).toEqual([0, 0]);
    const q = await import('@/lib/offline-queue');
    expect(await q.listQueue()).toEqual([expect.objectContaining({ store: 'expense', label: 'Bell', amountCents: 12000 })]);
  });

  it('a lost response mid-save (network) queues with the key the online attempt used', async () => {
    api.createBill.mockRejectedValue(new TypeError('Failed to fetch'));
    const q = await import('@/lib/offline-queue');
    const spy = vi.spyOn(q, 'queueBill');
    renderPage();
    startManual();
    type('Amount', '50');
    type('Vendor', 'Rogers');
    fireEvent.click(screen.getByRole('switch', { name: 'Pay later' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    expect(await screen.findByText(/Saved offline/)).toBeInTheDocument();
    expect(spy.mock.calls[0][1]).toBe(api.createBill.mock.calls[0][1]);
  });

  it('needs a vendor and a due date on/after the bill date — no request', async () => {
    renderPage();
    startManual();
    type('Amount', '50');
    fireEvent.click(screen.getByRole('switch', { name: 'Pay later' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    expect(await screen.findByText('Add the vendor to save a bill.')).toBeInTheDocument();
    type('Vendor', 'Rogers');
    type('Date', '2026-11-20');
    type('Due date', '2026-11-01');
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    expect(await screen.findByText('Choose a due date on or after the bill date.')).toBeInTheDocument();
    expect(api.createBill).not.toHaveBeenCalled();
  });

  it('personal entries never offer Pay later', () => {
    renderPage();
    startManual();
    fireEvent.click(screen.getByRole('radio', { name: 'Personal' }));
    expect(screen.queryByRole('switch', { name: 'Pay later' })).not.toBeInTheDocument();
  });

  it('a closed period shows the period message, nothing queued', async () => {
    api.createBill.mockRejectedValue(err(422, 'closed', 'period_closed'));
    renderPage();
    startManual();
    type('Amount', '50');
    type('Vendor', 'Rogers');
    fireEvent.click(screen.getByRole('switch', { name: 'Pay later' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    expect(await screen.findByTestId('capture-error')).toBeInTheDocument();
    const q = await import('@/lib/offline-queue');
    expect(await q.listQueue()).toEqual([]);
  });
});
