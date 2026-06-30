import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { prisma as db } from '@naap/database';
import { getPastFilingPack } from '@agentbook/jurisdictions/past-filing-loader';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;

    const searchParams = request.nextUrl.searchParams;
    const year = parseInt(searchParams.get('year') || '', 10) || new Date().getFullYear() - 1;

    const filing = await db.abTaxFiling.findFirst({
      where: { tenantId, taxYear: year, jurisdiction: 'ca' },
    });
    if (!filing) {
      return NextResponse.json(
        { success: false, error: 'No CA filing found for this year' },
        { status: 404 },
      );
    }

    const config = await db.abTaxConfig.findUnique({ where: { tenantId } }).catch(() => null);
    const region = config?.region || (filing as any).region || 'ON';

    const pack = getPastFilingPack('ca');
    if (!pack.generateEFileExport) {
      return NextResponse.json(
        { success: false, error: 'E-file export not implemented for this pack' },
        { status: 501 },
      );
    }

    const forms = ((filing as any).forms as Record<string, any>) || {};
    const result = pack.generateEFileExport(forms, year, region);

    return new NextResponse(result.content, {
      status: 200,
      headers: {
        'Content-Type': 'application/xml',
        'Content-Disposition': `attachment; filename="${result.filename}"`,
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || String(err) },
      { status: err?.status || 500 },
    );
  }
}
