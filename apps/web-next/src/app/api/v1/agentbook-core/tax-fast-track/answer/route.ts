import 'server-only';
import { after, NextRequest, NextResponse } from 'next/server';
import { answerTaxQuestionnaire } from '@agentbook-core/tax-questionnaire-core';
import { getActiveTaxQuestionnaireSession } from '@agentbook-core/tax-questionnaire-session';
import { callGemini } from '@agentbook-core/server';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { generateFilingDraft } from '@/lib/tax-fast-track-draft';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;

  const body = await request.json().catch(() => ({}));
  const text = String(body.text ?? '').trim();
  if (!text) {
    return NextResponse.json({ success: false, error: 'text required' }, { status: 400 });
  }

  const tqSession = await getActiveTaxQuestionnaireSession(tenantId);
  if (!tqSession) {
    return NextResponse.json({ success: false, error: 'no_active_session' }, { status: 400 });
  }

  const result = await answerTaxQuestionnaire(tqSession, text, callGemini);

  if (result.status === 'done') {
    const completedSessionId = result.sessionId;
    after(() => generateFilingDraft(completedSessionId, callGemini).catch((err) => {
      console.error('[tax-fast-track/answer] generateFilingDraft failed:', err);
    }));
  }

  return NextResponse.json({ success: true, data: result });
}
