import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { getPastFiling } from '@agentbook-tax/tax-past-filings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse | Response> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const { id } = await params;

    const rec = await getPastFiling(tenantId, id);

    // Local dev or no blob token — return metadata only
    if (rec.blobUrl.startsWith('local://') || !process.env.BLOB_READ_WRITE_TOKEN) {
      return NextResponse.json({
        success: true,
        data: { blobKey: rec.blobKey, note: 'local dev — no real blob' },
      });
    }

    // Stream the private blob (no 302 redirect — private blobs need the token)
    const { head } = await import('@vercel/blob');
    const info = await head(rec.blobUrl, { token: process.env.BLOB_READ_WRITE_TOKEN });
    const fileRes = await fetch(info.downloadUrl ?? info.url);
    const ab = await fileRes.arrayBuffer();
    return new NextResponse(Buffer.from(ab), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${rec.formType}-${rec.taxYear}.pdf"`,
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || String(err) },
      { status: err?.status || 500 },
    );
  }
}
