import React, { useEffect, useState, useCallback } from 'react';
import {
  Building2,
  CheckCircle,
  X,
  Loader2,
  RefreshCw,
  ChevronRight,
  AlertCircle,
} from 'lucide-react';
import { ChatCTA } from '@naap/plugin-sdk';

/**
 * Bank-review picker (PR 51 / Tier 2 #5).
 *
 * Shows unmatched bank transactions. For each, calls the new
 * /bank-transactions/:id/candidates endpoint to get the top-N ranked
 * candidates (invoice or expense), and lets the user one-click match.
 *
 * Replaces the Telegram-only review flow as a web surface, but uses the
 * same shared transactional applier (`agentbook-bank-match.ts`) so the
 * outcome is identical regardless of channel.
 */

const API = '/api/v1/agentbook-expense';

interface BankTxn {
  id: string;
  amount: number;
  date: string;
  name: string;
  merchantName: string | null;
  matchStatus: string;
}

interface Candidate {
  kind: 'invoice' | 'expense';
  targetId: string;
  label: string;
  amountCents: number;
  date: string;
  score: number;
}

interface CandidatesResponse {
  success: boolean;
  data?: {
    transactionId: string;
    direction: 'inflow' | 'outflow';
    amountCents: number;
    merchantName: string;
    candidates: Candidate[];
  };
}

function fmtCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export const BankReviewPage: React.FC = () => {
  const [txns, setTxns] = useState<BankTxn[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [candidatesByTxn, setCandidatesByTxn] = useState<Record<string, Candidate[]>>({});
  const [loadingTxn, setLoadingTxn] = useState<string | null>(null);
  const [actingOn, setActingOn] = useState<string | null>(null);

  const loadTxns = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/bank-transactions?matchStatus=exception&limit=20`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const rows: BankTxn[] = Array.isArray(data.data) ? data.data : data.data?.transactions ?? [];
      setTxns(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTxns();
  }, [loadTxns]);

  const loadCandidates = async (txnId: string) => {
    if (candidatesByTxn[txnId]) return; // already loaded
    setLoadingTxn(txnId);
    try {
      const res = await fetch(`${API}/bank-transactions/${txnId}/candidates?limit=3`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as CandidatesResponse;
      setCandidatesByTxn((prev) => ({ ...prev, [txnId]: data.data?.candidates ?? [] }));
    } catch (err) {
      console.warn('Failed to load candidates for txn', txnId, err);
      setCandidatesByTxn((prev) => ({ ...prev, [txnId]: [] }));
    } finally {
      setLoadingTxn(null);
    }
  };

  const applyMatch = async (txnId: string, kind: 'invoice' | 'expense', targetId: string) => {
    setActingOn(txnId);
    try {
      const res = await fetch(`${API}/bank-transactions/${txnId}/match`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetType: kind, targetId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      // Drop the txn from the list — it's now matched.
      setTxns((prev) => prev.filter((t) => t.id !== txnId));
      setCandidatesByTxn((prev) => {
        const next = { ...prev };
        delete next[txnId];
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActingOn(null);
    }
  };

  const skip = async (txnId: string) => {
    setActingOn(txnId);
    try {
      await fetch(`${API}/bank-transactions/${txnId}/skip`, { method: 'POST' });
      setTxns((prev) => prev.filter((t) => t.id !== txnId));
    } catch {
      /* noop — skip is best-effort */
    } finally {
      setActingOn(null);
    }
  };

  return (
    <div className="px-4 py-5 sm:p-6 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Building2 className="w-6 h-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Bank review</h1>
            <p className="text-sm text-muted-foreground">
              Transactions we couldn't auto-match. Pick the best candidate or skip.
            </p>
          </div>
        </div>
        <button
          onClick={() => void loadTxns()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-sm hover:bg-muted"
          disabled={loading}
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      <ChatCTA example="show me the bank transactions I still need to review" />

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-300 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <p className="text-sm">{error}</p>
        </div>
      )}

      {loading && txns.length === 0 ? (
        <div className="py-16 flex justify-center">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : txns.length === 0 ? (
        <div className="py-16 text-center text-muted-foreground">
          <CheckCircle className="w-10 h-10 mx-auto mb-3 opacity-40" />
          <p className="font-medium">All caught up</p>
          <p className="text-sm mt-1">No bank transactions waiting for review.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {txns.map((t) => {
            const direction: 'inflow' | 'outflow' = t.amount < 0 ? 'inflow' : 'outflow';
            const merchant = t.merchantName || t.name;
            const dateLabel = fmtDate(t.date);
            const candidates = candidatesByTxn[t.id];
            const isLoadingCandidates = loadingTxn === t.id;
            const isActing = actingOn === t.id;

            return (
              <div
                key={t.id}
                className="rounded-xl border border-border bg-card p-4"
              >
                <div className="flex items-start justify-between gap-4 mb-3">
                  <div className="min-w-0">
                    <div className="font-medium text-sm flex items-center gap-2">
                      <span
                        className={direction === 'inflow' ? 'text-emerald-600' : 'text-foreground'}
                      >
                        {direction === 'inflow' ? '+' : '-'}{fmtCents(Math.abs(t.amount))}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {direction === 'inflow' ? 'from' : 'to'} {merchant} on {dateLabel}
                      </span>
                    </div>
                  </div>
                  <button
                    onClick={() => void skip(t.id)}
                    disabled={isActing}
                    className="text-xs px-2 py-1 rounded border border-border hover:bg-muted disabled:opacity-50"
                  >
                    Skip
                  </button>
                </div>

                {!candidates && !isLoadingCandidates && (
                  <button
                    onClick={() => void loadCandidates(t.id)}
                    className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
                  >
                    Find matches <ChevronRight className="w-3 h-3" />
                  </button>
                )}

                {isLoadingCandidates && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Looking for candidates…
                  </div>
                )}

                {candidates && candidates.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No nearby invoices or expenses match this transaction.
                    Use the chat to log it manually.
                  </p>
                )}

                {candidates && candidates.length > 0 && (
                  <div className="space-y-2">
                    {candidates.map((c, ci) => (
                      <button
                        key={`${c.kind}-${c.targetId}`}
                        onClick={() => void applyMatch(t.id, c.kind, c.targetId)}
                        disabled={isActing}
                        className="w-full text-left rounded-lg border border-border p-3 hover:bg-muted/40 transition-colors flex items-center justify-between gap-3 disabled:opacity-50"
                      >
                        <div className="min-w-0">
                          <div className="text-sm font-medium truncate">
                            {ci === 0 ? '🟢 ' : ci === 1 ? '🟡 ' : '⚪️ '}
                            {c.kind} · {c.label}
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5">
                            {fmtCents(c.amountCents)} · {fmtDate(c.date)} · confidence {(c.score * 100).toFixed(0)}%
                          </div>
                        </div>
                        <CheckCircle className={`w-4 h-4 flex-shrink-0 ${ci === 0 ? 'text-emerald-600' : 'text-muted-foreground'}`} />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default BankReviewPage;
