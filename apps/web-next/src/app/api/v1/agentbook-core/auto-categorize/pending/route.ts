import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { getPendingSuggestions } from '@/lib/agentbook-auto-categorize';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const resolved = await safeResolveAgentbookTenant(request);
    if ('response' in resolved) return resolved.response;
    const { tenantId } = resolved;

    // Fetch raw pending suggestions from AbUserMemory.
    const suggestions = await getPendingSuggestions(tenantId);

    // Expense totals.
    const [totalCount, uncategorizedCount] = await Promise.all([
      db.abExpense.count({ where: { tenantId, isPersonal: false } }),
      db.abExpense.count({ where: { tenantId, isPersonal: false, categoryId: null } }),
    ]);

    // Filter stale suggestions — keep only those whose expense is still uncategorized.
    let freshItems = suggestions;
    if (suggestions.length > 0) {
      const expenseIds = suggestions.map((s) => s.expenseId);
      const stillUncategorized = await db.abExpense.findMany({
        where: { id: { in: expenseIds }, categoryId: null },
        select: { id: true },
      });
      const stillUncategorizedSet = new Set(stillUncategorized.map((e) => e.id));
      freshItems = suggestions.filter((s) => stillUncategorizedSet.has(s.expenseId));
    }

    const uncategorizedPct =
      totalCount > 0 ? Math.round((uncategorizedCount / totalCount) * 1000) / 10 : 0;

    return NextResponse.json({
      success: true,
      data: {
        items: freshItems,
        uncategorizedCount,
        totalCount,
        uncategorizedPct,
      },
    });
  } catch (err) {
    console.error('[auto-categorize/pending] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
