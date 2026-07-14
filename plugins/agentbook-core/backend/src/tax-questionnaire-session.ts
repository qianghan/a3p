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
  // Expire any existing in-progress questionnaire sessions for this tenant,
  // AND any active AbAgentSession — mutual exclusion must hold in both
  // directions (agent-planner.ts's createSession() does the reverse).
  await db.abTaxQuestionnaireSession.updateMany({
    where: { tenantId, status: 'in_progress' },
    data: { status: 'abandoned' },
  });
  await db.abAgentSession.updateMany({
    where: { tenantId, status: 'active' },
    data: { status: 'expired' },
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

// ─── getLatestTaxQuestionnaireSession ───────────────────────────────────────

/**
 * The tenant's most recent session regardless of status — unlike
 * getActiveTaxQuestionnaireSession, which only ever returns an in-progress,
 * non-expired one. Used to check whether a *completed* session's draft is
 * ready (PR-5's chat/MCP draft-status intent, and the dedicated /status
 * route both need this same read).
 */
export async function getLatestTaxQuestionnaireSession(tenantId: string): Promise<any | null> {
  return db.abTaxQuestionnaireSession.findFirst({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
  });
}

// ─── isDraftStale ────────────────────────────────────────────────────────────

const STALE_PENDING_MS = 2 * 60 * 1000;

/**
 * A killed after() invocation (the function was frozen mid-generation)
 * leaves an AbTaxFastTrackDraft row 'pending' forever with nothing to flip
 * it to 'failed'. Flag it as stale past a fixed timeout so callers (the
 * /status route, the /regenerate route, and PR-5's chat/MCP status intent)
 * can all offer a retry instead of waiting forever — one shared
 * computation instead of three copies of the same constant + comparison.
 */
export function isDraftStale(draftRow: { status: string; updatedAt: Date } | null): boolean {
  if (!draftRow) return false;
  return draftRow.status === 'pending' && Date.now() - draftRow.updatedAt.getTime() > STALE_PENDING_MS;
}
