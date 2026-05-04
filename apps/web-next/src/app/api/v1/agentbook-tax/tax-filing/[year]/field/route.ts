/**
 * Update a single tax filing field override.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { resolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { updateFilingField } from '@agentbook-tax/tax-filing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface FieldBody {
  formCode?: string;
  fieldId?: string;
  value?: unknown;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ year: string }> },
): Promise<NextResponse> {
  try {
    const tenantId = await resolveAgentbookTenant(request);
    const { year } = await params;
    const body = (await request.json().catch(() => ({}))) as FieldBody;
    const { formCode, fieldId, value } = body;
    if (!formCode || !fieldId) {
      return NextResponse.json(
        { success: false, error: 'formCode and fieldId are required' },
        { status: 400 },
      );
    }
    const result = await updateFilingField(
      tenantId,
      parseInt(year, 10),
      formCode,
      fieldId,
      value,
    );
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    console.error('[agentbook-tax/tax-filing/:year/field] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
