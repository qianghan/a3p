/**
 * POST /api/v1/agentbook-expense/bank/basiq/disconnect
 * Body: { accountId: string }
 *
 * Mirrors `plaid/disconnect/route.ts`: best-effort removes the connection
 * upstream, then flips `connected=false` locally. Historical
 * `AbBankTransaction` rows are kept.
 */

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

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;

    const body = (await request.json().catch(() => ({}))) as DisconnectBody;
    const { accountId } = body;
    if (!accountId || typeof accountId !== 'string') {
      return NextResponse.json(
        { success: false, error: 'accountId is required' },
        { status: 400 },
      );
    }

    const account = await db.abBankAccount.findFirst({ where: { id: accountId, tenantId } });
    if (!account) {
      return NextResponse.json({ success: true });
    }

    const config = await db.abTenantConfig.findUnique({ where: { userId: tenantId } });
    if (config?.basiqUserId && account.basiqConnectionId) {
      try {
        await removeConnection(config.basiqUserId, account.basiqConnectionId);
      } catch {
        // ignore — Basiq may have already invalidated the connection
      }
    }

    await db.abBankAccount.update({
      where: { id: accountId },
      data: { connected: false },
    });

    await db.abEvent.create({
      data: {
        tenantId,
        eventType: 'basiq.account_disconnected',
        actor: 'system',
        action: { accountId },
      },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[basiq/disconnect POST] failed:', err);
    return NextResponse.json(
      { success: false, error: sanitizeBasiqError(err) },
      { status: 500 },
    );
  }
}
