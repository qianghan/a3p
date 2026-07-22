import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { removeConnection, sanitizeBasiqError } from '@/lib/agentbook-basiq';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface DisconnectBody {
  accountId?: string;
}

/**
 * Disconnects a personal-finance (AU) Basiq-backed bank account. Unlike the
 * other 3 personal Basiq routes (consent-url/status/sync), this route is
 * intentionally NOT wrapped in `requirePersonalInsightsAddon` — it uses
 * plain `safeResolveAgentbookTenant`, mirroring the exact asymmetry already
 * established by `agentbook-personal/plaid/disconnect/route.ts`: a user who
 * lets their Personal Insights add-on lapse must still be able to disconnect
 * a bank account (data-egress/control should never be paywalled), they just
 * can't re-connect or sync a new one without the add-on.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const resolved = await safeResolveAgentbookTenant(request);
  if ('response' in resolved) return resolved.response;
  const { tenantId } = resolved;

  try {
    const body = (await request.json().catch(() => ({}))) as DisconnectBody;
    const { accountId } = body;
    if (!accountId || typeof accountId !== 'string') {
      return NextResponse.json({ success: false, error: 'accountId is required' }, { status: 400 });
    }

    const account = await db.abPersonalAccount.findFirst({ where: { id: accountId, tenantId } });
    if (!account) {
      return NextResponse.json({ success: true });
    }

    const config = await db.abTenantConfig.findUnique({ where: { userId: tenantId } });
    if (config?.basiqUserId && account.basiqConnectionId) {
      try {
        await removeConnection(config.basiqUserId, account.basiqConnectionId);
      } catch (err) {
        // Basiq may have already invalidated the connection — don't block
        // the local disconnect on a remote-side failure, matching Plaid's
        // disconnectAccount precedent (agentbook-personal-plaid.ts).
        console.warn('[agentbook-personal/bank/basiq/disconnect POST] removeConnection failed:', err);
      }
    }

    await db.abPersonalAccount.update({
      where: { id: accountId },
      data: { connected: false },
    });

    await db.abEvent.create({
      data: {
        tenantId,
        eventType: 'personal.account_disconnected',
        actor: 'system',
        action: { accountId, provider: 'basiq' },
      },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[agentbook-personal/bank/basiq/disconnect POST] failed:', err);
    return NextResponse.json(
      { success: false, error: sanitizeBasiqError(err) },
      { status: 500 },
    );
  }
}
