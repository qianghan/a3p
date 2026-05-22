/**
 * GET /api/v1/agentbook-core/agent/skills/metrics?days=N
 *
 * Per-skill aggregation over the last N days (default 7, max 90):
 *   - total runs, success/error/timeout/skipped counts
 *   - success rate, error rate
 *   - p50 / p95 latency
 *   - average confidence
 *
 * Sorted by total runs descending so the most-used skills surface first.
 *
 * Wave 2 PR 14 / G-016 — closes the -2 auto-deduction on Tier 1 #2
 * ("skills measurable").
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface SkillBucket {
  total: number;
  success: number;
  error: number;
  timeout: number;
  skipped: number;
  durations: number[];
  confidences: number[];
}

function percentile(sortedAsc: number[], p: number): number | null {
  if (!sortedAsc.length) return null;
  const idx = Math.floor((p / 100) * sortedAsc.length);
  return sortedAsc[Math.min(idx, sortedAsc.length - 1)];
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const resolved = await safeResolveAgentbookTenant(request);
    if ('response' in resolved) return resolved.response;
    const { tenantId } = resolved;

    const url = request.nextUrl;
    const daysRaw = Number(url.searchParams.get('days') ?? '7');
    const days = Math.max(1, Math.min(90, Number.isFinite(daysRaw) ? daysRaw : 7));
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);

    const runs = await prisma.abSkillRun.findMany({
      where: { tenantId, createdAt: { gte: since } },
      select: { skillName: true, status: true, durationMs: true, confidence: true },
    });

    // Group in-memory — small set per tenant; if it grows, switch to a
    // grouped SQL query with a percentile_cont over a window.
    const bySkill: Record<string, SkillBucket> = {};
    for (const r of runs) {
      const s = (bySkill[r.skillName] ??= {
        total: 0, success: 0, error: 0, timeout: 0, skipped: 0,
        durations: [], confidences: [],
      });
      s.total++;
      if (r.status === 'success') s.success++;
      else if (r.status === 'error') s.error++;
      else if (r.status === 'timeout') s.timeout++;
      else if (r.status === 'skipped') s.skipped++;
      s.durations.push(r.durationMs);
      if (typeof r.confidence === 'number') s.confidences.push(r.confidence);
    }

    const metrics = Object.entries(bySkill).map(([name, s]) => {
      s.durations.sort((a, b) => a - b);
      return {
        skill: name,
        total: s.total,
        success: s.success,
        error: s.error,
        timeout: s.timeout,
        skipped: s.skipped,
        successRate: s.total ? s.success / s.total : 0,
        errorRate: s.total ? s.error / s.total : 0,
        p50LatencyMs: percentile(s.durations, 50),
        p95LatencyMs: percentile(s.durations, 95),
        avgConfidence: s.confidences.length
          ? s.confidences.reduce((a, b) => a + b, 0) / s.confidences.length
          : null,
      };
    });

    // Most-used skills first.
    metrics.sort((a, b) => b.total - a.total);

    return NextResponse.json({
      windowDays: days,
      since: since.toISOString(),
      totalRuns: runs.length,
      skills: metrics,
    });
  } catch (err) {
    console.error('[agent/skills/metrics] failed:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
