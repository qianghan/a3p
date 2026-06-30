/**
 * Tax filing config — get + upsert.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const config = await db.abTaxConfig.findUnique({ where: { tenantId } });
    if (!config) {
      return NextResponse.json({
        success: true,
        data: {
          tenantId,
          filingStatus: 'single',
          region: '',
          retirementType: null,
          homeOfficeMethod: null,
        },
      });
    }
    return NextResponse.json({ success: true, data: config });
  } catch (err) {
    console.error('[agentbook-tax/tax/config GET] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

interface ConfigBody {
  filingStatus?: string;
  region?: string;
  retirementType?: string | null;
  homeOfficeMethod?: string | null;
  w2IncomeAnnual?: number | null;
  w2WithheldYtd?: number | null;
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const body = (await request.json().catch(() => ({}))) as ConfigBody;
    const { filingStatus, region, retirementType, homeOfficeMethod, w2IncomeAnnual, w2WithheldYtd } = body;

    const update: Record<string, unknown> = {};
    if (filingStatus !== undefined) update.filingStatus = filingStatus;
    if (region !== undefined) update.region = region;
    if (retirementType !== undefined) update.retirementType = retirementType;
    if (homeOfficeMethod !== undefined) update.homeOfficeMethod = homeOfficeMethod;
    if (w2IncomeAnnual !== undefined) update.w2IncomeAnnual = w2IncomeAnnual;
    if (w2WithheldYtd !== undefined) update.w2WithheldYtd = w2WithheldYtd;

    const config = await db.abTaxConfig.upsert({
      where: { tenantId },
      update,
      create: {
        tenantId,
        filingStatus: filingStatus || 'single',
        region: region || '',
        retirementType: retirementType || null,
        homeOfficeMethod: homeOfficeMethod || null,
        w2IncomeAnnual: w2IncomeAnnual ?? null,
        w2WithheldYtd: w2WithheldYtd ?? null,
      },
    });

    await db.abEvent.create({
      data: {
        tenantId,
        eventType: 'tax.config.updated',
        actor: 'agent',
        action: {
          filingStatus: config.filingStatus,
          region: config.region,
          retirementType: config.retirementType,
          homeOfficeMethod: config.homeOfficeMethod,
        },
      },
    });

    return NextResponse.json({ success: true, data: config });
  } catch (err) {
    console.error('[agentbook-tax/tax/config PUT] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
