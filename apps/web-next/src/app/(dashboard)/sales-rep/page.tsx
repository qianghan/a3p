'use client';

/**
 * Sales Rep Dashboard — a promoted rep's own view: referral link, invitee
 * conversion status, commission earned, invoice submission, and payout
 * bank details. Gated on the `sales_rep` role (see admin/users/[id]/sales-rep
 * for how that role is granted).
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Users, DollarSign, FileText, Landmark, Copy, Check } from 'lucide-react';
import { Button, Input, Badge } from '@naap/ui';
import { useAuth } from '@/contexts/auth-context';

interface SalesRepSummary {
  profile: {
    commissionBps: number;
    payoutFrequency: string;
    status: string;
    hasBankDetails: boolean;
    referralCode: string | null;
  };
  invitees: Array<{ maskedEmail: string | null; status: string; joinedAt: string; paidAt: string | null; commissionCents: number }>;
  revenue: { thisMonthCents: number; thisYearCents: number; allTimeCents: number };
  pendingCommissionCents: number;
}

interface Payout {
  id: string;
  invoiceNumber: string;
  periodLabel: string;
  totalCents: number;
  status: string;
  submittedAt: string;
  paidAt: string | null;
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export default function SalesRepDashboardPage() {
  const router = useRouter();
  const { hasRole, isLoading: authLoading } = useAuth();
  const [summary, setSummary] = useState<SalesRepSummary | null>(null);
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [bankDetails, setBankDetails] = useState('');

  const isSalesRep = hasRole('sales_rep');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [summaryRes, payoutsRes] = await Promise.all([
        fetch('/api/v1/agentbook-billing/sales-rep/summary', { credentials: 'include' }),
        fetch('/api/v1/agentbook-billing/sales-rep/payouts', { credentials: 'include' }),
      ]);
      const summaryData = await summaryRes.json();
      const payoutsData = await payoutsRes.json();
      if (summaryData.success) setSummary(summaryData.data);
      else setError(summaryData.error || 'Failed to load sales rep summary');
      if (payoutsData.success) setPayouts(payoutsData.data.payouts);
    } catch {
      setError('Failed to load sales rep dashboard');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!isSalesRep) { router.push('/agentbook'); return; }
    load();
  }, [authLoading, isSalesRep, load, router]);

  const flash = (m: string) => { setSuccessMsg(m); setTimeout(() => setSuccessMsg(null), 4000); };

  const shareUrl = summary?.profile.referralCode
    ? `${typeof window !== 'undefined' ? window.location.origin : ''}/register?ref=${encodeURIComponent(summary.profile.referralCode)}`
    : null;

  const copyLink = async () => {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const submitInvoice = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/agentbook-billing/sales-rep/payouts', { method: 'POST', credentials: 'include' });
      const data = await res.json();
      if (data.success) {
        flash(`Submitted invoice ${data.data.invoiceNumber} for ${money(data.data.totalCents)}.`);
        await load();
      } else {
        setError(data.error || 'Failed to submit invoice');
      }
    } catch {
      setError('Failed to submit invoice');
    } finally {
      setBusy(false);
    }
  };

  const saveBankDetails = async () => {
    if (!bankDetails.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/agentbook-billing/sales-rep/bank-details', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ bankDetails: bankDetails.trim() }),
      });
      const data = await res.json();
      if (data.success) {
        setBankDetails('');
        flash('Bank details saved.');
        await load();
      } else {
        setError(data.error || 'Failed to save bank details');
      }
    } catch {
      setError('Failed to save bank details');
    } finally {
      setBusy(false);
    }
  };

  if (authLoading || loading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }
  if (!summary) {
    return <div className="p-6 text-sm text-destructive">{error || 'Unable to load your sales rep dashboard.'}</div>;
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Sales Rep Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          You earn {(summary.profile.commissionBps / 100).toFixed(0)}% commission on revenue from users who sign up
          through your link, paid out {summary.profile.payoutFrequency}.
        </p>
      </div>

      {error && <div className="rounded-md bg-destructive/10 text-destructive text-sm px-3 py-2">{error}</div>}
      {successMsg && <div className="rounded-md bg-emerald-500/10 text-emerald-600 text-sm px-3 py-2">{successMsg}</div>}

      {/* Referral link */}
      <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-start">
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-xs font-medium text-muted-foreground mb-2">Your referral link</div>
          <div className="flex items-center gap-2">
            <Input readOnly value={shareUrl ?? ''} className="font-mono text-sm" />
            <Button onClick={copyLink} variant="secondary">
              {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            </Button>
          </div>
        </div>
        {summary.profile.referralCode && (
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="text-xs font-medium text-muted-foreground mb-2">Or let them scan</div>
            {/* eslint-disable-next-line @next/next/no-img-element -- server-generated PNG, not an optimizable static asset */}
            <img
              src={`/api/v1/agentbook-billing/referrals/qr-card/${encodeURIComponent(summary.profile.referralCode)}`}
              alt="Scan to join AgentBook"
              className="w-full max-w-[160px] rounded-lg border border-border"
            />
          </div>
        )}
      </div>

      {/* Revenue tiles */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1"><DollarSign className="w-3.5 h-3.5" /> This month</div>
          <div className="text-lg font-semibold">{money(summary.revenue.thisMonthCents)}</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1"><DollarSign className="w-3.5 h-3.5" /> This year</div>
          <div className="text-lg font-semibold">{money(summary.revenue.thisYearCents)}</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1"><DollarSign className="w-3.5 h-3.5" /> All time</div>
          <div className="text-lg font-semibold">{money(summary.revenue.allTimeCents)}</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1"><FileText className="w-3.5 h-3.5" /> Pending invoice</div>
          <div className="text-lg font-semibold">{money(summary.pendingCommissionCents)}</div>
        </div>
      </div>

      {/* Invitees */}
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-center gap-2 text-sm font-medium mb-3"><Users className="w-4 h-4" /> Signups via your link</div>
        {summary.invitees.length === 0 ? (
          <p className="text-sm text-muted-foreground">No signups yet — share your link above to get started.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground border-b border-border">
                <th className="pb-2">Email</th>
                <th className="pb-2">Status</th>
                <th className="pb-2">Joined</th>
                <th className="pb-2 text-right">Commission earned</th>
              </tr>
            </thead>
            <tbody>
              {summary.invitees.map((inv, i) => (
                <tr key={i} className="border-b border-border/50 last:border-0">
                  <td className="py-2">{inv.maskedEmail || '—'}</td>
                  <td className="py-2"><Badge variant={inv.status === 'paid' ? 'emerald' : 'blue'}>{inv.status}</Badge></td>
                  <td className="py-2 text-muted-foreground">{new Date(inv.joinedAt).toLocaleDateString()}</td>
                  <td className="py-2 text-right">{money(inv.commissionCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Submit invoice */}
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 text-sm font-medium"><FileText className="w-4 h-4" /> Commission invoice</div>
          <Button onClick={submitInvoice} disabled={busy || summary.pendingCommissionCents === 0}>
            Submit invoice for this period
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mb-3">
          One invoice per {summary.profile.payoutFrequency} period, covering everything accrued since your last submission.
        </p>
        {payouts.length > 0 && (
          <table className="w-full text-sm mt-2">
            <thead>
              <tr className="text-left text-xs text-muted-foreground border-b border-border">
                <th className="pb-2">Invoice</th>
                <th className="pb-2">Period</th>
                <th className="pb-2">Status</th>
                <th className="pb-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {payouts.map((p) => (
                <tr key={p.id} className="border-b border-border/50 last:border-0">
                  <td className="py-2 font-mono text-xs">{p.invoiceNumber}</td>
                  <td className="py-2 text-muted-foreground">{p.periodLabel}</td>
                  <td className="py-2"><Badge variant={p.status === 'paid' ? 'emerald' : 'blue'}>{p.status}</Badge></td>
                  <td className="py-2 text-right">{money(p.totalCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Bank details */}
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-center gap-2 text-sm font-medium mb-2">
          <Landmark className="w-4 h-4" /> Payout bank details
          {summary.profile.hasBankDetails && <Badge variant="emerald">On file</Badge>}
        </div>
        <p className="text-xs text-muted-foreground mb-3">
          Stored encrypted. Only decrypted by admin at the moment they send a payment.
        </p>
        <div className="flex items-center gap-2">
          <Input
            placeholder="Bank name, account/routing number, or payout email"
            value={bankDetails}
            onChange={(e) => setBankDetails(e.target.value)}
          />
          <Button onClick={saveBankDetails} disabled={busy || !bankDetails.trim()}>Save</Button>
        </div>
      </div>
    </div>
  );
}
