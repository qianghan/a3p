/**
 * PR 5B — New Invoice item picker: shown only when the tenant tracks
 * inventory; picking an item fills the description and sale price, and the
 * created invoice line carries the itemId (that is what posts COGS).
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ShellProvider } from '@naap/plugin-sdk';
import type { ShellContext, II18nService } from '@naap/plugin-sdk';
import { createTranslator, formatCurrency } from '@agentbook/i18n';
import { CATALOG } from '@agentbook/i18n/catalog';
import { NewInvoicePage } from '../pages/NewInvoice';

function shellFor(locale: string): ShellContext {
  const { t } = createTranslator(locale, CATALOG);
  const i18n = {
    locale, t,
    formatMoney: (c: number, cur = 'CAD') => formatCurrency(c, locale, cur),
    formatCurrency: (c: number, cur = 'CAD') => formatCurrency(c, locale, cur),
  } as unknown as II18nService;
  return { auth: {}, navigate: () => {}, eventBus: {}, theme: {}, notifications: {}, integrations: {}, logger: {}, permissions: {}, version: '2.0.0', i18n } as unknown as ShellContext;
}

function install(trackInventory: boolean) {
  const posts: Array<{ url: string; body: any }> = [];
  globalThis.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === 'POST') {
      posts.push({ url: u, body: JSON.parse(String(init.body)) });
      return Promise.resolve({ ok: true, json: async () => ({ success: true, data: { id: 'inv-1' } }) } as any);
    }
    const body = u.includes('/tenant-config')
      ? { success: true, data: { currency: 'CAD', jurisdiction: 'ca', region: 'QC', trackInventory } }
      : u.includes('/inventory/items')
        ? { success: true, data: [{ id: 'i1', name: 'Widget', sku: 'W-1', salePriceCents: 1500, onHandQty: 10, isActive: true }] }
        : u.includes('/clients')
          ? { success: true, data: [{ id: 'c1', name: 'Acme' }] }
          : { success: true, data: {} };
    return Promise.resolve({ ok: true, json: async () => body } as any);
  }) as any;
  return posts;
}

const renderAt = (locale: string) => render(
  <MemoryRouter><ShellProvider value={shellFor(locale)}><NewInvoicePage /></ShellProvider></MemoryRouter>,
);

afterEach(() => vi.restoreAllMocks());

describe('New Invoice item picker', () => {
  it('hidden when inventory tracking is off', async () => {
    install(false);
    renderAt('en');
    await screen.findByText('Acme');
    expect(screen.queryByLabelText(createTranslator('en', CATALOG).t('invoice_ui.inventory_item'))).toBeNull();
    expect(vi.mocked(globalThis.fetch).mock.calls.some(([u]) => String(u).includes('/inventory/items'))).toBe(false);
  });

  it('fr-CA: picking an item fills the line and the POST carries itemId', async () => {
    const posts = install(true);
    renderAt('fr-CA');
    const { t } = createTranslator('fr-CA', CATALOG);
    const picker = await screen.findByLabelText(t('invoice_ui.inventory_item'));
    expect(picker.textContent).toContain(t('invoice_ui.in_stock_count', { qty: 10 }));
    fireEvent.change(screen.getByDisplayValue('— New client —'), { target: { value: 'c1' } });
    fireEvent.change(picker, { target: { value: 'i1' } });
    expect(screen.getByDisplayValue('Widget')).toBeTruthy();
    fireEvent.click(screen.getByText('Save as Draft'));
    await waitFor(() => expect(posts.some((p) => p.url.endsWith('/invoices'))).toBe(true));
    const inv = posts.find((p) => p.url.endsWith('/invoices'))!;
    expect(inv.body.lines).toEqual([{ description: 'Widget', quantity: 1, itemId: 'i1', rateCents: 1500 }]);
  });
});
