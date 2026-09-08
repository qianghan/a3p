/**
 * Download the filing worksheet — the artifact at the end of the core journey.
 *
 * Replaces `tax/export/mef-xml` and `tax/export/netfile-xml`, which emitted
 * files named for agency submission formats, under invented XML namespaces,
 * with every monetary value zero because the exporters read field IDs the form
 * templates do not define. Their instructions told the user to send the result
 * to the IRS or CRA. See filing-worksheet.ts for the full account.
 *
 * One route for every jurisdiction, because the worksheet is built from that
 * filing's own form templates rather than from per-jurisdiction code. AU is
 * covered by the same path for the first time.
 */
import { NextRequest, NextResponse } from 'next/server';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { publicErrorMessage } from '@/lib/api-error';
import { exportFiling } from '@agentbook-tax/tax-export';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;

    const year = parseInt(request.nextUrl.searchParams.get('year') || '', 10)
      || new Date().getFullYear() - 1;

    const result = await exportFiling(tenantId, year, 'csv');
    if (!result.success) {
      // Validation failures carry the reasons, which are the actionable part —
      // "you have not entered a SIN" is what the caller needs, not a 500.
      return NextResponse.json(
        { success: false, error: result.error, data: result.data },
        { status: 422 },
      );
    }

    const { csv, filename } = result.data as { csv: string; filename: string };
    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        // A tax worksheet is per-tenant and must never sit in a shared cache.
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (err: unknown) {
    return NextResponse.json({ success: false, error: publicErrorMessage(err) }, { status: 500 });
  }
}
