import 'server-only';
import { after, NextRequest, NextResponse } from 'next/server';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { getPastFiling, parsePastFiling } from '@agentbook-tax/tax-past-filings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const { id } = await params;

    const rec = await getPastFiling(tenantId, id);

    if (rec.blobUrl.startsWith('local://') || !process.env.BLOB_READ_WRITE_TOKEN) {
      return NextResponse.json(
        { success: false, error: 'Re-parse requires Blob storage' },
        { status: 400 },
      );
    }

    // Fetch the PDF from blob storage
    const { head } = await import('@vercel/blob');
    const info = await head(rec.blobUrl, { token: process.env.BLOB_READ_WRITE_TOKEN });
    const fileRes = await fetch(info.downloadUrl ?? info.url);
    const ab = await fileRes.arrayBuffer();
    const buf = Buffer.from(ab);

    after(async () => {
      try {
        await parsePastFiling(tenantId, id, buf);
      } catch (e) {
        console.error('[past-filings/parse] parse error', e);
      }
    });

    return NextResponse.json({ success: true, data: { id, status: 'parsing' } });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || String(err) },
      { status: err?.status || 500 },
    );
  }
}
