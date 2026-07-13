import 'server-only';
import { after, NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { startTaxQuestionnaire } from '@agentbook-core/tax-questionnaire-core';
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

  // Same lookup classifyOnly() uses in server.ts to resolve a tenant's
  // configured jurisdiction/region — note the column is `userId`, not
  // `tenantId`, on this particular model.
  const tenantConfig = await db.abTenantConfig.findFirst({ where: { userId: tenantId } });
  const jurisdiction = (tenantConfig?.jurisdiction || 'us').toLowerCase();
  const region = tenantConfig?.region || null;

  const result = await startTaxQuestionnaire(tenantId, { taxYear: body.taxYear, jurisdiction, region }, callGemini);

  if (result.status === 'done') {
    const completedSessionId = result.sessionId;
    after(() => generateFilingDraft(completedSessionId, callGemini).catch((err) => {
      console.error('[tax-fast-track/start] generateFilingDraft failed:', err);
    }));
  }

  return NextResponse.json({ success: true, data: result });
}
