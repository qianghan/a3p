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
import { NextRequest, NextResponse } from 'next/server';
import { handleAgentMessage } from '@agentbook-core/agent-brain';
import {
  callGemini,
  classifyAndExecuteV1,
  classifyOnly,
  executeClassification,
} from '@agentbook-core/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface AgentMessageBody {
  text?: string;
  attachments?: { type: string; url: string }[];
  sessionAction?: string;
  feedback?: string;
  // sessionId is captured client-side for debugging but the server resolves
  // the active session by tenantId — see handleAgentMessage Step 1.
  sessionId?: string;
}

function getBaseUrls(): Record<string, string> {
  const host = process.env.AGENTBOOK_HOST || 'https://a3book.brainliber.com';
  return {
    '/api/v1/agentbook-core': process.env.AGENTBOOK_CORE_URL || host,
    '/api/v1/agentbook-expense': process.env.AGENTBOOK_EXPENSE_URL || host,
    '/api/v1/agentbook-invoice': process.env.AGENTBOOK_INVOICE_URL || host,
    '/api/v1/agentbook-tax': process.env.AGENTBOOK_TAX_URL || host,
  };
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

  try {
    const skills = await db.abSkillManifest.findMany({
      where: { enabled: true, OR: [{ tenantId: null }, { tenantId }] },
    });
    const baseUrls = getBaseUrls();

    const brainResult = await handleAgentMessage(
      {
        text,
        tenantId,
        channel: 'web',
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
