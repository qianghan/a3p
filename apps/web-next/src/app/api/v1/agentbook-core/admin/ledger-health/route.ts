/**
 * GET /api/v1/agentbook-core/admin/ledger-health
 *
 * Read-only diagnostic: which tenants CAN'T post to the ledger?
 *
 * Journal posting is best-effort by design — expense booking, the post-hoc
 * categorization back-fill, and Stripe payment reconciliation all skip silently
 * when the tenant has no Cash account (code 1000) or A/R account (code 1100).
 * A tenant in that state looks fine in the UI while its P&L, trial balance and
 * tax estimate quietly omit real money.
 *
 * New signups get these seeded during onboarding, so the risk is accounts that
 * predate the seed (or a partially-failed seed). This endpoint answers that
 * across every tenant in one query instead of requiring direct DB access.
 *
 * Admin-gated, read-only, and returns no PII beyond the tenant id already
 * visible in the admin user list.
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { requireAdmin } from '@/lib/admin-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** Codes journal posting depends on. 2100 is tax-liability (sales-tax lines). */
const CASH = '1000';
const AR = '1100';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await requireAdmin(request);
  if ('response' in guard) return guard.response as NextResponse;

  try {
    const tenants = await db.abTenantConfig.findMany({
      select: { userId: true, jurisdiction: true, businessType: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });

    // One pass over the relevant accounts for all tenants, rather than N queries.
    const accounts = await db.abAccount.findMany({
      where: { code: { in: [CASH, AR] } },
      select: { tenantId: true, code: true, isActive: true },
    });

    const byTenant = new Map<string, Set<string>>();
    for (const a of accounts) {
      // Only an ACTIVE account is usable by the posting paths.
      if (!a.isActive) continue;
      const set = byTenant.get(a.tenantId) ?? new Set<string>();
      set.add(a.code);
      byTenant.set(a.tenantId, set);
    }

    const unhealthy: {
      tenantId: string;
      jurisdiction: string;
      businessType: string | null;
      createdAt: string;
      missing: string[];
    }[] = [];

    for (const t of tenants) {
      const have = byTenant.get(t.userId) ?? new Set<string>();
      const missing: string[] = [];
      if (!have.has(CASH)) missing.push(CASH);
      if (!have.has(AR)) missing.push(AR);
      if (missing.length > 0) {
        unhealthy.push({
          tenantId: t.userId,
          jurisdiction: t.jurisdiction,
          businessType: t.businessType ?? null,
          createdAt: t.createdAt.toISOString(),
          missing,
        });
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        totalTenants: tenants.length,
        healthy: tenants.length - unhealthy.length,
        unhealthyCount: unhealthy.length,
        // A tenant missing 1000 cannot book expenses or payments at all; missing
        // only 1100 affects invoice A/R posting.
        cannotBookAtAll: unhealthy.filter((u) => u.missing.includes(CASH)).length,
        unhealthy,
        checkedCodes: { cash: CASH, accountsReceivable: AR },
      },
    });
  } catch (err) {
    console.error('[admin/ledger-health] failed:', err);
    return NextResponse.json(
      { success: false, error: 'Could not compute ledger health' },
      { status: 500 },
    );
  }
}
