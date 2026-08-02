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
    // Both enabled AND disabled rows, deliberately.
    //
    // `orderBy` — routing tries skills in array order and takes the first match
    // (see "Skills are tried in array order" in server.ts and the collision
    // comments in skill-routing.ts). Without it, which of two colliding skills
    // wins is whatever order Postgres returned. agent-brain asks for this order
    // on its own fetch, but that fetch only runs when the caller passes no
    // `skills` — and this route always passes them (Launch-gap PR-5).
    //
    // No `enabled: true` — the filter used to live in the query, which made the
    // admin disable toggle leak: a disabled row was absent from the result, so
    // `seenNames` below didn't know the skill existed and the built-in fallback
    // re-created it with `enabled: true`. Nothing downstream re-checks `enabled`,
    // so a skill an admin switched off kept routing on web chat (Telegram and
    // WhatsApp were unaffected — they have no fallback merge). The rows are
    // filtered in code instead, so `seenNames` can see the disabled ones.
    const allRows = await db.abSkillManifest.findMany({
      where: { OR: [{ tenantId: null }, { tenantId }] },
      orderBy: { name: 'asc' },
    });
    const dbSkills = allRows.filter((row) => row.enabled);
    // CODE IS AUTHORITATIVE for global built-in skills.
    //
    // This used to be "DB rows take precedence", which made every edit to
    // BUILT_IN_SKILLS a silent no-op in production until someone remembered to
    // POST /api/v1/admin/seed-skills. A routing fix shipped, CI went green, and
    // the agent kept routing the old way — code and data disagreeing with no
    // signal anywhere. That cost a real misroute: a tax question answered with
    // accounts payable, still live after the fix had merged.
    //
    // So the definition fields (patterns, parameters, endpoint, template) are now
    // read from code for rows that are global AND built-in. Two things are
    // deliberately NOT overridden:
    //   • `enabled` — the admin skill toggle lives in the DB and must keep
    //     winning, or disabling a skill in the UI would silently un-disable.
    //   • anything tenant-scoped (tenantId !== null) or source !== 'built_in' —
    //     those are genuine customisations and code has no business clobbering
    //     them.
    // Seeding still works and is still worth running; it just stops being load
    // bearing for correctness.
    const builtInByName = new Map(BUILT_IN_SKILLS.map((s) => [s.name, s as Record<string, unknown>]));
    const reconciled = dbSkills.map((row) => {
      if (row.tenantId !== null || row.source !== 'built_in') return row;
      const code = builtInByName.get(row.name);
      if (!code) return row;
      return {
        ...row,
        description: (code.description as string) ?? row.description,
        category: (code.category as string) ?? row.category,
        triggerPatterns: (code.triggerPatterns as string[]) ?? row.triggerPatterns,
        requirePatterns: (code.requirePatterns as string[]) ?? row.requirePatterns,
        excludePatterns: (code.excludePatterns as string[]) ?? row.excludePatterns,
        parameters: (code.parameters as object) ?? row.parameters,
        endpoint: (code.endpoint as string) ?? row.endpoint,
        responseTemplate: (code.responseTemplate as string) ?? row.responseTemplate,
        // enabled intentionally left as the DB has it — see above.
      };
    });

    // Built from ALL rows, not just the enabled ones: a name the admin disabled
    // has been seen, and must not be resurrected by the fallback below.
    const seenNames = new Set(allRows.map((s) => s.name));
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
    const skills = [...reconciled, ...fallbackSkills] as typeof dbSkills;
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
