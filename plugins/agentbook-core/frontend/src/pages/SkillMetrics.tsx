import React, { useEffect, useState, useCallback } from 'react';
import { Loader2, RefreshCw, BarChart3, AlertTriangle, Clock, CheckCircle } from 'lucide-react';

/**
 * Skill-metrics dashboard (G-016 / PR 38).
 *
 * Surfaces the per-skill aggregate from
 * GET /api/v1/agentbook-core/agent/skills/metrics
 * — success rate, p50/p95 latency, run count, error / timeout counts.
 *
 * The chat-discoverable equivalent is the "show me skill metrics" command
 * which invokes the same endpoint. This page exists so the same numbers
 * are visible without a chat turn — Tier 1 #2 "measurable" criterion.
 */

const API = '/api/v1/agentbook-core/agent/skills/metrics';

interface SkillRow {
  skill: string;
  total: number;
  success: number;
  error: number;
  timeout: number;
  skipped: number;
  successRate: number;
  errorRate: number;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  avgConfidence: number | null;
}

interface MetricsResponse {
  windowDays: number;
  since: string;
  totalRuns: number;
  skills: SkillRow[];
}

const WINDOWS = [
  { days: 1, label: '24h' },
  { days: 7, label: '7d' },
  { days: 30, label: '30d' },
  { days: 90, label: '90d' },
];

function fmtPct(rate: number | null): string {
  if (rate === null) return '—';
  return `${(rate * 100).toFixed(1)}%`;
}

function fmtMs(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function rateClass(successRate: number): string {
  if (successRate >= 0.95) return 'text-emerald-600 dark:text-emerald-400';
  if (successRate >= 0.85) return 'text-amber-600 dark:text-amber-400';
  return 'text-rose-600 dark:text-rose-400';
}

export const SkillMetricsPage: React.FC = () => {
  const [days, setDays] = useState(7);
  const [data, setData] = useState<MetricsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}?days=${days}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as MetricsResponse;
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between gap-4 mb-6 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <BarChart3 className="w-6 h-6" />
            Skill metrics
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
            How each skill performed across {data?.totalRuns ?? '—'} runs in the last {days} days.
          </p>
        </div>
        <div className="flex items-center gap-1">
          {WINDOWS.map((w) => (
            <button
              key={w.days}
              onClick={() => setDays(w.days)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                days === w.days
                  ? 'bg-primary text-primary-foreground'
                  : 'hover:bg-muted'
              }`}
              style={days === w.days ? undefined : { color: 'var(--text-secondary)' }}
            >
              {w.label}
            </button>
          ))}
          <button
            onClick={load}
            className="ml-2 p-2 rounded-lg hover:bg-muted"
            title="Refresh"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
        </div>
      ) : error ? (
        <div className="rounded-lg p-4 bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-300 flex items-start gap-2">
          <AlertTriangle className="w-5 h-5 mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-medium">Failed to load metrics</p>
            <p className="text-sm">{error}</p>
          </div>
        </div>
      ) : !data || data.skills.length === 0 ? (
        <div className="text-center py-20" style={{ color: 'var(--text-secondary)' }}>
          <BarChart3 className="w-10 h-10 mx-auto mb-3 opacity-40" />
          <p className="font-medium">No skill runs yet in this window</p>
          <p className="text-sm mt-1">Try a wider window, or chat with the agent to start recording metrics.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-left">
                <th className="px-4 py-3 font-medium" style={{ color: 'var(--text-secondary)' }}>Skill</th>
                <th className="px-4 py-3 font-medium text-right" style={{ color: 'var(--text-secondary)' }}>Runs</th>
                <th className="px-4 py-3 font-medium text-right" style={{ color: 'var(--text-secondary)' }}>Success</th>
                <th className="px-4 py-3 font-medium text-right" style={{ color: 'var(--text-secondary)' }}>Errors</th>
                <th className="px-4 py-3 font-medium text-right" style={{ color: 'var(--text-secondary)' }}>p50</th>
                <th className="px-4 py-3 font-medium text-right" style={{ color: 'var(--text-secondary)' }}>p95</th>
                <th className="px-4 py-3 font-medium text-right" style={{ color: 'var(--text-secondary)' }}>Avg conf</th>
              </tr>
            </thead>
            <tbody>
              {data.skills.map((s) => (
                <tr key={s.skill} className="border-t border-border hover:bg-muted/30">
                  <td className="px-4 py-3 font-medium" style={{ color: 'var(--text-primary)' }}>
                    {s.skill}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                    {s.total}
                  </td>
                  <td className={`px-4 py-3 text-right tabular-nums font-medium ${rateClass(s.successRate)}`}>
                    {fmtPct(s.successRate)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                    {s.error}{s.timeout > 0 ? ` (+${s.timeout} timeout)` : ''}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                    {fmtMs(s.p50LatencyMs)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                    {fmtMs(s.p95LatencyMs)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                    {fmtPct(s.avgConfidence)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.skills.length > 0 && (
        <div className="mt-6 flex items-center gap-4 text-xs flex-wrap" style={{ color: 'var(--text-secondary)' }}>
          <div className="flex items-center gap-1">
            <CheckCircle className="w-3 h-3 text-emerald-500" /> ≥95% success
          </div>
          <div className="flex items-center gap-1">
            <Clock className="w-3 h-3 text-amber-500" /> 85–95% success
          </div>
          <div className="flex items-center gap-1">
            <AlertTriangle className="w-3 h-3 text-rose-500" /> &lt;85% success
          </div>
          <div className="ml-auto">
            Window: {new Date(data.since).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} —
            {' '}now · {data.totalRuns} total runs
          </div>
        </div>
      )}
    </div>
  );
};

export default SkillMetricsPage;
