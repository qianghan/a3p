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
 * Tenant-scoped: the transaction must belong to the resolved tenant or we
 * return 404. Errors are sanitized so we don't leak Prisma internals.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { resolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface MatchBody {
  targetType?: 'invoice' | 'expense';
  targetId?: string;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const tenantId = await resolveAgentbookTenant(request);
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as MatchBody;
    const { targetType, targetId } = body;

    if (!targetType || (targetType !== 'invoice' && targetType !== 'expense')) {
      return NextResponse.json(
        { success: false, error: 'targetType must be "invoice" or "expense"' },
        { status: 400 },
      );
    }
    if (!targetId) {
      return NextResponse.json(
        { success: false, error: 'targetId is required' },
        { status: 400 },
      );
    }

    // Tenant scope: refuse to act on someone else's row.
    const txn = await db.abBankTransaction.findFirst({
      where: { id, tenantId },
    });
    if (!txn) {
      return NextResponse.json(
        { success: false, error: 'Transaction not found' },
        { status: 404 },
      );
    }

    if (targetType === 'invoice') {
      const invoice = await db.abInvoice.findFirst({
        where: { id: targetId, tenantId },
        include: { payments: true, client: true },
      });
      if (!invoice) {
        return NextResponse.json(
          { success: false, error: 'Invoice not found' },
          { status: 404 },
        );
      }

      const amountCents = Math.abs(txn.amount);
      const existingPaid = invoice.payments.reduce((s, p) => s + p.amountCents, 0);
      const remainingBalance = invoice.amountCents - existingPaid;
      const paymentAmount = Math.min(amountCents, remainingBalance);

      // Look up the standard cash + AR accounts. If they're not seeded we
      // can't post a balanced JE — fail loudly rather than silently corrupting
      // the books. Same precondition the /agentbook-invoice/payments route
      // enforces.
      const [arAccount, cashAccount] = await Promise.all([
        db.abAccount.findUnique({ where: { tenantId_code: { tenantId, code: '1100' } } }),
        db.abAccount.findUnique({ where: { tenantId_code: { tenantId, code: '1000' } } }),
      ]);
      if (!arAccount || !cashAccount) {
        return NextResponse.json(
          {
            success: false,
            error:
              'AR account (1100) or Cash account (1000) not found. Ensure chart of accounts is seeded.',
          },
          { status: 422 },
        );
      }

      const fullyPaid = existingPaid + paymentAmount >= invoice.amountCents;

      await db.$transaction(async (tx) => {
        const journalEntry = await tx.abJournalEntry.create({
          data: {
            tenantId,
            date: txn.date,
            memo: `Bank reconciliation — Invoice ${invoice.number}`,
            sourceType: 'payment',
            verified: true,
            lines: {
              create: [
                {
                  accountId: cashAccount.id,
                  debitCents: paymentAmount,
                  creditCents: 0,
                  description: `Cash received - Invoice ${invoice.number}`,
                },
                {
                  accountId: arAccount.id,
                  debitCents: 0,
                  creditCents: paymentAmount,
                  description: `AR payment - Invoice ${invoice.number}`,
                },
              ],
            },
          },
        });

        const payment = await tx.abPayment.create({
          data: {
            tenantId,
            invoiceId: invoice.id,
            amountCents: paymentAmount,
            method: 'bank_transfer',
            date: txn.date,
            journalEntryId: journalEntry.id,
          },
        });

        await tx.abJournalEntry.update({
          where: { id: journalEntry.id },
          data: { sourceId: payment.id },
        });

        if (fullyPaid) {
          await tx.abInvoice.update({
            where: { id: invoice.id },
            data: { status: 'paid' },
          });
        }

        await tx.abClient.update({
          where: { id: invoice.clientId },
          data: { totalPaidCents: { increment: paymentAmount } },
        });

        await tx.abBankTransaction.update({
          where: { id: txn.id },
          data: {
            matchedInvoiceId: invoice.id,
            matchStatus: 'matched',
          },
        });

        await tx.abEvent.create({
          data: {
            tenantId,
            eventType: 'bank.txn_matched',
            actor: 'user',
            action: {
              transactionId: txn.id,
              targetType: 'invoice',
              invoiceId: invoice.id,
              invoiceNumber: invoice.number,
              amountCents: paymentAmount,
              source: 'reconciliation',
            },
          },
        });
      });

      return NextResponse.json({
        success: true,
        data: {
          transactionId: txn.id,
          matchedInvoiceId: invoice.id,
          invoiceNumber: invoice.number,
          amountCents: paymentAmount,
          fullyPaid,
        },
      });
    }

    // targetType === 'expense'
    const expense = await db.abExpense.findFirst({
      where: { id: targetId, tenantId },
    });
    if (!expense) {
      return NextResponse.json(
        { success: false, error: 'Expense not found' },
        { status: 404 },
      );
    }

    await db.$transaction([
      db.abBankTransaction.update({
        where: { id: txn.id },
        data: { matchedExpenseId: expense.id, matchStatus: 'matched' },
      }),
      db.abEvent.create({
        data: {
          tenantId,
          eventType: 'bank.txn_matched',
          actor: 'user',
          action: {
            transactionId: txn.id,
            targetType: 'expense',
            expenseId: expense.id,
            source: 'reconciliation',
          },
        },
      }),
    ]);

    return NextResponse.json({
      success: true,
      data: {
        transactionId: txn.id,
        matchedExpenseId: expense.id,
      },
    });
  } catch (err) {
    console.error('[bank-transactions/match] failed:', err);
    // Sanitized: don't echo Prisma internals or stack traces back to the
    // client. The detailed log goes server-side only.
    return NextResponse.json(
      { success: false, error: 'Failed to match transaction' },
      { status: 500 },
    );
  }
}
