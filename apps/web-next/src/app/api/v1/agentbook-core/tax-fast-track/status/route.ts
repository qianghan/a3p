import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STALE_PENDING_MS = 2 * 60 * 1000;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;

  const session = await db.abTaxQuestionnaireSession.findFirst({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
  });

  if (!session) {
    return NextResponse.json({ success: true, data: { session: null, draft: null } });
  }

  const draftRow = await db.abTaxFastTrackDraft.findUnique({ where: { sessionId: session.id } });
  const draft = draftRow
    ? {
      status: draftRow.status,
      draftPdfUrl: draftRow.draftPdfUrl,
      letterPdfUrl: draftRow.letterPdfUrl,
      draftSummary: draftRow.draftSummary,
      errorMsg: draftRow.errorMsg,
      // A killed after() invocation (e.g. the function was frozen before
      // generateFilingDraft finished) leaves the row 'pending' forever with
      // nothing to flip it to 'failed' — flag it as stale past a fixed
      // timeout so the UI can offer a retry rather than polling forever.
      stale: draftRow.status === 'pending' && Date.now() - draftRow.updatedAt.getTime() > STALE_PENDING_MS,
    }
    : null;

  return NextResponse.json({
    success: true,
    data: {
      session: {
        id: session.id, status: session.status, qaHistory: session.qaHistory, askedCount: session.askedCount,
      },
      draft,
    },
  });
}
