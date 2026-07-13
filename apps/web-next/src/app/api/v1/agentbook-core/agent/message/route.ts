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
import {
  callGemini,
  classifyAndExecuteV1,
  classifyOnly,
  executeClassification,
} from '@agentbook-core/server';
import { BUILT_IN_SKILLS } from '@agentbook-core/built-in-skills';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { checkAndIncrement } from '@/lib/agentbook-rate-limit';
import { t, parseLocaleHeader } from '@/lib/agentbook-i18n';
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
      // PR 62: i18n the rate-limit message based on the client's
      // Accept-Language header. Falls back to English when the locale
      // isn't supported.
      const locale = parseLocaleHeader(request.headers.get('accept-language'));
      const message = t(
        limit.reason === 'day' ? 'rate.day_exceeded' : 'rate.minute_exceeded',
        locale,
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
    const dbSkills = await db.abSkillManifest.findMany({
      where: { enabled: true, OR: [{ tenantId: null }, { tenantId }] },
    });
    // Merge in any BUILT_IN_SKILLS not yet seeded into AbSkillManifest, so a
    // deploy that adds new built-in skills works immediately without a manual
    // re-seed. DB rows take precedence (they may be customized per tenant).
    const seenNames = new Set(dbSkills.map((s) => s.name));
    const fallbackSkills = BUILT_IN_SKILLS
      .filter((s) => !seenNames.has(s.name))
      .map((s) => ({
        id: `builtin-${s.name}`,
        tenantId: null,
        name: s.name,
        description: s.description,
        category: s.category,
        triggerPatterns: (s as { triggerPatterns?: string[] }).triggerPatterns ?? [],
        requirePatterns: (s as { requirePatterns?: string[] }).requirePatterns ?? [],
        excludePatterns: (s as { excludePatterns?: string[] }).excludePatterns ?? [],
        parameters: (s as { parameters?: unknown }).parameters ?? {},
        endpoint: (s as { endpoint?: unknown }).endpoint ?? null,
        responseTemplate: (s as { responseTemplate?: string }).responseTemplate ?? null,
        confirmBefore: false,
        enabled: true,
        source: 'built_in',
        createdAt: new Date(),
        updatedAt: new Date(),
      }));
    const skills = [...dbSkills, ...fallbackSkills] as typeof dbSkills;
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
