/**
 * GET /agentbook-expense/tax-codes?amountCents=&inclusive=&taxCode=
 *
 * The entry UIs' tax row (PR 2b.8): whether to show it for this tenant, which
 * codes apply, the default, the registration prompt, and an engine preview of
 * the line (see lib/expense-tax-row). Read-only.
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { buildTaxRowView } from '@/lib/expense-tax-row';
import { publicErrorMessage } from '@/lib/api-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const q = request.nextUrl.searchParams;
    const cfg = await db.abTenantConfig.findUnique({
      where: { userId: tenantId },
      select: { jurisdiction: true, region: true, gstRegistered: true, qstRegistered: true },
    });
    const rawAmount = q.get('amountCents');
    const amount = rawAmount !== null && /^\d{1,12}$/.test(rawAmount) ? Number(rawAmount) : undefined;
    const taxCode = q.get('taxCode');
    const view = buildTaxRowView(cfg, {
      amountCents: amount,
      inclusive: q.get('inclusive') !== 'false',
      taxCode: taxCode && /^[A-Za-z_]{1,20}$/.test(taxCode) ? taxCode : undefined,
    });
    return NextResponse.json({ success: true, data: view });
  } catch (err) {
    console.error('[agentbook-expense/tax-codes] failed:', err);
    return NextResponse.json({ success: false, error: publicErrorMessage(err) }, { status: 500 });
  }
}
