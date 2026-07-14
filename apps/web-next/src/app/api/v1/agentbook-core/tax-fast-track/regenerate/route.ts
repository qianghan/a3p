import 'server-only';
import { after, NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { isDraftStale } from '@agentbook-core/tax-questionnaire-session';
import { callGemini } from '@agentbook-core/server';
import { requireTaxFastTrackAddon } from '@/lib/agentbook-tax-fast-track/guard';
import { generateFilingDraft } from '@/lib/tax-fast-track-draft';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const __resolved = await requireTaxFastTrackAddon(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;

  const body = await request.json().catch(() => ({}));
  const sessionId = String(body.sessionId ?? '');
  if (!sessionId) {
    return NextResponse.json({ success: false, error: 'sessionId required' }, { status: 400 });
  }

  const session = await db.abTaxQuestionnaireSession.findUnique({ where: { id: sessionId } });
  if (!session || session.tenantId !== tenantId || session.status !== 'completed') {
    return NextResponse.json({ success: false, error: 'session not eligible for regeneration' }, { status: 400 });
  }

  const draft = await db.abTaxFastTrackDraft.findUnique({ where: { sessionId } });
  const isStale = isDraftStale(draft);
  if (draft && draft.status !== 'failed' && !isStale) {
    return NextResponse.json({ success: false, error: `draft is '${draft.status}', not eligible for regeneration` }, { status: 400 });
  }

  after(() => generateFilingDraft(sessionId, callGemini).catch((err) => {
    console.error('[tax-fast-track/regenerate] generateFilingDraft failed:', err);
  }));

  return NextResponse.json({ success: true, data: { status: 'pending' } });
}
