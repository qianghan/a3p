/**
 * Public skill registry endpoint (PR 57 / Tier 1 #2).
 *
 * Lists the skills the agent currently has available, with stable shape
 * so third-party tools (marketplaces, dashboards, eval suites, debugging
 * tools) can introspect the agent's capabilities without DB access.
 *
 * Response is *intentionally* a read-only view of AbSkillManifest, with
 * sensitive endpoint internals (URLs, post-actions) stripped — the
 * outside world should see WHAT the agent can do, not HOW it routes.
 *
 * Auth: tenant-scoped via safeResolveAgentbookTenant. A tenant sees
 * built-in skills + their own tenant-specific skills, not other tenants'.
 *
 * Query params:
 *   ?category=bookkeeping     filter by category
 *   ?source=built_in          filter by source (built_in | plugin | user)
 *   ?enabled=true             only enabled skills (default true)
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface PublicSkill {
  name: string;
  description: string;
  category: string;
  source: string;
  confirmBefore: boolean;
  /** Sample trigger phrases — public so third parties can build catalogs. */
  triggers: string[];
  /** Names + types of params the skill accepts. No endpoint internals. */
  parameters: Array<{ name: string; type: string; required: boolean }>;
  /** Stable identifier the chat layer uses ("this skill ran"). */
  manifestId: string;
}

function summarizeTriggers(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is string => typeof s === 'string').slice(0, 5);
}

function summarizeParameters(raw: unknown): PublicSkill['parameters'] {
  if (!raw || typeof raw !== 'object') return [];
  return Object.entries(raw as Record<string, unknown>).map(([name, spec]) => {
    const s = (spec ?? {}) as { type?: string; required?: boolean };
    return {
      name,
      type: s.type || 'string',
      required: Boolean(s.required),
    };
  });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const resolved = await safeResolveAgentbookTenant(request);
  if ('response' in resolved) return resolved.response;
  const { tenantId } = resolved;

  const url = request.nextUrl;
  const category = url.searchParams.get('category');
  const source = url.searchParams.get('source');
  const enabledParam = url.searchParams.get('enabled');
  const enabledOnly = enabledParam === null ? true : enabledParam === 'true';

  const where: Record<string, unknown> = {
    OR: [{ tenantId: null }, { tenantId }],
  };
  if (enabledOnly) where.enabled = true;
  if (category) where.category = category;
  if (source) where.source = source;

  const rows = await db.abSkillManifest.findMany({
    where,
    orderBy: [{ category: 'asc' }, { name: 'asc' }],
  });

  const skills: PublicSkill[] = rows.map((r) => ({
    name: r.name,
    description: r.description,
    category: r.category,
    source: r.source,
    confirmBefore: r.confirmBefore,
    triggers: summarizeTriggers(r.triggerPatterns),
    parameters: summarizeParameters(r.parameters),
    manifestId: r.id,
  }));

  // Categories histogram so a marketplace can render filter chips without
  // a second request.
  const categoryCounts: Record<string, number> = {};
  for (const s of skills) {
    categoryCounts[s.category] = (categoryCounts[s.category] ?? 0) + 1;
  }

  return NextResponse.json({
    success: true,
    data: {
      total: skills.length,
      skills,
      categories: Object.entries(categoryCounts)
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => b.count - a.count),
      // Stable schema marker — bump if the response shape changes so
      // downstream consumers can guard against drift.
      schemaVersion: '1.0',
    },
  });
}
