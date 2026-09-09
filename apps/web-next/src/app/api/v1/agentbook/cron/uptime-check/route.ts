/**
 * Uptime check cron — records dependency health and alerts on a transition.
 *
 * Runs the same probes `/api/health/deep` serves, but for a different
 * purpose: the endpoint answers a monitor asking "now?", this one gives the
 * answers a memory. Without it a dependency can be down for six hours and
 * leave no trace, because nobody was curling the endpoint at the time.
 *
 * ALERTS ON CHANGE, NOT ON STATE. A probe that is down stays down; alerting
 * every five minutes for as long as it does produces 72 identical messages
 * before lunch and a channel everyone has muted by the afternoon. So an
 * alert fires when a probe ENTERS a bad state and again when it recovers,
 * and nothing in between.
 *
 * And it needs two consecutive failures to enter one. A single timed-out
 * query on a serverless cold start is not an outage, and a monitor that
 * cannot tell the difference teaches people to ignore it.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { runProbes, overallStatus, type ProbeResult } from '@/lib/health/probes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** Failures in a row before a probe is considered down. */
export const FAILURES_BEFORE_ALERT = 2;

/** Health is deployment-wide, not per-tenant; events need a tenant column. */
const SYSTEM_TENANT = 'system';

function isBad(status: string): boolean {
  return status === 'down' || status === 'degraded';
}

/**
 * Fold one probe result into its stored state.
 *
 * Pure, so the debounce and transition rules can be tested without a
 * database — they are the part that decides whether anyone gets woken up.
 */
export function nextState(
  prev: { status: string; consecutiveFails: number } | null,
  result: ProbeResult,
): { status: string; consecutiveFails: number; changed: boolean } {
  const fails = isBad(result.status) ? (prev?.consecutiveFails ?? 0) + 1 : 0;

  // Below the threshold a failing probe keeps its previous status: a blip
  // must not be recorded as an outage, and must not clear one either.
  const status = isBad(result.status) && fails < FAILURES_BEFORE_ALERT
    ? (prev?.status ?? result.status)
    : result.status;

  return { status, consecutiveFails: fails, changed: !!prev && prev.status !== status };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    // Fail CLOSED. A cron route that runs for anyone who finds the URL is how
    // 21 of them came to be publicly triggerable in this codebase.
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const results = await runProbes();
  const transitions: { probe: string; from: string; to: string }[] = [];

  for (const result of results) {
    const prev = await db.abHealthState
      .findUnique({ where: { probe: result.name }, select: { status: true, consecutiveFails: true } })
      .catch(() => null);

    const next = nextState(prev, result);

    await db.abHealthState.upsert({
      where: { probe: result.name },
      create: {
        probe: result.name,
        status: next.status,
        consecutiveFails: next.consecutiveFails,
        lastLatencyMs: result.latencyMs,
        detail: result.detail ?? null,
      },
      update: {
        status: next.status,
        consecutiveFails: next.consecutiveFails,
        lastCheckedAt: new Date(),
        lastLatencyMs: result.latencyMs,
        detail: result.detail ?? null,
        // Only moved on an actual change, so `since` answers "how long has
        // this been broken" rather than "when did the cron last run".
        ...(next.changed ? { since: new Date() } : {}),
      },
    }).catch((err: unknown) => console.error('[uptime-check] state write failed', err));

    if (next.changed) {
      transitions.push({ probe: result.name, from: prev!.status, to: next.status });
    }
  }

  for (const t of transitions) {
    const recovered = !isBad(t.to);
    const message = recovered
      ? `Health recovered: ${t.probe} is ${t.to} (was ${t.from})`
      : `Health degraded: ${t.probe} is ${t.to} (was ${t.from})`;
    // Sentry is the alerting channel because it is already wired and already
    // routes to whoever is on call. When its DSN is unset this is a no-op —
    // which is itself one of the probes above, so the gap reports itself.
    try {
      const Sentry = await import('@sentry/nextjs');
      Sentry.captureMessage(message, recovered ? 'info' : 'error');
    } catch (err) {
      console.error('[uptime-check] sentry unavailable', err);
    }
    console.warn(`[uptime-check] ${message}`);
    await db.abEvent.create({
      data: {
        tenantId: SYSTEM_TENANT,
        eventType: recovered ? 'health.recovered' : 'health.degraded',
        actor: 'system',
        action: { probe: t.probe, from: t.from, to: t.to },
      },
    }).catch(() => {});
  }

  return NextResponse.json({
    success: true,
    status: overallStatus(results),
    transitions,
    checks: results.map((r) => ({ name: r.name, status: r.status, latencyMs: r.latencyMs })),
  });
}
