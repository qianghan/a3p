/**
 * Admin payroll-provider config — choose the provider per jurisdiction and
 * store its (encrypted) API key. Admin-only. GET returns all jurisdictions
 * merged with the registry; PATCH upserts one jurisdiction's config.
 *
 * Today only the calculator is live; selecting another provider is recorded
 * for when its adapter ships (pay runs fall back to the calculator meanwhile).
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { requireAdmin } from '@/lib/admin-guard';
import { encryptToken } from '@/lib/agentbook-bank-token';
import { PAYROLL_PROVIDERS, JURISDICTIONS, parseProviderUpdate } from '@/lib/payroll/providers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const guard = await requireAdmin(request);
    if ('response' in guard) return guard.response as NextResponse;

    const rows = await db.abPayrollProviderConfig.findMany();
    const byJ = new Map(rows.map((r) => [r.jurisdiction, r]));
    const config = JURISDICTIONS.map((j) => {
      const row = byJ.get(j);
      return {
        jurisdiction: j,
        provider: row?.provider ?? 'calculator',
        enabled: row?.enabled ?? true,
        hasApiKey: !!row?.apiKeyEnc,
      };
    });
    return NextResponse.json({ success: true, data: { config, providers: PAYROLL_PROVIDERS } });
  } catch (err) {
    console.error('[admin/payroll-providers GET] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  try {
    const guard = await requireAdmin(request);
    if ('response' in guard) return guard.response as NextResponse;

    const update = parseProviderUpdate(await request.json().catch(() => null));
    if (!update) {
      return NextResponse.json(
        { success: false, error: 'Body must be { jurisdiction: us|ca|uk|au, provider: calculator|finch|check|deel, apiKey? }' },
        { status: 400 },
      );
    }

    const data: { provider: string; enabled: boolean; apiKeyEnc?: string } = {
      provider: update.provider,
      enabled: true,
    };
    if (update.apiKey) data.apiKeyEnc = encryptToken(update.apiKey);

    const saved = await db.abPayrollProviderConfig.upsert({
      where: { jurisdiction: update.jurisdiction },
      update: data,
      create: { jurisdiction: update.jurisdiction, ...data },
    });
    return NextResponse.json({
      success: true,
      data: { jurisdiction: saved.jurisdiction, provider: saved.provider, enabled: saved.enabled, hasApiKey: !!saved.apiKeyEnc },
    });
  } catch (err) {
    console.error('[admin/payroll-providers PATCH] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
