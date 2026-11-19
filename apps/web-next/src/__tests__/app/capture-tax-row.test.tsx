/**
 * PR 2b.8 — the tax row on mobile capture review. The visibility RULES live
 * server-side (lib/expense-tax-row, tested there); this proves the screen
 * renders what the view says and saves the engine's gross.
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import type { TaxRow } from '@/app/app/_lib/api';
import { ToastHost } from '@/app/app/_kit';
import { buildTaxRowView } from '@/lib/expense-tax-row';

vi.mock('server-only', () => ({}));
vi.mock('@/hooks/use-t', async () => (await import('./mobile/_i18n-mock')).useTMock);
const api = vi.hoisted(() => ({ uploadReceipt: vi.fn(), patchDoc: vi.fn(), categorizeDoc: vi.fn(), deleteDoc: vi.fn(), listExpenseCategories: vi.fn(), getTaxRow: vi.fn() }));
vi.mock('@/app/app/_lib/api', async (orig) => ({ ...(await orig<object>()), ...api }));
const extra = vi.hoisted(() => ({ confirmDoc: vi.fn(), createExpense: vi.fn(), getTenantCurrency: vi.fn(), suggestCategoryFor: vi.fn() }));
vi.mock('@/app/app/_lib/api-extra', async (orig) => ({ ...(await orig<object>()), ...extra }));

import MobileCapture from '../../app/app/capture/page';

type Cfg = Parameters<typeof buildTaxRowView>[0];
/** The fake server: the REAL view builder over a tenant config. */
function serve(cfg: Cfg) {
  api.getTaxRow.mockImplementation(async (q: { amountCents?: number; inclusive: boolean; taxCode?: string | null }) =>
    buildTaxRowView(cfg, { amountCents: q.amountCents, inclusive: q.inclusive, taxCode: q.taxCode ?? undefined }) as TaxRow);
}
const AU = { jurisdiction: 'au', region: 'NSW', gstRegistered: true };
const renderManual = () => {
  render(<ToastHost><MobileCapture /></ToastHost>);
  fireEvent.click(screen.getByRole('button', { name: 'Enter without a photo' }));
};
const typeAmount = (v: string) => fireEvent.change(screen.getByLabelText('Amount'), { target: { value: v } });

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => true });
  Object.values(api).forEach((f) => f.mockReset());
  Object.values(extra).forEach((f) => f.mockReset());
  extra.getTenantCurrency.mockResolvedValue('AUD');
  extra.suggestCategoryFor.mockResolvedValue(null);
  extra.createExpense.mockResolvedValue({ id: 'm1' });
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch not expected')));
});

describe('capture tax row — visibility', () => {
  it('US tenant: no tax row, and the save carries no tax code', async () => {
    serve({ jurisdiction: 'us', region: 'NY', gstRegistered: null });
    renderManual();
    typeAmount('50');
    await waitFor(() => expect(api.getTaxRow).toHaveBeenCalled());
    expect(screen.queryByTestId('capture-tax-row')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await waitFor(() => expect(extra.createExpense).toHaveBeenCalled());
    expect(extra.createExpense.mock.calls[0][0]).not.toHaveProperty('taxCode');
    expect(extra.createExpense.mock.calls[0][0].amountCents).toBe(5000);
  });
  it('AU registrant: row shown with GST selected and the computed tax', async () => {
    serve(AU);
    renderManual();
    typeAmount('110');
    const gst = await screen.findByTestId('capture-tax-code-GST');
    expect(gst).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(screen.getByTestId('capture-tax-amount')).toHaveTextContent('Tax A$10 · total A$110'));
  });
  it('AU gstRegistered false: hidden', async () => {
    serve({ ...AU, gstRegistered: false });
    renderManual();
    typeAmount('110');
    await waitFor(() => expect(api.getTaxRow).toHaveBeenCalled());
    expect(screen.queryByTestId('capture-tax-row')).toBeNull();
  });
  it('CA ON: HST', async () => {
    serve({ jurisdiction: 'ca', region: 'ON', gstRegistered: true });
    renderManual();
    expect(await screen.findByTestId('capture-tax-code-HST')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByTestId('capture-tax-code-GST_QST')).toBeNull();
  });
  it('QC registrant: GST + QST', async () => {
    serve({ jurisdiction: 'ca', region: 'QC', gstRegistered: true, qstRegistered: true });
    renderManual();
    const chip = await screen.findByTestId('capture-tax-code-GST_QST');
    expect(chip).toHaveTextContent('GST + QST');
    expect(chip).toHaveAttribute('aria-pressed', 'true');
  });
  it('unknown registration: prompt links to Business Profile', async () => {
    serve({ ...AU, gstRegistered: null });
    renderManual();
    const prompt = await screen.findByTestId('capture-tax-prompt');
    expect(prompt.querySelector('a')).toHaveAttribute('href', '/settings');
  });
});

describe('capture tax row — saving', () => {
  it('$100 tax-exclusive AU → sends the engine gross 11000 with GST and its tax', async () => {
    serve(AU);
    renderManual();
    typeAmount('100');
    fireEvent.click(await screen.findByTestId('capture-tax-mode-exclusive'));
    await waitFor(() => expect(screen.getByTestId('capture-tax-amount')).toHaveTextContent('Tax A$10 · total A$110'));
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await waitFor(() => expect(extra.createExpense).toHaveBeenCalled());
    expect(extra.createExpense.mock.calls[0][0]).toMatchObject({ amountCents: 11000, taxCode: 'GST', taxAmountCents: 1000 });
  });
  it('$110 inclusive AU → sends 11000 unchanged', async () => {
    serve(AU);
    renderManual();
    typeAmount('110');
    await screen.findByTestId('capture-tax-code-GST');
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await waitFor(() => expect(extra.createExpense).toHaveBeenCalled());
    expect(extra.createExpense.mock.calls[0][0]).toMatchObject({ amountCents: 11000, taxCode: 'GST', taxAmountCents: 1000 });
  });
  it('picking GST-free sends FRE and zero tax', async () => {
    serve(AU);
    renderManual();
    typeAmount('110');
    fireEvent.click(await screen.findByTestId('capture-tax-code-FRE'));
    await waitFor(() => expect(screen.getByTestId('capture-tax-code-FRE')).toHaveAttribute('aria-pressed', 'true'));
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await waitFor(() => expect(extra.createExpense).toHaveBeenCalled());
    expect(extra.createExpense.mock.calls[0][0]).toMatchObject({ amountCents: 11000, taxCode: 'FRE', taxAmountCents: 0 });
  });
  it('exclusive mode but the preview cannot be fetched: refuses to save rather than book the net as gross', async () => {
    serve(AU);
    renderManual();
    typeAmount('100');
    fireEvent.click(await screen.findByTestId('capture-tax-mode-exclusive'));
    api.getTaxRow.mockRejectedValue(Object.assign(new Error('x'), { status: 502 }));
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    expect(await screen.findByTestId('capture-error')).toBeInTheDocument();
    expect(extra.createExpense).not.toHaveBeenCalled();
  });
});

describe('capture tax row — uploaded receipt (T6a review minor 2)', () => {
  it('the PATCH carries the code the chip shows even when the user never touched the row', async () => {
    serve(AU);
    // Server stored a different (vendor-default) code; the chip shows GST.
    api.uploadReceipt.mockResolvedValue({
      doc: { id: 'd1', date: '2026-10-01', amountCents: 11000, vendorName: 'Officeworks', description: null, categoryId: null, categoryName: null,
        categorySource: null, confidence: null, status: 'confirmed', isPersonal: false, receiptUrl: null, receiptStatus: 'attached', archivedAt: null, suggestion: null, taxCode: 'FRE' },
      duplicate: false, ocr: { amountCents: 11000, vendor: 'Officeworks', date: '2026-10-01' },
    });
    api.patchDoc.mockImplementation(async (_id: string, p: object) => ({ id: 'd1', amountCents: 11000, status: 'confirmed', isPersonal: false, categoryId: null, ...p }));
    render(<ToastHost><MobileCapture /></ToastHost>);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'r.jpg', { type: 'image/jpeg' })], configurable: true });
    await act(async () => { fireEvent.change(input); });
    expect(await screen.findByTestId('capture-tax-code-GST')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await waitFor(() => expect(api.patchDoc).toHaveBeenCalled());
    expect(api.patchDoc.mock.calls[0][1]).toMatchObject({ taxCode: 'GST' });
  });

  it('confirm refused by a closed period shows the period message, not a generic failure', async () => {
    serve(AU);
    api.uploadReceipt.mockResolvedValue({
      doc: { id: 'd1', date: '2026-10-01', amountCents: 11000, vendorName: 'Officeworks', description: null, categoryId: 'c1', categoryName: 'Office', categorySource: null,
        confidence: null, status: 'pending_review', isPersonal: false, receiptUrl: null, receiptStatus: 'attached', archivedAt: null, suggestion: null },
      duplicate: false, ocr: { amountCents: 11000, vendor: 'Officeworks', date: '2026-10-01' },
    });
    api.patchDoc.mockImplementation(async (_id: string, p: object) => ({ id: 'd1', amountCents: 11000, status: 'pending_review', isPersonal: false, categoryId: 'c1', ...p }));
    extra.confirmDoc.mockRejectedValue(Object.assign(new Error('Period gate violated'), { status: 422 }));
    render(<ToastHost><MobileCapture /></ToastHost>);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'r.jpg', { type: 'image/jpeg' })], configurable: true });
    await act(async () => { fireEvent.change(input); });
    await screen.findByTestId('capture-tax-code-GST');
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    expect(await screen.findByTestId('capture-error')).toHaveTextContent('closed period');
  });
});
