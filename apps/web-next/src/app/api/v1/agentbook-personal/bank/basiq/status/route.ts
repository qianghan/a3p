import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { requirePersonalInsightsAddon } from '@/lib/agentbook-personal-insights/guard';
import { pollJob, listAccounts, sanitizeBasiqError } from '@/lib/agentbook-basiq';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * Polls a Basiq job for the personal-finance (AU) bank connect flow. On
 * success, creates one AbPersonalAccount row per Basiq account that doesn't
 * already exist (matched on `basiqAccountId`). Mirrors the business-side
 * `agentbook-expense/bank/basiq/status` route (AU-1 Task 2, Step 2) — same
 * shape, targeting AbPersonalAccount instead of AbBankAccount, and gated by
 * `requirePersonalInsightsAddon` per personal-finance's precedent.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await requirePersonalInsightsAddon(request);
  if ('response' in guard) return guard.response;
  const { tenantId } = guard;

  const jobId = request.nextUrl.searchParams.get('jobId');
  if (!jobId) {
    return NextResponse.json({ success: false, error: 'jobId is required' }, { status: 400 });
  }

  try {
    const config = await db.abTenantConfig.findUnique({ where: { userId: tenantId } });
    if (!config?.basiqUserId) {
      return NextResponse.json(
        { success: false, error: 'no Basiq user for this tenant' },
        { status: 400 },
      );
    }

    const job = await pollJob(jobId);
    if (job.status !== 'success') {
      return NextResponse.json({ success: true, data: { status: job.status, error: job.error } });
    }

    const accounts = await listAccounts(config.basiqUserId);
    for (const acct of accounts) {
      await db.abPersonalAccount.upsert({
        where: { basiqAccountId: acct.id },
        create: {
          tenantId,
          provider: 'basiq',
          basiqAccountId: acct.id,
          basiqConnectionId: acct.connection ?? job.connectionId ?? null,
          name: acct.name,
          type: (acct.class?.type ?? 'checking').toLowerCase(),
          balanceCents: Math.round(parseFloat(acct.balance) * 100),
          currency: acct.currency,
          institution: acct.institution ?? null,
          connected: true,
          isAsset: (acct.class?.type ?? 'checking').toLowerCase() !== 'credit-card',
          lastSynced: new Date(),
        },
        update: {
          connected: true,
          balanceCents: Math.round(parseFloat(acct.balance) * 100),
          lastSynced: new Date(),
        },
      });
    }

    await db.abEvent.create({
      data: {
        tenantId,
        eventType: 'personal.account_connected',
        actor: 'system',
        action: { provider: 'basiq', jobId, accountCount: accounts.length },
      },
    });

    return NextResponse.json({
      success: true,
      data: { status: 'success', accountsLinked: accounts.length },
    });
  } catch (err) {
    console.error('[agentbook-personal/bank/basiq/status GET] failed:', err);
    return NextResponse.json(
      { success: false, error: sanitizeBasiqError(err) },
      { status: 500 },
    );
  }
}
