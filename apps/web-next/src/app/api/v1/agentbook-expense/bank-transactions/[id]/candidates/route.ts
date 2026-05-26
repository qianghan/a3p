/**
 * GET /api/v1/agentbook-expense/bank-transactions/:id/candidates?limit=3
 *
 * Returns the top-N ranked match candidates for an unmatched bank
 * transaction so the UI / Telegram picker can offer alternatives.
 *
 * Builds on PR 49's `matchTransactionWithCandidates`. Tenant-scoped:
 * the transaction must belong to the resolved tenant or we return 404.
 *
 * Response shape:
 *   {
 *     success: true,
 *     data: {
 *       transactionId, direction, amountCents, merchantName,
 *       candidates: [
 *         {
 *           kind: 'invoice' | 'expense',
 *           targetId, label, amountCents, date, score
 *         }, ...
 *       ]
 *     }
 *   }
 *
 * `label` is human-readable (invoice number / client name / vendor name /
 * description) so the picker can render the chip without a follow-up query.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { matchTransactionWithCandidates } from '@/lib/agentbook-payment-matcher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 10;

interface CandidateOut {
  kind: 'invoice' | 'expense';
  targetId: string;
  label: string;
  amountCents: number;
  date: string;
  score: number;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const { id } = await params;

    const limitRaw = Number(request.nextUrl.searchParams.get('limit') ?? DEFAULT_LIMIT);
    const limit = Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(limitRaw) ? limitRaw : DEFAULT_LIMIT));

    const txn = await db.abBankTransaction.findFirst({
      where: { id, tenantId },
    });
    if (!txn) {
      return NextResponse.json({ success: false, error: 'Transaction not found' }, { status: 404 });
    }

    const candidates = await matchTransactionWithCandidates(tenantId, {
      id: txn.id,
      amountCents: txn.amount,
      date: txn.date,
      name: txn.name,
      merchantName: txn.merchantName,
    }, limit);

    // Hydrate each candidate into a human-readable shape. Done with
    // bounded N+1 — we only ever return ≤10 candidates so the per-row
    // queries don't matter.
    const hydrated: CandidateOut[] = [];
    for (const c of candidates) {
      if (!c.targetId) continue;
      if (c.kind === 'invoice') {
        const inv = await db.abInvoice.findFirst({
          where: { id: c.targetId, tenantId },
          select: {
            id: true,
            number: true,
            amountCents: true,
            issuedDate: true,
            client: { select: { name: true } },
          },
        });
        if (inv) {
          hydrated.push({
            kind: 'invoice',
            targetId: inv.id,
            label: `${inv.number}${inv.client?.name ? ` — ${inv.client.name}` : ''}`,
            amountCents: inv.amountCents,
            date: inv.issuedDate.toISOString(),
            score: c.score,
          });
        }
      } else if (c.kind === 'expense') {
        const exp = await db.abExpense.findFirst({
          where: { id: c.targetId, tenantId },
          select: {
            id: true,
            amountCents: true,
            date: true,
            description: true,
            vendor: { select: { name: true } },
          },
        });
        if (exp) {
          const label = exp.vendor?.name || exp.description || 'expense';
          hydrated.push({
            kind: 'expense',
            targetId: exp.id,
            label,
            amountCents: exp.amountCents,
            date: exp.date.toISOString(),
            score: c.score,
          });
        }
      }
    }

    const direction: 'inflow' | 'outflow' = txn.amount < 0 ? 'inflow' : 'outflow';
    return NextResponse.json({
      success: true,
      data: {
        transactionId: txn.id,
        direction,
        amountCents: Math.abs(txn.amount),
        merchantName: txn.merchantName || txn.name,
        candidates: hydrated,
      },
    });
  } catch (err) {
    console.error('[bank-transactions/candidates] failed:', err);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch match candidates' },
      { status: 500 },
    );
  }
}
