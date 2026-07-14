import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { requirePersonalInsightsAddon } from '@/lib/agentbook-personal-insights/guard';
import { createLinkToken, sanitizePlaidError } from '@/lib/agentbook-personal-plaid';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guard = await requirePersonalInsightsAddon(request);
  if ('response' in guard) return guard.response;
  const { tenantId } = guard;

  try {
    const { linkToken, expiration } = await createLinkToken(tenantId);
    return NextResponse.json({
      success: true,
      data: { linkToken, expiration, environment: process.env.PLAID_ENV || 'sandbox' },
    });
  } catch (err) {
    console.error('[agentbook-personal/plaid/link-token POST] failed:', err);
    return NextResponse.json(
      { success: false, error: sanitizePlaidError(err) },
      { status: 500 },
    );
  }
}
