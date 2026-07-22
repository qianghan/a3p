/**
 * GET /api/v1/agentbook-expense/bank/basiq/status?jobId=...
 *
 * Polled by the frontend after `callback/route.ts` hands it a `jobId`.
 * On job success, creates one `AbBankAccount` row per Basiq account that
 * doesn't already exist locally (matched on `basiqAccountId`), so a
 * connection is safe to poll to success more than once.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { pollJob, listAccounts, sanitizeBasiqError } from '@/lib/agentbook-basiq';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;

    const jobId = request.nextUrl.searchParams.get('jobId');
    if (!jobId) {
      return NextResponse.json({ success: false, error: 'jobId is required' }, { status: 400 });
    }

    const config = await db.abTenantConfig.findUnique({ where: { userId: tenantId } });
    if (!config?.basiqUserId) {
      return NextResponse.json(
        { success: false, error: 'no basiq user for tenant' },
        { status: 400 },
      );
    }

    const job = await pollJob(jobId);
    if (job.status !== 'success') {
      // in-progress or failed — nothing to create yet, frontend keeps polling
      // (or surfaces job.error on 'failed').
      return NextResponse.json({ success: true, data: { status: job.status, error: job.error } });
    }

    const accounts = await listAccounts(config.basiqUserId);
    for (const acct of accounts) {
      const balanceCents = Math.round(parseFloat(acct.balance) * 100);
      await db.abBankAccount.upsert({
        where: { basiqAccountId: acct.id },
        create: {
          tenantId,
          provider: 'basiq',
          basiqAccountId: acct.id,
          basiqConnectionId: acct.connection ?? job.connectionId ?? null,
          name: acct.name,
          type: (acct.class?.type ?? 'checking').toLowerCase(),
          balanceCents,
          currency: acct.currency,
          institution: acct.institution ?? null,
          connected: true,
          lastSynced: new Date(),
        },
        update: {
          connected: true,
          balanceCents,
          lastSynced: new Date(),
        },
      });
    }

    return NextResponse.json({
      success: true,
      data: { status: 'success', accountsLinked: accounts.length },
    });
  } catch (err) {
    console.error('[basiq/status GET] failed:', err);
    return NextResponse.json(
      { success: false, error: sanitizeBasiqError(err) },
      { status: 500 },
    );
  }
}
