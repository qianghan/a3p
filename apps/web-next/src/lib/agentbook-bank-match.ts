/**
 * Shared bank-reconciliation primitives.
 *
 * Three call-sites used to inline an identical "post payment + JE +
 * mark invoice paid + update client.totalPaidCents + flip txn matched"
 * transaction:
 *   - apps/web-next/src/app/api/v1/agentbook-expense/bank-transactions/[id]/match/route.ts (HTTP)
 *   - apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts (bnk_match)
 *   - apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts (bnk_m2)
 *
 * That duplication was a footgun: a fix posted in the HTTP route would
 * silently miss the two Telegram paths. Both helpers here run inside a
 * single `$transaction` so the JE / payment / invoice flip are atomic.
 *
 * `source` differentiates the AbEvent for telemetry: 'reconciliation'
 * for the HTTP endpoint, 'telegram_button' / 'telegram_picker' for the
 * two Telegram callback paths.
 */

import 'server-only';
import { prisma as db } from '@naap/database';
import { PublicError } from '@/lib/api-error';
import { payBill } from '@/lib/purchases';

export type MatchSource = 'reconciliation' | 'telegram_button' | 'telegram_picker' | 'bank_sync';

export interface ApplyInvoiceMatchInput {
  tenantId: string;
  txnId: string;
  invoiceId: string;
  source: MatchSource;
}

export interface ApplyInvoiceMatchResult {
  paymentId: string;
  jeId: string;
  invoicePaid: boolean;
  paymentAmountCents: number;
  remainingCents: number;
  invoiceNumber: string;
}

export interface ApplyExpenseMatchInput {
  tenantId: string;
  txnId: string;
  expenseId: string;
  source: MatchSource;
}

export interface ApplyExpenseMatchResult {
  ok: true;
  expenseId: string;
}

export class BankMatchError extends PublicError {
  constructor(
    message: string,
    /** A short, user-presentable code so callers can pick a stable copy. */
    public readonly code:
      | 'txn_not_found'
      | 'invoice_not_found'
      | 'expense_not_found'
      | 'bill_not_found'
      | 'txn_not_debit'
      | 'txn_already_matched'
      | 'txn_currency_mismatch'
      | 'amount_mismatch'
      | 'coa_missing',
  ) {
    super(message);
    this.name = 'BankMatchError';
  }
}

/**
 * Apply a confirmed invoice match against a bank transaction.
 *
 * - Posts a balanced JE (debit Cash 1000, credit AR 1100, both = paymentAmount).
 * - Creates an AbPayment row tied to that JE.
 * - Marks the invoice 'paid' if existingPaid + paymentAmount >= invoice.amountCents.
 * - Increments the client's totalPaidCents.
 * - Flips the txn to matchStatus='matched' with matchedInvoiceId.
 * - Emits an AbEvent { eventType: 'bank.txn_matched' } tagged with `source`.
 */
export async function applyInvoiceMatch(
  input: ApplyInvoiceMatchInput,
): Promise<ApplyInvoiceMatchResult> {
  const { tenantId, txnId, invoiceId, source } = input;

  const txn = await db.abBankTransaction.findFirst({
    where: { id: txnId, tenantId },
  });
  if (!txn) throw new BankMatchError('Transaction not found', 'txn_not_found');

  const invoice = await db.abInvoice.findFirst({
    where: { id: invoiceId, tenantId },
    include: { payments: true },
  });
  if (!invoice) throw new BankMatchError('Invoice not found', 'invoice_not_found');

  const amountCents = Math.abs(txn.amount);
  const existingPaid = invoice.payments.reduce((s, p) => s + p.amountCents, 0);
  const remainingBalance = invoice.amountCents - existingPaid;
  const paymentAmount = Math.min(amountCents, remainingBalance);

  // Same precondition as the per-payment route: without a 1000/1100 chart
  // we'd post an unbalanced or dangling JE. Fail loudly.
  const [arAccount, cashAccount] = await Promise.all([
    db.abAccount.findUnique({ where: { tenantId_code: { tenantId, code: '1100' } } }),
    db.abAccount.findUnique({ where: { tenantId_code: { tenantId, code: '1000' } } }),
  ]);
  if (!arAccount || !cashAccount) {
    throw new BankMatchError(
      'AR account (1100) or Cash account (1000) not found. Ensure chart of accounts is seeded.',
      'coa_missing',
    );
  }

  const fullyPaid = existingPaid + paymentAmount >= invoice.amountCents;

  return await db.$transaction(async (tx) => {
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
              tenantId, // G-009
              accountId: cashAccount.id,
              debitCents: paymentAmount,
              creditCents: 0,
              description: `Cash received - Invoice ${invoice.number}`,
            },
            {
              tenantId, // G-009
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
      data: { matchedInvoiceId: invoice.id, matchStatus: 'matched' },
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
          source,
        },
      },
    });

    return {
      paymentId: payment.id,
      jeId: journalEntry.id,
      invoicePaid: fullyPaid,
      paymentAmountCents: paymentAmount,
      remainingCents: Math.max(0, invoice.amountCents - existingPaid - paymentAmount),
      invoiceNumber: invoice.number,
    };
  });
}

/**
 * Apply a confirmed expense match. No JE — expense JEs are posted at
 * booking time, not at reconciliation. Just link `matchedExpenseId` and
 * emit the matched event.
 */
export async function applyExpenseMatch(
  input: ApplyExpenseMatchInput,
): Promise<ApplyExpenseMatchResult> {
  const { tenantId, txnId, expenseId, source } = input;

  const txn = await db.abBankTransaction.findFirst({
    where: { id: txnId, tenantId },
  });
  if (!txn) throw new BankMatchError('Transaction not found', 'txn_not_found');

  const expense = await db.abExpense.findFirst({
    where: { id: expenseId, tenantId },
  });
  if (!expense) throw new BankMatchError('Expense not found', 'expense_not_found');

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
          source,
        },
      },
    }),
  ]);

  return { ok: true, expenseId: expense.id };
}

export interface ApplyBillMatchInput {
  tenantId: string;
  txnId: string;
  billId: string;
  source: MatchSource;
}

export interface ApplyBillMatchResult {
  billId: string;
  paymentId: string;
  paymentAmountCents: number;
  remainingCents: number;
  billPaid: boolean;
  vendorName: string;
  /** Debit minus what was paid (a fee on top of the bill); 0 when exact. */
  excessCents: number;
}

/**
 * PR 3d.4 — apply a bank debit to an unpaid bill: records a bill payment
 * through lib/purchases (at_entry → DR 2000 / CR 1000; legacy at_payment →
 * DR expense / CR 1000, exactly as paying it from the Bills page) and sets
 * `matchedBillId`. Never creates an AbExpense — the bill already carries the
 * expense, so an expense row here is the double count this exists to stop.
 *
 * Amount: the debit, capped at what is still owing (a debit within the
 * matcher's fee tolerance above it settles the bill). Idempotent on
 * `bank:<txnId>`: a retry after a crash between the payment and the txn
 * update replays the same payment instead of paying twice.
 */
export async function applyBillMatch(input: ApplyBillMatchInput): Promise<ApplyBillMatchResult> {
  const { tenantId, txnId, billId, source } = input;
  const txn = await db.abBankTransaction.findFirst({
    where: { id: txnId, tenantId },
    include: { bankAccount: { select: { currency: true } } },
  });
  if (!txn) throw new BankMatchError('Transaction not found', 'txn_not_found');
  if (txn.amount <= 0) throw new BankMatchError('Only a debit can pay a bill', 'txn_not_debit');
  const bill = await db.abBill.findFirst({ where: { id: billId, tenantId, deletedAt: null } });
  if (!bill) throw new BankMatchError('Bill not found', 'bill_not_found');

  // Review I2: the debit and the bill must be in the same currency. A bill
  // with no currency is in the tenant's; an account with none is unknown.
  const cfg = bill.currency ? null : await db.abTenantConfig.findUnique({ where: { userId: tenantId } });
  const billCur = String(bill.currency ?? cfg?.currency ?? 'USD').toUpperCase();
  const txnCur = (txn as { bankAccount?: { currency?: string | null } | null }).bankAccount?.currency?.toUpperCase();
  if (txnCur && txnCur !== billCur) {
    throw new BankMatchError(`This ${txnCur} debit cannot pay a ${billCur} bill`, 'txn_currency_mismatch');
  }

  const key = `bank:${txn.id}`;
  // Review I1: a live payment keyed to this debit on ANY other bill means the
  // debit is spent, whatever matchStatus says (e.g. a review-band re-point).
  const elsewhere = await db.abBillPayment.findFirst({ where: { tenantId, idempotencyKey: key, voidedAt: null, billId: { not: bill.id } } });
  if (elsewhere) throw new BankMatchError('This transaction already paid another bill', 'txn_already_matched');
  const prior = await db.abBillPayment.findFirst({ where: { tenantId, billId: bill.id, idempotencyKey: key } });
  const owing = bill.amountCents - (bill.paidCents ?? 0);
  // Review M1: a legacy at_payment bill cannot be part-paid; a debit below
  // what is owing is not this bill's payment (the matcher never proposes it).
  if (!prior && txn.amount < owing && bill.postingMode !== 'at_entry') {
    throw new BankMatchError('The debit is less than the bill and this bill cannot be part-paid', 'amount_mismatch');
  }
  const amountCents = prior ? prior.amountCents : Math.min(txn.amount, owing);

  // Review I1: claim the debit atomically BEFORE paying. The WHERE is
  // re-evaluated under the row lock, so of two racing claims (bank sync → A,
  // a tap → B) exactly one updates the row; the loser pays nothing.
  // Re-claiming for the same bill is allowed (a retry replays its payment).
  const before = { matchStatus: txn.matchStatus, matchedBillId: txn.matchedBillId, matchedExpenseId: txn.matchedExpenseId };
  const claim = await db.abBankTransaction.updateMany({
    where: { id: txn.id, tenantId, OR: [{ matchStatus: { not: 'matched' } }, { matchedBillId: bill.id }] },
    data: { matchedBillId: bill.id, matchedExpenseId: null, matchStatus: 'matched' },
  });
  if (claim.count === 0) throw new BankMatchError('This transaction is already matched', 'txn_already_matched');

  let after: Awaited<ReturnType<typeof payBill>>['bill'];
  let payment: Awaited<ReturnType<typeof payBill>>['payment'];
  try {
    ({ bill: after, payment } = await payBill(db, tenantId, bill.id, {
      amountCents,
      date: prior ? (prior.date as Date) : txn.date,
      method: 'bank',
      idempotencyKey: key,
    }));
  } catch (err) {
    // The payment was refused (closed period, already paid…): release the
    // claim so the debit can be matched to something else.
    if (!prior) {
      await db.abBankTransaction.updateMany({ where: { id: txn.id, tenantId, matchedBillId: bill.id, matchStatus: 'matched' }, data: before });
    }
    throw err;
  }

  // Review M2: a debit above what was owing (bank fee) is not booked as a fee
  // — there is no fee account the user chose; the excess is reported so the
  // reconciliation can show it. Bank sync never auto-applies such a debit.
  const excessCents = Math.max(0, txn.amount - payment.amountCents);
  await db.abEvent.create({
    data: {
      tenantId,
      eventType: 'bank.txn_matched',
      actor: source === 'bank_sync' ? 'system' : 'user',
      action: { transactionId: txn.id, targetType: 'bill', billId: bill.id, paymentId: payment.id, amountCents: payment.amountCents, excessCents, source },
    },
  });

  return {
    billId: bill.id,
    paymentId: payment.id,
    paymentAmountCents: payment.amountCents,
    remainingCents: Math.max(0, after.amountCents - (after.paidCents ?? 0)),
    billPaid: after.status === 'paid',
    vendorName: bill.vendorName,
    excessCents,
  };
}
