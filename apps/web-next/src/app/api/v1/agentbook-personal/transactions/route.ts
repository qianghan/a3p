/**
 * Personal transactions — list + create.
 *
 * amountCents is signed: positive = money in (income), negative = money out
 * (spending). Creating a transaction also adjusts the linked account balance.
 * `businessFlag` marks a personal-account charge that is actually a business
 * expense (the separation bridge); business reporting can pick these up.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const params = request.nextUrl.searchParams;
    const accountId = params.get('accountId');
    const limit = Math.min(parseInt(params.get('limit') || '100', 10), 500);

    const txns = await db.abPersonalTransaction.findMany({
      where: { tenantId, ...(accountId ? { accountId } : {}) },
      orderBy: { date: 'desc' },
      take: limit,
    });
    return NextResponse.json({ success: true, data: txns });
  } catch (err) {
    console.error('[agentbook-personal/transactions GET] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

interface CreateTxnBody {
  accountId?: string;
  description?: string;
  amountCents?: number;
  date?: string;
  category?: string;
  businessFlag?: boolean;
  notes?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const body = (await request.json().catch(() => ({}))) as CreateTxnBody;

    if (!body.accountId || !body.description || typeof body.amountCents !== 'number') {
      return NextResponse.json(
        { success: false, error: 'accountId, description, and amountCents are required' },
        { status: 400 },
      );
    }
    const account = await db.abPersonalAccount.findFirst({ where: { id: body.accountId, tenantId } });
    if (!account) return NextResponse.json({ success: false, error: 'account not found' }, { status: 404 });

    const txn = await db.$transaction(async (tx) => {
      const created = await tx.abPersonalTransaction.create({
        data: {
          tenantId,
          accountId: body.accountId!,
          description: body.description!,
          amountCents: body.amountCents!,
          date: body.date ? new Date(body.date) : new Date(),
          category: body.category || 'uncategorized',
          businessFlag: !!body.businessFlag,
          notes: body.notes || null,
        },
      });
      // Keep the account balance in sync (assets: inflow raises balance).
      await tx.abPersonalAccount.update({
        where: { id: body.accountId! },
        data: { balanceCents: { increment: body.amountCents! } },
      });
      return created;
    });

    return NextResponse.json({ success: true, data: txn }, { status: 201 });
  } catch (err) {
    console.error('[agentbook-personal/transactions POST] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
