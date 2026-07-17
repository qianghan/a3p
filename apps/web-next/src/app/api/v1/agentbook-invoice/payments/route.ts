/**
 * Invoice payments — record payment, post journal entry, update invoice
 * status if fully paid. Native port of the legacy plugin handler.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { audit } from '@/lib/agentbook-audit';
import { inferSource, inferActor } from '@/lib/agentbook-audit-context';
import { withHttpIdempotency } from '@/lib/agentbook-idempotency';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface CreatePaymentBody {
  invoiceId?: string;
  amountCents?: number;
  method?: string;
  date?: string;
  stripePaymentId?: string;
  feesCents?: number;
}

// Typed error for the payment-transaction balance re-check (mirrors the
// legacy plugin handler in plugins/agentbook-invoice/backend/src/server.ts).
class PaymentExceedsBalanceError extends Error {
  constructor(public readonly amountCents: number, public readonly remainingBalance: number) {
    super(`Payment amount (${amountCents}) exceeds remaining balance (${remainingBalance})`);
    this.name = 'PaymentExceedsBalanceError';
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;
  const auditSource = inferSource(request);
  const auditActor = await inferActor(request);

  return withHttpIdempotency(request, {
    tenantId,
    endpoint: 'POST /api/v1/agentbook-invoice/payments',
    handler: async (rawBody) => {
      try {
        let body: CreatePaymentBody = {};
        try {
          body = rawBody ? (JSON.parse(rawBody) as CreatePaymentBody) : {};
        } catch {
          body = {};
        }
        const { invoiceId, amountCents, method, date, stripePaymentId, feesCents } = body;

        if (!invoiceId || !amountCents || amountCents <= 0) {
          return {
            status: 400,
            body: { success: false, error: 'invoiceId and positive amountCents are required' },
          };
        }

        // Fast-path existence/void check (cheap, outside the transaction —
        // the authoritative balance check happens inside the locked
        // transaction below, so a stale read here can't cause an incorrect
        // write).
        const invoicePrecheck = await db.abInvoice.findFirst({ where: { id: invoiceId, tenantId } });
        if (!invoicePrecheck) {
          return { status: 404, body: { success: false, error: 'Invoice not found' } };
        }
        if (invoicePrecheck.status === 'void') {
          return { status: 422, body: { success: false, error: 'Cannot pay a voided invoice' } };
        }

        const fees = feesCents || 0;

        const [arAccount, cashAccount, feesAccount] = await Promise.all([
          db.abAccount.findUnique({ where: { tenantId_code: { tenantId, code: '1100' } } }),
          db.abAccount.findUnique({ where: { tenantId_code: { tenantId, code: '1000' } } }),
          fees > 0
            ? db.abAccount.findUnique({ where: { tenantId_code: { tenantId, code: '5200' } } })
            : Promise.resolve(null),
        ]);

        if (!arAccount || !cashAccount) {
          return {
            status: 422,
            body: {
              success: false,
              error: 'AR account (1100) or Cash account (1000) not found. Ensure chart of accounts is seeded.',
            },
          };
        }

        const { payment, alreadyRecorded, fullyPaid, invoiceNumber, previousStatus } = await db.$transaction(
          async (tx) => {
            // Idempotent replay: a Stripe-sourced payment retried with the
            // same stripePaymentId returns the payment already recorded for
            // it, instead of creating a duplicate (the unique index on
            // (invoiceId, stripePaymentId) would reject the insert anyway —
            // this check makes the replay path return 200 with the existing
            // row rather than a raw constraint-violation error).
            if (stripePaymentId) {
              const existingForStripeId = await tx.abPayment.findFirst({
                where: { invoiceId, stripePaymentId },
              });
              if (existingForStripeId) {
                return {
                  payment: existingForStripeId,
                  alreadyRecorded: true,
                  fullyPaid: false,
                  invoiceNumber: invoicePrecheck.number,
                  previousStatus: invoicePrecheck.status,
                };
              }
            }

            // Row-lock the invoice for the remainder of this transaction. Any
            // concurrent submission against the SAME invoice (manual double-
            // submit, or two Stripe retries with different payment ids)
            // blocks here until this transaction commits or rolls back — so
            // the re-read below is always up to date with any payment that
            // already committed, closing the check-then-act race the
            // pre-transaction balance check had.
            await tx.$queryRaw`SELECT id FROM "plugin_agentbook_invoice"."AbInvoice" WHERE id = ${invoiceId} FOR UPDATE`;

            // Second stripePaymentId check, now that we hold the invoice's
            // row lock: closes the race where two requests carrying the SAME
            // stripePaymentId arrive concurrently and both pass the pre-lock
            // check above (neither has committed yet). By the time the lock
            // is acquired, any concurrent transaction that already committed
            // a matching payment is guaranteed visible here — catching it
            // now avoids hitting the AbPayment unique-constraint violation
            // later and returns the intended graceful replay instead of a
            // raw 500.
            if (stripePaymentId) {
              const existingForStripeIdAfterLock = await tx.abPayment.findFirst({
                where: { invoiceId, stripePaymentId },
              });
              if (existingForStripeIdAfterLock) {
                return {
                  payment: existingForStripeIdAfterLock,
                  alreadyRecorded: true,
                  fullyPaid: false,
                  invoiceNumber: invoicePrecheck.number,
                  previousStatus: invoicePrecheck.status,
                };
              }
            }

            const invoice = await tx.abInvoice.findFirst({
              where: { id: invoiceId, tenantId },
              include: { payments: true, client: true },
            });
            if (!invoice) {
              throw new Error('Invoice not found'); // extremely unlikely: deleted between precheck and lock
            }

            const existingPaid = invoice.payments.reduce((sum, p) => sum + p.amountCents, 0);
            const remainingBalance = invoice.amountCents - existingPaid;
            if (amountCents > remainingBalance) {
              throw new PaymentExceedsBalanceError(amountCents, remainingBalance);
            }

            const fullyPaidNow = existingPaid + amountCents >= invoice.amountCents;

            const journalLines: Array<{
              tenantId: string;
              accountId: string;
              debitCents: number;
              creditCents: number;
              description: string;
            }> = [
              { tenantId, accountId: cashAccount.id, debitCents: amountCents, creditCents: 0, description: `Cash received - Invoice ${invoice.number}` }, // G-009
              { tenantId, accountId: arAccount.id, debitCents: 0, creditCents: amountCents, description: `AR payment - Invoice ${invoice.number}` }, // G-009
            ];
            if (fees > 0 && feesAccount) {
              journalLines.push(
                { tenantId, accountId: feesAccount.id, debitCents: fees, creditCents: 0, description: `Payment processing fees - Invoice ${invoice.number}` }, // G-009
                { tenantId, accountId: cashAccount.id, debitCents: 0, creditCents: fees, description: `Fees deducted from cash - Invoice ${invoice.number}` }, // G-009
              );
            }

            const journalEntry = await tx.abJournalEntry.create({
              data: {
                tenantId,
                date: new Date(date || Date.now()),
                memo: `Payment for Invoice ${invoice.number}`,
                sourceType: 'payment',
                verified: true,
                lines: { create: journalLines },
              },
            });

            const pmt = await tx.abPayment.create({
              data: {
                tenantId,
                invoiceId,
                amountCents,
                method: method || 'manual',
                date: new Date(date || Date.now()),
                stripePaymentId: stripePaymentId || null,
                feesCents: fees,
                journalEntryId: journalEntry.id,
              },
            });

            await tx.abJournalEntry.update({ where: { id: journalEntry.id }, data: { sourceId: pmt.id } });

            if (fullyPaidNow) {
              await tx.abInvoice.update({ where: { id: invoiceId }, data: { status: 'paid' } });
            }

            await tx.abClient.update({
              where: { id: invoice.clientId },
              data: { totalPaidCents: { increment: amountCents } },
            });

            await tx.abEvent.create({
              data: {
                tenantId,
                eventType: 'payment.received',
                actor: 'agent',
                action: {
                  paymentId: pmt.id,
                  invoiceId,
                  invoiceNumber: invoice.number,
                  amountCents,
                  method: method || 'manual',
                  feesCents: fees,
                  fullyPaid: fullyPaidNow,
                  clientId: invoice.clientId,
                  clientName: invoice.client.name,
                },
                constraintsPassed: ['balance_invariant'],
                verificationResult: 'passed',
              },
            });

            return {
              payment: pmt,
              alreadyRecorded: false,
              fullyPaid: fullyPaidNow,
              invoiceNumber: invoice.number,
              previousStatus: invoice.status,
            };
          },
        );

        // PR 10 — audit the payment + the invoice status flip if it became
        // paid. Skipped on a replay (alreadyRecorded): no new payment was
        // actually created, so there's nothing new to audit.
        if (!alreadyRecorded) {
          await audit({
            tenantId,
            source: auditSource,
            actor: auditActor,
            action: 'payment.create',
            entityType: 'AbPayment',
            entityId: payment.id,
            after: {
              invoiceId,
              invoiceNumber,
              amountCents,
              method: payment.method,
              feesCents: fees,
              fullyPaid,
            },
          });
          if (fullyPaid) {
            await audit({
              tenantId,
              source: auditSource,
              actor: auditActor,
              action: 'invoice.mark_paid',
              entityType: 'AbInvoice',
              entityId: invoiceId,
              before: { status: previousStatus },
              after: { status: 'paid', number: invoiceNumber, paymentId: payment.id },
            });
          }
        }

        return {
          status: alreadyRecorded ? 200 : 201,
          body: { success: true, data: payment, alreadyRecorded },
        };
      } catch (err) {
        if (err instanceof PaymentExceedsBalanceError) {
          return { status: 422, body: { success: false, error: err.message } };
        }
        console.error('[agentbook-invoice/payments POST] failed:', err);
        return {
          status: 500,
          body: { success: false, error: err instanceof Error ? err.message : String(err) },
        };
      }
    },
  });
}
