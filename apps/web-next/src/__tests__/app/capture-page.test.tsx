/**
 * Mobile capture page.
 *
 * Regression history kept here:
 *  - #235: real phone photos hit the platform's 413 body limit; the response
 *    body is plain text and the old handler swallowed the JSON parse error —
 *    the user saw an empty form and a disabled Save with no explanation.
 *  - Offline receipts replayed to /receipts/scan and were orphaned (now
 *    queued for /expenses/from-receipt with the attempt's idempotency key).
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react';
import type { MobileDoc, FromReceiptResult } from '@/lib/mobile/types';
import { ToastHost } from '@/app/app/_kit';
import { RECENTS_KEY } from '@/app/app/_lib/category-recents';

vi.mock('@/hooks/use-t', async () => (await import('./mobile/_i18n-mock')).useTMock);
const api = vi.hoisted(() => ({ uploadReceipt: vi.fn(), patchDoc: vi.fn(), categorizeDoc: vi.fn(), deleteDoc: vi.fn(), listExpenseCategories: vi.fn() }));
vi.mock('@/app/app/_lib/api', async (orig) => ({ ...(await orig<object>()), ...api }));
const extra = vi.hoisted(() => ({ confirmDoc: vi.fn(), createExpense: vi.fn(), getTenantCurrency: vi.fn() }));
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
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch not expected in this test')));
});

describe('camera-first entry', () => {
  it('offers a camera input (capture=environment, images only) and a manual path', () => {
    renderPage();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toHaveAttribute('capture', 'environment');
    expect(input).toHaveAttribute('accept', 'image/*');
    expect(screen.getByRole('button', { name: /Snap a receipt/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enter without a photo' })).toBeInTheDocument();
  });
});

describe('online photo', () => {
  it('uploads with a per-attempt uuid key and prefills amount/vendor/date from OCR', async () => {
    api.uploadReceipt.mockResolvedValue(result());
    renderPage();
    await selectPhoto(makeFile());
    await waitFor(() => expect(screen.getByLabelText('Amount')).toHaveValue('42.50'));
    expect(screen.getByLabelText('Vendor')).toHaveValue('Test Cafe');
    expect(screen.getByLabelText('Date')).toHaveValue('2026-10-01');
    const [file, fields] = api.uploadReceipt.mock.calls[0];
    expect(file).toBeInstanceOf(File);
    expect(fields.idempotencyKey).toMatch(UUID);
    expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    expect(screen.queryByText(/couldn.t auto-read the receipt/i)).not.toBeInTheDocument();
  });

  it('shows the AI guess first, then recents; choosing it categorizes and confirms on Save', async () => {
    localStorage.setItem(RECENTS_KEY, JSON.stringify([{ id: 'c2', name: 'Travel' }]));
    api.uploadReceipt.mockResolvedValue(result({ suggestion: { categoryId: 'c9', categoryName: 'Meals', confidence: 0.8 } }));
    api.categorizeDoc.mockResolvedValue(doc({ categoryId: 'c9', categoryName: 'Meals', categorySource: 'ai' }));
    renderPage();
    await selectPhoto(makeFile());
    const group = await screen.findByRole('group', { name: 'Category' });
    const chips = within(group).getAllByRole('button');
    expect(chips[0]).toHaveTextContent('Meals');
    expect(within(group).getByText('AI guess')).toBeInTheDocument();
    expect(chips[1]).toHaveTextContent('Travel');
    fireEvent.click(chips[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await waitFor(() => expect(extra.confirmDoc).toHaveBeenCalledWith('d1'));
    expect(api.categorizeDoc).toHaveBeenCalledWith('d1', 'c9');
    expect(api.patchDoc).not.toHaveBeenCalled();
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(RECENTS_KEY)!)[0]).toEqual({ id: 'c9', name: 'Meals' });
  });

  it('patches only what the user edited, including personal', async () => {
    api.uploadReceipt.mockResolvedValue(result({ status: 'confirmed' }));
    api.patchDoc.mockResolvedValue(doc({ amountCents: 5000, isPersonal: true, status: 'confirmed' }));
    renderPage();
    await selectPhoto(makeFile());
    await waitFor(() => expect(screen.getByLabelText('Amount')).toHaveValue('42.50'));
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Personal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await waitFor(() => expect(api.patchDoc).toHaveBeenCalledWith('d1', { amountCents: 5000, isPersonal: true }));
    expect(extra.confirmDoc).not.toHaveBeenCalled();
  });

  it('never confirms an uncategorized pending_review expense (confirm would skip the journal)', async () => {
    api.uploadReceipt.mockResolvedValue(result());
    renderPage();
    await selectPhoto(makeFile());
    await waitFor(() => expect(screen.getByLabelText('Amount')).toHaveValue('42.50'));
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(extra.confirmDoc).not.toHaveBeenCalled();
  });

  it('Save & next returns to the camera-ready screen with focus on Snap', async () => {
    api.uploadReceipt.mockResolvedValue(result({ status: 'confirmed' }));
    renderPage();
    await selectPhoto(makeFile());
    await waitFor(() => expect(screen.getByLabelText('Amount')).toHaveValue('42.50'));
    fireEvent.click(screen.getByRole('button', { name: 'Save & next' }));
    const snap = await screen.findByRole('button', { name: /Snap a receipt/ });
    await waitFor(() => expect(snap).toHaveFocus());
  });

  it('Discard deletes the uploaded expense', async () => {
    api.uploadReceipt.mockResolvedValue(result());
    api.deleteDoc.mockResolvedValue({ id: 'd1' });
    renderPage();
    await selectPhoto(makeFile());
    await waitFor(() => expect(screen.getByLabelText('Amount')).toHaveValue('42.50'));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(api.deleteDoc).toHaveBeenCalledWith('d1'));
    expect(await screen.findByRole('button', { name: /Snap a receipt/ })).toBeInTheDocument();
  });

  it('a timed-out OCR ($0 pending_review) shows the review prompt and does not let a $0 be saved', async () => {
    api.uploadReceipt.mockResolvedValue(result({ amountCents: 0, vendorName: null }, { amountCents: null, vendor: null, date: null }));
    renderPage();
    await selectPhoto(makeFile());
    expect(await screen.findByText(/could not read an amount from this receipt/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Amount')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
    expect(api.patchDoc).not.toHaveBeenCalled();
  });
});

describe('upload failures are visible, never swallowed (#235)', () => {
  it('a platform 413 shows "too large" + manual-entry guidance; Save waits for an amount', async () => {
    api.uploadReceipt.mockRejectedValueOnce(err(413, 'Payload Too Large'));
    renderPage();
    await selectPhoto(makeFile());
    expect(await screen.findByText(/too large to upload/i)).toBeInTheDocument();
    expect(screen.getByText(/couldn.t auto-read the receipt/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Amount')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  });

  it('the client pre-flight code file_too_large gets the specific message, and the server message is never shown', async () => {
    api.uploadReceipt.mockRejectedValueOnce(err(413, 'SECRET-SERVER-TEXT', 'file_too_large'));
    renderPage();
    await selectPhoto(makeFile());
    expect(await screen.findByText(/too large to upload/i)).toBeInTheDocument();
    expect(screen.queryByText(/SECRET-SERVER-TEXT/)).not.toBeInTheDocument();
  });

  it('a well-formed error JSON (401/500) shows the guidance too, without the server message', async () => {
    api.uploadReceipt.mockRejectedValueOnce(err(401, 'Unauthorized-raw'));
    renderPage();
    await selectPhoto(makeFile());
    expect(await screen.findByText(/couldn.t auto-read the receipt/i)).toBeInTheDocument();
    expect(screen.queryByText(/Unauthorized-raw/)).not.toBeInTheDocument();
  });

  it('after a failed read, Save re-sends the SAME key with the typed fields', async () => {
    api.uploadReceipt.mockRejectedValueOnce(err(500, 'boom')).mockResolvedValueOnce(result({ status: 'confirmed' }));
    renderPage();
    await selectPhoto(makeFile());
    await screen.findByText(/couldn.t auto-read the receipt/i);
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '12' } });
    fireEvent.change(screen.getByLabelText('Vendor'), { target: { value: 'Kiosk' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await waitFor(() => expect(api.uploadReceipt).toHaveBeenCalledTimes(2));
    const [, first] = api.uploadReceipt.mock.calls[0];
    const [, second] = api.uploadReceipt.mock.calls[1];
    expect(second).toMatchObject({ idempotencyKey: first.idempotencyKey, amountCents: 1200, vendor: 'Kiosk', isPersonal: false });
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('a duplicate on retry (the first upload did land) applies the typed fields with a PATCH', async () => {
    api.uploadReceipt.mockRejectedValueOnce(err(500)).mockResolvedValueOnce({ ...result({ status: 'confirmed', amountCents: 4250 }), duplicate: true });
    api.patchDoc.mockResolvedValue(doc({ amountCents: 1200, status: 'confirmed' }));
    renderPage();
    await selectPhoto(makeFile());
    await screen.findByText(/couldn.t auto-read the receipt/i);
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await waitFor(() => expect(api.patchDoc).toHaveBeenCalledWith('d1', expect.objectContaining({ amountCents: 1200 })));
  });

  it('a retry that finds the expense was deleted says so and never claims it was saved', async () => {
    api.uploadReceipt.mockRejectedValueOnce(err(500)).mockResolvedValueOnce({ ...result({ status: 'confirmed' }), duplicate: true, deleted: true });
    renderPage();
    await selectPhoto(makeFile());
    await screen.findByText(/couldn.t auto-read the receipt/i);
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    expect(await screen.findByText(/This receipt was deleted/)).toBeInTheDocument();
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
    expect(api.patchDoc).not.toHaveBeenCalled();
    expect(extra.confirmDoc).not.toHaveBeenCalled();
  });

  it('a 413 while saving the retry shows the specific too-large message', async () => {
    api.uploadReceipt.mockRejectedValueOnce(err(500)).mockRejectedValueOnce(err(413, 'raw', 'file_too_large'));
    renderPage();
    await selectPhoto(makeFile());
    await screen.findByText(/couldn.t auto-read the receipt/i);
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await waitFor(() => expect(api.uploadReceipt).toHaveBeenCalledTimes(2));
    expect((await screen.findAllByText(/too large to upload/i)).length).toBeGreaterThan(0);
  });

  it('rejects an invalid amount before any request', async () => {
    api.uploadReceipt.mockRejectedValueOnce(err(500));
    renderPage();
    await selectPhoto(makeFile());
    await screen.findByText(/couldn.t auto-read the receipt/i);
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    expect(await screen.findByText('Enter an amount like 12.50')).toBeInTheDocument();
    expect(api.uploadReceipt).toHaveBeenCalledTimes(1);
  });
});

describe('offline', () => {
  it('offline at photo time: no upload, offline notice, Save queues for from-receipt with the attempt key and shows the pill', async () => {
    setOnline(false);
    renderPage();
    await selectPhoto(makeFile());
    expect(api.uploadReceipt).not.toHaveBeenCalled();
    expect(await screen.findByText(/You're offline/)).toBeInTheDocument();
    expect(screen.queryByText(/couldn.t auto-read the receipt/i)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '18.40' } });
    fireEvent.change(screen.getByLabelText('Vendor'), { target: { value: 'Corner Store' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    expect(await screen.findByText(/Saved offline/)).toBeInTheDocument();
    const q = await import('@/lib/offline-queue');
    expect(await q.listQueue()).toEqual([expect.objectContaining({ store: 'receipt', label: 'Corner Store', amountCents: 1840 })]);
    expect(await screen.findByTestId('queue-pill')).toHaveTextContent('Queued · 1 waiting');
  });

  it('the service worker reporting offline mid-upload switches to offline mode without an error', async () => {
    api.uploadReceipt.mockRejectedValue(Object.assign(new Error('Offline'), { status: 503 }));
    renderPage();
    await selectPhoto(makeFile());
    expect(await screen.findByText(/You're offline/)).toBeInTheDocument();
    expect(screen.queryByText(/couldn.t auto-read the receipt/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Amount')).toHaveValue('');
  });
});

describe('manual entry', () => {
  it('creates an expense with the tenant currency and an idempotency key', async () => {
    extra.createExpense.mockResolvedValue({ id: 'm1' });
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Enter without a photo' }));
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '7.25' } });
    fireEvent.change(screen.getByLabelText('Vendor'), { target: { value: 'Parking' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await waitFor(() => expect(extra.createExpense).toHaveBeenCalled());
    const [body, key] = extra.createExpense.mock.calls[0];
    expect(body).toMatchObject({ amountCents: 725, vendor: 'Parking', isPersonal: false, currency: 'CAD' });
    expect(key).toMatch(UUID);
  });

  it('offline manual entry goes to the (unchanged) expense queue', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Enter without a photo' }));
    setOnline(false);
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    expect(await screen.findByText(/Saved offline/)).toBeInTheDocument();
    expect(extra.createExpense).not.toHaveBeenCalled();
    const q = await import('@/lib/offline-queue');
    expect(await q.listQueue()).toEqual([expect.objectContaining({ store: 'expense', amountCents: 300 })]);
  });
});
