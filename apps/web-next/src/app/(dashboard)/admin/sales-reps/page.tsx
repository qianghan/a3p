'use client';

/**
 * Admin Sales Rep Review — pending commission invoices to review and pay,
 * plus a roster overview of all promoted reps. Bank details are only ever
 * decrypted here, on demand, right before marking a payout paid.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Users, DollarSign, Landmark, CheckCircle2, XCircle } from 'lucide-react';
import { Button, Input, Badge } from '@naap/ui';
import { useAuth } from '@/contexts/auth-context';
import { AdminNav } from '@/components/admin/AdminNav';

interface Rep {
  tenantId: string;
  email: string | null;
  displayName: string | null;
  status: string;
  commissionBps: number;
  payoutFrequency: string;
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
    </div>
  );
}
