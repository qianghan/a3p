import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { withShell } from './i18n-harness';
import { ItemsPage, inventoryErrorKey } from '../pages/Items';
import { createTranslator } from '@agentbook/i18n';
import { CATALOG } from '@agentbook/i18n/catalog';

/**
 * PR 5A.5 — Items page: gated on trackInventory, renders the server's
 * computed on-hand qty/value, localized, and maps a 409 duplicate SKU.
 */
const ITEM = { id: 'i1', sku: 'W-1', name: 'Widget', unit: 'each', onHandQty: 15, onHandValueCents: 9000, avgCostCents: 600, reorderPoint: 20, lowStock: true, negative: false };
afterEach(() => vi.unstubAllGlobals());

function stub(list: { data: unknown[]; summary: Record<string, unknown> }, post?: { status: number; body: Record<string, unknown> }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (init?.method === 'POST' && post) return { ok: post.status < 400, status: post.status, json: async () => post.body };
    return { ok: true, status: 200, json: async () => ({ success: true, ...list }) };
  }));
  return calls;
}

describe('Items page', () => {
  it.each(['en', 'fr-CA', 'zh-CN'])('%s: tracking off → the turn-on message, no New item button', async (locale) => {
    stub({ data: [], summary: { totalValueCents: 0, lowStockCount: 0, trackInventory: false } });
    render(withShell(<ItemsPage />, locale));
    const { t } = createTranslator(locale, CATALOG);
    expect((await screen.findByTestId('items-disabled')).textContent).toBe(t('expenses_ui.items_turn_on_tracking'));
    expect(screen.queryByRole('button', { name: t('expenses_ui.items_new_item') })).toBeNull();
  });

  it('shows on-hand qty, value and the low-stock badge from the server', async () => {
    stub({ data: [ITEM], summary: { totalValueCents: 9000, lowStockCount: 1, trackInventory: true } });
    render(withShell(<ItemsPage />, 'en'));
    const row = await screen.findByTestId('item-row');
    expect(row.textContent).toContain('15 each');
    // The harness formatCurrency renders `$<cents>`: proves the shell's locale-bound formatter is used.
    expect(row.textContent).toContain('$9000');
    expect(row.textContent).toContain('Low stock');
    expect(screen.getByTestId('items-total-value').textContent).toBe('$9000');
  });

  it('a duplicate SKU shows the localized 409 message', async () => {
    stub({ data: [], summary: { totalValueCents: 0, lowStockCount: 0, trackInventory: true } }, { status: 409, body: { success: false, code: 'duplicate_sku' } });
    render(withShell(<ItemsPage />, 'fr-CA'));
    const { t } = createTranslator('fr-CA', CATALOG);
    fireEvent.click(await screen.findByRole('button', { name: t('expenses_ui.items_new_item') }));
    fireEvent.change(screen.getByLabelText(t('expenses_ui.items_name')), { target: { value: 'Widget' } });
    fireEvent.click(screen.getByRole('button', { name: t('expenses_ui.items_save') }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(t('expenses_ui.items_duplicate_sku')));
  });

  it('PR 5B: COGS by quarter from the server, and a write-off posts a negative adjust with the reason', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('/cogs')) return { ok: true, status: 200, json: async () => ({ success: true, data: { periods: [{ period: '2026-Q4', cogsCents: 3000 }], totalCents: 3000 } }) };
      if (init?.method === 'POST') return { ok: true, status: 201, json: async () => ({ success: true, data: {} }) };
      return { ok: true, status: 200, json: async () => ({ success: true, data: [ITEM], summary: { totalValueCents: 9000, lowStockCount: 1, trackInventory: true } }) };
    }));
    render(withShell(<ItemsPage />, 'fr-CA'));
    const { t } = createTranslator('fr-CA', CATALOG);
    expect((await screen.findByTestId('cogs-row')).textContent).toBe('2026-Q4$3000');
    expect(screen.getByTestId('cogs-total').textContent).toBe('$3000');
    fireEvent.click(screen.getByRole('button', { name: t('expenses_ui.items_write_off') }));
    fireEvent.change(screen.getByLabelText(t('expenses_ui.items_quantity_to_write_off')), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText(t('expenses_ui.items_reason')), { target: { value: 'cassé' } });
    fireEvent.click(screen.getByRole('button', { name: t('expenses_ui.items_save') }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.init?.method === 'POST')!;
    expect(post.url).toBe('/api/v1/agentbook-expense/inventory/items/i1/adjust');
    expect(JSON.parse(String(post.init!.body))).toMatchObject({ qty: -2, valueCents: null, reason: 'cassé' });
  });

  it('maps server codes to catalog keys', () => {
    expect(inventoryErrorKey(409, 'duplicate_sku')).toBe('expenses_ui.items_duplicate_sku');
    expect(inventoryErrorKey(422, 'period_closed')).toBe('expenses_ui.bill_payment_period_closed');
    expect(inventoryErrorKey(500)).toBe('expenses_ui.items_save_failed');
  });
});
