import React, { useEffect, useState, useCallback, useRef } from 'react';
import { usePlaidLink } from 'react-plaid-link';
import { Building2, Link2, RefreshCw, CheckCircle, AlertCircle, Plus, Clock, Loader2 } from 'lucide-react';
import { ChatCTA } from '@naap/plugin-sdk';
import { formatMoney } from '@agentbook/i18n';
import { useTenantCurrency } from '../hooks/useTenantCurrency';

interface BankAccount {
  id: string;
  name: string;
  officialName: string | null;
  type: string;
  subtype: string | null;
  mask: string | null;
  balanceCents: number;
  currency: string;
  institution: string | null;
  connected: boolean;
  lastSynced: string | null;
  transactionCount?: number;
  provider?: string;
}

interface BankTransaction {
  id: string;
  amount: number;
  date: string;
  merchantName: string | null;
  name: string;
  category: string | null;
  pending: boolean;
  matchStatus: string;
}

interface ReconciliationSummary {
  totalTransactions: number;
  matched: number;
  exceptions: number;
  pending: number;
  matchRate: number;
}

const API = '/api/v1/agentbook-expense';

// Plaid's hosted Link UI can occasionally freeze mid-flow (observed in sandbox:
// the account-selection "Continue" pane sometimes never advances and never
// calls onSuccess/onExit). Without a watchdog the user is stuck staring at
// Plaid's full-viewport overlay (z-index 2147483647, so nothing we render can
// cover it) with no way back except abandoning the tab. window.confirm is used
// for the recovery prompt specifically because it renders as browser chrome,
// which is the only thing guaranteed to sit above Plaid's overlay.
const PLAID_STUCK_TIMEOUT_MS = 45000;

// Basiq's hosted Consent UI can involve multi-step bank login/MFA — this is
// a legitimately slow (but healthy) flow, not the frozen-iframe failure mode
// Plaid's PLAID_STUCK_TIMEOUT_MS watchdog above guards against. Give it
// materially longer before giving up.
const BASIQ_TIMEOUT_MS = 5 * 60 * 1000;
const BASIQ_POLL_MS = 3000;

function fmt(cents: number, currency: string) {
  return formatMoney(Math.abs(cents), currency);
}

export const BankConnectionPage: React.FC = () => {
  const currency = useTenantCurrency();
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [transactions, setTransactions] = useState<BankTransaction[]>([]);
  const [reconciliation, setReconciliation] = useState<ReconciliationSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [syncResult, setSyncResult] = useState<any>(null);
  const [jurisdiction, setJurisdiction] = useState<string>('us');
  const [basiqError, setBasiqError] = useState<string | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const basiqPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const basiqMessageHandlerRef = useRef<((event: MessageEvent) => void) | null>(null);
  const basiqCloseWatchRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearPlaidWatchdog = useCallback(() => {
    if (watchdogRef.current) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, []);

  const fetchData = useCallback(async () => {
    try {
      const [accts, recon, txns] = await Promise.all([
        fetch(`${API}/bank-accounts`).then(r => r.json()).catch(() => ({ data: [] })),
        fetch(`${API}/reconciliation-summary`).then(r => r.json()).catch(() => ({ data: null })),
        fetch(`${API}/bank-transactions?limit=20`).then(r => r.json()).catch(() => ({ data: [] })),
      ]);
      if (accts.data) setAccounts(accts.data);
      if (recon.data) setReconciliation(recon.data);
      if (txns.data) setTransactions(txns.data);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Tenant jurisdiction — same tenant-config fetch pattern used elsewhere in
  // this plugin (e.g. TaxDashboard.tsx's SettingsTab) — used only to decide
  // whether "Connect Bank" should drive the Plaid Link flow or Basiq's
  // hosted Consent UI (AU has no Plaid support).
  useEffect(() => {
    let active = true;
    fetch('/api/v1/agentbook-core/tenant-config')
      .then(r => (r.ok ? r.json() : null))
      .then(json => {
        if (!active || !json?.data) return;
        setJurisdiction(json.data.jurisdiction ?? 'us');
      })
      .catch(() => { /* keep default 'us' */ });
    return () => { active = false; };
  }, []);

  const clearBasiqPolling = useCallback(() => {
    if (basiqPollRef.current) {
      clearInterval(basiqPollRef.current);
      basiqPollRef.current = null;
    }
    if (basiqCloseWatchRef.current) {
      clearInterval(basiqCloseWatchRef.current);
      basiqCloseWatchRef.current = null;
    }
    if (basiqMessageHandlerRef.current) {
      window.removeEventListener('message', basiqMessageHandlerRef.current);
      basiqMessageHandlerRef.current = null;
    }
  }, []);

  useEffect(() => clearBasiqPolling, [clearBasiqPolling]);

  const handleStartConnectBasiq = useCallback(async () => {
    setConnecting(true);
    setBasiqError(null);
    try {
      const res = await fetch(`${API}/bank/basiq/consent-url`, { method: 'POST' });
      const data = await res.json();
      if (!data.success) {
        setBasiqError('Failed to start bank connection: ' + (data.error || 'Unknown error'));
        setConnecting(false);
        return;
      }
      const consentUrl: string = data.data.consentUrl;
      const popup = window.open(consentUrl, 'basiq-consent', 'width=480,height=720');

      clearBasiqPolling();

      const onMessage = (event: MessageEvent) => {
        if (event.origin !== window.location.origin || !('basiqJobId' in (event.data ?? {}))) return;
        window.removeEventListener('message', onMessage);
        basiqMessageHandlerRef.current = null;
        if (basiqCloseWatchRef.current) {
          clearInterval(basiqCloseWatchRef.current);
          basiqCloseWatchRef.current = null;
        }

        const jobId = event.data.basiqJobId as string | null;
        if (!jobId) {
          // User cancelled inside Basiq's hosted UI (or the redirect
          // otherwise arrived without a valid jobId) — stop cleanly, no
          // error, matching the Plaid onExit behavior below.
          setConnecting(false);
          return;
        }

        const startedAt = Date.now();
        basiqPollRef.current = setInterval(async () => {
          if (Date.now() - startedAt > BASIQ_TIMEOUT_MS) {
            clearBasiqPolling();
            setBasiqError('Bank connection timed out — please try again.');
            setConnecting(false);
            return;
          }
          try {
            const statusRes = await fetch(`${API}/bank/basiq/status?jobId=${encodeURIComponent(jobId)}`);
            const statusJson = await statusRes.json();
            if (!statusJson.success) return; // transient — keep polling
            const status = statusJson.data;
            if (status.status === 'success') {
              clearBasiqPolling();
              setConnecting(false);
              setSyncResult({ type: 'connected', message: `Connected ${status.accountsLinked ?? 0} account(s)` });
              await fetchData();
            } else if (status.status === 'failed') {
              clearBasiqPolling();
              setBasiqError(`Bank connection failed: ${status.error ?? 'unknown error'}`);
              setConnecting(false);
            }
          } catch {
            // transient network error — keep polling until timeout
          }
        }, BASIQ_POLL_MS);
      };
      basiqMessageHandlerRef.current = onMessage;
      window.addEventListener('message', onMessage);

      // Fallback: if the popup is closed without ever posting a message
      // (user cancelled inside Basiq's UI before completing consent, or
      // simply closed the window), stop waiting.
      basiqCloseWatchRef.current = setInterval(() => {
        if (popup?.closed) {
          clearBasiqPolling();
          setConnecting(false);
        }
      }, 1000);
    } catch (err) {
      setBasiqError('Connection error: ' + String(err));
      setConnecting(false);
    }
  }, [fetchData, clearBasiqPolling]);

  const handleStartConnect = async () => {
    if (jurisdiction === 'au') {
      await handleStartConnectBasiq();
      return;
    }
    setConnecting(true);
    try {
      const res = await fetch(`${API}/plaid/link-token`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setLinkToken(data.data.linkToken);
      } else {
        alert('Failed to create link token: ' + (data.error || 'Unknown error'));
        setConnecting(false);
      }
    } catch (err) {
      alert('Connection error: ' + String(err));
      setConnecting(false);
    }
  };

  const handleDisconnect = async (accountId: string, provider?: string) => {
    if (!window.confirm('Disconnect this bank account? Historical transactions are kept.')) return;
    const path = provider === 'basiq' ? `${API}/bank/basiq/disconnect` : `${API}/plaid/disconnect`;
    try {
      await fetch(path, {
        method: 'POST',
        body: JSON.stringify({ accountId }),
        headers: { 'Content-Type': 'application/json' },
      });
      await fetchData();
    } catch (err) {
      alert('Failed to disconnect: ' + String(err));
    }
  };

  const onPlaidSuccess = useCallback(async (publicToken: string, metadata: any) => {
    clearPlaidWatchdog();
    setConnecting(true);
    try {
      const res = await fetch(`${API}/plaid/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publicToken,
          institutionName: metadata.institution?.name,
          accounts: metadata.accounts,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setSyncResult({ type: 'connected', message: `Connected ${data.data.accounts?.length || 0} account(s) from ${metadata.institution?.name || 'bank'}` });
        await fetchData();
      }
    } catch (err) {
      alert('Failed to connect: ' + String(err));
    }
    setConnecting(false);
    setLinkToken(null);
  }, [fetchData, clearPlaidWatchdog]);

  const { open: openPlaidLink, ready: plaidReady, exit: exitPlaidLink } = usePlaidLink({
    token: linkToken,
    onSuccess: onPlaidSuccess,
    onExit: () => { clearPlaidWatchdog(); setLinkToken(null); setConnecting(false); },
  });

  const armPlaidWatchdog = useCallback(() => {
    clearPlaidWatchdog();
    watchdogRef.current = setTimeout(() => {
      const keepWaiting = !window.confirm(
        'Bank connection is taking longer than expected.\n\nClick OK to cancel and try again, or Cancel to keep waiting a bit longer.'
      );
      if (keepWaiting) {
        armPlaidWatchdog();
      } else {
        exitPlaidLink({ force: true });
        setLinkToken(null);
        setConnecting(false);
      }
    }, PLAID_STUCK_TIMEOUT_MS);
  }, [clearPlaidWatchdog, exitPlaidLink]);

  useEffect(() => {
    if (linkToken && plaidReady) {
      openPlaidLink();
      armPlaidWatchdog();
    }
    return clearPlaidWatchdog;
  }, [linkToken, plaidReady, openPlaidLink, armPlaidWatchdog, clearPlaidWatchdog]);

  const handleSync = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch(`${API}/plaid/sync`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setSyncResult({
          type: 'sync',
          message: `Synced ${data.data.accountsSynced} account(s). Imported ${data.data.transactionsImported} transactions.`,
        });
      }
      await fetchData();
    } finally { setSyncing(false); }
  };

  const STATUS_COLORS: Record<string, string> = {
    matched: 'text-green-500 bg-green-500/10',
    pending: 'text-amber-500 bg-amber-500/10',
    exception: 'text-red-500 bg-red-500/10',
    ignored: 'text-muted-foreground bg-muted',
  };

  return (
    <div className="px-4 py-5 sm:p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Building2 className="w-6 h-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Bank Connections</h1>
            <p className="text-sm text-muted-foreground">Connect your bank to auto-import and reconcile transactions</p>
          </div>
        </div>
        <div className="flex gap-2">
          {accounts.length > 0 && (
            <button onClick={handleSync} disabled={syncing}
              className="flex items-center gap-2 px-4 py-2 bg-muted text-foreground rounded-lg text-sm hover:bg-muted/80 transition-colors disabled:opacity-50">
              <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
              {syncing ? 'Syncing...' : 'Sync Now'}
            </button>
          )}
          <button onClick={handleStartConnect} disabled={connecting}
            className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm hover:bg-primary/90 transition-colors disabled:opacity-50">
            {connecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Connect Bank
          </button>
        </div>
      </div>

      {/* PR 45 / Tier 1 #1: chat-first escape hatch */}
      <ChatCTA example="connect my Chase business checking account" />

      {syncResult && (
        <div className={`mb-4 p-3 rounded-xl text-sm flex items-center gap-2 ${
          syncResult.type === 'connected' ? 'bg-green-500/10 text-green-600 border border-green-500/20' : 'bg-blue-500/10 text-blue-600 border border-blue-500/20'
        }`}>
          <CheckCircle className="w-4 h-4 shrink-0" />
          {syncResult.message}
          <button onClick={() => setSyncResult(null)} className="ml-auto text-xs opacity-60 hover:opacity-100">Dismiss</button>
        </div>
      )}

      {basiqError && (
        <div className="mb-4 p-3 rounded-xl text-sm flex items-center gap-2 bg-red-500/10 text-red-600 border border-red-500/20">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {basiqError}
          <button onClick={() => setBasiqError(null)} className="ml-auto text-xs opacity-60 hover:opacity-100">Dismiss</button>
        </div>
      )}

      {reconciliation && reconciliation.totalTransactions > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-6">
          <div className="bg-card border border-border rounded-xl p-4">
            <p className="text-xs text-muted-foreground">Transactions</p>
            <p className="text-xl font-bold">{reconciliation.totalTransactions}</p>
          </div>
          <div className="bg-card border border-border rounded-xl p-4">
            <p className="text-xs text-muted-foreground">Matched</p>
            <p className="text-xl font-bold text-green-500">{reconciliation.matched}</p>
          </div>
          <div className="bg-card border border-border rounded-xl p-4">
            <p className="text-xs text-muted-foreground">Pending</p>
            <p className="text-xl font-bold text-amber-500">{reconciliation.pending}</p>
          </div>
          <div className="bg-card border border-border rounded-xl p-4">
            <p className="text-xs text-muted-foreground">Exceptions</p>
            <p className="text-xl font-bold text-red-500">{reconciliation.exceptions}</p>
          </div>
          <div className="bg-card border border-border rounded-xl p-4">
            <p className="text-xs text-muted-foreground">Match Rate</p>
            <p className="text-xl font-bold">{(reconciliation.matchRate * 100).toFixed(0)}%</p>
          </div>
        </div>
      )}

      {loading && <p className="text-muted-foreground py-8 text-center">Loading bank accounts...</p>}

      {accounts.length === 0 && !loading && (
        <div className="bg-card border border-dashed border-border rounded-xl p-12 text-center">
          <Building2 className="w-12 h-12 mx-auto mb-4 text-muted-foreground/50" />
          <h3 className="text-lg font-medium mb-2">No banks connected yet</h3>
          <p className="text-sm text-muted-foreground mb-4">
            Connect your bank account to automatically import transactions and reconcile with your recorded expenses.
          </p>
          <button onClick={handleStartConnect} disabled={connecting}
            className="px-6 py-3 bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90 transition-colors disabled:opacity-50">
            <span className="flex items-center gap-2">
              {connecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}
              {jurisdiction === 'au' ? 'Connect with Basiq' : 'Connect with Plaid'}
            </span>
          </button>
          {jurisdiction !== 'au' && (
            <p className="text-xs text-muted-foreground mt-3">Sandbox: use <strong>user_good</strong> / <strong>pass_good</strong></p>
          )}
        </div>
      )}

      {accounts.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-medium text-muted-foreground mb-3 uppercase tracking-wide">Connected Accounts</h2>
          <div className="space-y-2">
            {accounts.map(account => (
              <div key={account.id} className="bg-card border border-border rounded-xl p-4 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center ${account.connected ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'}`}>
                    {account.connected ? <CheckCircle className="w-5 h-5" /> : <AlertCircle className="w-5 h-5" />}
                  </div>
                  <div>
                    <p className="font-medium">{account.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {account.institution || 'Bank'} · {account.type}{account.subtype ? ` (${account.subtype})` : ''} {account.mask ? `····${account.mask}` : ''}
                    </p>
                  </div>
                </div>
                <div className="text-right flex items-center gap-4">
                  <div>
                    <p className="font-bold font-mono">{fmt(account.balanceCents, currency)}</p>
                    <p className="text-xs text-muted-foreground">
                      {account.transactionCount ? `${account.transactionCount} txns · ` : ''}
                      {account.lastSynced ? `Synced ${new Date(account.lastSynced).toLocaleDateString()}` : 'Not synced'}
                    </p>
                  </div>
                  <button onClick={() => handleDisconnect(account.id, account.provider)}
                    className="px-3 py-1.5 text-xs font-medium text-red-600 border border-red-500/20 rounded-lg hover:bg-red-500/10 transition-colors">
                    Disconnect
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {transactions.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-muted-foreground mb-3 uppercase tracking-wide">Recent Bank Transactions</h2>
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="px-4 py-3 text-xs font-medium text-muted-foreground uppercase">Date</th>
                  <th className="px-4 py-3 text-xs font-medium text-muted-foreground uppercase">Description</th>
                  <th className="px-4 py-3 text-xs font-medium text-muted-foreground uppercase">Category</th>
                  <th className="px-4 py-3 text-xs font-medium text-muted-foreground uppercase text-right">Amount</th>
                  <th className="px-4 py-3 text-xs font-medium text-muted-foreground uppercase">Status</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map(txn => (
                  <tr key={txn.id} className="border-b border-border/50 hover:bg-muted/20">
                    <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                      {new Date(txn.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-medium">{txn.merchantName || txn.name}</p>
                      {txn.merchantName && txn.name !== txn.merchantName && (
                        <p className="text-xs text-muted-foreground">{txn.name}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{txn.category || '—'}</td>
                    <td className="px-4 py-3 text-right font-bold font-mono">
                      <span className={txn.amount > 0 ? 'text-red-500' : 'text-green-500'}>
                        {txn.amount > 0 ? '-' : '+'}{fmt(Math.abs(txn.amount), currency)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${STATUS_COLORS[txn.matchStatus] || STATUS_COLORS.pending}`}>
                        {txn.matchStatus === 'matched' && <CheckCircle className="w-3 h-3" />}
                        {txn.matchStatus === 'pending' && <Clock className="w-3 h-3" />}
                        {txn.matchStatus === 'exception' && <AlertCircle className="w-3 h-3" />}
                        {txn.matchStatus}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

export default BankConnectionPage;
