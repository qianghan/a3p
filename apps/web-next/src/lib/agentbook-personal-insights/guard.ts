/**
 * Shared entitlement guard for the Personal Insights add-on (net-worth trend
 * chart + proactive nudges: budget-threshold, net-worth month-over-month,
 * negative savings rate). Resolves the tenant AND confirms an active
 * `personal_insights` add-on — defense-in-depth beyond any UI-level teaser
 * gate, so paid endpoints can't be hit directly by a non-subscriber.
 * Fail-closed (hasAddOn returns false on any error). One implementation so
 * every enforcement point never drifts on how "paid" is checked. Mirrors
 * `lib/agentbook-student/guard.ts`'s `requireStudentAddon()`.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { hasAddOn } from '@naap/billing';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const PERSONAL_INSIGHTS_ADDON_CODE = 'personal_insights';

export type PersonalInsightsGuard = { tenantId: string } | { response: NextResponse };

export async function requirePersonalInsightsAddon(request: NextRequest): Promise<PersonalInsightsGuard> {
  const resolved = await safeResolveAgentbookTenant(request);
  if ('response' in resolved) return { response: resolved.response };
  const { tenantId } = resolved;
  if (!(await hasAddOn(tenantId, PERSONAL_INSIGHTS_ADDON_CODE))) {
    return {
      response: NextResponse.json(
        {
          error:
            'Net-worth trends and proactive alerts are part of Personal Insights — enable it in your Personal Finance settings to use them.',
        },
        { status: 402 },
      ),
    };
  }
  return { tenantId };
}
