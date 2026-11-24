/**
 * Bank transaction → manual match (PR 9 — daily reconciliation diff).
 *
 * POST { targetType: 'invoice' | 'expense', targetId } marks the transaction
 * as matched. For invoice matches we mirror the auto-match path in
 * `runMatcherOnTransaction`: post the cash-debit / AR-credit journal entry,
 * create the AbPayment row, and flip the invoice to 'paid'. For expense
 * matches we just link `matchedExpenseId` (no JE — expense JEs are posted
 * at booking time, not at reconciliation time).
 *
 * The actual transactional work lives in `agentbook-bank-match.ts` so the
 * HTTP path and the two Telegram callback paths (`bnk_match`, `bnk_m2`)
 * cannot drift.
 *
 * Tenant-scoped: the transaction must belong to the resolved tenant or we
 * return 404. Errors are sanitized so we don't leak Prisma internals.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import {
  applyInvoiceMatch,
  applyExpenseMatch,
  applyBillMatch,
  BankMatchError,
} from '@/lib/agentbook-bank-match';
import { audit } from '@/lib/agentbook-audit';
import { inferSource, inferActor } from '@/lib/agentbook-audit-context';
import { publicErrorMessage } from '@/lib/api-error';
import { PurchaseError } from '@/lib/purchases';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface MatchBody {
  targetType?: 'invoice' | 'expense' | 'bill';
  targetId?: string;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as MatchBody;
    const { targetType, targetId } = body;

    if (!targetType || (targetType !== 'invoice' && targetType !== 'expense' && targetType !== 'bill')) {
      return NextResponse.json(
        { success: false, error: 'targetType must be "invoice", "expense" or "bill"' },
        { status: 400 },
      );
    }
    if (!targetId) {
      return NextResponse.json(
        { success: false, error: 'targetId is required' },
        { status: 400 },
      );
    }

    if (targetType === 'invoice') {
      const result = await applyInvoiceMatch({
        tenantId,
        txnId: id,
        invoiceId: targetId,
        source: 'reconciliation',
      });
      await audit({
        tenantId,
        source: inferSource(request),
        actor: await inferActor(request),
        action: 'bank.match_invoice',
        entityType: 'AbBankTransaction',
        entityId: id,
        after: {
          matchedInvoiceId: targetId,
          invoiceNumber: result.invoiceNumber,
          paymentAmountCents: result.paymentAmountCents,
          invoicePaid: result.invoicePaid,
        },
      });
      return NextResponse.json({
        success: true,
        data: {
          transactionId: id,
          matchedInvoiceId: targetId,
          invoiceNumber: result.invoiceNumber,
          amountCents: result.paymentAmountCents,
          fullyPaid: result.invoicePaid,
        },
      });
    }

    // PR 3d.4 — one tap "this is for bill X": records a bill payment
    // (lib/purchases) and sets matchedBillId; no expense row is created.
    if (targetType === 'bill') {
      const result = await applyBillMatch({ tenantId, txnId: id, billId: targetId, source: 'reconciliation' });
      await audit({
        tenantId,
        source: inferSource(request),
        actor: await inferActor(request),
        action: 'bank.match_bill',
        entityType: 'AbBankTransaction',
        entityId: id,
        after: { matchedBillId: result.billId, paymentId: result.paymentId, paymentAmountCents: result.paymentAmountCents },
      });
      return NextResponse.json({
        success: true,
        data: {
          transactionId: id,
          matchedBillId: result.billId,
          paymentId: result.paymentId,
          amountCents: result.paymentAmountCents,
          remainingCents: result.remainingCents,
          fullyPaid: result.billPaid,
        },
      });
    }

    // targetType === 'expense'
    const result = await applyExpenseMatch({
      tenantId,
      txnId: id,
      expenseId: targetId,
      source: 'reconciliation',
    });
    await audit({
      tenantId,
      source: inferSource(request),
      actor: await inferActor(request),
      action: 'bank.match_expense',
      entityType: 'AbBankTransaction',
      entityId: id,
      after: {
        matchedExpenseId: result.expenseId,
      },
    });
    return NextResponse.json({
      success: true,
      data: {
        transactionId: id,
        matchedExpenseId: result.expenseId,
      },
    });
  } catch (err) {
    if (err instanceof BankMatchError) {
      // Map domain errors to HTTP status codes. The user-facing message is
      // safe to echo (it's authored above, not a DB internal).
      const status =
        err.code === 'txn_not_found' ||
        err.code === 'invoice_not_found' ||
        err.code === 'expense_not_found' ||
        err.code === 'bill_not_found'
          ? 404
          : err.code === 'txn_already_matched'
          ? 409
          : 422;
      return NextResponse.json(
        { success: false, error: publicErrorMessage(err) },
        { status },
      );
    }
    if (err instanceof PurchaseError) {
      return NextResponse.json({ success: false, code: err.code, error: publicErrorMessage(err) }, { status: err.status });
    }
    console.error('[bank-transactions/match] failed:', err);
    // Sanitized: don't echo Prisma internals or stack traces back to the
    // client. The detailed log goes server-side only.
    return NextResponse.json(
      { success: false, error: 'Failed to match transaction' },
      { status: 500 },
    );
  }
}
