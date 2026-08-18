/**
 * Structured (non-conversational) field correction from the web review tab.
 *
 * Production mirror of the Express plugin route of the same path. Value
 * bounds live inside `applyFieldEdit` itself so this route and the chat
 * path cannot disagree about what a valid money value is.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { reviewErrorResponse } from '@/lib/agentbook-tax-review/errors';
import { applyFieldEdit } from '@agentbook-tax/tax-review-agent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface EditFieldBody {
  formCode?: unknown;
  fieldId?: unknown;
  valueCents?: unknown;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ year: string }> },
): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const { year } = await params;
    const body = (await request.json().catch(() => ({}))) as EditFieldBody;
    const { formCode, fieldId, valueCents } = body;
    if (typeof formCode !== 'string' || typeof fieldId !== 'string' || typeof valueCents !== 'number') {
      return NextResponse.json(
        { success: false, error: 'formCode, fieldId, and a numeric valueCents are required' },
        { status: 400 },
      );
    }
    const result = await applyFieldEdit(tenantId, parseInt(year, 10), formCode, fieldId, valueCents);
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    return reviewErrorResponse('agentbook-tax/tax-filing/:year/review/edit-field', err);
  }
}
