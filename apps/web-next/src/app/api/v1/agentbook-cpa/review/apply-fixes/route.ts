/**
 * AI-CPA write capability — apply the auto-fixable findings.
 *
 * Gated on the tenant's aiCpaAutoFix toggle (default on; user can disable).
 * The concrete, reversible fix: assign uncategorized confirmed expenses to a
 * fallback "Other Expenses" account so they stop being uncategorized and flow
 * to the tax form. Returns how many were fixed (0 if the toggle is off).
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;

    const cfg = await db.abTenantConfig.findUnique({ where: { userId: tenantId }, select: { aiCpaAutoFix: true } });
    if (!cfg?.aiCpaAutoFix) {
      return NextResponse.json({ success: true, data: { applied: 0, reason: 'auto-fix disabled' } });
    }

    // Fallback expense account: a misc/other expense account, else the
    // highest-coded active expense account (chart convention puts "other" last).
    const fallback =
      (await db.abAccount.findFirst({ where: { tenantId, accountType: 'expense', isActive: true, name: { contains: 'Other', mode: 'insensitive' } } })) ||
      (await db.abAccount.findFirst({ where: { tenantId, accountType: 'expense', isActive: true }, orderBy: { code: 'desc' } }));

    if (!fallback) {
      return NextResponse.json({ success: true, data: { applied: 0, reason: 'no expense account to assign' } });
    }

    const result = await db.abExpense.updateMany({
      where: { tenantId, deletedAt: null, status: 'confirmed', categoryId: null },
      data: { categoryId: fallback.id },
    });

    return NextResponse.json({
      success: true,
      data: { applied: result.count, fallbackAccount: { code: fallback.code, name: fallback.name } },
    });
  } catch (err) {
    console.error('[agentbook-cpa/review/apply-fixes] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
