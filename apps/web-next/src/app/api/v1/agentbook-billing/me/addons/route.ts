import { NextRequest, NextResponse } from 'next/server';
import { hasAddOn, resolveAddOnPrice } from '@naap/billing';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;

  const url = new URL(request.url);
  const code = url.searchParams.get('code') ?? 'startup_tax_benefits';
  const region = url.searchParams.get('region') ?? 'us';

  const active = await hasAddOn(tenantId, code);
  const price = await resolveAddOnPrice(code, region);
  return NextResponse.json({ active, price });
}
