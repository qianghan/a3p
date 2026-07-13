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
  let draft = draftRow
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

  // A killed after() invocation can also die BEFORE its first DB write —
  // i.e. before the row-creating upsert ever runs — leaving no
  // AbTaxFastTrackDraft row at all. In that case `draft` above is null and
  // there is no staleness signal, so the UI polls "Generating..." forever
  // with no retry option. Synthesize a stale-pending draft once the session
  // itself has sat 'completed' (which is when generation should have
  // started) for longer than the same timeout used for stale draft rows.
  if (!draft && session.status === 'completed' && Date.now() - session.updatedAt.getTime() > STALE_PENDING_MS) {
    draft = {
      status: 'pending',
      draftPdfUrl: null,
      letterPdfUrl: null,
      draftSummary: null,
      errorMsg: null,
      stale: true,
    };
  }

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
