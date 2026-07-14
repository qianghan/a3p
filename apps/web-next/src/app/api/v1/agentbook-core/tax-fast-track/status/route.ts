import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { isDraftStale } from '@agentbook-core/tax-questionnaire-session';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STALE_PENDING_MS = 2 * 60 * 1000;

// The "annual filing due" event is titled differently per jurisdiction
// pack — us/calendar-deadlines.ts uses calendar.annual_tax_filing_due,
// ca/calendar-deadlines.ts uses calendar.t1_filing_due (no
// annual_tax_filing_due key exists for CA at all). Fast-track only
// supports us/ca, so this two-entry list covers it — each key is already
// unambiguous to its own jurisdiction, no tenant ever has both. Shared
// with cron/calendar-check/route.ts (Task 5) so both call sites recognize
// the identical set.
export const ANNUAL_FILING_DEADLINE_KEYS = ['calendar.annual_tax_filing_due', 'calendar.t1_filing_due'];

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
