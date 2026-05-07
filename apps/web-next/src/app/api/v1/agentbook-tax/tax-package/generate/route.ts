/**
 * Year-end tax package — generate endpoint.
 *
 *   POST /api/v1/agentbook-tax/tax-package/generate
 *   body: { year: number, jurisdiction?: 'us' | 'ca' }
 *
 * Calls the orchestrator in `lib/agentbook-tax-package.ts`, which is
 * idempotent on `(tenantId, year, jurisdiction)`. A second call for
 * the same triple regenerates artifacts but reuses the row id, which
 * the e2e suite asserts.
 *
 * Tenant scoping happens up-front via `resolveAgentbookTenant`; every
 * downstream Prisma query in `gatherPackageData` filters by `tenantId`.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { resolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { generatePackage } from '@/lib/agentbook-tax-package';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface GenerateBody {
  year?: number;
  jurisdiction?: 'us' | 'ca';
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const tenantId = await resolveAgentbookTenant(request);
    const body = (await request.json().catch(() => ({}))) as GenerateBody;

    const year = typeof body.year === 'number' ? body.year : NaN;
    if (!isFinite(year) || year < 2000 || year > 2100) {
      return NextResponse.json(
        { success: false, error: 'year must be a 4-digit calendar year' },
        { status: 400 },
      );
    }

    // Resolve jurisdiction: explicit body wins, else read tenant config,
    // else default 'us'. This mirrors the mileage POST behaviour.
    let jurisdiction: 'us' | 'ca' = body.jurisdiction === 'ca' ? 'ca' : 'us';
    if (!body.jurisdiction) {
      const cfg = await db.abTenantConfig.findUnique({
        where: { userId: tenantId },
        select: { jurisdiction: true },
      });
      jurisdiction = cfg?.jurisdiction === 'ca' ? 'ca' : 'us';
    }

    const result = await generatePackage({ tenantId, year, jurisdiction });

    return NextResponse.json({
      success: true,
      data: {
        packageId: result.packageId,
        pdfUrl: result.pdfUrl,
        receiptsZipUrl: result.receiptsZipUrl ?? null,
        csvUrls: result.csvUrls,
        summary: result.summary,
      },
    });
  } catch (err) {
    console.error('[agentbook-tax/tax-package/generate POST] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
