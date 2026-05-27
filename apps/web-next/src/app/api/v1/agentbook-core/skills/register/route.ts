/**
 * POST /api/v1/agentbook-core/skills/register
 *
 * Upserts a skill manifest. Designed to be called by plugin installers
 * (server-to-server) so a third-party plugin can register its own
 * skills with the agent at install time. Closes the "third-party skill
 * SDK" gap on Tier 1 #2 (PR 60).
 *
 * Auth: gated by INTERNAL_ADMIN_SECRET via `x-internal-admin` header.
 * The same secret the LLM-configs plugin route uses. In dev when the
 * secret is unset the route is open (matches plugin-server pattern at
 * plugins/agentbook-core/backend/src/server.ts:1827).
 *
 * Request body shape (mirrors the SkillManifest type the agent brain
 * expects):
 *   {
 *     name: string,                      // unique per tenantId
 *     description: string,
 *     category: string,
 *     triggerPatterns: string[],         // regex source strings
 *     requirePatterns?: string[],
 *     excludePatterns?: string[],
 *     parameters: { [name]: { type, required?, extractHint? } },
 *     endpoint: { method, url, queryParams? },
 *     responseTemplate?: string,
 *     confirmBefore?: boolean,
 *     tenantId?: string | null           // null = global / built_in,
 *                                        // string = scoped to one tenant
 *   }
 *
 * On success returns the manifest row with id + source='plugin'.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface SkillRegistrationBody {
  name?: string;
  description?: string;
  category?: string;
  triggerPatterns?: string[];
  requirePatterns?: string[];
  excludePatterns?: string[];
  parameters?: Record<string, { type?: string; required?: boolean; extractHint?: string }>;
  endpoint?: { method?: string; url?: string; queryParams?: string[] };
  responseTemplate?: string | null;
  confirmBefore?: boolean;
  tenantId?: string | null;
}

function isInternalAdmin(request: NextRequest): boolean {
  const secret = process.env.INTERNAL_ADMIN_SECRET;
  // Dev convention: when the secret is unset, the route is open.
  if (!secret) return true;
  return request.headers.get('x-internal-admin') === secret;
}

function validate(body: SkillRegistrationBody): { ok: true; data: Required<Pick<SkillRegistrationBody, 'name' | 'description' | 'category' | 'triggerPatterns' | 'parameters' | 'endpoint'>> & SkillRegistrationBody } | { ok: false; error: string } {
  if (!body.name || typeof body.name !== 'string') return { ok: false, error: 'name (string) is required' };
  if (!/^[a-z0-9][a-z0-9-]*$/.test(body.name)) return { ok: false, error: 'name must be kebab-case lowercase alphanumeric' };
  if (!body.description || typeof body.description !== 'string') return { ok: false, error: 'description (string) is required' };
  if (!body.category || typeof body.category !== 'string') return { ok: false, error: 'category (string) is required' };
  if (!Array.isArray(body.triggerPatterns)) return { ok: false, error: 'triggerPatterns (string[]) is required' };
  if (!body.parameters || typeof body.parameters !== 'object') return { ok: false, error: 'parameters (object) is required' };
  if (!body.endpoint || typeof body.endpoint !== 'object') return { ok: false, error: 'endpoint (object) is required' };
  if (!body.endpoint.method || !body.endpoint.url) return { ok: false, error: 'endpoint.method + endpoint.url required' };

  // Validate every trigger pattern compiles as a regex.
  for (const t of body.triggerPatterns) {
    if (typeof t !== 'string') return { ok: false, error: 'triggerPatterns must be all strings' };
    try {
      new RegExp(t);
    } catch {
      return { ok: false, error: `triggerPattern is not a valid regex: ${t.slice(0, 60)}` };
    }
  }

  return { ok: true, data: body as never };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isInternalAdmin(request)) {
    return NextResponse.json({ success: false, error: 'unauthorized' }, { status: 401 });
  }

  let body: SkillRegistrationBody;
  try {
    body = (await request.json()) as SkillRegistrationBody;
  } catch {
    return NextResponse.json({ success: false, error: 'invalid JSON body' }, { status: 400 });
  }

  const v = validate(body);
  if (!v.ok) {
    return NextResponse.json({ success: false, error: v.error }, { status: 400 });
  }
  const data = v.data;

  // Per the schema, (tenantId, name) is the natural identity. null tenantId
  // means a global / built_in-equivalent skill. Plugin-registered skills
  // typically have source='plugin'.
  const tenantId = data.tenantId ?? null;
  const existing = await db.abSkillManifest.findFirst({
    where: { tenantId, name: data.name },
  });

  const upsertData = {
    description: data.description,
    category: data.category,
    triggerPatterns: data.triggerPatterns as unknown as object,
    requirePatterns: data.requirePatterns ?? [],
    excludePatterns: data.excludePatterns ?? [],
    parameters: data.parameters as unknown as object,
    endpoint: data.endpoint as unknown as object,
    responseTemplate: data.responseTemplate ?? null,
    confirmBefore: Boolean(data.confirmBefore),
    source: 'plugin' as const,
    enabled: true,
  };

  const manifest = existing
    ? await db.abSkillManifest.update({
        where: { id: existing.id },
        data: upsertData,
      })
    : await db.abSkillManifest.create({
        data: {
          ...upsertData,
          name: data.name,
          tenantId,
        },
      });

  return NextResponse.json({
    success: true,
    data: {
      id: manifest.id,
      name: manifest.name,
      tenantId: manifest.tenantId,
      created: !existing,
      updated: !!existing,
    },
  });
}

/**
 * DELETE /api/v1/agentbook-core/skills/register?name=...&tenantId=...
 *
 * Unregister (soft-disable) a plugin-registered skill. Hard-deleting
 * removes metric history; disabling preserves it. The admin gate is
 * the same as POST.
 */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  if (!isInternalAdmin(request)) {
    return NextResponse.json({ success: false, error: 'unauthorized' }, { status: 401 });
  }
  const name = request.nextUrl.searchParams.get('name');
  const tenantId = request.nextUrl.searchParams.get('tenantId');
  if (!name) {
    return NextResponse.json({ success: false, error: 'name is required' }, { status: 400 });
  }
  const where = { tenantId: tenantId || null, name };
  const existing = await db.abSkillManifest.findFirst({ where });
  if (!existing) {
    return NextResponse.json({ success: false, error: 'skill not found' }, { status: 404 });
  }
  // Refuse to disable a built_in skill via this path — built_in skills
  // are owned by the agent core, not by plugins.
  if (existing.source === 'built_in') {
    return NextResponse.json(
      { success: false, error: 'cannot disable built-in skill via plugin path' },
      { status: 403 },
    );
  }
  await db.abSkillManifest.update({
    where: { id: existing.id },
    data: { enabled: false },
  });
  return NextResponse.json({
    success: true,
    data: { id: existing.id, name: existing.name, disabled: true },
  });
}
