import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { isDraftStale, STALE_PENDING_MS } from '@agentbook-core/tax-questionnaire-session';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { ANNUAL_FILING_DEADLINE_KEYS } from '@/lib/tax-fast-track/deadline-keys';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function findNextDeadline(tenantId: string) {
  const event = await db.abCalendarEvent.findFirst({
    where: { tenantId, titleKey: { in: ANNUAL_FILING_DEADLINE_KEYS }, date: { gte: new Date() } },
    orderBy: { date: 'asc' },
  });
  return event ? { date: event.date.toISOString(), titleKey: event.titleKey } : null;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;

  const session = await db.abTaxQuestionnaireSession.findFirst({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
  });

  const nextDeadline = await findNextDeadline(tenantId);

  if (!session) {
    return NextResponse.json({ success: true, data: { session: null, draft: null, nextDeadline } });
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

  // STALE_PENDING_MS is imported from the session module (single-sourced
  // with isDraftStale's own use of it) and drives the SESSION-level
  // synthesis path below — the case where there's no draft row at all
  // yet — which isDraftStale itself doesn't cover, since isDraftStale only
  // takes a draft row.
  //
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
      nextDeadline,
    },
  });
}
