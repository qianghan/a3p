import React, { useEffect, useState } from 'react';
import { Receipt, Plus, X, ChevronDown, ChevronRight } from 'lucide-react';
import { ExpenseTabs } from '../components/ExpenseTabs';
import { formatMoney } from '@agentbook/i18n';
import { useTenantCurrency } from '../hooks/useTenantCurrency';
import { useI18n } from '@naap/plugin-sdk';

/**
 * Bills (accounts payable) — PR 3d.1.
 *
 * Open / Overdue / Paid filters, AP aging buckets (reports/ap-aging), add,
 * edit (amend for posted at_entry bills, PUT for legacy at_payment ones),
 * pay in full or in part, void a bill, and void a payment. Every write goes
 * to the bills routes, which post through lib/purchases; the page computes
 * nothing that reaches the books. Writes carry an idempotency key per
 * submission so a double click or a retry is one bill / one payment.
 */

const API = '/api/v1/agentbook-expense';
const AGING_API = '/api/v1/agentbook-tax/reports/ap-aging';

interface Bill {
  id: string;
  vendorName: string;
  description: string | null;
  billNumber?: string | null;
  amountCents: number;
  paidCents?: number | null;
  billDate?: string | null;
  dueDate: string;
  status: string;
  effectiveStatus: string;
  postingMode?: string;
}

interface Payment { id: string; amountCents: number; date: string; method?: string | null; voidedAt?: string | null }

interface Summary { openCents: number; overdueCents: number; count: number }
type BucketKey = 'current' | 'd1_30' | 'd31_60' | 'd60_plus';
type Buckets = Record<BucketKey, { totalCents: number; count: number }>;
const EMPTY_BUCKETS: Buckets = { current: { totalCents: 0, count: 0 }, d1_30: { totalCents: 0, count: 0 }, d31_60: { totalCents: 0, count: 0 }, d60_plus: { totalCents: 0, count: 0 } };

const FILTERS = ['all', 'open', 'overdue', 'paid'] as const;
type Filter = typeof FILTERS[number];

const STATUS_STYLE: Record<string, string> = {
  open: 'bg-yellow-500/10 text-yellow-600',
  partial: 'bg-blue-500/10 text-blue-600',
  overdue: 'bg-destructive/10 text-destructive',
  paid: 'bg-green-500/10 text-green-600',
  cancelled: 'bg-muted text-muted-foreground',
};

export const owingCents = (b: Pick<Bill, 'amountCents' | 'paidCents'>) => Math.max(0, b.amountCents - (b.paidCents ?? 0));
export const isUnpaid = (b: Pick<Bill, 'status'>) => b.status === 'open' || b.status === 'partial';

/** Which rows a filter shows. Open = every unpaid bill (overdue included). */
export function filterBills(bills: Bill[], f: Filter): Bill[] {
  if (f === 'open') return bills.filter(isUnpaid);
  if (f === 'overdue') return bills.filter((b) => b.effectiveStatus === 'overdue');
  if (f === 'paid') return bills.filter((b) => b.status === 'paid');
  return bills;
}

/** Catalog key for a refused bill payment (server `code`, else HTTP status). */
export function payErrorKey(status: number, code?: string): string {
  if (code === 'period_closed') return 'expenses_ui.bill_payment_period_closed';
  if (code === 'ledger_account_missing') return 'expenses_ui.bill_payment_account_missing';
  if (code === 'overpayment') return 'expenses_ui.bill_overpayment';
  if (status === 409) return 'expenses_ui.bill_payment_conflict';
  return 'expenses_ui.bill_payment_failed';
}

/** Catalog key for a refused bill create / edit / void. */
export function writeErrorKey(status: number, code?: string): string {
  if (code === 'period_closed') return 'expenses_ui.bill_period_closed';
  if (code === 'bill_has_payments') return 'expenses_ui.bill_void_has_payments';
  if (code === 'bill_currency_unsupported') return 'expenses_ui.bill_currency_unsupported';
  if (status === 409) return 'expenses_ui.bill_payment_conflict';
  return 'expenses_ui.bill_save_failed';
}

const newKey = () => {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  return c && typeof c.randomUUID === 'function' ? c.randomUUID() : `k${Date.now()}${Math.random().toString(16).slice(2)}`;
};
const todayIso = () => new Date().toISOString().slice(0, 10);
const plusDays = (iso: string, n: number) => new Date(new Date(`${iso}T12:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);

interface FormState { id: string | null; vendorName: string; amount: string; billDate: string; dueDate: string; billNumber: string; description: string; key: string }
const blankForm = (): FormState => ({ id: null, vendorName: '', amount: '', billDate: todayIso(), dueDate: plusDays(todayIso(), 14), billNumber: '', description: '', key: newKey() });

async function readJson(res: Response): Promise<{ code?: string; data?: unknown; summary?: Summary; error?: string }> {
  try { return (await res.json()) ?? {}; } catch { return {}; }
}

const input = 'rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground w-full';
const fieldLabel = 'grid gap-1 text-xs text-muted-foreground';

export const BillsPage: React.FC = () => {
  const { parseAmount, formatDateOnly, formatNumber, t } = useI18n();
  const currency = useTenantCurrency();
  const money = (cents: number) => formatMoney(cents, currency);

  const [bills, setBills] = useState<Bill[]>([]);
  const [summary, setSummary] = useState<Summary>({ openCents: 0, overdueCents: 0, count: 0 });
  const [buckets, setBuckets] = useState<Buckets>(EMPTY_BUCKETS);
  const [filter, setFilter] = useState<Filter>('all');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [partialFor, setPartialFor] = useState<{ id: string; amount: string; key: string } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [payments, setPayments] = useState<Record<string, Payment[]>>({});

  const load = async () => {
    setLoading(true);
    try {
      const [billsRes, agingRes] = await Promise.all([
        fetch(`${API}/bills?status=all`).then((r) => r.json()).catch(() => null),
        fetch(AGING_API).then((r) => r.json()).catch(() => null),
      ]);
      setBills(Array.isArray(billsRes?.data) ? billsRes.data : []);
      setSummary(billsRes?.summary || { openCents: 0, overdueCents: 0, count: 0 });
      const b = agingRes?.data?.buckets;
      setBuckets(b && typeof b === 'object' && 'current' in b ? { ...EMPTY_BUCKETS, ...b } : EMPTY_BUCKETS);
    } finally {
      setLoading(false);
    }
  };

  const loadPayments = async (id: string) => {
    const res = await fetch(`${API}/bills/${encodeURIComponent(id)}`).then((r) => r.json()).catch(() => null);
    setPayments((p) => ({ ...p, [id]: Array.isArray(res?.data?.payments) ? res.data.payments : [] }));
  };

  useEffect(() => { void load(); }, []);

  const saveForm = async () => {
    if (!form) return;
    const parsed = parseAmount(form.amount);
    if (!form.vendorName.trim() || !parsed.ok || parsed.cents <= 0) { setErr(t('expenses_ui.bill_form_invalid')); return; }
    if (form.dueDate < form.billDate) { setErr(t('expenses_ui.bill_due_before_bill_date')); return; }
    setSubmitting(true);
    setErr(null);
    try {
      const editing = form.id ? bills.find((b) => b.id === form.id) : null;
      const body = {
        vendorName: form.vendorName.trim(),
        amountCents: parsed.cents,
        dueDate: form.dueDate,
        billDate: form.billDate,
        billNumber: form.billNumber.trim() || undefined,
        description: form.description.trim() || undefined,
      };
      const res = !editing
        ? await fetch(`${API}/bills`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'Idempotency-Key': form.key },
          body: JSON.stringify({ ...body, idempotencyKey: form.key }),
        })
        // A posted (at_entry) bill is amended (reversal + new entry); a legacy one is edited.
        : await fetch(`${API}/bills/${encodeURIComponent(editing.id)}`, {
          method: editing.postingMode === 'at_entry' ? 'PATCH' : 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      if (!res.ok) {
        const j = await readJson(res);
        setErr(t(writeErrorKey(res.status, j.code)));
        return;
      }
      setForm(null);
      await load();
    } catch {
      setErr(t('expenses_ui.bill_save_failed'));
    } finally {
      setSubmitting(false);
    }
  };

  const pay = async (b: Bill, amountCents?: number, key: string = newKey()) => {
    const amount = amountCents ?? owingCents(b);
    if (!confirm(t('expenses_ui.bill_pay_confirm', { amount: money(amount), vendor: b.vendorName }))) return;
    setErr(null);
    try {
      const res = await fetch(`${API}/bills/${encodeURIComponent(b.id)}?action=pay`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify(amountCents !== undefined ? { amountCents, idempotencyKey: key } : { idempotencyKey: key }),
      });
      if (!res.ok) {
        // The server refuses rather than marking the bill paid without a ledger
        // entry (closed period, missing account, already paid): say why.
        const j = await readJson(res);
        setErr(t(payErrorKey(res.status, j.code)));
      } else {
        setPartialFor(null);
        if (expanded === b.id) await loadPayments(b.id);
      }
    } catch {
      setErr(t('expenses_ui.bill_payment_failed'));
    }
    await load();
  };

  const payPartial = async (b: Bill) => {
    if (!partialFor) return;
    const parsed = parseAmount(partialFor.amount);
    if (!parsed.ok || parsed.cents <= 0) { setErr(t('expenses_ui.bill_form_invalid')); return; }
    if (parsed.cents > owingCents(b)) { setErr(t('expenses_ui.bill_overpayment')); return; }
    await pay(b, parsed.cents, partialFor.key);
  };

  const voidBill = async (b: Bill) => {
    if (!confirm(t('expenses_ui.bill_void_confirm', { vendor: b.vendorName }))) return;
    setErr(null);
    try {
      const res = await fetch(`${API}/bills/${encodeURIComponent(b.id)}`, { method: 'DELETE' });
      if (!res.ok) {
        const j = await readJson(res);
        setErr(t(writeErrorKey(res.status, j.code)));
      }
    } catch {
      setErr(t('expenses_ui.bill_save_failed'));
    }
    await load();
  };

  const voidPayment = async (b: Bill, p: Payment) => {
    if (!confirm(t('expenses_ui.bill_void_payment_confirm', { amount: money(p.amountCents) }))) return;
    setErr(null);
    try {
      const res = await fetch(`${API}/bills/${encodeURIComponent(b.id)}/payments/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
      if (!res.ok) {
        const j = await readJson(res);
        setErr(t(writeErrorKey(res.status, j.code)));
      }
    } catch {
      setErr(t('expenses_ui.bill_save_failed'));
    }
    await loadPayments(b.id);
    await load();
  };

  const toggle = async (id: string) => {
    if (expanded === id) { setExpanded(null); return; }
    setExpanded(id);
    await loadPayments(id);
  };

  const statusLabel = (s: string) =>
    s === 'overdue' ? t('expenses_ui.overdue')
      : s === 'paid' ? t('expenses_ui.bill_paid')
        : s === 'partial' ? t('expenses_ui.bill_status_partial')
          : s === 'cancelled' ? t('expenses_ui.bill_status_void')
            : t('expenses_ui.bill_status_open');
  const filterLabel = (f: Filter) =>
    f === 'all' ? t('expenses_ui.bill_filter_all')
      : f === 'open' ? t('expenses_ui.bill_status_open')
        : f === 'overdue' ? t('expenses_ui.overdue')
          : t('expenses_ui.bill_paid');
  const bucketLabel = (k: BucketKey) =>
    k === 'current' ? t('expenses_ui.aging_current')
      : k === 'd1_30' ? t('expenses_ui.aging_1_30')
        : k === 'd31_60' ? t('expenses_ui.aging_31_60')
          : t('expenses_ui.aging_60_plus');

  const visible = filterBills(bills, filter);

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-5 gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
            <Receipt className="w-5 h-5" aria-hidden="true" />{t('tabs.bills')}</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{t('expenses_ui.bills_sub')}</p>
        </div>
        <button
          type="button"
          onClick={() => setForm((f) => (f ? null : blankForm()))}
          aria-expanded={!!form}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:opacity-90"
        >
          {form ? <X className="w-4 h-4" aria-hidden="true" /> : <Plus className="w-4 h-4" aria-hidden="true" />}
          {form ? t('common.cancel') : t('expenses_ui.add_bill')}
        </button>
      </div>

      <ExpenseTabs active="bills" />

      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground">{t('expenses_ui.open_owed')}</p>
          <p className="text-2xl font-bold text-foreground" data-testid="bills-open-total">{money(summary.openCents)}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground">{t('expenses_ui.overdue')}</p>
          <p className="text-2xl font-bold text-destructive">{money(summary.overdueCents)}</p>
        </div>
      </div>

      <section aria-labelledby="bills-aging-title" className="mb-5">
        <h2 id="bills-aging-title" className="text-sm font-semibold text-foreground mb-2">{t('expenses_ui.aging_title')}</h2>
        <ul className="grid grid-cols-2 sm:grid-cols-4 gap-2" data-testid="bills-aging">
          {(Object.keys(EMPTY_BUCKETS) as BucketKey[]).map((k) => (
            <li key={k} className="rounded-lg border border-border bg-card p-3">
              <p className="text-xs text-muted-foreground">{bucketLabel(k)}</p>
              <p className={`text-base font-semibold ${k === 'current' ? 'text-foreground' : 'text-destructive'}`}>{money(buckets[k].totalCents)}</p>
            </li>
          ))}
        </ul>
      </section>

      {form && (
        <form
          aria-label={form.id ? t('expenses_ui.edit_bill') : t('expenses_ui.add_bill')}
          onSubmit={(e) => { e.preventDefault(); void saveForm(); }}
          className="rounded-xl border border-border bg-card p-4 mb-5 space-y-3"
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className={fieldLabel}>{t('expenses_ui.col_vendor')}
              <input value={form.vendorName} onChange={(e) => setForm({ ...form, vendorName: e.target.value })} placeholder={t('expenses_ui.vendor_placeholder')} className={input} />
            </label>
            <label className={fieldLabel}>{t('expenses_ui.col_amount')}
              <input inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder={t('expenses_ui.amount_placeholder')} className={input} />
            </label>
            <label className={fieldLabel}>{t('expenses_ui.bill_date')}
              <input type="date" value={form.billDate} onChange={(e) => setForm({ ...form, billDate: e.target.value })} className={input} />
            </label>
            <label className={fieldLabel}>{t('expenses_ui.bill_due_date')}
              <input type="date" value={form.dueDate} min={form.billDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} className={input} />
            </label>
            <label className={fieldLabel}>{t('expenses_ui.bill_number')}
              <input value={form.billNumber} onChange={(e) => setForm({ ...form, billNumber: e.target.value })} className={input} />
            </label>
            <label className={fieldLabel}>{t('expenses_ui.description_optional')}
              <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className={input} />
            </label>
          </div>
          <button type="submit" disabled={submitting || !form.vendorName || !form.amount}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50">
            {submitting ? t('common.saving') : form.id ? t('common.save') : t('expenses_ui.save_bill')}
          </button>
        </form>
      )}

      {err && <p role="alert" className="text-sm text-destructive mb-3">{err}</p>}

      <div role="tablist" aria-label={t('common.filter')} className="flex border-b border-border mb-4">
        {FILTERS.map((f) => (
          <button key={f} type="button" role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              filter === f ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}>
            {filterLabel(f)}
          </button>
        ))}
      </div>

      {loading ? (
        <p role="status" className="text-sm text-muted-foreground py-10 text-center">{t('common.loading_ellipsis')}</p>
      ) : visible.length === 0 ? (
        <p className="text-sm text-muted-foreground py-10 text-center">{t('expenses_ui.no_bills')}</p>
      ) : (
        <div className="rounded-xl border border-border bg-card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-muted-foreground border-b border-border">
                <th className="text-left px-4 py-2">{t('expenses_ui.col_vendor')}</th>
                <th className="text-left px-4 py-2">{t('expenses_ui.due')}</th>
                <th className="text-right px-4 py-2">{t('expenses_ui.col_amount')}</th>
                <th className="text-right px-4 py-2">{t('expenses_ui.bill_owing')}</th>
                <th className="text-left px-4 py-2">{t('expenses_ui.col_status')}</th>
                <th className="px-4 py-2"><span className="sr-only">{t('common.actions')}</span></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((b) => {
                const owing = owingCents(b);
                const unpaid = isUnpaid(b);
                return (
                  <React.Fragment key={b.id}>
                    <tr className="border-b border-border last:border-0 align-top" data-testid={`bill-row-${b.id}`}>
                      <td className="px-4 py-2.5 text-foreground font-medium">
                        <button type="button" onClick={() => void toggle(b.id)} aria-expanded={expanded === b.id}
                          aria-label={t('expenses_ui.bill_show_payments', { vendor: b.vendorName })}
                          className="inline-flex items-center gap-1 text-left hover:underline">
                          {expanded === b.id ? <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" /> : <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />}
                          {b.vendorName}
                        </button>
                        {(b.billNumber || b.description) && (
                          <span className="block text-xs text-muted-foreground">{[b.billNumber, b.description].filter(Boolean).join(' · ')}</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">
                        {/* A bill DUE DATE is a logical date: formatDateOnly pins it to UTC. */}
                        {formatDateOnly(b.dueDate, { month: 'short', day: 'numeric' })}
                      </td>
                      <td className="px-4 py-2.5 text-right text-foreground">{money(b.amountCents)}</td>
                      <td className="px-4 py-2.5 text-right text-foreground" data-testid={`bill-owing-${b.id}`}>{unpaid ? money(owing) : '—'}</td>
                      <td className="px-4 py-2.5">
                        <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLE[b.effectiveStatus] ?? STATUS_STYLE[b.status] ?? ''}`}>
                          {statusLabel(b.effectiveStatus === 'overdue' ? 'overdue' : b.status)}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right whitespace-nowrap space-x-3">
                        {unpaid && (
                          <>
                            <button type="button" onClick={() => void pay(b)} className="text-xs font-medium text-primary hover:underline">{t('expenses_ui.pay')}</button>
                            <button type="button" onClick={() => setPartialFor(partialFor?.id === b.id ? null : { id: b.id, amount: '', key: newKey() })}
                              aria-expanded={partialFor?.id === b.id} className="text-xs font-medium text-primary hover:underline">{t('expenses_ui.bill_pay_partial')}</button>
                          </>
                        )}
                        {b.status === 'open' && (b.paidCents ?? 0) === 0 && (
                          <button type="button" className="text-xs font-medium text-foreground hover:underline"
                            onClick={() => setForm({ id: b.id, vendorName: b.vendorName, amount: formatNumber(b.amountCents / 100, { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false }), billDate: (b.billDate ?? b.dueDate).slice(0, 10), dueDate: b.dueDate.slice(0, 10), billNumber: b.billNumber ?? '', description: b.description ?? '', key: newKey() })}>
                            {t('common.edit')}
                          </button>
                        )}
                        {b.status !== 'cancelled' && b.status !== 'paid' && (
                          <button type="button" onClick={() => void voidBill(b)} className="text-xs font-medium text-destructive hover:underline">{t('expenses_ui.bill_void')}</button>
                        )}
                      </td>
                    </tr>
                    {partialFor?.id === b.id && (
                      <tr className="border-b border-border bg-muted/30">
                        <td colSpan={6} className="px-4 py-2.5">
                          <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void payPartial(b); }}>
                            <label className={fieldLabel}>{t('expenses_ui.bill_partial_amount', { amount: money(owing) })}
                              <input inputMode="decimal" value={partialFor.amount} onChange={(e) => setPartialFor({ ...partialFor, amount: e.target.value })} className={input} />
                            </label>
                            <button type="submit" disabled={!partialFor.amount} className="px-3 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground disabled:opacity-50">
                              {t('expenses_ui.bill_record_payment')}
                            </button>
                          </form>
                        </td>
                      </tr>
                    )}
                    {expanded === b.id && (
                      <tr className="border-b border-border bg-muted/20">
                        <td colSpan={6} className="px-4 py-2.5">
                          <p className="text-xs font-semibold text-foreground mb-1">{t('expenses_ui.bill_payments')}</p>
                          {(payments[b.id] ?? []).length === 0 ? (
                            <p className="text-xs text-muted-foreground">{t('expenses_ui.bill_no_payments')}</p>
                          ) : (
                            <ul className="space-y-1">
                              {(payments[b.id] ?? []).map((p) => (
                                <li key={p.id} className="flex items-center justify-between text-xs" data-testid={`payment-${p.id}`}>
                                  <span className={p.voidedAt ? 'line-through text-muted-foreground' : 'text-foreground'}>
                                    {formatDateOnly(p.date, { month: 'short', day: 'numeric' })} · {money(p.amountCents)}
                                  </span>
                                  {p.voidedAt ? (
                                    <span className="text-muted-foreground">{t('expenses_ui.bill_payment_voided')}</span>
                                  ) : (
                                    <button type="button" onClick={() => void voidPayment(b, p)} className="font-medium text-destructive hover:underline">
                                      {t('expenses_ui.bill_void_payment')}
                                    </button>
                                  )}
                                </li>
                              ))}
                            </ul>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default BillsPage;
