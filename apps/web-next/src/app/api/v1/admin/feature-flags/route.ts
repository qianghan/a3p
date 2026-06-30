/**
 * Admin Feature Flags — list, create/update, toggle, delete global flags.
 * Admin-only. Lets launch features be dark-shipped and flipped without a deploy.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { requireAdmin } from '@/lib/admin-guard';
import { parseFlagUpsert, normalizeFlagKey } from '@/lib/admin-feature-flags';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const guard = await requireAdmin(request);
    if ('response' in guard) return guard.response as NextResponse;
    const flags = await db.featureFlag.findMany({
      orderBy: { key: 'asc' },
      select: { key: true, enabled: true, description: true, updatedAt: true },
    });
    return NextResponse.json({ success: true, data: { flags, total: flags.length } });
  } catch (err) {
    console.error('[admin/feature-flags GET] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const guard = await requireAdmin(request);
    if ('response' in guard) return guard.response as NextResponse;
    const upsert = parseFlagUpsert(await request.json().catch(() => null));
    if (!upsert) {
      return NextResponse.json({ success: false, error: 'Body must be { key (slug), enabled (boolean), description? }' }, { status: 400 });
    }
    const flag = await db.featureFlag.upsert({
      where: { key: upsert.key },
      update: { enabled: upsert.enabled, ...(upsert.description !== undefined ? { description: upsert.description } : {}) },
      create: { key: upsert.key, enabled: upsert.enabled, description: upsert.description ?? null },
      select: { key: true, enabled: true, description: true, updatedAt: true },
    });
    return NextResponse.json({ success: true, data: flag }, { status: 201 });
  } catch (err) {
    console.error('[admin/feature-flags POST] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  try {
    const guard = await requireAdmin(request);
    if ('response' in guard) return guard.response as NextResponse;
    const upsert = parseFlagUpsert(await request.json().catch(() => null));
    if (!upsert) {
      return NextResponse.json({ success: false, error: 'Body must be { key, enabled (boolean), description? }' }, { status: 400 });
    }
    const existing = await db.featureFlag.findUnique({ where: { key: upsert.key }, select: { key: true } });
    if (!existing) return NextResponse.json({ success: false, error: `Unknown flag: ${upsert.key}` }, { status: 404 });
    const flag = await db.featureFlag.update({
      where: { key: upsert.key },
      data: { enabled: upsert.enabled, ...(upsert.description !== undefined ? { description: upsert.description } : {}) },
      select: { key: true, enabled: true, description: true, updatedAt: true },
    });
    return NextResponse.json({ success: true, data: flag });
  } catch (err) {
    console.error('[admin/feature-flags PATCH] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  try {
    const guard = await requireAdmin(request);
    if ('response' in guard) return guard.response as NextResponse;
    const key = normalizeFlagKey(request.nextUrl.searchParams.get('key'));
    if (!key) return NextResponse.json({ success: false, error: 'a valid ?key= is required' }, { status: 400 });
    await db.featureFlag.deleteMany({ where: { key } });
    return NextResponse.json({ success: true, data: { key, deleted: true } });
  } catch (err) {
    console.error('[admin/feature-flags DELETE] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
