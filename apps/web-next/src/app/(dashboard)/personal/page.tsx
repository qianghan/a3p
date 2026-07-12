'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  Wallet, Plus, TrendingUp, TrendingDown, PiggyBank, Briefcase, Loader2,
  Receipt, Target, ArrowUpCircle, ArrowDownCircle,
} from 'lucide-react';
import { formatCurrencyCents } from '@/lib/jurisdiction-currency';

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
interface Transaction {
  id: string;
  accountId: string;
  description: string;
  amountCents: number;
  date: string;
  category: string;
  businessFlag: boolean;
}
interface Budget {
  id: string;
  category: string;
  monthlyLimitCents: number;
  spentCents: number;
  remainingCents: number;
  percent: number;
}

const ACCOUNT_TYPES = [
  { value: 'checking', label: 'Checking' },
  { value: 'savings', label: 'Savings' },
  { value: 'investment', label: 'Investment' },
  { value: 'cash', label: 'Cash' },
  { value: 'credit', label: 'Credit card' },
  { value: 'mortgage', label: 'Mortgage / loan' },
];

const COMMON_CATEGORIES = [
  'groceries', 'dining', 'rent', 'utilities', 'transportation', 'entertainment',
  'subscriptions', 'healthcare', 'shopping', 'travel', 'salary', 'freelance',
  'investment', 'gift', 'other',
];

// Local date, not UTC — toISOString() reports the UTC date, which reads as
// "yesterday" for local-midnight-to-~7am in US Pacific (and similar) time zones.
const todayStr = () => {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

export default function PersonalFinancePage() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [currency, setCurrency] = useState('USD');
  const [locale, setLocale] = useState('en-US');
  const [loading, setLoading] = useState(true);

  // Add account
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState('checking');
  const [balance, setBalance] = useState('');
  const [saving, setSaving] = useState(false);

  // Record transaction
  const [showTxnForm, setShowTxnForm] = useState(false);
  const [txnFilter, setTxnFilter] = useState('');
  const [txnAccountId, setTxnAccountId] = useState('');
  const [txnDescription, setTxnDescription] = useState('');
  const [txnAmount, setTxnAmount] = useState('');
  const [txnDirection, setTxnDirection] = useState<'income' | 'spend'>('spend');
  const [txnCategory, setTxnCategory] = useState('');
  const [txnDate, setTxnDate] = useState(todayStr());
  const [txnBusinessFlag, setTxnBusinessFlag] = useState(false);
  const [savingTxn, setSavingTxn] = useState(false);

  // Set budget
  const [showBudgetForm, setShowBudgetForm] = useState(false);
  const [budgetCategory, setBudgetCategory] = useState('');
  const [budgetLimit, setBudgetLimit] = useState('');
  const [savingBudget, setSavingBudget] = useState(false);

  const fetchTransactions = useCallback(async (accountId: string) => {
    const qs = accountId ? `?accountId=${encodeURIComponent(accountId)}` : '';
    const res = await fetch(`${API}/transactions${qs}`).then((r) => r.json());
    if (res?.success) setTransactions(res.data);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [snapRes, acctRes, budgetRes, cfgRes] = await Promise.all([
        fetch(`${API}/snapshot`).then((r) => r.json()),
        fetch(`${API}/accounts`).then((r) => r.json()),
        fetch(`${API}/budget`).then((r) => r.json()),
        fetch('/api/v1/agentbook-core/tenant-config').then((r) => r.json()),
      ]);
      if (snapRes?.success) setSnapshot(snapRes.data);
      if (acctRes?.success) setAccounts(acctRes.data);
      if (budgetRes?.success) setBudgets(budgetRes.data);
      if (cfgRes?.success) {
        setCurrency(cfgRes.data?.currency || 'USD');
        setLocale(cfgRes.data?.locale || 'en-US');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void fetchTransactions(txnFilter); }, [fetchTransactions, txnFilter]);

  // Default the transaction form's account picker to the first account once
  // accounts load, so the form is usable without an extra click.
  useEffect(() => {
    if (!txnAccountId && accounts.length > 0) setTxnAccountId(accounts[0].id);
  }, [accounts, txnAccountId]);

  const fmt$ = useCallback((cents: number) => formatCurrencyCents(cents, currency, locale), [currency, locale]);

  // Transactions are stored as a UTC-midnight timestamp (see the
  // transactions route's `date: body.date ? new Date(body.date) : new
  // Date()`). `new Date(iso).toLocaleDateString()` lets the browser
  // reinterpret that UTC midnight in the local timezone, which reads as
  // "yesterday" west of UTC (e.g. US Pacific) for a transaction recorded
  // "today". Build the display date from the UTC Y/M/D components instead,
  // so the shown date matches what was actually recorded — same fix
  // `todayStr()` above already applies to the date *input*'s default.
  const fmtTxnDate = useCallback((iso: string) => {
    const d = new Date(iso);
    return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()).toLocaleDateString(locale);
  }, [locale]);

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

  const addTransaction = async () => {
    if (!txnAccountId || !txnDescription.trim() || !txnAmount) return;
    setSavingTxn(true);
    try {
      const magnitudeCents = Math.round(Number(txnAmount || '0') * 100);
      const amountCents = txnDirection === 'income' ? Math.abs(magnitudeCents) : -Math.abs(magnitudeCents);
      await fetch(`${API}/transactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          accountId: txnAccountId,
          description: txnDescription.trim(),
          amountCents,
          category: txnCategory.trim() || undefined,
          date: txnDate || undefined,
          businessFlag: txnBusinessFlag,
        }),
      });
      setTxnDescription(''); setTxnAmount(''); setTxnCategory('');
      setTxnBusinessFlag(false); setTxnDirection('spend'); setTxnDate(todayStr());
      setShowTxnForm(false);
      await Promise.all([load(), fetchTransactions(txnFilter)]);
    } finally {
      setSavingTxn(false);
    }
  };

  const addBudget = async () => {
    if (!budgetCategory.trim() || !budgetLimit) return;
    setSavingBudget(true);
    try {
      await fetch(`${API}/budget`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          category: budgetCategory.trim(),
          monthlyLimitCents: Math.round(Number(budgetLimit || '0') * 100),
        }),
      });
      setBudgetCategory(''); setBudgetLimit(''); setShowBudgetForm(false);
      await load();
    } finally {
      setSavingBudget(false);
    }
  };

  if (loading && !snapshot) {
    return <div className="flex items-center justify-center py-24"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>;
  }

  const m = snapshot?.month;

  return (
    <div className="max-w-4xl mx-auto p-4 sm:p-6">
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
            <Wallet className="w-5 h-5" /> Personal finance
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Your household money, kept separate from the business books.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={() => setShowForm((s) => !s)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:opacity-90">
            <Plus className="w-4 h-4" /> Add account
          </button>
          <button onClick={() => setShowTxnForm((s) => !s)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:opacity-90">
            <Plus className="w-4 h-4" /> Record transaction
          </button>
          <button onClick={() => setShowBudgetForm((s) => !s)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:opacity-90">
            <Plus className="w-4 h-4" /> Set budget
          </button>
        </div>
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
          <input name="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Account name"
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground" />
          <select name="type" value={type} onChange={(e) => setType(e.target.value)}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground">
            {ACCOUNT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          <input name="balance" type="number" value={balance} onChange={(e) => setBalance(e.target.value)} placeholder="Balance"
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
        <p className="text-sm text-muted-foreground py-6 text-center rounded-xl border border-border bg-card mb-6">
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

      {/* Record transaction */}
      {showTxnForm && (
        accounts.length === 0 ? (
          <div className="rounded-xl border border-border bg-card p-4 mb-5 text-sm text-muted-foreground">
            Add a personal account above before recording a transaction.
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-card p-4 mb-5 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <select name="accountId" value={txnAccountId} onChange={(e) => setTxnAccountId(e.target.value)}
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground">
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              <input name="description" value={txnDescription} onChange={(e) => setTxnDescription(e.target.value)}
                placeholder="Description"
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground" />
              <input name="category" list="personal-categories" value={txnCategory}
                onChange={(e) => setTxnCategory(e.target.value)} placeholder="Category"
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="flex rounded-lg border border-border overflow-hidden text-xs font-medium">
                <button type="button" onClick={() => setTxnDirection('income')}
                  className={`flex-1 flex items-center justify-center gap-1 px-3 py-2 ${
                    txnDirection === 'income' ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground'
                  }`}>
                  <ArrowUpCircle className="w-3.5 h-3.5" /> Income
                </button>
                <button type="button" onClick={() => setTxnDirection('spend')}
                  className={`flex-1 flex items-center justify-center gap-1 px-3 py-2 ${
                    txnDirection === 'spend' ? 'bg-destructive text-destructive-foreground' : 'bg-background text-muted-foreground'
                  }`}>
                  <ArrowDownCircle className="w-3.5 h-3.5" /> Spend
                </button>
              </div>
              <input name="amount" type="number" min="0" step="0.01" value={txnAmount}
                onChange={(e) => setTxnAmount(e.target.value)} placeholder="Amount"
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground" />
              <input name="date" type="date" value={txnDate} onChange={(e) => setTxnDate(e.target.value)}
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground" />
            </div>
            <div className="flex items-center justify-between flex-wrap gap-2">
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input name="businessFlag" type="checkbox" checked={txnBusinessFlag}
                  onChange={(e) => setTxnBusinessFlag(e.target.checked)} className="rounded border-border" />
                This is a business expense
              </label>
              <button onClick={() => void addTransaction()}
                disabled={savingTxn || !txnAccountId || !txnDescription.trim() || !txnAmount}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50">
                {savingTxn ? 'Saving…' : 'Save transaction'}
              </button>
            </div>
          </div>
        )
      )}

      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <h2 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
          <Receipt className="w-4 h-4" /> Transactions
        </h2>
        {accounts.length > 0 && (
          <select name="txnFilter" value={txnFilter} onChange={(e) => setTxnFilter(e.target.value)}
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-xs text-foreground">
            <option value="">All accounts</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        )}
      </div>
      {transactions.length === 0 ? (
        <p className="text-sm text-muted-foreground py-6 text-center rounded-xl border border-border bg-card mb-6">
          No transactions yet. Record income or a spend above.
        </p>
      ) : (
        <div className="rounded-xl border border-border bg-card divide-y divide-border mb-6">
          {transactions.map((t) => (
            <div key={t.id} className="flex items-center justify-between px-4 py-3 gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground truncate">{t.description}</p>
                <p className="text-xs text-muted-foreground">
                  {fmtTxnDate(t.date)} &middot; <span className="capitalize">{t.category}</span>
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {t.businessFlag && (
                  <span className="px-2 py-0.5 text-xs rounded-full bg-violet-500/10 text-violet-400">Business</span>
                )}
                <span className={`text-sm font-bold ${t.amountCents >= 0 ? 'text-emerald-500' : 'text-destructive'}`}>
                  {t.amountCents >= 0 ? '+' : ''}{fmt$(t.amountCents)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Set budget */}
      {showBudgetForm && (
        <div className="rounded-xl border border-border bg-card p-4 mb-5 grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
          <input name="budgetCategory" list="personal-categories" value={budgetCategory}
            onChange={(e) => setBudgetCategory(e.target.value)} placeholder="Category"
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground" />
          <input name="monthlyLimit" type="number" min="0" step="0.01" value={budgetLimit}
            onChange={(e) => setBudgetLimit(e.target.value)} placeholder="Monthly limit"
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground" />
          <button onClick={() => void addBudget()} disabled={savingBudget || !budgetCategory.trim() || !budgetLimit}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50">
            {savingBudget ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}

      <h2 className="text-sm font-semibold text-foreground mb-2 flex items-center gap-1.5">
        <Target className="w-4 h-4" /> Budgets
      </h2>
      {budgets.length === 0 ? (
        <p className="text-sm text-muted-foreground py-6 text-center rounded-xl border border-border bg-card mb-6">
          No budgets yet. Set a monthly limit for a category to track your spending.
        </p>
      ) : (
        <div className="rounded-xl border border-border bg-card divide-y divide-border mb-6">
          {budgets.map((b) => (
            <div key={b.id} className="px-4 py-3">
              <div className="flex items-center justify-between mb-1.5 gap-3">
                <p className="text-sm font-medium text-foreground capitalize">{b.category}</p>
                <p className="text-xs text-muted-foreground text-right">
                  {fmt$(b.spentCents)} of {fmt$(b.monthlyLimitCents)} &middot;{' '}
                  <span className={b.remainingCents < 0 ? 'text-destructive font-medium' : ''}>
                    {fmt$(b.remainingCents)} left
                  </span>
                </p>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                  <div className={`h-full rounded-full transition-all ${b.percent >= 100 ? 'bg-destructive' : 'bg-primary'}`}
                    style={{ width: `${Math.min(b.percent, 100)}%` }} />
                </div>
                <span className="text-xs text-muted-foreground w-10 text-right">{b.percent}%</span>
              </div>
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

      <datalist id="personal-categories">
        {COMMON_CATEGORIES.map((c) => <option key={c} value={c} />)}
      </datalist>
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
