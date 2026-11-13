import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { withShell } from './i18n-harness';
import { NewExpensePage } from '../pages/NewExpense';

/**
 * One-step entry: the New Expense form carries the category. Before this the form had NO category
 * field, so every manual expense was saved uncategorized and categorized in a second step.
 */

const ACCOUNTS = [
  { id: 'acc-office', code: '5010', name: 'Office Supplies', accountType: 'expense', isActive: true },
  { id: 'acc-meals', code: '5200', name: 'Meals', accountType: 'expense', isActive: true },
  { id: 'acc-susp', code: '6999', name: 'Uncategorized Expenses', accountType: 'expense', isActive: true },
];

type Call = { url: string; method: string; body?: Record<string, unknown> };
let calls: Call[];
let suggestion: unknown;
let suggestFails: boolean;
let accounts: unknown[];

beforeEach(() => {
  calls = [];
  suggestion = null;
  suggestFails = false;
  accounts = ACCOUNTS;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ success: true, data }) });
    if (url.includes('/agentbook-core/accounts')) return ok(accounts);
    if (url.includes('/categories/suggest')) {
      if (suggestFails) throw new Error('offline');
      return ok(suggestion);
    }
    if (url.endsWith('/expenses') && method === 'POST') return ok({ id: 'exp-1' });
    return ok(null);
  }));
});
afterEach(() => vi.unstubAllGlobals());

const renderPage = () => render(withShell(<NewExpensePage />));
const select = () => screen.getByLabelText('Category') as HTMLSelectElement;
const type = (label: RegExp | string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Record Expense' }));
const posts = () => calls.filter((c) => c.method === 'POST' && c.url.endsWith('/expenses'));

describe('NewExpense — Category field', () => {
  it("lists the tenant's expense categories, never the suspense account", async () => {
    renderPage();
    await waitFor(() => expect(select().options.length).toBeGreaterThan(1));
    const names = Array.from(select().options).map((o) => o.textContent);
    expect(names).toEqual(['Choose a category', 'Office Supplies', 'Meals']);
  });

  it('is required for a business expense, and not for a personal one', async () => {
    renderPage();
    await waitFor(() => expect(select().options.length).toBeGreaterThan(1));
    expect(select().required).toBe(true);
    fireEvent.click(screen.getByLabelText('This is a personal expense'));
    expect(select().required).toBe(false);
  });

  it('is not required when the tenant has no categories yet (the server seeds the chart on save)', async () => {
    accounts = [];
    renderPage();
    await waitFor(() => expect(calls.some((c) => c.url.includes('/agentbook-core/accounts'))).toBe(true));
    expect(select().required).toBe(false);
  });

  it('prefills from the suggestion for the typed vendor and says where it came from', async () => {
    suggestion = { categoryId: 'acc-meals', categoryName: 'Meals', confidence: 0.95, source: 'vendor' };
    renderPage();
    await waitFor(() => expect(select().options.length).toBeGreaterThan(1));
    type('Vendor', 'Starbucks');
    await waitFor(() => expect(select().value).toBe('acc-meals'));
    expect(screen.getByText(/remembered from your past expenses/i)).toBeTruthy();
    const q = calls.find((c) => c.url.includes('/categories/suggest'))!.url;
    expect(q).toContain('vendor=Starbucks');
  });

  it('shows the AI source with its confidence so the user knows to check it', async () => {
    suggestion = { categoryId: 'acc-office', categoryName: 'Office Supplies', confidence: 0.7, source: 'ai' };
    renderPage();
    await waitFor(() => expect(select().options.length).toBeGreaterThan(1));
    type('Vendor', 'Staples');
    await waitFor(() => expect(screen.getByText(/suggested by ai.*70%/i)).toBeTruthy());
  });

  it("never overwrites the user's own choice with a late suggestion", async () => {
    suggestion = { categoryId: 'acc-meals', categoryName: 'Meals', confidence: 0.95, source: 'vendor' };
    renderPage();
    await waitFor(() => expect(select().options.length).toBeGreaterThan(1));
    fireEvent.change(select(), { target: { value: 'acc-office' } });
    type('Vendor', 'Starbucks');
    await new Promise((r) => setTimeout(r, 600)); // past the debounce
    expect(select().value).toBe('acc-office');
  });

  it('a failing suggestion lookup leaves the form fully usable', async () => {
    suggestFails = true;
    renderPage();
    await waitFor(() => expect(select().options.length).toBeGreaterThan(1));
    type('Vendor', 'Starbucks');
    await new Promise((r) => setTimeout(r, 600));
    expect(select().value).toBe('');
    expect(screen.queryByText(/failed|error/i)).toBeNull();
  });
});

describe('NewExpense — saving is ONE request', () => {
  const fill = async () => {
    await waitFor(() => expect(select().options.length).toBeGreaterThan(1));
    type('Amount *', '42.00');
    type('Vendor', 'Starbucks');
  };

  it('accepting the suggestion posts category + categorySource "user" once, with no follow-up categorize/confirm call', async () => {
    suggestion = { categoryId: 'acc-meals', categoryName: 'Meals', confidence: 0.95, source: 'vendor' };
    renderPage();
    await fill();
    await waitFor(() => expect(select().value).toBe('acc-meals'));
    submit();
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toMatchObject({ amountCents: 4200, vendor: 'Starbucks', categoryId: 'acc-meals', categorySource: 'user' });
    await waitFor(() => expect(screen.getByText(/recorded successfully/i)).toBeTruthy());
    expect(calls.some((c) => /\/categorize|\/confirm/.test(c.url))).toBe(false);
  });

  it('changing a suggested category is reported as a correction', async () => {
    suggestion = { categoryId: 'acc-meals', categoryName: 'Meals', confidence: 0.95, source: 'vendor' };
    renderPage();
    await fill();
    await waitFor(() => expect(select().value).toBe('acc-meals'));
    fireEvent.change(select(), { target: { value: 'acc-office' } });
    submit();
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toMatchObject({ categoryId: 'acc-office', categorySource: 'user_corrected' });
  });

  it('a category picked with no suggestion is a plain user choice', async () => {
    renderPage();
    await fill();
    fireEvent.change(select(), { target: { value: 'acc-office' } });
    submit();
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toMatchObject({ categoryId: 'acc-office', categorySource: 'user' });
  });

  it('a personal expense sends no category and teaches nothing', async () => {
    suggestion = { categoryId: 'acc-meals', categoryName: 'Meals', confidence: 0.95, source: 'vendor' };
    renderPage();
    await fill();
    await waitFor(() => expect(select().value).toBe('acc-meals'));
    fireEvent.click(screen.getByLabelText('This is a personal expense'));
    submit();
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).not.toHaveProperty('categoryId');
    expect(posts()[0].body).not.toHaveProperty('categorySource');
  });

  it('the form is cleared (category included) after a successful save', async () => {
    renderPage();
    await fill();
    fireEvent.change(select(), { target: { value: 'acc-office' } });
    submit();
    await waitFor(() => expect(screen.getByText(/recorded successfully/i)).toBeTruthy());
    expect(select().value).toBe('');
  });
});

describe('NewExpense — Category field in every shipped locale', () => {
  it.each([
    ['fr-CA', 'Catégorie', 'Choisir une catégorie'],
    ['zh-CN', '类别', '选择类别'],
  ])('%s renders the label and placeholder from the catalog, not the English fallback', async (loc, label, choose) => {
    render(withShell(<NewExpensePage />, loc));
    const sel = (await screen.findByLabelText(label)) as HTMLSelectElement;
    expect(sel.options[0].textContent).toBe(choose);
  });

  it.each([
    ['fr-CA', /Retenue d’après vos dépenses passées/],
    ['zh-CN', /根据您过去的支出记住的类别/],
  ])('%s explains where a remembered suggestion came from', async (loc, hint) => {
    suggestion = { categoryId: 'acc-meals', categoryName: 'Meals', confidence: 0.95, source: 'vendor' };
    render(withShell(<NewExpensePage />, loc));
    await waitFor(() => expect(screen.getByRole('combobox', { name: /Catégorie|类别/ })).toBeTruthy());
    await waitFor(() => expect((screen.getByRole('combobox', { name: /Catégorie|类别/ }) as HTMLSelectElement).options.length).toBeGreaterThan(1));
    const vendorInput = screen.getAllByRole('textbox')[0];
    fireEvent.change(vendorInput, { target: { value: 'Starbucks' } });
    await waitFor(() => expect(screen.getByText(hint)).toBeTruthy());
  });
});
