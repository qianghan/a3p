import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@naap/database';
import { hasAddOn, resolveAddOnPrice, activeAddOnCodes } from '@naap/billing';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { isAddOnAvailable } from '@/lib/addon-availability';

export const runtime = 'nodejs';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;

  const url = new URL(request.url);
  const code = url.searchParams.get('code');

  if (!code) {
    // List all active add-ons with this tenant's subscription status. No
    // code/region query params on this branch — the tenant's own region
    // comes from AbTenantConfig.jurisdiction (same source Settings' Business
    // Profile tab reads/writes), unlike the single-code branch below which
    // still takes region from the caller (established convention: the
    // subscribe route also receives region from the request body since the
    // client already has it in hand there).
    const cfg = await prisma.abTenantConfig.findUnique({ where: { userId: tenantId } });
    const region = cfg?.jurisdiction || 'us';
    const [catalog, activeCodes] = await Promise.all([
      prisma.billAddOn.findMany({ where: { isActive: true } }),
      activeAddOnCodes(tenantId),
    ]);
    // Hide add-ons not available in this tenant's jurisdiction (e.g. the
    // startup benefits engine exists only for US + AU) so they can't be bought
    // where they'd return "not available" — but still surface any the tenant
    // already has active, so they can see/cancel it.
    const offerable = catalog.filter((a) => isAddOnAvailable(a.code, region) || activeCodes.has(a.code));
    const addons = await Promise.all(offerable.map(async (a) => ({
      code: a.code,
      name: a.name,
      // BillAddOn has no description column today — surface null rather
      // than fabricating text; consumers already treat this as optional.
      description: null as string | null,
      active: activeCodes.has(a.code),
      // Surface the add-on's billing interval so the UI renders /mo vs /yr
      // correctly instead of assuming monthly (tax_fast_track / student_success
      // bill yearly; personal_insights bills monthly).
      interval: a.interval,
      price: await resolveAddOnPrice(a.code, region),
    })));
    return NextResponse.json({ addons });
  }

  // Existing single-code lookup, unchanged.
  const region = url.searchParams.get('region') ?? 'us';
  const active = await hasAddOn(tenantId, code);
  const price = await resolveAddOnPrice(code, region);
  return NextResponse.json({ active, price });
}
