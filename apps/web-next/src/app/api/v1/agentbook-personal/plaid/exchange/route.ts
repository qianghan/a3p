import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { requirePersonalInsightsAddon } from '@/lib/agentbook-personal-insights/guard';
import { exchangePublicToken, sanitizePlaidError } from '@/lib/agentbook-personal-plaid';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface ExchangeBody {
  publicToken?: string;
  institutionName?: string | null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guard = await requirePersonalInsightsAddon(request);
  if ('response' in guard) return guard.response;
  const { tenantId } = guard;

  try {
    const body = (await request.json().catch(() => ({}))) as ExchangeBody;
    const { publicToken, institutionName } = body;
    if (!publicToken || typeof publicToken !== 'string') {
      return NextResponse.json({ success: false, error: 'publicToken is required' }, { status: 400 });
    }
    const accounts = await exchangePublicToken(publicToken, institutionName ?? null, tenantId);
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
    console.error('[agentbook-personal/plaid/exchange POST] failed:', err);
    return NextResponse.json(
      { success: false, error: sanitizePlaidError(err) },
      { status: 500 },
    );
  }
}
