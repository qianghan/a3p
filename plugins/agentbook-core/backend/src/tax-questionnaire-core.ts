import { db } from './db/client.js';
import { listPastFilingsForTenant } from './past-filing-context.js';
import {
  createTaxQuestionnaireSession,
  updateTaxQuestionnaireSession,
  type QaPair,
} from './tax-questionnaire-session.js';
import { getTaxQuestionnairePack, listSupportedJurisdictions } from '@agentbook/jurisdictions/tax-questionnaire-loader';
import type { StandardTaxExtract, TaxQuestionnairePack } from '@agentbook/jurisdictions/interfaces';
import { buildPersonalProfileContext } from './personal-profile-context.js';

/**
 * Extracted from PR-3's chat-only code (server.ts's `start-tax-fast-track`
 * INTERNAL handler + agent-brain.ts's "Step 1b" session-recovery branch) so
 * the same state machine can be driven by chat AND by plain UI-facing HTTP
 * routes (PR-4, Task 6) without duplicating cancel-keyword handling,
 * pending-question recovery, the consecutive-failure cap, or version-guarded
 * updates in two places. See docs/superpowers/specs/2026-07-13-tax-fast-
 * track-filing-draft-design.md ("Shared core: extracting PR-3's state
 * machine").
 *
 * No chat-specific concerns here — no `skillUsed`, no `AgentResponse`
 * shape, no `confidence`. Callers (agent-brain.ts's Step 1b, server.ts's
 * start-tax-fast-track handler, and PR-4's new UI routes) translate
 * `CoreResult` into whatever their own response shape needs.
 */
export type CoreResult =
  | { status: 'question'; question: string; sessionId: string }
  | { status: 'done'; sessionId: string }
  | { status: 'blocked'; message: string }
  | { status: 'failed'; message: string; sessionId?: string }
  | { status: 'cancelled'; sessionId: string };

/**
 * callGemini() has the real signature (systemPrompt, userMessage, maxTokens?)
 * => Promise<string | null> and NEVER throws — a missing key, HTTP error, or
 * empty response are all a `null` return, not an exception. Passed in by
 * every caller (never imported from server.ts) to avoid a circular import:
 * server.ts already imports from agent-brain.ts, and agent-brain.ts imports
 * this module, so this module importing callGemini FROM server.ts would
 * close the cycle.
 */
export type CallGeminiFn = (systemPrompt: string, userMessage: string, maxTokens?: number) => Promise<string | null>;

/**
 * Strip markdown code-fence wrapping from an LLM's raw JSON string before
 * JSON.parse'ing it. This is the single copy of a helper that used to be
 * duplicated three ways (server.ts's `cleanJsonForTaxFastTrack`,
 * agent-brain.ts's `cleanJson`, and tax-past-filings.ts's private
 * `cleanJson`) — the first two collapse into this one now that their only
 * callers live in the same file. Exported so Task 4's `generateFilingDraft`
 * orchestrator can reuse it too, rather than adding a fourth copy.
 */
export function cleanJson(raw: string): string {
  let s = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first > 0 || (last >= 0 && last < s.length - 1)) {
    if (first >= 0 && last > first) s = s.slice(first, last + 1);
  }
  return s;
}

/**
 * Shared failure-turn handling, used both when callGemini() returns falsy
 * and when the fence-strip/JSON.parse/parseNextQuestionResponse() step
 * throws on malformed content. Deliberately does NOT touch qaHistory/
 * askedCount/expiresAt — only consecutiveFailures advances, so the next
 * answer re-attempts the SAME pending question. At consecutiveFailures >= 3
 * the session is marked 'abandoned' instead (a small safety cap distinct
 * from the 8-question content cap).
 */
async function handleFailureTurn(tqSession: any): Promise<CoreResult> {
  const nextFailures = (tqSession.consecutiveFailures || 0) + 1;
  const abandon = nextFailures >= 3;

  const ok = await updateTaxQuestionnaireSession(tqSession.id, tqSession.version, {
    consecutiveFailures: nextFailures,
    ...(abandon ? { status: 'abandoned' } : {}),
  });

  if (!ok) {
    // No sessionId here — matches the original handleTaxQuestionnaireFailure
    // exactly (agent-brain.ts:501-511 omits it on the version-conflict path
    // specifically, while the two "real" failure messages below DO carry
    // it). Preserve this asymmetry; it is deliberate in the original, not
    // an inconsistency to "fix."
    return { status: 'failed', message: 'Session was modified by another process. Please try again.' };
  }

  return {
    status: 'failed',
    message: abandon
      ? "I'm having trouble processing your answers right now, so I've paused the tax questionnaire. Feel free to start it again in a bit."
      : "Sorry, something went wrong on my end — could you try answering that again?",
    sessionId: tqSession.id,
  };
}

/**
 * Turn 1: find a confirmed prior-year filing, create the session, get the
 * first question. `params.triggerText` is the exact user message that
 * triggered this (chat) or '' (UI's plain Start button) — passed through to
 * callGemini as extra context, matching the original chat behavior exactly.
 */
export async function startTaxQuestionnaire(
  tenantId: string,
  params: { taxYear?: number; jurisdiction?: string; region?: string | null; triggerText?: string },
  callGemini: CallGeminiFn,
): Promise<CoreResult> {
  const allFilings: any[] = await listPastFilingsForTenant(tenantId);
  const confirmedFilings = allFilings.filter((f: any) => f.status === 'confirmed');

  if (confirmedFilings.length === 0) {
    return {
      status: 'blocked',
      message: "I don't have a confirmed prior-year return to fast-track from yet. Upload last year's return on the **Tax Package** page → Past Filings tab, confirm it, and then just ask me again.",
    };
  }

  const filing = confirmedFilings.reduce((latest: any, f: any) => (f.taxYear > latest.taxYear ? f : latest));

  const taxYear = params.taxYear || 2025;
  const jurisdiction = (params.jurisdiction || 'us').toLowerCase();
  const region = params.region ?? null;

  if (!listSupportedJurisdictions().includes(jurisdiction)) {
    return {
      status: 'blocked',
      message: "Tax fast-track isn't available for your jurisdiction yet — I can still help with the regular tax filing flow, just ask.",
    };
  }

  const session = await createTaxQuestionnaireSession(tenantId, taxYear, jurisdiction, region, 'fast_track', filing.id);

  const pack = getTaxQuestionnairePack(jurisdiction);
  const profile = await buildPersonalProfileContext(tenantId).catch(() => '');
  const prompt = pack.nextQuestionPrompt({ qaHistory: [], priorFiling: filing.extractedData, profile });

  const raw = await callGemini(prompt, params.triggerText || 'Start the tax fast-track questionnaire.', 300);

  let outcome: { question: string } | { done: true } | null = null;
  if (raw) {
    try {
      outcome = pack.parseNextQuestionResponse(JSON.parse(cleanJson(raw)));
    } catch {
      outcome = null;
    }
  }

  if (!outcome) {
    await updateTaxQuestionnaireSession(session.id, session.version, { status: 'abandoned' }).catch(() => {});
    // No sessionId surfaced here — matches the original chat behavior
    // exactly (server.ts's turn-1-failure branch never included one).
    return { status: 'failed', message: 'Something went wrong setting up your tax questionnaire — could you try asking again?' };
  }

  if ('done' in outcome) {
    await updateTaxQuestionnaireSession(session.id, session.version, { status: 'completed' });
    return { status: 'done', sessionId: session.id };
  }

  const ok = await updateTaxQuestionnaireSession(session.id, session.version, {
    qaHistory: [{ question: outcome.question, answer: '' }],
    askedCount: 1,
  });
  if (!ok) {
    // Also no sessionId here — matches the original exactly.
    return { status: 'failed', message: 'Something went wrong setting up your tax questionnaire — could you try asking again?' };
  }

  return { status: 'question', question: outcome.question, sessionId: session.id };
}

/**
 * Turn 2+: recover the pending question from qaHistory's last entry,
 * finalize it with the user's answer, get the next question (or complete).
 * `tqSession` must already have been fetched by the caller via
 * `getActiveTaxQuestionnaireSession(tenantId)` — this function does not
 * re-fetch it, matching PR-3's original code exactly (Step 1b always
 * operated on an already-fetched session).
 */
export async function answerTaxQuestionnaire(
  tqSession: any,
  text: string,
  callGemini: CallGeminiFn,
): Promise<CoreResult> {
  const trimmedText = text.trim();

  const qaHistory = ((tqSession.qaHistory as QaPair[]) || []).slice();
  const lastEntry = qaHistory.length > 0 ? qaHistory[qaHistory.length - 1] : null;
  const pending = lastEntry && lastEntry.answer === '' ? lastEntry : null;

  if (!pending) {
    // Data-invariant violation — should never happen once
    // startTaxQuestionnaire always seeds a pending entry at creation.
    return handleFailureTurn(tqSession);
  }

  const answeredHistory: QaPair[] = [
    ...qaHistory.slice(0, -1),
    { question: pending.question, answer: trimmedText || text },
  ];

  let priorFiling: StandardTaxExtract | undefined;
  if (tqSession.sourceFilingId) {
    const filing = await db.abPastTaxFiling.findUnique({ where: { id: tqSession.sourceFilingId } }).catch(() => null);
    priorFiling = (filing?.extractedData as StandardTaxExtract | undefined) || undefined;
  }
  const profile = await buildPersonalProfileContext(tqSession.tenantId).catch(() => '');

  let pack: TaxQuestionnairePack;
  try {
    pack = getTaxQuestionnairePack(tqSession.jurisdiction);
  } catch {
    return handleFailureTurn(tqSession);
  }
  const prompt = pack.nextQuestionPrompt({ qaHistory: answeredHistory, priorFiling, profile });

  const raw = await callGemini(prompt, text, 300);

  let outcome: { question: string } | { done: true } | null = null;
  if (raw) {
    try {
      const parsed = JSON.parse(cleanJson(raw));
      outcome = pack.parseNextQuestionResponse(parsed);
    } catch {
      outcome = null;
    }
  }

  if (!outcome) {
    return handleFailureTurn(tqSession);
  }

  const isDone = 'done' in outcome || tqSession.askedCount >= 8;

  const finalQaHistory: QaPair[] = isDone
    ? answeredHistory
    : [...answeredHistory, { question: (outcome as { question: string }).question, answer: '' }];

  const ok = await updateTaxQuestionnaireSession(tqSession.id, tqSession.version, {
    qaHistory: finalQaHistory,
    consecutiveFailures: 0,
    expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
    status: isDone ? 'completed' : 'in_progress',
    ...(isDone ? {} : { askedCount: tqSession.askedCount + 1 }),
  });

  if (!ok) {
    // No sessionId — matches agent-brain.ts:1009-1017's version-conflict
    // return exactly (unlike the cancel/done/question paths below, which
    // all carry it).
    return { status: 'failed', message: 'Session was modified by another process. Please try again.' };
  }

  if (isDone) {
    return { status: 'done', sessionId: tqSession.id };
  }
  return { status: 'question', question: (outcome as { question: string }).question, sessionId: tqSession.id };
}

/** `tqSession` must already have been fetched by the caller, same as `answerTaxQuestionnaire`. */
export async function cancelTaxQuestionnaire(tqSession: any): Promise<CoreResult> {
  const ok = await updateTaxQuestionnaireSession(tqSession.id, tqSession.version, { status: 'abandoned' });
  if (!ok) {
    // No sessionId — matches agent-brain.ts:899-906's version-conflict
    // return exactly.
    return { status: 'failed', message: 'Session was modified by another process. Please try again.' };
  }
  return { status: 'cancelled', sessionId: tqSession.id };
}
