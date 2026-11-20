import React, { useCallback, useEffect, useState } from 'react';
import { Package, Plus, X } from 'lucide-react';
import { ExpenseTabs } from '../components/ExpenseTabs';
import { formatMoney } from '@agentbook/i18n';
import { useTenantCurrency } from '../hooks/useTenantCurrency';
import { useI18n } from '@naap/plugin-sdk';

/**
 * Inventory items (PR 5A): stock on hand, opening stock, adjustments, soft
 * delete. Purchases arrive through bill lines with an item (Bills page / API);
 * sales and COGS land in PR 5B. Gated on the tenant's trackInventory flag —
 * when it is off the page says where to turn it on.
 */
const API = '/api/v1/agentbook-expense/inventory';

export interface InventoryItem {
  id: string;
  sku: string | null;
  name: string;
  unit: string;
  onHandQty: number;
  onHandValueCents: number;
  avgCostCents: number | null;
  reorderPoint: number | null;
  lowStock: boolean;
  negative: boolean;
}
interface Summary { totalValueCents: number; lowStockCount: number; trackInventory: boolean }

/** Catalog key for a refused inventory write (server `code`, else status). */
export function inventoryErrorKey(status: number, code?: string): string {
  if (code === 'duplicate_sku') return 'expenses_ui.items_duplicate_sku';
  if (code === 'period_closed') return 'expenses_ui.bill_payment_period_closed';
  if (code === 'inventory_not_enabled') return 'expenses_ui.items_turn_on_tracking';
  if (status === 409) return 'expenses_ui.items_conflict';
  return 'expenses_ui.items_save_failed';
}

type Dialog = null | { kind: 'new' } | { kind: 'opening' | 'adjust'; item: InventoryItem };

export const ItemsPage: React.FC = () => {
  const { t, parseAmount } = useI18n();
  const currency = useTenantCurrency();
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', sku: '', unit: 'each', reorderPoint: '', qty: '', amount: '', reason: '' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/items`);
      const body = await res.json();
      if (body?.success) {
        setItems(body.data ?? []);
        setSummary(body.summary ?? null);
      }
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const open = (d: Dialog) => {
    setError(null);
    setForm({ name: '', sku: '', unit: 'each', reorderPoint: '', qty: '', amount: '', reason: '' });
    setDialog(d);
  };

  async function send(url: string, method: string, payload?: unknown) {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body?.success) {
      setError(t(inventoryErrorKey(res.status, body?.code)));
      return false;
    }
    return true;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!dialog) return;
    let ok = false;
    if (dialog.kind === 'new') {
      ok = await send(`${API}/items`, 'POST', {
        name: form.name, sku: form.sku || null, unit: form.unit || 'each',
        reorderPoint: form.reorderPoint === '' ? null : form.reorderPoint,
      });
    } else {
      const amount = form.amount === '' ? null : parseAmount(form.amount);
      if (amount && !amount.ok) { setError(t('expenses_ui.items_save_failed')); return; }
      if (dialog.kind === 'opening') {
        ok = await send(`${API}/items/${dialog.item.id}/opening`, 'POST', { qty: form.qty, valueCents: amount?.cents ?? 0 });
      } else {
        ok = await send(`${API}/items/${dialog.item.id}/adjust`, 'POST', {
          qty: form.qty, valueCents: amount ? amount.cents : null, reason: form.reason || null,
          idempotencyKey: `web-${dialog.item.id}-${Date.now()}`,
        });
      }
    }
    if (ok) { setDialog(null); await load(); }
  }

  async function remove(item: InventoryItem) {
    if (!confirm(t('expenses_ui.items_delete_confirm', { name: item.name }))) return;
    if (await send(`${API}/items/${item.id}`, 'DELETE')) await load();
  }

  const inputCls = 'w-full rounded-md border border-border bg-background px-3 py-2 text-sm';

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      <ExpenseTabs active="items" />
      <div className="flex items-center justify-between mb-4 gap-3">
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <Package className="w-5 h-5" aria-hidden="true" /> {t('expenses_ui.items_title')}
        </h1>
        {summary?.trackInventory && (
          <button type="button" onClick={() => open({ kind: 'new' })} className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground">
            <Plus className="w-4 h-4" aria-hidden="true" /> {t('expenses_ui.items_new_item')}
          </button>
        )}
      </div>

      {!loading && summary && !summary.trackInventory && (
        <p data-testid="items-disabled" className="rounded-md border border-border bg-muted p-4 text-sm text-muted-foreground">
          {t('expenses_ui.items_turn_on_tracking')}
        </p>
      )}

      {summary?.trackInventory && (
        <div className="grid grid-cols-2 gap-3 mb-4">
          <div className="rounded-lg border border-border p-3">
            <div className="text-xs text-muted-foreground">{t('expenses_ui.items_stock_value')}</div>
            <div data-testid="items-total-value" className="text-lg font-semibold">{formatMoney(summary.totalValueCents, currency)}</div>
          </div>
          <div className="rounded-lg border border-border p-3">
            <div className="text-xs text-muted-foreground">{t('expenses_ui.items_low_stock')}</div>
            <div data-testid="items-low-count" className="text-lg font-semibold">{summary.lowStockCount}</div>
          </div>
        </div>
      )}

      {summary?.trackInventory && !loading && items.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('expenses_ui.items_empty')}</p>
      )}

      {items.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground border-b border-border">
                <th className="py-2 pr-2">{t('expenses_ui.items_item')}</th>
                <th className="py-2 pr-2 text-right">{t('expenses_ui.items_on_hand')}</th>
                <th className="py-2 pr-2 text-right">{t('expenses_ui.items_value')}</th>
                <th className="py-2 pr-2 text-right">{t('expenses_ui.items_average_cost')}</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id} data-testid="item-row" className="border-b border-border">
                  <td className="py-2 pr-2">
                    <div className="font-medium">{i.name}</div>
                    {i.sku && <div className="text-xs text-muted-foreground">{i.sku}</div>}
                    {i.lowStock && <span className="text-xs rounded-full bg-yellow-500/10 text-yellow-700 px-2">{t('expenses_ui.items_low_stock')}</span>}
                    {i.negative && <span className="ml-1 text-xs rounded-full bg-destructive/10 text-destructive px-2">{t('expenses_ui.items_negative_stock')}</span>}
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums">{i.onHandQty} {i.unit}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">{formatMoney(i.onHandValueCents, currency)}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">{i.avgCostCents == null ? '—' : formatMoney(i.avgCostCents, currency)}</td>
                  <td className="py-2 text-right whitespace-nowrap">
                    <button type="button" className="text-xs text-primary mr-2" onClick={() => open({ kind: 'opening', item: i })}>{t('expenses_ui.items_opening_stock')}</button>
                    <button type="button" className="text-xs text-primary mr-2" onClick={() => open({ kind: 'adjust', item: i })}>{t('expenses_ui.items_adjust')}</button>
                    <button type="button" className="text-xs text-destructive" onClick={() => remove(i)}>{t('expenses_ui.items_delete')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {error && !dialog && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}

      {dialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
          <form onSubmit={submit} className="w-full max-w-md rounded-lg bg-background p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">
                {dialog.kind === 'new' ? t('expenses_ui.items_new_item') : dialog.kind === 'opening' ? t('expenses_ui.items_opening_stock') : t('expenses_ui.items_adjust')}
              </h2>
              <button type="button" onClick={() => setDialog(null)} aria-label={t('common.close')}><X className="w-4 h-4" /></button>
            </div>
            {dialog.kind === 'new' ? (
              <>
                <label className="block text-sm">{t('expenses_ui.items_name')}<input required className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
                <label className="block text-sm">{t('expenses_ui.items_sku')}<input className={inputCls} value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} /></label>
                <label className="block text-sm">{t('expenses_ui.items_unit')}<input className={inputCls} value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} /></label>
                <label className="block text-sm">{t('expenses_ui.items_reorder_point')}<input inputMode="decimal" className={inputCls} value={form.reorderPoint} onChange={(e) => setForm({ ...form, reorderPoint: e.target.value })} /></label>
              </>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">{dialog.item.name}</p>
                <label className="block text-sm">{dialog.kind === 'adjust' ? t('expenses_ui.items_quantity_change') : t('expenses_ui.items_quantity')}<input required inputMode="decimal" className={inputCls} value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} /></label>
                <label className="block text-sm">{t('expenses_ui.items_total_value')}<input inputMode="decimal" required={dialog.kind === 'opening'} className={inputCls} value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></label>
                {dialog.kind === 'adjust' && (
                  <>
                    <p className="text-xs text-muted-foreground">{t('expenses_ui.items_adjust_help')}</p>
                    <label className="block text-sm">{t('expenses_ui.items_reason')}<input className={inputCls} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></label>
                  </>
                )}
              </>
            )}
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <button type="submit" className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground">{t('expenses_ui.items_save')}</button>
          </form>
        </div>
      )}
    </div>
  );
};

export default ItemsPage;
