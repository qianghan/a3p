/**
 * Tenant config — GET (auto-create on first access) + PUT (upsert).
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { resolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const tenantId = await resolveAgentbookTenant(request);
    let config = await db.abTenantConfig.findUnique({ where: { userId: tenantId } });
    if (!config) {
      config = await db.abTenantConfig.create({ data: { userId: tenantId } });
    }
    return NextResponse.json({ success: true, data: config });
  } catch (err) {
    console.error('[agentbook-core/tenant-config GET] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

interface UpdateConfigBody {
  businessType?: string;
  jurisdiction?: string;
  region?: string;
  currency?: string;
  locale?: string;
  timezone?: string;
  fiscalYearStart?: number;
  autoApproveLimitCents?: number;
  autoRemindEnabled?: boolean;
  autoRemindDays?: number[];
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  try {
    const tenantId = await resolveAgentbookTenant(request);
    const body = (await request.json().catch(() => ({}))) as UpdateConfigBody;
    const update: Record<string, unknown> = {};
    if (body.businessType) update.businessType = body.businessType;
    if (body.jurisdiction) update.jurisdiction = body.jurisdiction;
    if (body.region !== undefined) update.region = body.region;
    if (body.currency) update.currency = body.currency;
    if (body.locale) update.locale = body.locale;
    if (body.timezone) update.timezone = body.timezone;
    if (body.fiscalYearStart) update.fiscalYearStart = body.fiscalYearStart;
    if (body.autoApproveLimitCents !== undefined) update.autoApproveLimitCents = body.autoApproveLimitCents;
    if (body.autoRemindEnabled !== undefined) update.autoRemindEnabled = body.autoRemindEnabled;
    if (body.autoRemindDays !== undefined) update.autoRemindDays = body.autoRemindDays;

    const config = await db.abTenantConfig.upsert({
      where: { userId: tenantId },
      update,
      create: {
        userId: tenantId,
        businessType: body.businessType || 'freelancer',
        jurisdiction: body.jurisdiction || 'us',
        region: body.region || '',
        currency: body.currency || 'USD',
        locale: body.locale || 'en-US',
        timezone: body.timezone || 'America/New_York',
      },
    });
    return NextResponse.json({ success: true, data: config });
  } catch (err) {
    console.error('[agentbook-core/tenant-config PUT] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
