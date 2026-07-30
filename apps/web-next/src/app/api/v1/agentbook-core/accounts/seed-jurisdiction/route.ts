/**
 * Seed a default chart of accounts for the tenant's jurisdiction.
 *
 * Real, tested jurisdiction-pack charts — replaces the previously
 * duplicated, US-only inline account list (and the silent "always US"
 * fallback for every other jurisdiction, including ca and au) with the
 * same us/ca/au ChartOfAccountsTemplate packs already used elsewhere in
 * the tax engine. Re-runnable: upserts by (tenantId, code).
 *
 * businessType='student' gets a separate set — tuition/scholarship/gig
 * income isn't a Schedule-C/T2125/BAS business in any jurisdiction, and
 * there's no per-jurisdiction student chart pack to consume.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { ensureChartOfAccounts } from '@/lib/agentbook-chart-of-accounts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;

    // force: this is the explicit seed endpoint, so always re-upsert the full
    // chart (refreshing names / tax categories) — matching prior behavior. The
    // seeding logic now lives in lib/agentbook-chart-of-accounts so the ledger
    // paths can seed on demand instead of silently skipping.
    const { count } = await ensureChartOfAccounts(tenantId, { force: true });

    return NextResponse.json({ success: true, data: { count } });
  } catch (err) {
    console.error('[agentbook-core/accounts/seed-jurisdiction] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
