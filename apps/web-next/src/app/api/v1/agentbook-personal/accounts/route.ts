/**
 * Personal finance accounts — list + create.
 *
 * Strictly separate from the business books: these live in the
 * plugin_agentbook_personal schema and never touch the business ledger.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const LIABILITY_TYPES = new Set(['credit', 'mortgage', 'loan']);

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const accounts = await db.abPersonalAccount.findMany({
      where: { tenantId, archived: false },
      orderBy: { createdAt: 'asc' },
    });
    // Never return accessTokenEnc/cursorToken to the client — same
    // discipline as agentbook-expense/plaid/exchange/route.ts's `safe`
    // mapping for the equivalent expense-side field.
    const safe = accounts.map((a) => ({
      id: a.id, tenantId: a.tenantId, name: a.name, type: a.type,
      balanceCents: a.balanceCents, currency: a.currency, isAsset: a.isAsset,
      archived: a.archived, plaidAccountId: a.plaidAccountId, institution: a.institution,
      officialName: a.officialName, subtype: a.subtype, mask: a.mask,
      connected: a.connected, lastSynced: a.lastSynced,
      createdAt: a.createdAt, updatedAt: a.updatedAt,
    }));
    return NextResponse.json({ success: true, data: safe });
  } catch (err) {
    console.error('[agentbook-personal/accounts GET] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

interface CreateAccountBody {
  name?: string;
  type?: string;
  balanceCents?: number;
  currency?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const body = (await request.json().catch(() => ({}))) as CreateAccountBody;

    if (!body.name || !body.type) {
      return NextResponse.json({ success: false, error: 'name and type are required' }, { status: 400 });
    }
    const account = await db.abPersonalAccount.create({
      data: {
        tenantId,
        name: body.name,
        type: body.type,
        balanceCents: typeof body.balanceCents === 'number' ? body.balanceCents : 0,
        currency: body.currency || 'USD',
        isAsset: !LIABILITY_TYPES.has(body.type),
      },
    });
    return NextResponse.json({ success: true, data: account }, { status: 201 });
  } catch (err) {
    console.error('[agentbook-personal/accounts POST] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
