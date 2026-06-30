'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Wallet, Plus, TrendingUp, TrendingDown, PiggyBank, Briefcase, Loader2 } from 'lucide-react';

const API = '/api/v1/agentbook-personal';

interface Account {
  id: string;
  name: string;
  type: string;
  balanceCents: number;
  isAsset: boolean;
}
interface Snapshot {
  netWorthCents: number;
  assetsCents: number;
  liabilitiesCents: number;
  accountCount: number;
  month: {
    incomeCents: number;
    spendingCents: number;
    savingsRate: number;
    businessFlaggedCents: number;
    spendByCategory: { category: string; amountCents: number }[];
  };
}

const fmt$ = (cents: number) =>
  (cents < 0 ? '-' : '') + '$' + Math.abs(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });

const ACCOUNT_TYPES = [
  { value: 'checking', label: 'Checking' },
  { value: 'savings', label: 'Savings' },
  { value: 'investment', label: 'Investment' },
  { value: 'cash', label: 'Cash' },
  { value: 'credit', label: 'Credit card' },
  { value: 'mortgage', label: 'Mortgage / loan' },
];

export default function PersonalFinancePage() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState('checking');
  const [balance, setBalance] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [snapRes, acctRes] = await Promise.all([
        fetch(`${API}/snapshot`).then((r) => r.json()),
        fetch(`${API}/accounts`).then((r) => r.json()),
      ]);
      if (snapRes?.success) setSnapshot(snapRes.data);
      if (acctRes?.success) setAccounts(acctRes.data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const addAccount = async () => {
    setSaving(true);
    try {
      await fetch(`${API}/accounts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), type, balanceCents: Math.round(Number(balance || '0') * 100) }),
      });
      setName(''); setBalance(''); setType('checking'); setShowForm(false);
      await load();
    } finally {
      setSaving(false);
    }
  };

  if (loading && !snapshot) {
    return <div className="flex items-center justify-center py-24"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>;
  }

  const m = snapshot?.month;

  return (
    <div className="max-w-4xl mx-auto p-4 sm:p-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
            <Wallet className="w-5 h-5" /> Personal finance
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Your household money, kept separate from the business books.
          </p>
        </div>
        <button onClick={() => setShowForm((s) => !s)}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:opacity-90">
          <Plus className="w-4 h-4" /> Add account
        </button>
      </div>

      {/* Net worth + month stats */}
      <div className="rounded-xl border border-border bg-card p-6 text-center mb-5">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Net worth</p>
        <p className="text-4xl sm:text-5xl font-bold text-foreground">{fmt$(snapshot?.netWorthCents ?? 0)}</p>
        <p className="mt-2 text-sm text-muted-foreground">
          {fmt$(snapshot?.assetsCents ?? 0)} assets &minus; {fmt$(snapshot?.liabilitiesCents ?? 0)} liabilities
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <Stat icon={<TrendingUp className="w-4 h-4 text-primary" />} label="Income (mo)" value={fmt$(m?.incomeCents ?? 0)} />
        <Stat icon={<TrendingDown className="w-4 h-4 text-destructive" />} label="Spending (mo)" value={fmt$(m?.spendingCents ?? 0)} />
        <Stat icon={<PiggyBank className="w-4 h-4 text-primary" />} label="Savings rate" value={`${m?.savingsRate ?? 0}%`} />
        <Stat icon={<Briefcase className="w-4 h-4 text-violet-400" />} label="Business-flagged" value={fmt$(m?.businessFlaggedCents ?? 0)} />
      </div>

      {showForm && (
        <div className="rounded-xl border border-border bg-card p-4 mb-5 grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Account name"
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground" />
          <select value={type} onChange={(e) => setType(e.target.value)}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground">
            {ACCOUNT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          <input type="number" value={balance} onChange={(e) => setBalance(e.target.value)} placeholder="Balance"
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground" />
          <button onClick={() => void addAccount()} disabled={saving || !name}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}

      {/* Accounts */}
      <h2 className="text-sm font-semibold text-foreground mb-2">Accounts</h2>
      {accounts.length === 0 ? (
        <p className="text-sm text-muted-foreground py-6 text-center rounded-xl border border-border bg-card">
          No accounts yet. Add your checking, savings, or credit card to see your net worth.
        </p>
      ) : (
        <div className="rounded-xl border border-border bg-card divide-y divide-border mb-6">
          {accounts.map((a) => (
            <div key={a.id} className="flex items-center justify-between px-4 py-3">
              <div>
                <p className="text-sm font-medium text-foreground">{a.name}</p>
                <p className="text-xs text-muted-foreground capitalize">{a.type}</p>
              </div>
              <p className={`text-sm font-bold ${a.isAsset ? 'text-foreground' : 'text-destructive'}`}>
                {fmt$(a.balanceCents)}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Spend by category */}
      {m && m.spendByCategory.length > 0 && (
        <>
          <h2 className="text-sm font-semibold text-foreground mb-2">This month by category</h2>
          <div className="rounded-xl border border-border bg-card divide-y divide-border">
            {m.spendByCategory.map((s) => (
              <div key={s.category} className="flex items-center justify-between px-4 py-2.5">
                <span className="text-sm text-foreground capitalize">{s.category}</span>
                <span className="text-sm text-muted-foreground">{fmt$(s.amountCents)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="flex items-center gap-1.5 mb-1">{icon}<span className="text-xs text-muted-foreground">{label}</span></div>
      <p className="text-lg font-bold text-foreground">{value}</p>
    </div>
  );
}
