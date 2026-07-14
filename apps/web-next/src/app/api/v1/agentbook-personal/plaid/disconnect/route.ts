import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { disconnectAccount, sanitizePlaidError } from '@/lib/agentbook-personal-plaid';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface DisconnectBody {
  accountId?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;

  try {
    const body = (await request.json().catch(() => ({}))) as DisconnectBody;
    const { accountId } = body;
    if (!accountId || typeof accountId !== 'string') {
      return NextResponse.json({ success: false, error: 'accountId is required' }, { status: 400 });
    }
    await disconnectAccount(accountId, tenantId);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[agentbook-personal/plaid/disconnect POST] failed:', err);
    return NextResponse.json(
      { success: false, error: sanitizePlaidError(err) },
      { status: 500 },
    );
  }
}
