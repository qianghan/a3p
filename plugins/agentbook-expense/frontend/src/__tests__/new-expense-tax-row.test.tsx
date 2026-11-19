import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { withShell } from './i18n-harness';
import { NewExpensePage } from '../pages/NewExpense';

/**
 * PR 2b.8 — the web New Expense tax row. Visibility rules are server-side
 * (GET /tax-codes, lib/expense-tax-row); this fake server returns the views
 * that endpoint gives each market, and computes AU GST previews (10%).
 */
type View = { visible: boolean; codes: Array<{ code: string; recoverable: boolean }>; defaultCode: string | null; registrationPrompt: boolean };
const HIDDEN: View = { visible: false, codes: [], defaultCode: null, registrationPrompt: false };
const AU: View = { visible: true, codes: ['GST', 'CAP', 'FRE', 'INP', 'NTR'].map((code) => ({ code, recoverable: true })), defaultCode: 'GST', registrationPrompt: false };
const ON: View = { visible: true, codes: ['HST', 'ZERO', 'EXEMPT', 'OUT_OF_SCOPE'].map((code) => ({ code, recoverable: true })), defaultCode: 'HST', registrationPrompt: false };
const QC: View = { visible: true, codes: ['GST_QST', 'GST', 'ZERO'].map((code) => ({ code, recoverable: true })), defaultCode: 'GST_QST', registrationPrompt: false };

let view: View;
let taxFails: boolean;
let taxServerError: string | null;
type Call = { url: string; method: string; body?: Record<string, unknown> };
let calls: Call[];

function auPreview(u: URL) {
  const amt = Number(u.searchParams.get('amountCents'));
  if (!amt) return null;
  const code = u.searchParams.get('taxCode') ?? 'GST';
  const inclusive = u.searchParams.get('inclusive') !== 'false';
  const rate = code === 'GST' || code === 'CAP' ? 0.1 : 0;
  const tax = inclusive ? Math.round(amt - amt / (1 + rate)) : Math.round(amt * rate);
  return { taxCode: code, inclusive, grossCents: inclusive ? amt : amt + tax, netCents: inclusive ? amt - tax : amt, taxCents: tax };
}

beforeEach(() => {
  view = HIDDEN; taxFails = false; taxServerError = null; calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ success: true, data }) });
    if (url.includes('/tax-codes')) {
      if (taxFails) throw new Error('offline');
      if (taxServerError) return { ok: false, status: 400, json: async () => ({ success: false, code: 'invalid_tax_code', error: taxServerError }) };
      const u = new URL(url, 'http://x');
      return ok({ ...view, preview: view.visible && view === AU ? auPreview(u) : null });
    }
    if (url.endsWith('/expenses') && method === 'POST') return ok({ id: 'exp-1' });
    return ok([]);
  }));
});
afterEach(() => vi.unstubAllGlobals());

const renderPage = () => render(withShell(<NewExpensePage />));
const amount = (v: string) => fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: v } });
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Record Expense' }));
const post = () => calls.find((c) => c.method === 'POST' && c.url.endsWith('/expenses'));

describe('NewExpense — tax row visibility', () => {
  it('US: no tax row; the POST has no taxCode', async () => {
    renderPage();
    amount('50');
    await waitFor(() => expect(calls.some((c) => c.url.includes('/tax-codes'))).toBe(true));
    expect(screen.queryByTestId('new-expense-tax-row')).toBeNull();
    submit();
    await waitFor(() => expect(post()).toBeTruthy());
    expect(post()!.body).not.toHaveProperty('taxCode');
    expect(post()!.body!.amountCents).toBe(5000);
  });
  it('AU registrant: GST selected by default', async () => {
    view = AU;
    renderPage();
    expect(await screen.findByTestId('new-expense-tax-code-GST')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('new-expense-tax-code-FRE')).toHaveTextContent('GST-free');
  });
  it('AU gstRegistered false (hidden view): no row', async () => {
    view = HIDDEN;
    renderPage();
    await waitFor(() => expect(calls.some((c) => c.url.includes('/tax-codes'))).toBe(true));
    expect(screen.queryByTestId('new-expense-tax-row')).toBeNull();
  });
  it('CA ON: HST', async () => {
    view = ON;
    renderPage();
    expect(await screen.findByTestId('new-expense-tax-code-HST')).toHaveAttribute('aria-pressed', 'true');
  });
  it('QC registrant: GST + QST', async () => {
    view = QC;
    renderPage();
    const chip = await screen.findByTestId('new-expense-tax-code-GST_QST');
    expect(chip).toHaveTextContent('GST + QST');
    expect(chip).toHaveAttribute('aria-pressed', 'true');
  });
  it('unknown registration: prompt links to Business Profile', async () => {
    view = { ...AU, registrationPrompt: true };
    renderPage();
    const p = await screen.findByTestId('new-expense-tax-prompt');
    expect(p.querySelector('a')).toHaveAttribute('href', '/settings');
  });
  it('French renders the row in French', async () => {
    view = AU;
    render(withShell(<NewExpensePage />, 'fr-CA'));
    expect(await screen.findByText('Montant taxes incluses')).toBeTruthy();
  });
});

describe('NewExpense — tax row saving', () => {
  it('$100 tax-exclusive AU → POST amountCents 11000, GST, tax 1000', async () => {
    view = AU;
    renderPage();
    amount('100');
    fireEvent.click(await screen.findByTestId('new-expense-tax-mode-exclusive'));
    await waitFor(() => expect(screen.getByTestId('new-expense-tax-amount').textContent).toContain('1000'));
    submit();
    await waitFor(() => expect(post()).toBeTruthy());
    expect(post()!.body).toMatchObject({ amountCents: 11000, taxCode: 'GST', taxAmountCents: 1000 });
  });
  it('$110 inclusive AU → POST 11000 unchanged', async () => {
    view = AU;
    renderPage();
    amount('110');
    await screen.findByTestId('new-expense-tax-code-GST');
    submit();
    await waitFor(() => expect(post()).toBeTruthy());
    expect(post()!.body).toMatchObject({ amountCents: 11000, taxCode: 'GST', taxAmountCents: 1000 });
  });
  it('exclusive and the preview fails: no POST, an error is shown', async () => {
    view = AU;
    renderPage();
    amount('100');
    fireEvent.click(await screen.findByTestId('new-expense-tax-mode-exclusive'));
    await screen.findByTestId('new-expense-tax-amount');
    taxFails = true;
    submit();
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(post()).toBeUndefined();
  });
  it("the tax endpoint answers an error: shows the server's message and does not POST (T6a minor 4)", async () => {
    view = AU;
    renderPage();
    amount('110');
    await screen.findByTestId('new-expense-tax-amount');
    taxServerError = 'taxCode is not a valid tax code for your jurisdiction and region';
    submit();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('taxCode is not a valid tax code for your jurisdiction and region');
    expect(post()).toBeUndefined();
  });
});
