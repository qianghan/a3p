import 'server-only';
import { after, NextRequest, NextResponse } from 'next/server';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import {
  listPastFilings,
  uploadPastFiling,
  parsePastFiling,
} from '@agentbook-tax/tax-past-filings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;

    const data = await listPastFilings(tenantId);
    const safe = data.map(({ blobUrl: _blobUrl, blobKey: _blobKey, ...rest }) => rest);
    return NextResponse.json({ success: true, data: safe });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || String(err) },
      { status: err?.status || 500 },
    );
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;

    const form = await request.formData();
    const file = form.get('file') as File | null;
    if (!file) {
      return NextResponse.json({ success: false, error: 'No file provided' }, { status: 400 });
    }
    if (file.type !== 'application/pdf') {
      return NextResponse.json(
        { success: false, error: 'Only PDF files are accepted' },
        { status: 400 },
      );
    }
    const buf = Buffer.from(await file.arrayBuffer());
    const taxYear = parseInt(String(form.get('taxYear')), 10);
    const jurisdiction = String(form.get('jurisdiction') || 'ca').toLowerCase();
    const region = form.get('region') ? String(form.get('region')) : undefined;
    const formType = form.get('formType') ? String(form.get('formType')) : undefined;
    if (!taxYear || taxYear < 2000 || taxYear > 2100) {
      return NextResponse.json(
        { success: false, error: 'Valid taxYear required' },
        { status: 400 },
      );
    }

    const result = await uploadPastFiling(tenantId, buf, taxYear, jurisdiction, region, formType);

    after(async () => {
      try {
        await parsePastFiling(tenantId, result.id, buf);
      } catch (e) {
        console.error('[past-filings] parse error', e);
      }
    });

    return NextResponse.json({ success: true, data: result });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || String(err) },
      { status: err?.status || 500 },
    );
  }
}
