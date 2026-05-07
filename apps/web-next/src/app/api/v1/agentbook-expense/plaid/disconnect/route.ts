/**
 * POST /api/v1/agentbook-expense/plaid/disconnect
 * Body: { accountId: string }
 *
 * Removes the Plaid item upstream (best-effort), clears the encrypted
 * access token + cursor, and flips `connected=false`. Historical
 * AbBankTransaction rows are kept — disconnecting shouldn't lose the
 * user's reconciled history.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { resolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { disconnectAccount } from '@/lib/agentbook-plaid';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface DisconnectBody {
  accountId?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const tenantId = await resolveAgentbookTenant(request);
    const body = (await request.json().catch(() => ({}))) as DisconnectBody;
    const { accountId } = body;
    if (!accountId || typeof accountId !== 'string') {
      return NextResponse.json(
        { success: false, error: 'accountId is required' },
        { status: 400 },
      );
    }
    await disconnectAccount(accountId, tenantId);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error(
      '[plaid/disconnect POST] failed:',
      err instanceof Error ? err.message : 'error',
    );
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'unknown error' },
      { status: 500 },
    );
  }
}
