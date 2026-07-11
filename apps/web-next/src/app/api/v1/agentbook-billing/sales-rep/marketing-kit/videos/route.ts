import { NextRequest, NextResponse } from 'next/server';
import { listPartnerMarketingVideos } from '@/lib/billing/partner-marketing-kit';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/agentbook-billing/sales-rep/marketing-kit/videos — admin-
 * curated marketing videos, gated to active ("qualified") reps only. A
 * removed/suspended rep loses access here even though they keep read
 * access to their own financial history elsewhere — this is a benefit of
 * active status, not a permanent record.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const resolved = await safeResolveAgentbookTenant(request);
  if ('response' in resolved) return resolved.response;

  try {
    const videos = await listPartnerMarketingVideos(resolved.tenantId);
    return NextResponse.json({ success: true, data: { videos } });
  } catch {
    return NextResponse.json({ success: false, error: 'Not an active sales rep.' }, { status: 403 });
  }
}
