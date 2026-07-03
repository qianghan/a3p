'use client';

/**
 * Admin Sales Rep Review — pending commission invoices to review and pay,
 * plus a roster overview of all promoted reps. Bank details are only ever
 * decrypted here, on demand, right before marking a payout paid.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Users, DollarSign, Landmark, CheckCircle2, XCircle, Pencil, History } from 'lucide-react';
import { Button, Input, Select, Badge } from '@naap/ui';
import { useAuth } from '@/contexts/auth-context';
import { AdminNav } from '@/components/admin/AdminNav';

interface Rep {
  tenantId: string;
  email: string | null;
  displayName: string | null;
  status: string;
  commissionBps: number;
  payoutFrequency: string;
  planCode: string;
  hasBankDetails: boolean;
  lifetimePaidCents: number;
  pendingSubmittedCents: number;
  paidThisYearCents: number;
  crossed1099Threshold: boolean;
}

interface Payout {
  id: string;
  salesRepEmail: string | null;
  salesRepName: string | null;
  invoiceNumber: string;
  periodLabel: string;
  totalCents: number;
  status: string;
  submittedAt: string;
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export default function AdminSalesRepsPage() {
  const router = useRouter();
  const { hasRole } = useAuth();
  const [reps, setReps] = useState<Rep[]>([]);
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reviewPayout, setReviewPayout] = useState<Payout | null>(null);
  const [bankDetails, setBankDetails] = useState<string | null>(null);
  const [paymentReference, setPaymentReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [editTarget, setEditTarget] = useState<Rep | null>(null);
  const [editPlan, setEditPlan] = useState<'pro' | 'business'>('pro');
  const [editCommissionPercent, setEditCommissionPercent] = useState('20');
  const [editFrequency, setEditFrequency] = useState<'monthly' | 'quarterly' | 'annual'>('quarterly');
  const [historyTarget, setHistoryTarget] = useState<Rep | null>(null);
  const [historyPayouts, setHistoryPayouts] = useState<Payout[] | null>(null);

  const isAdmin = hasRole('system:admin');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [repsRes, payoutsRes] = await Promise.all([
        fetch('/api/v1/admin/sales-reps', { credentials: 'include' }),
        fetch('/api/v1/admin/sales-reps/payouts?status=submitted', { credentials: 'include' }),
      ]);
      const repsData = await repsRes.json();
      const payoutsData = await payoutsRes.json();
      if (repsData.success) setReps(repsData.data.reps);
      if (payoutsData.success) setPayouts(payoutsData.data.payouts);
      if (!repsData.success) setError(repsData.error?.message || repsData.error || 'Failed to load sales reps');
    } catch {
      setError('Failed to load sales reps');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) { router.push('/agentbook'); return; }
    load();
  }, [isAdmin, load, router]);

  const openReview = async (payout: Payout) => {
    setReviewPayout(payout);
    setBankDetails(null);
    setPaymentReference('');
    try {
      const res = await fetch(`/api/v1/admin/sales-reps/payouts/${payout.id}`, { credentials: 'include' });
      const data = await res.json();
      if (data.success) setBankDetails(data.data.bankDetails);
    } catch {
      // Non-fatal — admin can still mark paid without seeing bank details again.
    }
  };

  const markPaid = async () => {
    if (!reviewPayout) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/admin/sales-reps/payouts/${reviewPayout.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ action: 'markPaid', paymentReference: paymentReference || undefined }),
      });
      const data = await res.json();
      if (data.success) {
        setReviewPayout(null);
        await load();
      } else {
        setError(data.error?.message || data.error || 'Failed to mark paid');
      }
    } catch {
      setError('Failed to mark paid');
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    if (!reviewPayout) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/admin/sales-reps/payouts/${reviewPayout.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ action: 'reject', rejectionReason: 'Rejected by admin' }),
      });
      const data = await res.json();
      if (data.success) {
        setReviewPayout(null);
        await load();
      } else {
        setError(data.error?.message || data.error || 'Failed to reject');
      }
    } catch {
      setError('Failed to reject');
    } finally {
      setBusy(false);
    }
  };

  const openEdit = (rep: Rep) => {
    setEditTarget(rep);
    setEditPlan(rep.planCode === 'business' ? 'business' : 'pro');
    setEditCommissionPercent(String(rep.commissionBps / 100));
    setEditFrequency((rep.payoutFrequency as 'monthly' | 'quarterly' | 'annual') || 'quarterly');
  };

  const saveEdit = async () => {
    if (!editTarget) return;
    const commissionBps = Math.round(Number(editCommissionPercent) * 100);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/admin/users/${editTarget.tenantId}/sales-rep`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ plan: editPlan, commissionBps, payoutFrequency: editFrequency }),
      });
      const data = await res.json();
      if (data.success) {
        setEditTarget(null);
        await load();
      } else {
        setError(data.error?.message || data.error || 'Failed to update sales rep');
      }
    } catch {
      setError('Failed to update sales rep');
    } finally {
      setBusy(false);
    }
  };

  const openHistory = async (rep: Rep) => {
    setHistoryTarget(rep);
    setHistoryPayouts(null);
    try {
      const res = await fetch(`/api/v1/admin/sales-reps/payouts?salesRepId=${rep.tenantId}`, { credentials: 'include' });
      const data = await res.json();
      if (data.success) setHistoryPayouts(data.data.payouts);
    } catch {
      setHistoryPayouts([]);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="h-5 w-5 animate-spin text-muted-foreground border-2 border-current border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="p-4 max-w-6xl mx-auto">
      <AdminNav />
      <h1 className="text-lg font-semibold flex items-center gap-2 mb-1">
        <Users className="w-5 h-5" /> Sales Reps
      </h1>
      <p className="text-sm text-muted-foreground mb-4">
        Review submitted commission invoices and pay them manually, then mark them paid here.
      </p>

      {error && <div className="rounded-md bg-destructive/10 text-destructive text-sm px-3 py-2 mb-4">{error}</div>}

      {/* Pending invoices */}
      <div className="rounded-lg border border-border bg-card p-4 mb-6">
        <div className="text-sm font-medium mb-3">Pending invoices ({payouts.length})</div>
        {payouts.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing awaiting payment.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground border-b border-border">
                <th className="pb-2">Rep</th>
                <th className="pb-2">Invoice</th>
                <th className="pb-2">Period</th>
                <th className="pb-2 text-right">Amount</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {payouts.map((p) => (
                <tr key={p.id} className="border-b border-border/50 last:border-0">
                  <td className="py-2">{p.salesRepEmail || p.salesRepName || '—'}</td>
                  <td className="py-2 font-mono text-xs">{p.invoiceNumber}</td>
                  <td className="py-2 text-muted-foreground">{p.periodLabel}</td>
                  <td className="py-2 text-right">{money(p.totalCents)}</td>
                  <td className="py-2 text-right">
                    <Button onClick={() => openReview(p)} variant="secondary">Review &amp; pay</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Roster */}
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="text-sm font-medium mb-3">Roster ({reps.length})</div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground border-b border-border">
              <th className="pb-2">Rep</th>
              <th className="pb-2">Status</th>
              <th className="pb-2">Commission</th>
              <th className="pb-2">Payout freq.</th>
              <th className="pb-2">Bank details</th>
              <th className="pb-2 text-right">Lifetime paid</th>
              <th className="pb-2 text-right">Paid this year</th>
              <th className="pb-2" />
            </tr>
          </thead>
          <tbody>
            {reps.map((r) => (
              <tr key={r.tenantId} className="border-b border-border/50 last:border-0">
                <td className="py-2">{r.email || r.displayName || r.tenantId}</td>
                <td className="py-2"><Badge variant={r.status === 'active' ? 'emerald' : 'secondary'}>{r.status}</Badge></td>
                <td className="py-2">{(r.commissionBps / 100).toFixed(0)}%</td>
                <td className="py-2 text-muted-foreground">{r.payoutFrequency}</td>
                <td className="py-2">
                  {r.hasBankDetails ? (
                    <span className="inline-flex items-center gap-1 text-emerald-600 text-xs"><Landmark className="w-3.5 h-3.5" /> On file</span>
                  ) : (
                    <span className="text-xs text-muted-foreground">Not set</span>
                  )}
                </td>
                <td className="py-2 text-right">{money(r.lifetimePaidCents)}</td>
                <td className="py-2 text-right">
                  <div className="flex items-center justify-end gap-2">
                    {money(r.paidThisYearCents)}
                    {r.crossed1099Threshold && (
                      <span title="Crossed the $600/year 1099-NEC reporting threshold">
                        <Badge variant="amber">1099</Badge>
                      </span>
                    )}
                  </div>
                </td>
                <td className="py-2 text-right whitespace-nowrap">
                  <button type="button" onClick={() => openHistory(r)} className="p-1.5 rounded hover:bg-muted text-muted-foreground" title="Payout history">
                    <History className="w-4 h-4" />
                  </button>
                  {r.status === 'active' && (
                    <button type="button" onClick={() => openEdit(r)} className="p-1.5 rounded hover:bg-muted text-muted-foreground" title="Edit commission / frequency">
                      <Pencil className="w-4 h-4" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {reviewPayout && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-xl">
            <h3 className="text-base font-semibold mb-1">
              {reviewPayout.invoiceNumber} — {money(reviewPayout.totalCents)}
            </h3>
            <p className="text-sm text-muted-foreground mb-3">
              {reviewPayout.salesRepEmail} · {reviewPayout.periodLabel}
            </p>
            <div className="rounded-md bg-muted/50 p-3 mb-3">
              <div className="text-xs font-medium text-muted-foreground mb-1 flex items-center gap-1">
                <DollarSign className="w-3.5 h-3.5" /> Bank details
              </div>
              <p className="text-sm whitespace-pre-wrap">{bankDetails ?? 'Loading…'}</p>
            </div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Payment reference (optional)</label>
            <Input
              placeholder="Wire confirmation #, transfer ID, etc."
              value={paymentReference}
              onChange={(e) => setPaymentReference(e.target.value)}
              className="mb-4"
            />
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setReviewPayout(null)} disabled={busy}>Cancel</Button>
              <Button variant="destructive" onClick={reject} disabled={busy}>
                <XCircle className="w-4 h-4 mr-1" /> Reject
              </Button>
              <Button onClick={markPaid} disabled={busy}>
                <CheckCircle2 className="w-4 h-4 mr-1" /> Mark paid
              </Button>
            </div>
          </div>
        </div>
      )}

      {editTarget && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-sm rounded-lg border border-border bg-card p-5 shadow-xl">
            <h3 className="text-base font-semibold mb-1">Edit {editTarget.email || editTarget.displayName}</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Changes apply going forward only — already-accrued commission keeps its original rate.
            </p>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Comped plan</label>
                <Select value={editPlan} onChange={(e) => setEditPlan(e.target.value as 'pro' | 'business')}>
                  <option value="pro">Pro</option>
                  <option value="business">Business</option>
                </Select>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Commission %</label>
                <Input
                  type="number" min={1} max={100} step={1}
                  value={editCommissionPercent}
                  onChange={(e) => setEditCommissionPercent(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Payout frequency</label>
                <Select value={editFrequency} onChange={(e) => setEditFrequency(e.target.value as 'monthly' | 'quarterly' | 'annual')}>
                  <option value="monthly">Monthly</option>
                  <option value="quarterly">Quarterly</option>
                  <option value="annual">Annual</option>
                </Select>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setEditTarget(null)} disabled={busy}>Cancel</Button>
              <Button onClick={saveEdit} disabled={busy}>Save</Button>
            </div>
          </div>
        </div>
      )}

      {historyTarget && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-lg rounded-lg border border-border bg-card p-5 shadow-xl">
            <h3 className="text-base font-semibold mb-3">
              Payout history — {historyTarget.email || historyTarget.displayName}
            </h3>
            {historyPayouts === null ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : historyPayouts.length === 0 ? (
              <p className="text-sm text-muted-foreground">No invoices submitted yet.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground border-b border-border">
                    <th className="pb-2">Invoice</th>
                    <th className="pb-2">Period</th>
                    <th className="pb-2">Status</th>
                    <th className="pb-2 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {historyPayouts.map((p) => (
                    <tr key={p.id} className="border-b border-border/50 last:border-0">
                      <td className="py-2 font-mono text-xs">{p.invoiceNumber}</td>
                      <td className="py-2 text-muted-foreground">{p.periodLabel}</td>
                      <td className="py-2">
                        <Badge variant={p.status === 'paid' ? 'emerald' : p.status === 'rejected' ? 'rose' : 'blue'}>{p.status}</Badge>
                      </td>
                      <td className="py-2 text-right">{money(p.totalCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="mt-5 flex justify-end">
              <Button variant="secondary" onClick={() => setHistoryTarget(null)}>Close</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
