import { db } from './db/client.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface QaPair {
  question: string;
  answer: string;
}

// ─── createTaxQuestionnaireSession ──────────────────────────────────────────

export async function createTaxQuestionnaireSession(
  tenantId: string,
  taxYear: number,
  jurisdiction: string,
  region: string | null,
  trigger: string,
  sourceFilingId: string | null,
): Promise<any> {
  // Expire any existing in-progress questionnaire sessions for this tenant
  await db.abTaxQuestionnaireSession.updateMany({
    where: { tenantId, status: 'in_progress' },
    data: { status: 'abandoned' },
  });

  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);

  return db.abTaxQuestionnaireSession.create({
    data: {
      tenantId,
      taxYear,
      jurisdiction,
      region,
      trigger,
      sourceFilingId,
      status: 'in_progress',
      qaHistory: [],
      askedCount: 0,
      consecutiveFailures: 0,
      expiresAt,
    },
  });
}

// ─── getActiveTaxQuestionnaireSession ───────────────────────────────────────

export async function getActiveTaxQuestionnaireSession(tenantId: string): Promise<any | null> {
  return db.abTaxQuestionnaireSession.findFirst({
    where: {
      tenantId,
      status: 'in_progress',
      expiresAt: { gt: new Date() },
    },
  });
}

// ─── updateTaxQuestionnaireSession ──────────────────────────────────────────

export async function updateTaxQuestionnaireSession(
  id: string,
  version: number,
  data: {
    qaHistory?: QaPair[];
    askedCount?: number;
    consecutiveFailures?: number;
    status?: string;
    expiresAt?: Date;
  },
): Promise<boolean> {
  const { qaHistory, askedCount, consecutiveFailures, status, expiresAt } = data;

  const result = await db.$executeRaw`
    UPDATE "plugin_agentbook_core"."AbTaxQuestionnaireSession"
    SET "version" = "version" + 1, "updatedAt" = NOW(),
        "qaHistory" = COALESCE(${qaHistory ? JSON.stringify(qaHistory) : null}::jsonb, "qaHistory"),
        "askedCount" = COALESCE(${askedCount ?? null}, "askedCount"),
        "consecutiveFailures" = COALESCE(${consecutiveFailures ?? null}, "consecutiveFailures"),
        "status" = COALESCE(${status ?? null}, "status"),
        "expiresAt" = COALESCE(${expiresAt ?? null}, "expiresAt")
    WHERE "id" = ${id} AND "version" = ${version}`;

  return result > 0;
}
