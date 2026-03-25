import React, { useEffect, useState } from 'react';
import { Building2, Link2, RefreshCw, CheckCircle, AlertCircle, Plus } from 'lucide-react';

interface BankAccount {
  id: string;
  name: string;
  officialName: string | null;
  type: string;
  mask: string | null;
  balanceCents: number;
  institution: string | null;
  connected: boolean;
  lastSynced: string | null;
}

interface ReconciliationSummary {
  totalTransactions: number;
  matched: number;
  exceptions: number;
  matchRate: number;
}

const API_BASE = '/api/v1/agentbook-expense';

export const BankConnectionPage: React.FC = () => {
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [reconciliation, setReconciliation] = useState<ReconciliationSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch(`${API_BASE}/bank-accounts`).then(r => r.json()).catch(() => ({ data: [] })),
      fetch(`${API_BASE}/reconciliation-summary`).then(r => r.json()).catch(() => ({ data: null })),
    ]).then(([accts, recon]) => {
      if (accts.data) setAccounts(accts.data);
      if (recon.data) setReconciliation(recon.data);
    }).finally(() => setLoading(false));
  }, []);

  const fmt = (cents: number) => `$${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

  const handleSync = async () => {
    setSyncing(true);
    try {
      await fetch(`${API_BASE}/bank-sync`, { method: 'POST' });
      // Refresh data
      const [accts, recon] = await Promise.all([
        fetch(`${API_BASE}/bank-accounts`).then(r => r.json()).catch(() => ({ data: [] })),
        fetch(`${API_BASE}/reconciliation-summary`).then(r => r.json()).catch(() => ({ data: null })),
      ]);
      if (accts.data) setAccounts(accts.data);
      if (recon.data) setReconciliation(recon.data);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="px-4 py-5 sm:p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Building2 className="w-6 h-6 text-primary" />
          <h1 className="text-2xl font-bold">Bank Connections</h1>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleSync}
            disabled={syncing}
            className="flex items-center gap-2 px-4 py-2 bg-muted text-foreground rounded-lg text-sm hover:bg-muted/80 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Syncing...' : 'Sync Now'}
          </button>
          <button className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm hover:bg-primary/90 transition-colors">
            <Plus className="w-4 h-4" />
            Connect Bank
          </button>
        </div>
      </div>

      {/* Reconciliation Summary */}
      {reconciliation && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          <div className="bg-card border border-border rounded-xl p-4">
            <p className="text-xs text-muted-foreground">Transactions</p>
            <p className="text-xl font-bold">{reconciliation.totalTransactions}</p>
          </div>
          <div className="bg-card border border-border rounded-xl p-4">
            <p className="text-xs text-muted-foreground">Matched</p>
            <p className="text-xl font-bold text-green-500">{reconciliation.matched}</p>
          </div>
          <div className="bg-card border border-border rounded-xl p-4">
            <p className="text-xs text-muted-foreground">Exceptions</p>
            <p className="text-xl font-bold text-amber-500">{reconciliation.exceptions}</p>
          </div>
          <div className="bg-card border border-border rounded-xl p-4">
            <p className="text-xs text-muted-foreground">Match Rate</p>
            <p className="text-xl font-bold">{(reconciliation.matchRate * 100).toFixed(0)}%</p>
          </div>
        </div>
      )}

      {/* Connected Accounts */}
      {loading && <p className="text-muted-foreground">Loading bank accounts...</p>}

      {accounts.length === 0 && !loading && (
        <div className="bg-card border border-dashed border-border rounded-xl p-12 text-center">
          <Building2 className="w-12 h-12 mx-auto mb-4 text-muted-foreground/50" />
          <h3 className="text-lg font-medium mb-2">No banks connected yet</h3>
          <p className="text-sm text-muted-foreground mb-4">
            Connect your bank account to automatically import transactions and reconcile with your books.
          </p>
          <button className="px-6 py-3 bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90 transition-colors">
            <span className="flex items-center gap-2"><Link2 className="w-4 h-4" /> Connect with Plaid</span>
          </button>
          <p className="text-xs text-muted-foreground mt-3">Supports US and Canadian banks. Powered by Plaid.</p>
        </div>
      )}

      <div className="space-y-3">
        {accounts.map(account => (
          <div key={account.id} className="bg-card border border-border rounded-xl p-4 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className={`w-10 h-10 rounded-full flex items-center justify-center ${account.connected ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'}`}>
                {account.connected ? <CheckCircle className="w-5 h-5" /> : <AlertCircle className="w-5 h-5" />}
              </div>
              <div>
                <p className="font-medium">{account.name}</p>
                <p className="text-sm text-muted-foreground">
                  {account.institution || 'Bank'} · {account.type} {account.mask ? `····${account.mask}` : ''}
                </p>
              </div>
            </div>
            <div className="text-right">
              <p className="font-bold font-mono">{fmt(account.balanceCents)}</p>
              <p className="text-xs text-muted-foreground">
                {account.lastSynced ? `Synced ${new Date(account.lastSynced).toLocaleDateString()}` : 'Not synced'}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
