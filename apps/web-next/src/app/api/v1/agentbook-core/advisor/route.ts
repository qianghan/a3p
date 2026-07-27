/**
 * GET  /api/v1/agentbook-core/advisor       → the tenant's advisor persona
 *                                             (name, avatar, age, bio) for the
 *                                             chat UI to render before the first
 *                                             message.
 * PATCH /api/v1/agentbook-core/advisor {name} → rename the advisor.
 *
 * Auth: requires a valid session via safeResolveAgentbookTenant (no x-tenant-id
 * header trust, no 'default' fallback) — same guard as /agent/message.
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { ensureAdvisorPersona, renameAdvisor, personaPublicView } from '@agentbook-core/advisor-persona';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const resolved = await safeResolveAgentbookTenant(request);
  if ('response' in resolved) return resolved.response;
  const { tenantId } = resolved;
  try {
    const persona = await ensureAdvisorPersona(tenantId);
    return NextResponse.json({ success: true, data: personaPublicView(persona, tenantId) });
  } catch {
    return NextResponse.json({ success: false, error: 'Could not load advisor.' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const resolved = await safeResolveAgentbookTenant(request);
  if ('response' in resolved) return resolved.response;
  const { tenantId } = resolved;

  let body: { name?: unknown };
  try {
    body = (await request.json()) as { name?: unknown };
  } catch {
    return NextResponse.json({ success: false, error: 'invalid JSON body' }, { status: 400 });
  }

  const updated = await renameAdvisor(tenantId, String(body?.name ?? ''));
  if (!updated) {
    return NextResponse.json(
      { success: false, error: 'Name must be a single word, 2–15 letters.' },
      { status: 400 },
    );
  }
  return NextResponse.json({ success: true, data: personaPublicView(updated, tenantId) });
}
