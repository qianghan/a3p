'use client';

/**
 * Observability dashboard (PR 50 / Tier 4 #14).
 *
 * One admin page that surfaces three signals the rubric calls out:
 *   1. Skill metrics — success rate / p50 / p95 per skill (PR 14 endpoint)
 *   2. Onboarding funnel — started/completed/dropOff per step (PR 46)
 *   3. Recent errors — last 24h failed/timeout AbSkillRun rows (this PR)
 *
 * Admin-only: every fetched endpoint is gated by `requireAdmin`. The page
 * itself sits under (dashboard) so the parent layout already enforces
 * authentication via <RequireAuth>.
 */

import React, { useEffect, useState } from 'react';
import {
  Loader2,
  BarChart3,
  Users,
  AlertTriangle,
  RefreshCw,
  CheckCircle,
  Clock,
} from 'lucide-react';

interface SkillMetricsRow {
  skill: string;
  total: number;
  success: number;
  error: number;
  timeout: number;
  successRate: number;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  avgConfidence: number | null;
}

interface FunnelStep {
  stepId: string;
  completedCount: number;
  dropOffFromPrev: number;
  dropOffPct: number;
}

interface RecentError {
  id: string;
  skillName: string;
  status: string;
  errorType: string | null;
  errorMessage: string | null;
  channel: string | null;
  durationMs: number;
  createdAt: string;
}

function fmtPct(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || Number.isNaN(rate)) return '—';
  return `${(rate * 100).toFixed(1)}%`;
}
function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}
function ago(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86400_000)}d ago`;
}

export default function ObservabilityPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [skillMetrics, setSkillMetrics] = useState<SkillMetricsRow[]>([]);
  const [skillWindowDays, setSkillWindowDays] = useState(7);

  const [funnel, setFunnel] = useState<{
    totals: { started: number; completed: number; inProgress: number; abandoned: number; under15Min: number };
    completionRate: number;
    under15MinRate: number;
    medianTimeToCompleteSec: number | null;
    funnel: FunnelStep[];
  } | null>(null);

  const [recentErrors, setRecentErrors] = useState<{
    totals: { error: number; timeout: number; skipped: number };
    bySkill: Array<{ skill: string; error: number; timeout: number; total: number }>;
    byErrorType: Array<{ errorType: string; count: number }>;
    recent: RecentError[];
  } | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [metricsRes, funnelRes, errorsRes] = await Promise.all([
        fetch(`/api/v1/agentbook-core/agent/skills/metrics?days=${skillWindowDays}`),
        fetch('/api/v1/agentbook-core/admin/onboarding-funnel'),
        fetch('/api/v1/agentbook-core/admin/recent-errors?hours=24'),
      ]);
      if (!metricsRes.ok) throw new Error(`skills/metrics HTTP ${metricsRes.status}`);
      if (!funnelRes.ok) throw new Error(`onboarding-funnel HTTP ${funnelRes.status}`);
      if (!errorsRes.ok) throw new Error(`recent-errors HTTP ${errorsRes.status}`);
      const metrics = await metricsRes.json();
      const funnelJson = await funnelRes.json();
      const errorsJson = await errorsRes.json();
      setSkillMetrics(metrics.skills ?? []);
      setFunnel(funnelJson.data ?? null);
      setRecentErrors(errorsJson.data ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // re-load every 30s while the page is open
    const id = setInterval(() => void load(), 30_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skillWindowDays]);

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-8">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <BarChart3 className="w-6 h-6" />
            Observability
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Skill performance · onboarding funnel · recent failures
          </p>
        </div>
        <button
          onClick={() => void load()}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border text-sm hover:bg-muted"
          disabled={loading}
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="rounded-lg p-4 bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-300 flex items-start gap-2">
          <AlertTriangle className="w-5 h-5 mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-medium">Failed to load some sections</p>
            <p className="text-sm">{error}</p>
            <p className="text-xs mt-1">
              You must be on the admin allowlist (ADMIN_EMAILS env var).
            </p>
          </div>
        </div>
      )}

      {/* === Section 1: Skill metrics === */}
      <section className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between flex-wrap gap-2">
          <h2 className="text-base font-semibold flex items-center gap-2">
            <CheckCircle className="w-4 h-4 text-emerald-600" />
            Skill performance
          </h2>
          <div className="flex items-center gap-1">
            {[1, 7, 30].map((d) => (
              <button
                key={d}
                onClick={() => setSkillWindowDays(d)}
                className={`px-2 py-1 rounded text-xs font-medium ${
                  skillWindowDays === d ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
                }`}
              >
                {d === 1 ? '24h' : `${d}d`}
              </button>
            ))}
          </div>
        </div>
        {loading && skillMetrics.length === 0 ? (
          <div className="p-8 flex justify-center"><Loader2 className="w-5 h-5 animate-spin" /></div>
        ) : skillMetrics.length === 0 ? (
          <p className="p-8 text-center text-sm text-muted-foreground">No skill runs in this window.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Skill</th>
                <th className="px-4 py-2 font-medium text-right">Runs</th>
                <th className="px-4 py-2 font-medium text-right">Success</th>
                <th className="px-4 py-2 font-medium text-right">p50</th>
                <th className="px-4 py-2 font-medium text-right">p95</th>
                <th className="px-4 py-2 font-medium text-right">Avg conf.</th>
              </tr>
            </thead>
            <tbody>
              {skillMetrics.slice(0, 12).map((s) => (
                <tr key={s.skill} className="border-t border-border">
                  <td className="px-4 py-2 font-medium">{s.skill}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{s.total}</td>
                  <td className={`px-4 py-2 text-right tabular-nums ${
                    s.successRate >= 0.95 ? 'text-emerald-600' :
                    s.successRate >= 0.85 ? 'text-amber-600' : 'text-rose-600'
                  }`}>
                    {fmtPct(s.successRate)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{fmtMs(s.p50LatencyMs)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{fmtMs(s.p95LatencyMs)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{fmtPct(s.avgConfidence)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* === Section 2: Onboarding funnel === */}
      <section className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-base font-semibold flex items-center gap-2">
            <Users className="w-4 h-4 text-blue-600" />
            Onboarding funnel
          </h2>
        </div>
        {loading && !funnel ? (
          <div className="p-8 flex justify-center"><Loader2 className="w-5 h-5 animate-spin" /></div>
        ) : !funnel || funnel.totals.started === 0 ? (
          <p className="p-8 text-center text-sm text-muted-foreground">No onboarding sessions yet.</p>
        ) : (
          <div className="p-4 space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-sm">
              <div className="rounded-lg bg-muted/30 p-3">
                <div className="text-xs text-muted-foreground">Started</div>
                <div className="text-xl font-semibold">{funnel.totals.started}</div>
              </div>
              <div className="rounded-lg bg-muted/30 p-3">
                <div className="text-xs text-muted-foreground">Completed</div>
                <div className="text-xl font-semibold">{funnel.totals.completed}</div>
              </div>
              <div className="rounded-lg bg-muted/30 p-3">
                <div className="text-xs text-muted-foreground">Completion</div>
                <div className="text-xl font-semibold">{fmtPct(funnel.completionRate)}</div>
              </div>
              <div className="rounded-lg bg-muted/30 p-3">
                <div className="text-xs text-muted-foreground">&lt; 15 min</div>
                <div className="text-xl font-semibold">{fmtPct(funnel.under15MinRate)}</div>
              </div>
              <div className="rounded-lg bg-muted/30 p-3">
                <div className="text-xs text-muted-foreground">Median time</div>
                <div className="text-xl font-semibold">
                  {funnel.medianTimeToCompleteSec === null
                    ? '—'
                    : `${Math.round(funnel.medianTimeToCompleteSec / 60)} m`}
                </div>
              </div>
            </div>
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-2 py-1 font-medium">Step</th>
                  <th className="px-2 py-1 font-medium text-right">Completed</th>
                  <th className="px-2 py-1 font-medium text-right">Drop-off</th>
                </tr>
              </thead>
              <tbody>
                {funnel.funnel.map((s) => (
                  <tr key={s.stepId} className="border-t border-border">
                    <td className="px-2 py-1.5 font-medium">{s.stepId}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{s.completedCount}</td>
                    <td className={`px-2 py-1.5 text-right tabular-nums ${
                      s.dropOffPct >= 0.3 ? 'text-rose-600' :
                      s.dropOffPct >= 0.1 ? 'text-amber-600' : 'text-muted-foreground'
                    }`}>
                      {s.dropOffFromPrev > 0 ? `${s.dropOffFromPrev} (${fmtPct(s.dropOffPct)})` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* === Section 3: Recent errors === */}
      <section className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-base font-semibold flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-rose-600" />
            Recent failures · last 24h
          </h2>
        </div>
        {loading && !recentErrors ? (
          <div className="p-8 flex justify-center"><Loader2 className="w-5 h-5 animate-spin" /></div>
        ) : !recentErrors || recentErrors.recent.length === 0 ? (
          <p className="p-8 text-center text-sm text-muted-foreground">
            No failed skill runs in the last 24 hours. Nice.
          </p>
        ) : (
          <div className="p-4 space-y-4">
            <div className="grid grid-cols-3 gap-3 text-sm">
              <div className="rounded-lg bg-rose-50 dark:bg-rose-950/30 p-3">
                <div className="text-xs text-muted-foreground">Errors</div>
                <div className="text-xl font-semibold text-rose-600">{recentErrors.totals.error}</div>
              </div>
              <div className="rounded-lg bg-amber-50 dark:bg-amber-950/30 p-3">
                <div className="text-xs text-muted-foreground">Timeouts</div>
                <div className="text-xl font-semibold text-amber-600">{recentErrors.totals.timeout}</div>
              </div>
              <div className="rounded-lg bg-muted/30 p-3">
                <div className="text-xs text-muted-foreground">Skipped</div>
                <div className="text-xl font-semibold">{recentErrors.totals.skipped}</div>
              </div>
            </div>
            {recentErrors.byErrorType.length > 0 && (
              <div className="text-xs text-muted-foreground">
                <span className="font-medium">By type:</span>{' '}
                {recentErrors.byErrorType.map((t) => `${t.errorType}: ${t.count}`).join(' · ')}
              </div>
            )}
            <ul className="space-y-2">
              {recentErrors.recent.slice(0, 20).map((r) => (
                <li
                  key={r.id}
                  className="rounded-lg border border-border p-3 flex items-start gap-3"
                >
                  <div className={
                    r.status === 'timeout'
                      ? 'text-amber-600'
                      : r.status === 'error'
                      ? 'text-rose-600'
                      : 'text-muted-foreground'
                  }>
                    {r.status === 'timeout' ? <Clock className="w-4 h-4 mt-0.5" /> : <AlertTriangle className="w-4 h-4 mt-0.5" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">
                      {r.skillName}
                      <span className="ml-2 text-xs text-muted-foreground">
                        {r.status}{r.errorType ? ` · ${r.errorType}` : ''}{r.channel ? ` · ${r.channel}` : ''}
                      </span>
                    </div>
                    {r.errorMessage && (
                      <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                        {r.errorMessage}
                      </div>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground whitespace-nowrap">
                    {ago(r.createdAt)} · {fmtMs(r.durationMs)}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <p className="text-xs text-muted-foreground">
        Auto-refreshes every 30 seconds while this tab is open.
      </p>
    </div>
  );
}
