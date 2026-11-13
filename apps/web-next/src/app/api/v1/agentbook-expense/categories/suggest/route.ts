/**
 * GET /agentbook-expense/categories/suggest?vendor=&description=&amountCents=
 *
 * The category an entry form should prefill while the user is still typing, so
 * an expense is saved once, on its real category (see lib/agentbook-suggest-category).
 * `data: null` means "no confident suggestion" — never an error.
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { suggestCategory } from '@/lib/agentbook-suggest-category';
import { publicErrorMessage } from '@/lib/api-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const MAX_VENDOR = 200;
const MAX_DESCRIPTION = 500;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const q = request.nextUrl.searchParams;
    const amount = Number(q.get('amountCents'));
    const suggestion = await suggestCategory(tenantId, {
      vendor: (q.get('vendor') ?? '').slice(0, MAX_VENDOR),
      description: (q.get('description') ?? '').slice(0, MAX_DESCRIPTION),
      amountCents: Number.isSafeInteger(amount) && amount > 0 ? amount : undefined,
    });
    return NextResponse.json({ success: true, data: suggestion });
  } catch (err) {
    console.error('[agentbook-expense/categories/suggest] failed:', err);
    return NextResponse.json({ success: false, error: publicErrorMessage(err) }, { status: 500 });
  }
}
