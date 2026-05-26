/**
 * AgentBook Agent Brain Orchestrator
 *
 * Central pipeline: session recovery → context assembly → classification →
 * complexity assessment → planning or direct execution → learning.
 *
 * Exports a single function: handleAgentMessage(req, ctx)
 */

import { db } from './db/client.js';
import { retrieveRelevantMemories, learnFromInteraction, handleCorrection } from './agent-memory.js';
import { assessComplexity, generatePlan, formatPlan, createSession, getActiveSession, updateSession, executeStep, buildUndoAction } from './agent-planner.js';
import { PlanStep, Evaluation, assessStepQuality, buildFinalEvaluation, formatEvaluation } from './agent-evaluator.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface AgentRequest {
  text: string;
  tenantId: string;
  channel: string;
  attachments?: { type: string; url: string }[];
  sessionAction?: string;
  feedback?: string;
}

interface AgentContext {
  skills: any[];
  callGemini: (sys: string, user: string, max?: number) => Promise<string | null>;
  baseUrls: Record<string, string>;
  classifyAndExecuteV1: (
    text: string,
    tenantId: string,
    channel: string,
    attachments?: any[],
    memory?: any[],
    skills?: any[],
    conversation?: any[],
    tenantConfig?: any,
    confirmed?: boolean,
  ) => Promise<any>;
  /**
   * PR 9 (G-010): pure classification — no side effects. Returns intent + params
   * without executing the skill. agent-brain uses this to gate destructive
   * actions (confirmBefore: true) behind a user confirmation step.
   *
   * Optional for backward compatibility: callers that don't provide it fall
   * back to the legacy classifyAndExecuteV1 path. New callers should always
   * provide it.
   */
  classifyOnly?: (
    text: string,
    tenantId: string,
    channel: string,
    attachments?: any[],
    memory?: any[],
    skills?: any[],
    conversation?: any[],
    tenantConfig?: any,
  ) => Promise<any>;
  /**
   * PR 9 (G-010): execute a previously-returned classification. Used by the
   * confirm-flow path — when the user replies "yes" to a destructive-action
   * preview, we re-invoke the skill via this function.
   */
  executeClassification?: (
    classification: any,
    text: string,
    tenantId: string,
    channel: string,
    attachments?: any[],
  ) => Promise<any>;
}

interface AgentResponse {
  success: true;
  data: {
    message: string;
    actions?: any[];
    chartData?: any;
    skillUsed: string;
    confidence: number;
    latencyMs?: number;
    plan?: { steps: PlanStep[]; requiresConfirmation: boolean };
    evaluation?: Evaluation;
    sessionId?: string;
    suggestions?: string[];
    undoAvailable?: boolean;
  };
}

// ─── Text matchers for session actions ──────────────────────────────────────

const CANCEL_RE = /^(cancel|stop|abort|nevermind|n)$/i;
const STATUS_RE = /^(status|where was i)$/i;
const SKIP_RE = /^(skip|next)$/i;
const UNDO_RE = /^(undo|revert)$/i;
const CONFIRM_RE = /^(yes|confirm|go|ok|proceed|do it|y)$/i;

// ─── Helpers ────────────────────────────────────────────────────────────────

function resolveSessionAction(
  explicit: string | undefined,
  text: string,
): string | null {
  if (explicit) return explicit;
  const trimmed = text.trim();
  if (CANCEL_RE.test(trimmed)) return 'cancel';
  if (STATUS_RE.test(trimmed)) return 'status';
  if (SKIP_RE.test(trimmed)) return 'skip';
  if (UNDO_RE.test(trimmed)) return 'undo';
  if (CONFIRM_RE.test(trimmed)) return 'confirm';
  return null;
}

function resolveBaseUrlForEndpoint(
  endpoint: string,
  baseUrls: Record<string, string>,
): string {
  for (const [prefix, url] of Object.entries(baseUrls)) {
    if (endpoint.startsWith(prefix)) return url;
  }
  // Fallback: partial match
  for (const [prefix, url] of Object.entries(baseUrls)) {
    if (endpoint.includes(prefix.replace(/^\/api\/v1\//, ''))) return url;
  }
  return '';
}

/**
 * Resolve pronoun-style referents in the user's text using recent
 * conversation context (G-014 / PR 12).
 *
 * Closes the "fix it" / "the last one" / "that invoice" handling gap
 * flagged by the 2026-05-12 chat-engagement review: conversation context
 * was loaded but only consumed in the Stage-3 LLM fallback. Stage-1
 * shortcut and Stage-2 regex paths classified raw "it" / "that" against
 * the skill manifest and rarely picked the right skill.
 *
 * This resolver runs BEFORE classification and rewrites the text so the
 * downstream classifier sees concrete IDs/numbers instead of pronouns.
 *
 * Strategy: scan the most recent agent turns for entity references
 * (invoice numbers, expense IDs, client names) and substitute pronouns
 * with the most recent matching entity.
 *
 * Conservative by design: only triggers when the input clearly contains
 * a pronoun pattern. Leaves text untouched otherwise.
 */
export function resolveReferents(
  text: string,
  conversation: Array<{ question?: string | null; answer?: string | null }>,
): string {
  if (!text || conversation.length === 0) return text;

  // Cheap gate — only run if there's at least one pronoun-like or definite
  // article pattern. Avoids the entity-extraction loop on every message.
  if (
    !/\b(it|that|this|those|them|the|fix\s+it|same)\b/i.test(text)
  ) {
    return text;
  }

  // Scan recent conversation turns for the most-recent entity references.
  // Most-recent-first so newer mentions win.
  const turns = conversation.slice(0, 5);

  let lastInvoiceNumber: string | null = null;
  let lastExpenseId: string | null = null;
  let lastClientName: string | null = null;
  let lastEntityKind: 'invoice' | 'expense' | 'client' | null = null;

  for (const turn of turns) {
    const combined = `${turn.question ?? ''}\n${turn.answer ?? ''}`;
    // Invoice number: INV-YYYY-NNNN
    if (!lastInvoiceNumber) {
      const m = combined.match(/\bINV-\d{4}-\d{4,}\b/i);
      if (m) {
        lastInvoiceNumber = m[0];
        if (!lastEntityKind) lastEntityKind = 'invoice';
      }
    }
    // Expense ID: cuid-style or uuid-style
    if (!lastExpenseId) {
      const m = combined.match(/\bexp(?:ense)?[-_]([a-z0-9]{6,})\b/i);
      if (m) {
        lastExpenseId = m[1];
        if (!lastEntityKind) lastEntityKind = 'expense';
      }
    }
    // Client name — heuristic: "client X" or "to X for"
    if (!lastClientName) {
      const m =
        combined.match(/\bclient\s+([A-Z][A-Za-z0-9\s&'.]{1,40}?)(?=[.,!?]|$|\s+(?:has|invoice|paid|owes))/i) ||
        combined.match(/\bto\s+([A-Z][A-Za-z0-9\s&'.]{1,40}?)(?=[.,!?]|\s+(?:for|invoice))/);
      if (m) {
        lastClientName = m[1].trim();
        if (!lastEntityKind) lastEntityKind = 'client';
      }
    }
  }

  let rewritten = text;

  // "the invoice" / "that invoice" → most recent invoice number
  if (lastInvoiceNumber && /\b(the|that|this)\s+invoice\b/i.test(rewritten)) {
    rewritten = rewritten.replace(/\b(the|that|this)\s+invoice\b/gi, `invoice ${lastInvoiceNumber}`);
  }
  // "the expense" / "that expense" → most recent expense ID (rewritten as exp-NNN)
  if (lastExpenseId && /\b(the|that|this)\s+expense\b/i.test(rewritten)) {
    rewritten = rewritten.replace(
      /\b(the|that|this)\s+expense\b/gi,
      `expense exp-${lastExpenseId}`,
    );
  }
  // "the client" → most recent client name
  if (lastClientName && /\b(the|that|this)\s+client\b/i.test(rewritten)) {
    rewritten = rewritten.replace(/\b(the|that|this)\s+client\b/gi, `client ${lastClientName}`);
  }

  // Generic "it" / "that" — resolve based on most recently mentioned entity kind.
  // We only do this when the message is short (≤ 6 words) — long sentences are
  // more likely to use "it" referentially in ways the classifier can already
  // handle, and we don't want to inject false context.
  const wordCount = rewritten.trim().split(/\s+/).length;
  if (wordCount <= 6 && lastEntityKind && /\b(it|that)\b/i.test(rewritten)) {
    let replacement: string | null = null;
    if (lastEntityKind === 'invoice' && lastInvoiceNumber) replacement = `invoice ${lastInvoiceNumber}`;
    else if (lastEntityKind === 'expense' && lastExpenseId) replacement = `expense exp-${lastExpenseId}`;
    else if (lastEntityKind === 'client' && lastClientName) replacement = `client ${lastClientName}`;
    if (replacement) {
      // Only replace standalone pronouns, not "it's" / "that's" / "its".
      rewritten = rewritten.replace(/\b(it|that)\b(?!'s|s\b)/gi, replacement);
    }
  }

  return rewritten;
}

function buildResponse(data: AgentResponse['data']): AgentResponse {
  return { success: true, data };
}

/**
 * Confidence threshold below which the agent forces a confirm-preview
 * step even on skills the manifest marks as non-destructive (PR 42 /
 * Tier 1 #3). Tuned so:
 *   - Regex-match path (confidence ≈ 0.85): never trips → fast loop preserved.
 *   - LLM happy-path  (confidence ≈ 0.7–0.9): never trips.
 *   - LLM unsure path (confidence ≈ 0.3–0.7): trips → user clarifies.
 *   - Ultimate fallback (confidence ≈ 0.3, skill=general-question): handled
 *     by the skip-list below, not by the threshold.
 */
const CONFIDENCE_ESCALATION_THRESHOLD = 0.55;

/**
 * Skills that should never be confidence-escalated. These are either
 * read-only (a wrong answer is recoverable) or already fallback / Q&A
 * paths where asking the user "are you sure?" would feel obtuse.
 */
const ESCALATION_EXEMPT_SKILLS = new Set([
  'general-question',
  'query-expenses',
  'query-finance',
  'expense-breakdown',
  'proactive-alerts',
  'vendor-insights',
  'show-skill-metrics',
]);

function shouldEscalateOnConfidence(classification: any): boolean {
  if (!classification) return false;
  const conf = typeof classification.confidence === 'number' ? classification.confidence : 1;
  if (conf >= CONFIDENCE_ESCALATION_THRESHOLD) return false;
  const name = classification.selectedSkill?.name;
  if (!name) return false;
  if (ESCALATION_EXEMPT_SKILLS.has(name)) return false;
  return true;
}

/**
 * Human-readable description of a destructive action, used in the plan preview.
 * Kept deliberately simple — the goal is to let the user understand what is
 * about to happen, not to render a full audit log.
 */
function describeDestructiveAction(classification: any, fallbackText: string): string {
  const name = classification?.selectedSkill?.name || 'unknown';
  const params = classification?.extractedParams || {};
  switch (name) {
    case 'send-invoice':
      return params.invoiceId
        ? `Send invoice ${params.invoiceId} to the client`
        : 'Send the most recent invoice to the client';
    case 'void-invoice':
      return params.invoiceId
        ? `Void invoice ${params.invoiceId} (reverses journal entries)`
        : 'Void the most recent invoice (reverses journal entries)';
    case 'tax-filing-submit':
      return `Submit ${params.taxYear || 2025} tax return to CRA (e-file)`;
    case 'create-credit-note':
      return `Issue a credit note${params.invoiceId ? ` against ${params.invoiceId}` : ''}`;
    case 'edit-expense':
      return `Edit expense ${params.expenseId || 'last'}`;
    case 'split-expense':
      return `Split expense ${params.expenseId || 'last'} ${params.businessPercent ? `(${params.businessPercent}% business)` : ''}`;
    case 'record-payment':
      return `Record payment${params.amountCents ? ` of $${(params.amountCents / 100).toFixed(2)}` : ''}${params.clientName ? ` from ${params.clientName}` : ''}`;
    default:
      return `Run ${name}: ${fallbackText.slice(0, 100)}`;
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

export async function handleAgentMessage(
  req: AgentRequest,
  ctx: AgentContext,
): Promise<AgentResponse> {
  const startTime = Date.now();
  const { text, tenantId, channel, attachments, feedback } = req;
  const expenseBaseUrl = ctx.baseUrls['/api/v1/agentbook-expense'] || 'http://localhost:4051';

  // ── Step 0: Handle feedback / corrections ──────────────────────────────
  if (feedback) {
    try {
      const lastConvo = await db.abConversation.findFirst({
        where: { tenantId, queryType: 'agent' },
        orderBy: { createdAt: 'desc' },
      });
      const lastResult = (lastConvo?.data as any) ?? null;
      const correction = await handleCorrection(tenantId, feedback, lastResult, expenseBaseUrl);
      if (correction.applied) {
        return buildResponse({
          message: correction.message,
          skillUsed: 'correction',
          confidence: 1,
          latencyMs: Date.now() - startTime,
        });
      }
      // Not applied — fall through, treat feedback text as a regular message
    } catch {
      // Fall through to normal processing
    }
  }

  // ── Step 1: Session recovery ───────────────────────────────────────────
  const activeSession = await getActiveSession(tenantId);

  if (activeSession) {
    const action = resolveSessionAction(req.sessionAction, text);

    if (action === 'cancel') {
      await updateSession(activeSession.id, activeSession.version, { status: 'expired' });
      return buildResponse({
        message: 'Plan cancelled.',
        skillUsed: 'session',
        confidence: 1,
        latencyMs: Date.now() - startTime,
      });
    }

    if (action === 'status') {
      const plan = (activeSession.plan as PlanStep[]) || [];
      const current = activeSession.currentStep ?? 0;
      const total = plan.length;
      const pending = activeSession.pendingConfirmation ? ' (awaiting confirmation)' : '';
      return buildResponse({
        message: `Session active: step ${current + 1} of ${total}${pending}. Trigger: "${activeSession.trigger}"`,
        skillUsed: 'session',
        confidence: 1,
        sessionId: activeSession.id,
        latencyMs: Date.now() - startTime,
      });
    }

    if (action === 'skip') {
      const plan = (activeSession.plan as PlanStep[]) || [];
      const current = activeSession.currentStep ?? 0;
      if (current < plan.length) {
        plan[current].status = 'skipped';
        await updateSession(activeSession.id, activeSession.version, {
          plan,
          currentStep: current + 1,
          pendingConfirmation: null,
        });
        return buildResponse({
          message: `Skipped step ${current + 1}: ${plan[current].description}`,
          skillUsed: 'session',
          confidence: 1,
          sessionId: activeSession.id,
          latencyMs: Date.now() - startTime,
        });
      }
      return buildResponse({
        message: 'No more steps to skip.',
        skillUsed: 'session',
        confidence: 1,
        latencyMs: Date.now() - startTime,
      });
    }

    if (action === 'undo') {
      const undoStack = (activeSession.undoStack as any[]) || [];
      if (undoStack.length === 0) {
        return buildResponse({
          message: 'Nothing to undo.',
          skillUsed: 'session',
          confidence: 1,
          latencyMs: Date.now() - startTime,
        });
      }
      // PR 24 (G-028): peek without popping. Only commit the pop + session
      // update if the reverse call succeeds. Previously the stack was popped
      // unconditionally and "Undone: X" was reported even when the reverse
      // fetch threw or returned 5xx — leaving the user with a misleading
      // success message and a lost undo entry.
      const lastUndo = undoStack[undoStack.length - 1];
      const baseUrl = resolveBaseUrlForEndpoint(lastUndo.reverseEndpoint, ctx.baseUrls);
      let reverseStatus: number | null = null;
      let reverseError: string | null = null;
      try {
        const r = await fetch(`${baseUrl}${lastUndo.reverseEndpoint}`, {
          method: lastUndo.reverseMethod || 'POST',
          headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenantId },
          body: JSON.stringify(lastUndo.reverseParams || {}),
        });
        reverseStatus = r.status;
        if (!r.ok) reverseError = `reverse call returned HTTP ${r.status}`;
      } catch (err) {
        reverseError = err instanceof Error ? err.message : String(err);
      }

      if (reverseError) {
        console.warn('[agent-brain] undo reverse-call failed:', {
          tenantId,
          description: lastUndo.description,
          reverseStatus,
          reverseError,
        });
        return buildResponse({
          message: `I couldn't undo "${lastUndo.description}" — the reverse step failed. Try again, or contact support if it keeps happening.`,
          skillUsed: 'session',
          confidence: 1,
          sessionId: activeSession.id,
          undoAvailable: true,
          latencyMs: Date.now() - startTime,
        });
      }

      // Reverse succeeded — commit the pop and update the session.
      undoStack.pop();
      await updateSession(activeSession.id, activeSession.version, { undoStack });
      return buildResponse({
        message: `Undone: ${lastUndo.description}`,
        skillUsed: 'session',
        confidence: 1,
        sessionId: activeSession.id,
        undoAvailable: undoStack.length > 0,
        latencyMs: Date.now() - startTime,
      });
    }

    if (action === 'confirm' && activeSession.pendingConfirmation) {
      // PR 9 (G-010): if the session carries a pendingClassification (a
      // destructive action gated on confirm), execute that classification now
      // via ctx.executeClassification — bypassing the plan-step loop entirely.
      const pc = activeSession.pendingConfirmation as any;
      if (pc?.pendingClassification && ctx.executeClassification) {
        const cleared = await updateSession(activeSession.id, activeSession.version, { pendingConfirmation: null });
        if (!cleared) {
          return buildResponse({
            message: 'Session was modified by another process. Please try again.',
            skillUsed: 'session',
            confidence: 1,
            latencyMs: Date.now() - startTime,
          });
        }
        const v1Result = await ctx.executeClassification(
          pc.pendingClassification,
          pc.text || '',
          tenantId,
          pc.channel || channel,
          pc.attachments || [],
        );
        await updateSession(activeSession.id, activeSession.version + 1, { status: 'completed' });

        const responseData = v1Result?.responseData || {
          message: v1Result?.skillResponse?.message || 'Done.',
          skillUsed: v1Result?.skillUsed,
          confidence: v1Result?.confidence,
        };

        // Best-effort logging
        db.abConversation.create({
          data: {
            tenantId,
            question: text,
            answer: responseData.message || '',
            queryType: 'agent',
            channel,
            skillUsed: responseData.skillUsed || v1Result?.skillUsed || 'unknown',
            data: v1Result?.skillResponse || {},
            latencyMs: Date.now() - startTime,
          },
        }).catch(() => {});

        return buildResponse({
          message: responseData.message,
          actions: responseData.actions,
          chartData: responseData.chartData,
          skillUsed: responseData.skillUsed || v1Result?.skillUsed || 'unknown',
          confidence: responseData.confidence ?? v1Result?.confidence ?? 1,
          sessionId: activeSession.id,
          latencyMs: Date.now() - startTime,
        });
      }

      // Existing path: execute remaining plan steps (from the complex planner).
      const plan = (activeSession.plan as PlanStep[]) || [];
      const startStep = activeSession.currentStep ?? 0;
      const stepResults = (activeSession.stepResults as any[]) || [];
      const undoStack = (activeSession.undoStack as any[]) || [];
      let baseVersion = activeSession.version;

      // Clear pending confirmation first
      const cleared = await updateSession(activeSession.id, baseVersion, { pendingConfirmation: null });
      if (!cleared) {
        return buildResponse({
          message: 'Session was modified by another process. Please try again.',
          skillUsed: 'session',
          confidence: 1,
          latencyMs: Date.now() - startTime,
        });
      }
      baseVersion++;

      for (let i = startStep; i < plan.length; i++) {
        const step = plan[i];
        step.status = 'running';
        await updateSession(activeSession.id, baseVersion + (i - startStep), {
          plan,
          currentStep: i,
        });

        const result = await executeStep(step, tenantId, ctx.skills, ctx.baseUrls);
        step.result = result;
        step.quality = assessStepQuality(step);
        step.status = result?.success ? 'done' : 'failed';

        const undo = step.canUndo ? buildUndoAction(step) : null;
        if (undo) undoStack.push(undo);

        stepResults.push({ stepId: step.id, result });
      }

      const finalVersion = baseVersion + (plan.length - startStep);
      const evaluation = buildFinalEvaluation(plan);
      await updateSession(activeSession.id, finalVersion, {
        plan,
        stepResults,
        undoStack,
        status: 'completed',
        evaluation,
        currentStep: plan.length,
      });

      const evalMessage = formatEvaluation(evaluation, plan);
      return buildResponse({
        message: evalMessage,
        skillUsed: 'session',
        confidence: 1,
        sessionId: activeSession.id,
        evaluation,
        suggestions: evaluation.suggestions,
        undoAvailable: evaluation.undoAvailable,
        latencyMs: Date.now() - startTime,
      });
    }

    // No session action matched — fall through to normal processing
  }

  // ── Step 2: Context assembly ───────────────────────────────────────────
  const [tenantConfig, conversation, memory, skills] = await Promise.all([
    db.abTenantConfig.findFirst({ where: { userId: tenantId } }),
    db.abConversation.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
    retrieveRelevantMemories(tenantId, text),
    db.abSkillManifest.findMany({
      where: { enabled: true, OR: [{ tenantId: null }, { tenantId }] },
    }),
  ]);

  // ── Step 2.5: Resolve referents using conversation context ───────────
  // PR 12 (G-014): rewrite pronouns ("fix it", "the last invoice") to
  // concrete entity refs BEFORE classification, so Stage-1 shortcuts and
  // Stage-2 regex paths see the same resolved text the Stage-3 LLM would.
  // No-op when the input has no pronoun-like tokens.
  const resolvedText = resolveReferents(text, conversation);

  // ── Step 3a: Classify ONLY (no side effects) ──────────────────────────
  // PR 9 (G-010): split classification from execution so destructive actions
  // can be gated on user confirmation BEFORE the skill HTTP call fires.
  let classification: any = null;
  if (ctx.classifyOnly) {
    classification = await ctx.classifyOnly(
      resolvedText, tenantId, channel, attachments, memory, skills, conversation, tenantConfig,
    );
  }

  // Fallback for legacy callers that only provide classifyAndExecuteV1.
  // We still need a classification to evaluate confirmBefore; if the legacy
  // function returned a result, treat it as already-executed.
  let v1Result: any = null;

  if (!classification) {
    // Legacy path: classifyAndExecuteV1 does the whole thing atomically.
    // This preserves backwards compatibility for callers that haven't migrated.
    // PR 12: also pass resolvedText here so the legacy path benefits from
    // pronoun resolution.
    v1Result = await ctx.classifyAndExecuteV1(
      resolvedText, tenantId, channel, attachments, memory, skills, conversation, tenantConfig,
    );
    if (!v1Result) {
      return buildResponse({
        message: 'I\'m not sure what you mean. Try "Spent $45 on lunch" or "How much on travel?"',
        skillUsed: 'none',
        confidence: 0,
        latencyMs: Date.now() - startTime,
      });
    }
  } else {
    // Step 3b: if destructive OR the agent is uncertain about this
    // non-fallback skill (PR 42 / Tier 1 #3), build a plan preview + create a
    // session that stores the pending classification. Do NOT execute the
    // skill.
    const escalateLowConfidence = shouldEscalateOnConfidence(classification);
    if (classification.confirmBefore || escalateLowConfidence) {
      const desc = describeDestructiveAction(classification, text);
      // When the gate fires because confidence is low (not because the skill
      // is intrinsically destructive), prepend a clarifying lead-in. The
      // user sees a clear "I'm not sure" framing rather than the standard
      // confirm prompt — accuracy signal AND a chance to correct.
      const lead = !classification.confirmBefore && escalateLowConfidence
        ? `I'm not entirely sure I understood — does this look right?\n`
        : '';
      const planSteps: PlanStep[] = [
        {
          id: 'step-1',
          action: classification.selectedSkill?.name || 'unknown',
          description: desc,
          params: classification.extractedParams || {},
          dependsOn: [],
          canUndo: false,
          status: 'pending',
        },
      ];

      // Expire any existing active sessions then create a new one carrying
      // the pendingClassification in the session.pendingConfirmation JSON blob.
      // No schema change required — pendingConfirmation is already JSONB.
      const session = await createSession(tenantId, text, planSteps);
      await updateSession(session.id, session.version, {
        pendingConfirmation: {
          awaitingApproval: true,
          pendingClassification: classification,
          channel,
          attachments: attachments || [],
          text,
        },
      });

      const planMessage = lead + formatPlan(planSteps);

      db.abConversation.create({
        data: {
          tenantId,
          question: text,
          answer: planMessage,
          queryType: 'agent',
          channel,
          skillUsed: classification.selectedSkill?.name || 'planner',
          data: {
            plan: planSteps as any,
            sessionId: session.id,
            pendingDestructive: !!classification.confirmBefore,
            // Surface the escalation reason so analytics / activity feed
            // can distinguish "destructive confirm" from "low-confidence
            // confirm" — they're different UX events.
            escalationReason: classification.confirmBefore
              ? 'destructive'
              : escalateLowConfidence
                ? 'low_confidence'
                : null,
          },
        },
      }).catch(() => {});

      return buildResponse({
        message: planMessage,
        skillUsed: classification.selectedSkill?.name || 'planner',
        confidence: classification.confidence ?? 0.8,
        plan: { steps: planSteps, requiresConfirmation: true },
        sessionId: session.id,
        latencyMs: Date.now() - startTime,
      });
    }

    // Step 3c: non-destructive — execute now.
    if (ctx.executeClassification) {
      v1Result = await ctx.executeClassification(classification, text, tenantId, channel, attachments);
    } else {
      // No executeClassification provided — fall back through classifyAndExecuteV1.
      // (The classification was non-destructive, so this is safe.)
      v1Result = await ctx.classifyAndExecuteV1(
        text, tenantId, channel, attachments, memory, skills, conversation, tenantConfig,
      );
    }
    if (!v1Result) {
      return buildResponse({
        message: 'I\'m not sure what you mean. Try "Spent $45 on lunch" or "How much on travel?"',
        skillUsed: 'none',
        confidence: 0,
        latencyMs: Date.now() - startTime,
      });
    }
  }

  // ── Step 4: Complexity assessment ──────────────────────────────────────
  const complexity = assessComplexity(text, v1Result.selectedSkill, v1Result.confidence);

  if (complexity === 'complex') {
    const recentConvo = conversation
      .slice(0, 5)
      .reverse()
      .map((c: any) => `User: ${c.question}\nAgent: ${c.answer}`)
      .join('\n');
    const memoryContext = memory
      .map((m: any) => `${m.key}: ${m.value}`)
      .join('\n');

    const planSteps = await generatePlan(
      text,
      skills as any,
      tenantConfig || {},
      recentConvo,
      memoryContext,
      ctx.callGemini,
    );

    if (planSteps.length > 0) {
      const session = await createSession(tenantId, text, planSteps);
      await updateSession(session.id, session.version, { pendingConfirmation: { awaitingApproval: true } });

      const planMessage = formatPlan(planSteps);

      // Log conversation
      db.abConversation.create({
        data: {
          tenantId,
          question: text,
          answer: planMessage,
          queryType: 'agent',
          channel,
          skillUsed: 'planner',
          data: { plan: planSteps as any, sessionId: session.id },
        },
      }).catch(() => {});

      return buildResponse({
        message: planMessage,
        skillUsed: 'planner',
        confidence: v1Result.confidence,
        plan: { steps: planSteps, requiresConfirmation: true },
        sessionId: session.id,
        latencyMs: Date.now() - startTime,
      });
    }
    // Empty plan — fall through to simple execution
  }

  // ── Step 5: Simple execution (v1 path) ─────────────────────────────────
  const responseData = v1Result.responseData || {
    message: v1Result.skillResponse?.message || 'Done.',
    actions: v1Result.skillResponse?.actions,
    chartData: v1Result.skillResponse?.chartData,
    skillUsed: v1Result.skillUsed,
    confidence: v1Result.confidence,
  };

  // ── Step 6: Learning (best-effort) ─────────────────────────────────────
  learnFromInteraction(
    tenantId,
    v1Result.skillUsed,
    v1Result.extractedParams,
    v1Result.skillResponse,
    feedback,
  ).catch(() => {});

  // Log conversation (best-effort)
  db.abConversation.create({
    data: {
      tenantId,
      question: text,
      answer: responseData.message || '',
      queryType: 'agent',
      channel,
      skillUsed: responseData.skillUsed || v1Result.skillUsed || 'unknown',
      data: v1Result.skillResponse || {},
      latencyMs: Date.now() - startTime,
    },
  }).catch(() => {});

  return buildResponse({
    message: responseData.message,
    actions: responseData.actions,
    chartData: responseData.chartData,
    skillUsed: responseData.skillUsed || v1Result.skillUsed,
    confidence: responseData.confidence ?? v1Result.confidence,
    latencyMs: Date.now() - startTime,
  });
}
