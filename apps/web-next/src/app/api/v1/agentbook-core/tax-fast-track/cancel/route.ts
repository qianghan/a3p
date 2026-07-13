import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { cancelTaxQuestionnaire } from '@agentbook-core/tax-questionnaire-core';
import { getActiveTaxQuestionnaireSession } from '@agentbook-core/tax-questionnaire-session';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;

  const tqSession = await getActiveTaxQuestionnaireSession(tenantId);
  if (!tqSession) {
    return NextResponse.json({ success: false, error: 'no_active_session' }, { status: 400 });
  }

  const result = await cancelTaxQuestionnaire(tqSession);
  return NextResponse.json({ success: true, data: result });
}
