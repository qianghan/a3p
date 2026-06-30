import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { autoCategorizeForTenant } from '@/lib/agentbook-auto-categorize';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function isCronRequest(request: NextRequest): { ok: boolean; tenantId?: string } {
  const cronSecret = process.env.CRON_SECRET;
  const provided = request.headers.get('x-internal-cron');
  const tenantId = request.headers.get('x-tenant-id') ?? undefined;
  if (!provided || !tenantId) return { ok: false };
  // Dev mode: no CRON_SECRET set — allow any internal caller (with warning)
  if (!cronSecret) {
    console.warn('[auto-categorize/run] CRON_SECRET not set — accepting internal call in dev mode');
    return { ok: true, tenantId };
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(cronSecret);
  if (a.length !== b.length) return { ok: false };
  return timingSafeEqual(a, b) ? { ok: true, tenantId } : { ok: false };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    // Check for internal cron/watchdog call first.
    const cron = isCronRequest(request);
    let tenantId: string;
    let force = false;

    if (cron.ok && cron.tenantId) {
      tenantId = cron.tenantId;
      force = true; // internal callers bypass the 20h dedupe
    } else {
      const resolved = await safeResolveAgentbookTenant(request);
      if ('response' in resolved) return resolved.response;
      tenantId = resolved.tenantId;
    }

    const result = await autoCategorizeForTenant(tenantId, { force });

    return NextResponse.json({
      success: true,
      data: {
        appliedCount: result.appliedCount,
        pendingCount: result.pending.length,
        skippedCount: result.skippedCount,
      },
    });
  } catch (err) {
    console.error('[auto-categorize/run] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
