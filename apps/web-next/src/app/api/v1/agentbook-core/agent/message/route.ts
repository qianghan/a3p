/**
 * Web-side entry point for the agent brain.
 *
 * The web chat UI (plugins/agentbook-core/frontend/src/pages/Chat.tsx) POSTs
 * here to invoke the agent. The handler mirrors the wiring in the Telegram
 * webhook — same `handleAgentMessage(req, ctx)` signature, but with
 * `channel: 'web'` and no Telegram-specific session bookkeeping.
 *
 * Closes G-012 finding F-2: the Chat.tsx component shipped without a
 * corresponding Next.js route, so the third auto-fail-clause fix (web
 * PlanPreview) was inert on the deployed target. This route makes it work.
 *
 * Auth: requires a valid session via safeResolveAgentbookTenant (no
 * x-tenant-id header trust, no 'default' fallback).
 */

import 'server-only';
import { after, NextRequest, NextResponse } from 'next/server';
import { handleAgentMessage } from '@agentbook-core/agent-brain';
import { buildGroundingFacts } from '@/lib/agentbook-grounding';
import {
  buildTaxReviewCtx,
  callGemini,
  classifyAndExecuteV1,
  classifyOnly,
  executeClassification,
} from '@agentbook-core/server';
import { reconcileSkills, SKILL_QUERY } from '@agentbook-core/skill-source';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { checkAndIncrement } from '@/lib/agentbook-rate-limit';
import { createTranslator, resolveLocale } from '@agentbook/i18n';
import { CATALOG, AVAILABLE_LOCALES } from '@agentbook/i18n/catalog';
import { getAppBaseUrl, getPluginBaseUrls } from '@/lib/agentbook-config';
import { generateFilingDraft } from '@/lib/tax-fast-track-draft';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90; // was 30 — after() work (tax fast-track draft generation) needs headroom past the response

interface AgentMessageBody {
  text?: string;
  attachments?: { type: string; url: string }[];
  sessionAction?: string;
  feedback?: string;
  // sessionId is captured client-side for debugging but the server resolves
  // the active session by tenantId — see handleAgentMessage Step 1.
  sessionId?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;

  let body: AgentMessageBody;
  try {
    body = (await request.json()) as AgentMessageBody;
  } catch {
    return NextResponse.json(
      { success: false, error: 'invalid JSON body' },
      { status: 400 },
    );
  }

  const text = String(body.text ?? '').trim();
  if (!text && !body.sessionAction) {
    return NextResponse.json(
      { success: false, error: 'text or sessionAction required' },
      { status: 400 },
    );
  }

  // PR 61: per-tenant rate limit on /agent/message. Session actions
  // (Proceed / Cancel button clicks) are user follow-throughs on an
  // already-counted message, not a new request — exempt them so the
  // user can confirm a plan even right at the ceiling.
  if (!body.sessionAction) {
    const limit = await checkAndIncrement(tenantId, 'web');
    if (!limit.allowed) {
      const retryAfterSec = limit.retryAfterMs
        ? Math.max(1, Math.ceil(limit.retryAfterMs / 1000))
        : 60;
      // i18n the rate-limit message from the client's Accept-Language
      // header. Falls back to English when the locale isn't supported.
      // Translator is built per request — never a module-level singleton,
      // since concurrent requests share this function instance.
      const locale = resolveLocale(
        { acceptLanguage: request.headers.get('accept-language') },
        AVAILABLE_LOCALES,
      );
      const { t } = createTranslator(locale, CATALOG);
      const message = t(
        limit.reason === 'day' ? 'rate.day_exceeded' : 'rate.minute_exceeded',
      );
      return NextResponse.json(
        {
          success: false,
          error: 'rate_limited',
          reason: limit.reason,
          retryAfterMs: limit.retryAfterMs,
          message,
          locale,
        },
        {
          status: 429,
          headers: { 'Retry-After': String(retryAfterSec) },
        },
      );
    }
  }

  try {
    // ctx.skills feeds plan execution only. The classifier routes against the
    // array agent-brain builds for itself, so this block used to be dead: it
    // reconciled code over DB and appended code-only built-ins for an array
    // that never reached routing. The reconcile now lives in skill-source.ts,
    // called from agent-brain where the classifier's array is built, and this
    // call site shares it so execution and routing cannot disagree.
    const skills = reconcileSkills(await db.abSkillManifest.findMany(SKILL_QUERY(tenantId)));
    const baseUrls = getPluginBaseUrls(getAppBaseUrl(request));

    const brainResult = await handleAgentMessage(
      {
        text,
        tenantId,
        channel: 'web',
        chatId: tenantId, // web: one thread per tenant
        attachments: body.attachments,
        sessionAction: body.sessionAction,
        feedback: body.feedback,
      },
      {
        skills,
        callGemini,
        baseUrls,
        classifyAndExecuteV1,
        classifyOnly,
        executeClassification,
        // Mid-review interception for the Tax Review Agent. Shared factory
        // (defined in agentbook-core's server.ts) rather than an inline copy,
        // because this ctx is built in four places — here, Telegram, WhatsApp
        // and the dev Express route — and the feature was originally wired
        // only in the last of those, i.e. dead on every real channel.
        ...buildTaxReviewCtx(baseUrls),
        // Ledger facts for consultative turns. Supplied here because it reads
        // the database, and agentbook-core must not depend on apps/web-next.
        // Called only when the turn is triaged as consultation, so it costs
        // nothing on the transactional path.
        buildGroundingFacts,
      },
    );

    if (brainResult?.data?.taxDraftReady && brainResult.data?.sessionId) {
      const completedSessionId = brainResult.data.sessionId;
      after(() => generateFilingDraft(completedSessionId, callGemini).catch((err) => {
        console.error('[agent/message] generateFilingDraft failed:', err);
      }));
    }

    return NextResponse.json(brainResult, { status: 200 });
  } catch (err) {
    console.error('[agentbook-core/agent/message] handler failed:', err);
    return NextResponse.json(
      {
        success: false,
        error: 'agent brain failed',
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
