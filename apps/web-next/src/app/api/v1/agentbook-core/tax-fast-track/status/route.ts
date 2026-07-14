import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { isDraftStale } from '@agentbook-core/tax-questionnaire-session';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STALE_PENDING_MS = 2 * 60 * 1000; // kept here too — used below for the session-level (no-draft-row) synthesis, which isDraftStale doesn't cover

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
      stale: isDraftStale(draftRow),
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
