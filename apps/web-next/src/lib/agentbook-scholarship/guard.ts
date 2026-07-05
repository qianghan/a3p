/**
 * Entitlement guard for the Scholarship plugin's API routes. Resolves the
 * tenant AND confirms an active `student_success` add-on subscription —
 * defense-in-depth beyond the plugin-visibility gate, so the paid endpoints
 * can't be hit directly by a non-subscriber. Fail-closed (hasAddOn returns
 * false on any error).
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { hasAddOn } from '@naap/billing';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const STUDENT_ADDON_CODE = 'student_success';

export type ScholarshipGuard = { tenantId: string } | { response: NextResponse };

export async function requireScholarshipAccess(request: NextRequest): Promise<ScholarshipGuard> {
  const resolved = await safeResolveAgentbookTenant(request);
  if ('response' in resolved) return { response: resolved.response };
  const { tenantId } = resolved;
  if (!(await hasAddOn(tenantId, STUDENT_ADDON_CODE))) {
    return {
      response: NextResponse.json(
        { error: 'The Student Success add-on is required for this feature.' },
        { status: 402 },
      ),
    };
  }
  return { tenantId };
}
