'use client';

/**
 * Admin platform overview — one-glance KPIs: users & signups, revenue
 * (MRR/ARR), free→paid conversion, plan mix, and sales-rep performance.
 * All figures come from GET /api/v1/agentbook-core/admin/metrics.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Users, DollarSign, TrendingUp, Percent } from 'lucide-react';
import { useAuth } from '@/contexts/auth-context';
import { AdminNav } from '@/components/admin/AdminNav';
import { useT } from '@/hooks/use-t';

interface Metrics {
  users: { total: number; new7d: number; new30d: number };
  signupTrend: { month: string; count: number }[];
  revenue: {
    mrrCents: number; arrCents: number; payingCount: number; conversionRate: number;
    planDistribution: { code: string; name: string; count: number; monthlyCents: number }[];
  };
  reps: { active: number; commissionsAllTimeCents: number; pendingPayoutCents: number; top: { tenantId: string; email: string | null; commissionCents: number }[] };
}

const money = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const pct = (r: number) => `${(r * 100).toFixed(1)}%`;

function Tile({ icon: Icon, label, value, sub }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1"><Icon className="w-3.5 h-3.5" /> {label}</div>
      <div className="text-2xl font-semibold">{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

/** Minimal inline sparkline (no chart lib) — signups over the last 6 months. */
function Sparkline({ data }: { data: { month: string; count: number }[] }) {
  const t = useT();
  const w = 320, h = 60, pad = 4;
  const max = Math.max(1, ...data.map((d) => d.count));
  const step = data.length > 1 ? (w - pad * 2) / (data.length - 1) : 0;
  const pts = data.map((d, i) => `${pad + i * step},${h - pad - (d.count / max) * (h - pad * 2)}`);
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2"><TrendingUp className="w-3.5 h-3.5" /> {t('admin_ui.new_signups_6mo')}</div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-16" preserveAspectRatio="none">
        <polyline fill="none" stroke="currentColor" strokeWidth="2" className="text-primary" points={pts.join(' ')} />
        {data.map((d, i) => (
          <circle key={d.month} cx={pad + i * step} cy={h - pad - (d.count / max) * (h - pad * 2)} r="2.5" className="fill-primary" />
        ))}
      </svg>
      <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
        {data.map((d) => <span key={d.month}>{d.month.slice(5)}</span>)}
      </div>
    </div>
  );
}

export default function AdminOverviewPage() {
  const t = useT();
  const router = useRouter();
  const { hasRole } = useAuth();
  const [m, setM] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isAdmin = hasRole('system:admin');

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch('/api/v1/agentbook-core/admin/metrics', { credentials: 'include' });
      const data = await res.json();
      if (data.success) setM(data.data);
      else setError(data.error?.message || data.error || 'Failed to load metrics');
    } catch {
      setError('Failed to load metrics');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) { router.push('/agentbook'); return; }
    load();
  }, [isAdmin, load, router]);

  return (
    <div className="p-4 max-w-6xl mx-auto">
      <AdminNav />
      <h1 className="text-lg font-semibold flex items-center gap-2 mb-1"><TrendingUp className="w-5 h-5" /> {t('admin_ui.platform_overview')}</h1>
      <p className="text-sm text-muted-foreground mb-4">{t('admin_ui.platform_overview_sub')}</p>

      {error && <div className="rounded-md bg-destructive/10 text-destructive text-sm px-3 py-2 mb-4">{error}</div>}
      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}

      {m && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Tile icon={Users} label={t('admin_ui.total_users')} value={m.users.total.toLocaleString()} sub={`+${m.users.new7d} this week · +${m.users.new30d} this month`} />
            <Tile icon={DollarSign} label="MRR" value={money(m.revenue.mrrCents)} sub={`${money(m.revenue.arrCents)} ARR`} />
            <Tile icon={Percent} label={t('admin_ui.paid_conversion')} value={pct(m.revenue.conversionRate)} sub={`${m.revenue.payingCount.toLocaleString()} paying`} />
            <Tile icon={Users} label={t('admin_ui.active_reps')} value={m.reps.active.toLocaleString()} sub={`${money(m.reps.pendingPayoutCents)} payouts pending`} />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Sparkline data={m.signupTrend} />
            <div className="rounded-lg border border-border bg-card p-4">
              <div className="text-xs text-muted-foreground mb-3">{t('admin_ui.plan_distribution')}</div>
              {m.revenue.planDistribution.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('admin_ui.no_active_subs')}</p>
              ) : (
                <table className="w-full text-sm">
                  <tbody>
                    {m.revenue.planDistribution.map((p) => (
                      <tr key={p.code} className="border-b border-border/50 last:border-0">
                        <td className="py-1.5 capitalize">{p.name || p.code}</td>
                        <td className="py-1.5 text-muted-foreground">{money(p.monthlyCents)}/mo</td>
                        <td className="py-1.5 text-right font-medium">{p.count.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm font-medium">{t('admin_ui.top_sales_reps')}</div>
              <div className="text-xs text-muted-foreground">{money(m.reps.commissionsAllTimeCents)} commissions accrued all-time</div>
            </div>
            {m.reps.top.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('admin_ui.no_commissions')}</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground border-b border-border">
                    <th className="pb-2">{t('admin_ui.rep')}</th>
                    <th className="pb-2 text-right">{t('admin_ui.commissions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {m.reps.top.map((r) => (
                    <tr key={r.tenantId} className="border-b border-border/50 last:border-0">
                      <td className="py-2">{r.email || r.tenantId}</td>
                      <td className="py-2 text-right font-medium">{money(r.commissionCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
