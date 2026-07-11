import React, { useEffect, useState } from 'react';
import { Receipt, Plus, X } from 'lucide-react';
import { ExpenseTabs } from '../components/ExpenseTabs';

const API = '/api/v1/agentbook-expense';

interface Bill {
  id: string;
  vendorName: string;
  description: string | null;
  amountCents: number;
  dueDate: string;
  status: string;
  effectiveStatus: string;
  paidDate: string | null;
}

interface Summary { openCents: number; overdueCents: number; count: number }

const fmt$ = (cents: number) =>
  '$' + (cents / 100).toLocaleString('en-US', {
    maximumFractionDigits: 2,
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  });

const TABS = ['all', 'open', 'overdue', 'paid'] as const;
type Tab = typeof TABS[number];

const STATUS_STYLE: Record<string, string> = {
  open: 'bg-yellow-500/10 text-yellow-600',
  overdue: 'bg-destructive/10 text-destructive',
  paid: 'bg-green-500/10 text-green-600',
  cancelled: 'bg-muted text-muted-foreground',
};

export const BillsPage: React.FC = () => {
  const [bills, setBills] = useState<Bill[]>([]);
  const [summary, setSummary] = useState<Summary>({ openCents: 0, overdueCents: 0, count: 0 });
  const [tab, setTab] = useState<Tab>('all');
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [vendorName, setVendorName] = useState('');
  const [amount, setAmount] = useState('');
  const [dueDate, setDueDate] = useState(new Date().toISOString().slice(0, 10));
  const [description, setDescription] = useState('');

  const load = async (which: Tab = tab) => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/bills?status=${which}`).then((r) => r.json());
      setBills(res.data || []);
      setSummary(res.summary || { openCents: 0, overdueCents: 0, count: 0 });
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(tab); /* eslint-disable-next-line */ }, [tab]);

  const addBill = async () => {
    setSubmitting(true);
    setErr(null);
    try {
      const res = await fetch(`${API}/bills`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          vendorName: vendorName.trim(),
          amountCents: Math.round(Number(amount) * 100),
          dueDate,
          description: description.trim() || undefined,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error || `${res.status}`);
      setVendorName(''); setAmount(''); setDescription('');
      setShowForm(false);
      await load(tab);
    } catch (e) {
      setErr(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const payBill = async (id: string) => {
    if (!confirm('Mark this bill as paid? This records the expense in your ledger.')) return;
    await fetch(`${API}/bills/${id}?action=pay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    await load(tab);
  };

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
            <Receipt className="w-5 h-5" /> Bills
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">Track what you owe vendors and pay on time.</p>
        </div>
        <button
          onClick={() => setShowForm((s) => !s)}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:opacity-90"
        >
          {showForm ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
          {showForm ? 'Cancel' : 'Add bill'}
        </button>
      </div>

      <ExpenseTabs active="bills" />

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 mb-5">
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground">Open (owed)</p>
          <p className="text-2xl font-bold text-foreground">{fmt$(summary.openCents)}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground">Overdue</p>
          <p className="text-2xl font-bold text-destructive">{fmt$(summary.overdueCents)}</p>
        </div>
      </div>

      {showForm && (
        <div className="rounded-xl border border-border bg-card p-4 mb-5 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input value={vendorName} onChange={(e) => setVendorName(e.target.value)} placeholder="Vendor (e.g. Landlord)"
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground" />
            <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount"
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground" />
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground" />
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description (optional)"
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground" />
          </div>
          <button onClick={() => void addBill()} disabled={submitting || !vendorName || !amount}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50">
            {submitting ? 'Saving…' : 'Save bill'}
          </button>
        </div>
      )}

      {err && <p className="text-sm text-destructive mb-3">{err}</p>}

      {/* Tabs */}
      <div className="flex border-b border-border mb-4">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px capitalize transition-colors ${
              tab === t ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}>
            {t}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground py-10 text-center">Loading…</p>
      ) : bills.length === 0 ? (
        <p className="text-sm text-muted-foreground py-10 text-center">No bills here.</p>
      ) : (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-muted-foreground border-b border-border">
                <th className="text-left px-4 py-2">Vendor</th>
                <th className="text-left px-4 py-2">Due</th>
                <th className="text-right px-4 py-2">Amount</th>
                <th className="text-left px-4 py-2">Status</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {bills.map((b) => (
                <tr key={b.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2.5 text-foreground font-medium">
                    {b.vendorName}
                    {b.description && <span className="block text-xs text-muted-foreground">{b.description}</span>}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {new Date(b.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </td>
                  <td className="px-4 py-2.5 text-right text-foreground">{fmt$(b.amountCents)}</td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium capitalize ${STATUS_STYLE[b.effectiveStatus] ?? ''}`}>
                      {b.effectiveStatus}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {b.status === 'open' && (
                      <button onClick={() => void payBill(b.id)}
                        className="text-xs font-medium text-primary hover:underline">
                        Pay
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default BillsPage;
