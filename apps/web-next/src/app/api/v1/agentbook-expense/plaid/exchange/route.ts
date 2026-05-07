/**
 * POST /api/v1/agentbook-expense/plaid/exchange
 * Body: { publicToken: string, institutionName?: string, accounts?: unknown[] }
 *
 * Exchanges the Link `publicToken` for a long-lived access token,
 * encrypts it, and creates `AbBankAccount` rows for each linked
 * account. The access token never leaves the server — the client only
 * sees the resulting bank-account rows.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { resolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { exchangePublicToken } from '@/lib/agentbook-plaid';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface ExchangeBody {
  publicToken?: string;
  institutionName?: string | null;
  accounts?: unknown;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const tenantId = await resolveAgentbookTenant(request);
    const body = (await request.json().catch(() => ({}))) as ExchangeBody;
    const { publicToken, institutionName } = body;
    if (!publicToken || typeof publicToken !== 'string') {
      return NextResponse.json(
        { success: false, error: 'publicToken is required' },
        { status: 400 },
      );
    }
    const accounts = await exchangePublicToken(publicToken, institutionName ?? null, tenantId);
    // Strip the encrypted token from the response — clients never need it.
    const safe = accounts.map((a) => ({
      id: a.id,
      tenantId: a.tenantId,
      plaidItemId: a.plaidItemId,
      plaidAccountId: a.plaidAccountId,
      name: a.name,
      officialName: a.officialName,
      type: a.type,
      subtype: a.subtype,
      mask: a.mask,
      balanceCents: a.balanceCents,
      currency: a.currency,
      institution: a.institution,
      connected: a.connected,
      lastSynced: a.lastSynced,
      createdAt: a.createdAt,
    }));
    return NextResponse.json({ success: true, data: { accounts: safe } });
  } catch (err) {
    console.error(
      '[plaid/exchange POST] failed:',
      err instanceof Error ? err.message : 'error',
    );
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'unknown error' },
      { status: 500 },
    );
  }
}
