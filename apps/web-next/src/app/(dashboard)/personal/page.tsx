'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Wallet, Plus, TrendingUp, TrendingDown, PiggyBank, Briefcase, Loader2,
  Receipt, Target, ArrowUpCircle, ArrowDownCircle, LineChart, Lock, Sparkles,
  Building2, Link2, RefreshCw, CheckCircle, AlertCircle,
} from 'lucide-react';
import { usePlaidLink } from 'react-plaid-link';
import { useBasiqConnect } from '@naap/plugin-sdk';
import { formatCurrencyCents } from '@/lib/jurisdiction-currency';
import { SubscribeModal } from '@/components/settings/SubscribeModal';

const API = '/api/v1/agentbook-personal';

interface Account {
  id: string;
  name: string;
  type: string;
  balanceCents: number;
  isAsset: boolean;
  plaidAccountId: string | null;
  institution: string | null;
  connected: boolean;
  lastSynced: string | null;
  provider?: string;
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
interface TrendPoint {
  month: string; // "YYYY-MM"
  netWorthCents: number;
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
  const [jurisdiction, setJurisdiction] = useState('us');
  const [loading, setLoading] = useState(true);

  // Net worth trend (Personal Insights add-on)
  const [trend, setTrend] = useState<TrendPoint[] | null>(null);
  const [trendGated, setTrendGated] = useState(false);
  const [showAddonSubscribe, setShowAddonSubscribe] = useState(false);
  const [addonPrice, setAddonPrice] = useState<{ priceCents: number } | null>(null);

  // Bank sync (Plaid)
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [connectingBank, setConnectingBank] = useState(false);
  const [syncingBank, setSyncingBank] = useState(false);
  const [bankResult, setBankResult] = useState<string | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      const [snapRes, acctRes, budgetRes, cfgRes, trendRes] = await Promise.all([
        fetch(`${API}/snapshot`).then((r) => r.json()),
        fetch(`${API}/accounts`).then((r) => r.json()),
        fetch(`${API}/budget`).then((r) => r.json()),
        fetch('/api/v1/agentbook-core/tenant-config').then((r) => r.json()),
        fetch(`${API}/trend`).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) })),
      ]);
      if (snapRes?.success) setSnapshot(snapRes.data);
      if (acctRes?.success) setAccounts(acctRes.data);
      if (budgetRes?.success) setBudgets(budgetRes.data);
      if (cfgRes?.success) {
        setCurrency(cfgRes.data?.currency || 'USD');
        setLocale(cfgRes.data?.locale || 'en-US');
        setJurisdiction(cfgRes.data?.jurisdiction || 'us');
      }
      // 200 -> unlocked chart; 402 -> gated teaser; anything else (e.g. a
      // transient 500) -> show neither rather than a broken chart or a
      // false "upgrade" prompt.
      if (trendRes.status === 200 && trendRes.json?.success) {
        setTrend(trendRes.json.data);
        setTrendGated(false);
      } else if (trendRes.status === 402) {
        setTrend(null);
        setTrendGated(true);
      } else {
        setTrend(null);
        setTrendGated(false);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void fetchTransactions(txnFilter); }, [fetchTransactions, txnFilter]);

  useEffect(() => {
    fetch('/api/v1/agentbook-billing/me/addons')
      .then((r) => r.json())
      .then((j) => {
        const pi = (j.addons ?? []).find((a: { code: string }) => a.code === 'personal_insights');
        if (pi?.price) setAddonPrice(pi.price);
      })
      .catch(() => {});
  }, []);

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

  const clearBankWatchdog = useCallback(() => {
    if (watchdogRef.current) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, []);

  // AU tenants use Basiq instead of Plaid (Plaid has no AU country code at
  // all — createLinkToken() only ever requests US/CA institutions). Shares
  // the popup-open + postMessage-listener + status-poll flow with the
  // business-side BankConnection.tsx (AU-1 Task 3) via `useBasiqConnect`.
  const basiqConnect = useBasiqConnect({
    apiBase: API,
    onConnected: async (accountsLinked: number) => {
      setBankResult(`Connected ${accountsLinked} account(s)`);
      await load();
    },
  });

  const handleStartBankConnectBasiq = useCallback(async () => {
    basiqConnect.setConnecting(true);
    basiqConnect.clearError();
    setBankResult(null);
    try {
      const res = await fetch(`${API}/bank/basiq/consent-url`, { method: 'POST' });
      const data = await res.json();
      if (res.status === 402) {
        setBankResult('Bank sync is part of Personal Insights — enable it above to sync.');
        basiqConnect.setConnecting(false);
        return;
      }
      if (!data.success) {
        setBankResult('Failed to start bank connection: ' + (data.error || 'Unknown error'));
        basiqConnect.setConnecting(false);
        return;
      }
      basiqConnect.startConnect(data.data.consentUrl);
    } catch (err) {
      setBankResult('Connection error: ' + String(err));
      basiqConnect.setConnecting(false);
    }
  }, [basiqConnect]);

  const handleStartBankConnect = async () => {
    if (jurisdiction === 'au') {
      await handleStartBankConnectBasiq();
      return;
    }
    setConnectingBank(true);
    try {
      const res = await fetch(`${API}/plaid/link-token`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setLinkToken(data.data.linkToken);
      } else {
        setBankResult('Failed to start bank connection: ' + (data.error || 'Unknown error'));
        setConnectingBank(false);
      }
    } catch (err) {
      setBankResult('Connection error: ' + String(err));
      setConnectingBank(false);
    }
  };

  const onPlaidSuccess = useCallback(async (publicToken: string, metadata: any) => {
    clearBankWatchdog();
    setConnectingBank(true);
    try {
      const res = await fetch(`${API}/plaid/exchange`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ publicToken, institutionName: metadata.institution?.name }),
      });
      const data = await res.json();
      if (data.success) {
        setBankResult(`Connected ${data.data.accounts?.length || 0} account(s) from ${metadata.institution?.name || 'bank'}`);
        await load();
      }
    } catch (err) {
      setBankResult('Failed to connect: ' + String(err));
    }
    setConnectingBank(false);
    setLinkToken(null);
  }, [load, clearBankWatchdog]);

  const { open: openPlaidLink, ready: plaidReady, exit: exitPlaidLink } = usePlaidLink({
    token: linkToken,
    onSuccess: onPlaidSuccess,
    onExit: () => { clearBankWatchdog(); setLinkToken(null); setConnectingBank(false); },
  });

  // Same 45s stuck-Link watchdog as BankConnection.tsx (the expense-side
  // equivalent) — Plaid's hosted Link UI can occasionally freeze mid-flow.
  const armBankWatchdog = useCallback(() => {
    clearBankWatchdog();
    watchdogRef.current = setTimeout(() => {
      const keepWaiting = !window.confirm(
        'Bank connection is taking longer than expected.\n\nClick OK to cancel and try again, or Cancel to keep waiting a bit longer.'
      );
      if (keepWaiting) {
        armBankWatchdog();
      } else {
        exitPlaidLink({ force: true });
        setLinkToken(null);
        setConnectingBank(false);
      }
    }, 45000);
  }, [clearBankWatchdog, exitPlaidLink]);

  useEffect(() => {
    if (linkToken && plaidReady) {
      openPlaidLink();
      armBankWatchdog();
    }
    return clearBankWatchdog;
  }, [linkToken, plaidReady, openPlaidLink, armBankWatchdog, clearBankWatchdog]);

  const handleBankSync = async () => {
    setSyncingBank(true);
    setBankResult(null);
    try {
      const res = await fetch(`${API}/plaid/sync`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setBankResult(`Synced ${data.data.accountsSynced} account(s). Imported ${data.data.transactionsImported} transactions.`);
      } else if (res.status === 402) {
        setBankResult('Bank sync is part of Personal Insights — enable it above to sync.');
      }
      await load();
    } finally {
      setSyncingBank(false);
    }
  };

  const handleBankDisconnect = async (accountId: string, provider?: string) => {
    if (!confirm('Disconnect this bank account? Historical transactions are kept.')) return;
    const path = provider === 'basiq' ? `${API}/bank/basiq/disconnect` : `${API}/plaid/disconnect`;
    await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId }),
    });
    await load();
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

      {/* Net worth trend (Personal Insights add-on) */}
      <h2 className="text-sm font-semibold text-foreground mb-2 flex items-center gap-1.5">
        <LineChart className="w-4 h-4" /> Net worth trend
      </h2>
      {trend && trend.length > 0 ? (
        <div className="rounded-xl border border-border bg-card p-4 mb-6">
          <NetWorthTrendChart points={trend} fmt$={fmt$} />
        </div>
      ) : trendGated ? (
        <div className="rounded-xl border border-border bg-card p-6 mb-6 text-center">
          <Lock className="w-5 h-5 text-muted-foreground mx-auto mb-2" />
          <p className="text-sm font-medium text-foreground mb-1">Personal Insights</p>
          <p className="text-sm text-muted-foreground max-w-md mx-auto mb-4">
            Net-worth trends and proactive nudges — budget alerts, monthly net-worth changes, and
            savings-rate warnings — are part of Personal Insights.
          </p>
          {addonPrice && (
            <button onClick={() => setShowAddonSubscribe(true)}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50">
              <Sparkles className="w-4 h-4" /> Enable Personal Insights
            </button>
          )}
        </div>
      ) : null}
      {showAddonSubscribe && addonPrice && (
        <SubscribeModal
          target={{ kind: 'addon', code: 'personal_insights', name: 'Personal Insights', priceCents: addonPrice.priceCents, interval: 'month', region: jurisdiction }}
          onClose={() => setShowAddonSubscribe(false)}
          onSubscribed={() => { setShowAddonSubscribe(false); load(); }}
        />
      )}

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
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-foreground">Accounts</h2>
        <div className="flex gap-2">
          {accounts.some((a) => a.plaidAccountId) && (
            <button onClick={handleBankSync} disabled={syncingBank}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-muted text-foreground rounded-lg text-xs hover:bg-muted/80 transition-colors disabled:opacity-50">
              <RefreshCw className={`w-3.5 h-3.5 ${syncingBank ? 'animate-spin' : ''}`} />
              {syncingBank ? 'Syncing…' : 'Sync bank'}
            </button>
          )}
          <button onClick={handleStartBankConnect} disabled={connectingBank || basiqConnect.connecting}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-xs hover:bg-primary/90 transition-colors disabled:opacity-50">
            {(connectingBank || basiqConnect.connecting) ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />}
            Connect bank
          </button>
        </div>
      </div>
      {bankResult && (
        <div className="mb-4 p-3 rounded-xl text-sm bg-blue-500/10 text-blue-600 border border-blue-500/20 flex items-center gap-2">
          <Building2 className="w-4 h-4 shrink-0" />
          {bankResult}
          <button onClick={() => setBankResult(null)} className="ml-auto text-xs opacity-60 hover:opacity-100">Dismiss</button>
        </div>
      )}
      {basiqConnect.error && (
        <div className="mb-4 p-3 rounded-xl text-sm bg-red-500/10 text-red-600 border border-red-500/20 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {basiqConnect.error}
          <button onClick={basiqConnect.clearError} className="ml-auto text-xs opacity-60 hover:opacity-100">Dismiss</button>
        </div>
      )}
      {accounts.length === 0 ? (
        <p className="text-sm text-muted-foreground py-6 text-center rounded-xl border border-border bg-card mb-6">
          No accounts yet. Add your checking, savings, or credit card to see your net worth, or connect a bank above.
        </p>
      ) : (
        <div className="rounded-xl border border-border bg-card divide-y divide-border mb-6">
          {accounts.map((a) => (
            <div key={a.id} className="flex items-center justify-between px-4 py-3">
              <div>
                <p className="text-sm font-medium text-foreground">{a.name}</p>
                <p className="text-xs text-muted-foreground capitalize">{a.type}</p>
                {(a.plaidAccountId || a.provider === 'basiq') && (
                  <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                    {a.connected ? <CheckCircle className="w-3 h-3 text-green-500" /> : <AlertCircle className="w-3 h-3 text-red-500" />}
                    {a.institution || 'Bank'} · {a.lastSynced ? `Synced ${new Date(a.lastSynced).toLocaleDateString()}` : 'Not synced'}
                    <button onClick={() => handleBankDisconnect(a.id, a.provider)} className="ml-2 underline hover:no-underline">Disconnect</button>
                  </p>
                )}
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

// Minimal hand-rolled SVG line/area chart for the 12-point net-worth trend.
// No new charting dependency: `recharts` is listed in package.json but isn't
// actually installed (no node_modules/recharts) or used anywhere else in
// this app, and this is a single simple 12-point line — a small inline SVG
// is a better fit than pulling in and wiring up an unused library.
function NetWorthTrendChart({ points, fmt$ }: { points: TrendPoint[]; fmt$: (cents: number) => string }) {
  const width = 640;
  const height = 160;
  const padX = 8;
  const padTop = 12;
  const padBottom = 22;
  const plotHeight = height - padTop - padBottom;

  const values = points.map((p) => p.netWorthCents);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = points.length > 1 ? (width - padX * 2) / (points.length - 1) : 0;

  const coords = points.map((p, i) => ({
    x: padX + i * stepX,
    y: padTop + (1 - (p.netWorthCents - min) / range) * plotHeight,
    ...p,
  }));

  const linePath = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${coords[coords.length - 1].x.toFixed(1)},${height - padBottom} `
    + `L${coords[0].x.toFixed(1)},${height - padBottom} Z`;

  const monthShort = (month: string) => {
    const [y, mo] = month.split('-').map(Number);
    return new Date(y, mo - 1, 1).toLocaleDateString(undefined, { month: 'short' });
  };

  const first = points[0];
  const last = points[points.length - 1];

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto text-primary" role="img"
        aria-label="Net worth trend, last 12 months">
        <path d={areaPath} fill="currentColor" fillOpacity={0.12} stroke="none" />
        <path d={linePath} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {coords.map((c) => (
          <circle key={c.month} cx={c.x} cy={c.y} r={3} fill="currentColor" data-month={c.month}
            data-net-worth-cents={c.netWorthCents}>
            <title>{`${monthShort(c.month)} ${c.month.slice(0, 4)}: ${fmt$(c.netWorthCents)}`}</title>
          </circle>
        ))}
        {coords.map((c, i) => (
          (i === 0 || i === coords.length - 1 || i % 3 === 0) && (
            <text key={`label-${c.month}`} x={c.x} y={height - 6} fontSize={10} fill="currentColor"
              className="text-muted-foreground"
              textAnchor={i === 0 ? 'start' : i === coords.length - 1 ? 'end' : 'middle'}>
              {monthShort(c.month)}
            </text>
          )
        ))}
      </svg>
      <div className="flex items-center justify-between mt-1 text-xs text-muted-foreground">
        <span>{monthShort(first.month)} {first.month.slice(0, 4)}</span>
        <span className="text-sm font-bold text-foreground">{fmt$(last.netWorthCents)}</span>
        <span>{monthShort(last.month)} {last.month.slice(0, 4)}</span>
      </div>
    </div>
  );
}
