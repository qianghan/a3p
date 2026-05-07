/**
 * POST /api/v1/agentbook-expense/plaid/link-token
 *
 * Returns a short-lived `linkToken` that the Plaid Link UI uses to start
 * an OAuth flow. Tenant-scoped via `resolveAgentbookTenant`.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { resolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { createLinkToken } from '@/lib/agentbook-plaid';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const tenantId = await resolveAgentbookTenant(request);
    const { linkToken, expiration } = await createLinkToken(tenantId);
    // NOTE: never log the linkToken itself — it's a session-bound credential.
    return NextResponse.json({
      success: true,
      data: { linkToken, expiration, environment: process.env.PLAID_ENV || 'sandbox' },
    });
  } catch (err) {
    console.error('[plaid/link-token POST] failed:', err instanceof Error ? err.message : 'error');
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'unknown error' },
      { status: 500 },
    );
  }
}
