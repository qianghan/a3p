/**
 * Admin Skills registry — list global agent skills and enable/disable them
 * (install / uninstall). Operates on platform-wide AbSkillManifest rows
 * (tenantId = null), the same rows seeded from BUILT_IN_SKILLS.
 *
 * Auth: an admin session (requireAdmin) OR the CRON_SECRET via `?secret=` /
 * `x-admin-secret` header — mirroring the seed-skills route so ops/automation
 * can drive it without a browser session.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { requireAdmin } from '@/lib/admin-guard';
import { parseToggle, toSkillDTO } from '@/lib/admin-skills';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function hasSecret(request: NextRequest): boolean {
  const secret = request.nextUrl.searchParams.get('secret') || request.headers.get('x-admin-secret');
  return !!process.env.CRON_SECRET && secret === process.env.CRON_SECRET;
}

/** Allow when the request carries the admin secret, else fall back to an admin session. */
async function authorize(request: NextRequest): Promise<NextResponse | null> {
  if (hasSecret(request)) return null;
  const guard = await requireAdmin(request);
  if ('response' in guard) return guard.response as NextResponse;
  return null;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const denied = await authorize(request);
    if (denied) return denied;

    const rows = await db.abSkillManifest.findMany({
      where: { tenantId: null },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
      select: { name: true, description: true, category: true, source: true, enabled: true },
    });
    const skills = rows.map(toSkillDTO);
    return NextResponse.json({
      success: true,
      data: { skills, total: skills.length, enabled: skills.filter((s) => s.enabled).length },
    });
  } catch (err) {
    console.error('[admin/skills GET] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  try {
    const denied = await authorize(request);
    if (denied) return denied;

    const toggle = parseToggle(await request.json().catch(() => null));
    if (!toggle) {
      return NextResponse.json(
        { success: false, error: 'Body must be { name: string, enabled: boolean }' },
        { status: 400 },
      );
    }

    const existing = await db.abSkillManifest.findFirst({
      where: { tenantId: null, name: toggle.name },
      select: { id: true },
    });
    if (!existing) {
      return NextResponse.json({ success: false, error: `Unknown skill: ${toggle.name}` }, { status: 404 });
    }

    const updated = await db.abSkillManifest.update({
      where: { id: existing.id },
      data: { enabled: toggle.enabled },
      select: { name: true, description: true, category: true, source: true, enabled: true },
    });
    return NextResponse.json({ success: true, data: toSkillDTO(updated) });
  } catch (err) {
    console.error('[admin/skills PATCH] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
