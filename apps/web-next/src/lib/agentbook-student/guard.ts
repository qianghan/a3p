/**
 * Shared entitlement guard for the Student Success plugins (Scholarship,
 * Career, Housing). Resolves the tenant AND confirms an active
 * `student_success` add-on — defense-in-depth beyond the plugin-visibility
 * gate, so paid endpoints can't be hit directly by a non-subscriber.
 * Fail-closed (hasAddOn returns false on any error). One implementation so
 * the three plugins never drift on how "paid" is checked.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { hasAddOn } from '@naap/billing';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const STUDENT_ADDON_CODE = 'student_success';

export type StudentGuard = { tenantId: string } | { response: NextResponse };

export async function requireStudentAddon(request: NextRequest): Promise<StudentGuard> {
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
