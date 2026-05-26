/**
 * Recent agent-side errors admin endpoint (PR 50 / Tier 4 #14).
 *
 * Aggregates non-success AbSkillRun rows from the last 24 hours so the
 * observability dashboard can surface "what's broken right now" without
 * needing a Datadog / Grafana wiring.
 *
 * Admin-gated by the same `requireAdmin` helper as the funnel endpoint.
 *
 * Response shape:
 *   {
 *     windowHours: 24,
 *     totals: { error, timeout, skipped },
 *     bySkill: [{ skill, error, timeout, skipped, total }],
 *     byErrorType: [{ errorType, count }],
 *     recent: [{ id, skillName, status, errorType, errorMessage, channel, durationMs, createdAt }]
 *   }
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { requireAdmin } from '@/lib/admin-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const DEFAULT_WINDOW_HOURS = 24;
const MAX_RECENT_ROWS = 50;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await requireAdmin(request);
  if ('response' in guard) return guard.response as NextResponse;

  const url = request.nextUrl;
  const hoursRaw = Number(url.searchParams.get('hours') ?? DEFAULT_WINDOW_HOURS);
  const windowHours = Math.max(1, Math.min(720, Number.isFinite(hoursRaw) ? hoursRaw : DEFAULT_WINDOW_HOURS));
  const since = new Date(Date.now() - windowHours * 3600 * 1000);

  const failedRuns = await db.abSkillRun.findMany({
    where: {
      status: { in: ['error', 'timeout', 'skipped'] },
      createdAt: { gte: since },
    },
    select: {
      id: true,
      skillName: true,
      status: true,
      errorType: true,
      errorMessage: true,
      channel: true,
      durationMs: true,
      createdAt: true,
      tenantId: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });

  // Per-status totals.
  const totals = { error: 0, timeout: 0, skipped: 0 };
  // Per-skill breakdown.
  const bySkillMap: Record<string, { skill: string; error: number; timeout: number; skipped: number; total: number }> = {};
  // Error-type histogram.
  const byErrorTypeMap: Record<string, number> = {};

  for (const r of failedRuns) {
    if (r.status === 'error') totals.error += 1;
    else if (r.status === 'timeout') totals.timeout += 1;
    else if (r.status === 'skipped') totals.skipped += 1;

    if (!bySkillMap[r.skillName]) {
      bySkillMap[r.skillName] = { skill: r.skillName, error: 0, timeout: 0, skipped: 0, total: 0 };
    }
    const bucket = bySkillMap[r.skillName];
    bucket.total += 1;
    if (r.status === 'error') bucket.error += 1;
    else if (r.status === 'timeout') bucket.timeout += 1;
    else if (r.status === 'skipped') bucket.skipped += 1;

    if (r.errorType) {
      byErrorTypeMap[r.errorType] = (byErrorTypeMap[r.errorType] ?? 0) + 1;
    }
  }

  const bySkill = Object.values(bySkillMap).sort((a, b) => b.total - a.total);
  const byErrorType = Object.entries(byErrorTypeMap)
    .map(([errorType, count]) => ({ errorType, count }))
    .sort((a, b) => b.count - a.count);

  // The "recent" list is for the UI to display individual failures — limit
  // to MAX_RECENT_ROWS to keep the response small.
  const recent = failedRuns.slice(0, MAX_RECENT_ROWS).map((r) => ({
    id: r.id,
    skillName: r.skillName,
    status: r.status,
    errorType: r.errorType,
    errorMessage: r.errorMessage,
    channel: r.channel,
    durationMs: r.durationMs,
    createdAt: r.createdAt,
    // Tenant id intentionally NOT exposed in the API response — it's
    // available to the admin only via direct DB if needed for support.
  }));

  return NextResponse.json({
    success: true,
    data: {
      windowHours,
      totals,
      totalCount: failedRuns.length,
      bySkill,
      byErrorType,
      recent,
    },
  });
}
