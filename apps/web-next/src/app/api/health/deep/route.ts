/**
 * GET /api/health/deep
 *
 * What an external uptime monitor should poll.
 *
 * `/api/health` answers "is this process alive and can it reach Postgres",
 * which a monitor can already infer from the page loading. This answers the
 * question that actually distinguishes a working deployment from a broken
 * one: can it reach everything it needs, and is everything it needs
 * configured. It turns red when the database goes away, not only when the
 * process dies.
 *
 * Public and unauthenticated, because a monitor that needs a credential is a
 * monitor somebody eventually turns off. That makes what it returns the
 * whole design: probe names, a status word, a latency, and a fixed phrase
 * chosen from a closed set. No URLs, no hostnames, no env values, no error
 * text. `/api/health` used to return `substring(0, 40)` of four Postgres
 * connection strings — one character short of the password — and this
 * endpoint exists in the shadow of that.
 */

import { NextResponse } from 'next/server';
import { runProbes, overallStatus } from '@/lib/health/probes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

export async function GET() {
  const probes = await runProbes();
  const status = overallStatus(probes);

  return NextResponse.json(
    {
      status,
      timestamp: new Date().toISOString(),
      checks: probes.map((p) => ({
        name: p.name,
        status: p.status,
        latencyMs: p.latencyMs,
        critical: p.critical,
        ...(p.detail ? { detail: p.detail } : {}),
      })),
    },
    {
      // 503 only for a critical dependency being down. A missing optional
      // config is a real finding and a bad reason to wake someone up, so it
      // appears in the body rather than in the status code.
      status: status === 'unhealthy' ? 503 : 200,
      headers: { 'Cache-Control': 'no-store' },
    },
  );
}
