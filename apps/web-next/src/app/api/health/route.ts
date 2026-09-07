/**
 * GET /api/health
 * Liveness + database connectivity. Public and unauthenticated, so it says
 * only whether the app can reach its database and how long that took.
 *
 * It used to also return a diagnostic dump: `substring(0, 40)` of
 * DATABASE_URL, POSTGRES_PRISMA_URL, POSTGRES_URL and POSTGRES_URL_NON_POOLING,
 * which env vars were set, and the raw Prisma error message. That published
 * the Supabase project ref and database username to anyone who curled it, and
 * the 40-character cut landed exactly one character before the password: for
 * `postgres://postgres.<20-char-ref>` the prefix is 40 chars, so index 40 —
 * the first byte of the password — was the next thing the slice would have
 * taken. A shorter project ref or a differently shaped URL would have leaked
 * the production credential outright.
 *
 * Diagnosing env problems belongs behind admin auth, not here.
 */

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic'; // never cache

export async function GET() {
  let database: { connected: boolean; latencyMs?: number };

  try {
    // Dynamic import to avoid module-level init issues
    const { prisma } = await import('@naap/database');
    const start = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    database = { connected: true, latencyMs: Date.now() - start };
  } catch (err) {
    // Deliberately not echoed to the caller: a Prisma connection error
    // carries the host, port and database name.
    console.error('[health] database check failed', err);
    database = { connected: false };
  }

  return NextResponse.json(
    {
      status: database.connected ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      database,
    },
    { status: database.connected ? 200 : 503 },
  );
}
