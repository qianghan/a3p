/**
 * E2E for the Plaid bank integration: seed a transaction + invoice
 * directly in the DB, run the matcher (via the manual sync route's
 * code path — `runMatcherOnTransaction`), and verify the
 * matchStatus moved to 'matched' for high-confidence and 'exception'
 * for the medium band. The full Plaid OAuth round-trip is exercised
 * by the manual sandbox flow (user_good / pass_good) and isn't
 * automated here because Plaid Link's UI is iframed.
 */

import { test, expect } from '@playwright/test';
import { PrismaClient } from '@prisma/client';

const MAYA = '2e2348b6-a64c-44ad-907e-4ac120ff06f2';

let prisma: PrismaClient;
let runMatcherOnTransaction: (
  tenantId: string,
  row: { id: string; amount: number; date: Date; name: string; merchantName: string | null },
) => Promise<{ matchStatus: string; targetId?: string; score: number }>;

test.beforeAll(async () => {
  // We import dynamically so the module's `server-only` guard doesn't
  // fire under the Playwright runtime.
  process.env.BANK_TOKEN_ENCRYPTION_KEY ??=
    '0000000000000000000000000000000000000000000000000000000000000001';
  prisma = new PrismaClient();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const matcherMod = await import(
    '../../apps/web-next/src/lib/agentbook-plaid'
  );
  runMatcherOnTransaction = matcherMod.runMatcherOnTransaction;
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

test.describe('Payment matcher — DB-backed', () => {
  test('high-confidence inflow → invoice marked paid + matchStatus=matched', async () => {
    // Seed: an outstanding invoice for $1,200 with a Stripe-named client,
    // and an inflow transaction matching it within the same day.
    const today = new Date();
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);

    const client = await prisma.abClient.create({
      data: {
        tenantId: MAYA,
        name: `Stripe Test ${Date.now()}`,
        defaultTerms: 'net-30',
      },
    });
    const invoice = await prisma.abInvoice.create({
      data: {
        tenantId: MAYA,
        clientId: client.id,
        number: `INV-TEST-${Date.now()}`,
        amountCents: 120000,
        currency: 'USD',
        issuedDate: yesterday,
        dueDate: new Date(today.getTime() + 30 * 86400000),
        status: 'sent',
      },
    });

    // Bank account + transaction.
    const acct = await prisma.abBankAccount.create({
      data: {
        tenantId: MAYA,
        plaidItemId: 'test-item',
        plaidAccountId: `test-account-${Date.now()}`,
        name: 'Test Checking',
        type: 'checking',
        connected: true,
      },
    });
    const txn = await prisma.abBankTransaction.create({
      data: {
        tenantId: MAYA,
        bankAccountId: acct.id,
        plaidTransactionId: `test-txn-hi-${Date.now()}`,
        amount: -120000, // negative = inflow
        date: today,
        merchantName: client.name,
        name: `WIRE FROM ${client.name}`,
        matchStatus: 'pending',
      },
    });

    const result = await runMatcherOnTransaction(MAYA, {
      id: txn.id,
      amount: txn.amount,
      date: txn.date,
      name: txn.name,
      merchantName: txn.merchantName,
    });

    expect(result.score).toBeGreaterThanOrEqual(0.85);
    expect(result.matchStatus).toBe('matched');

    const refreshedTxn = await prisma.abBankTransaction.findUnique({
      where: { id: txn.id },
    });
    expect(refreshedTxn?.matchStatus).toBe('matched');
    expect(refreshedTxn?.matchedInvoiceId).toBe(invoice.id);

    const refreshedInv = await prisma.abInvoice.findUnique({ where: { id: invoice.id } });
    expect(refreshedInv?.status).toBe('paid');

    const payments = await prisma.abPayment.findMany({ where: { invoiceId: invoice.id } });
    expect(payments.length).toBeGreaterThan(0);

    // Cleanup
    await prisma.abPayment.deleteMany({ where: { invoiceId: invoice.id } });
    await prisma.abBankTransaction.delete({ where: { id: txn.id } });
    await prisma.abBankAccount.delete({ where: { id: acct.id } });
    await prisma.abInvoice.delete({ where: { id: invoice.id } });
    await prisma.abClient.delete({ where: { id: client.id } });
  });

  test('medium-confidence inflow → matchStatus=exception (queued for review)', async () => {
    const today = new Date();
    const twoDaysAgo = new Date(today.getTime() - 2 * 86400000);

    const client = await prisma.abClient.create({
      data: {
        tenantId: MAYA,
        name: `Acme Corp ${Date.now()}`,
        defaultTerms: 'net-30',
      },
    });
    const invoice = await prisma.abInvoice.create({
      data: {
        tenantId: MAYA,
        clientId: client.id,
        number: `INV-TESTMED-${Date.now()}`,
        amountCents: 50000,
        currency: 'USD',
        issuedDate: twoDaysAgo,
        dueDate: new Date(today.getTime() + 30 * 86400000),
        status: 'sent',
      },
    });

    const acct = await prisma.abBankAccount.create({
      data: {
        tenantId: MAYA,
        plaidItemId: 'test-item-med',
        plaidAccountId: `test-account-med-${Date.now()}`,
        name: 'Test Checking',
        type: 'checking',
        connected: true,
      },
    });
    // Mismatched name + amount drift → falls into 0.55–0.85 band.
    const txn = await prisma.abBankTransaction.create({
      data: {
        tenantId: MAYA,
        bankAccountId: acct.id,
        plaidTransactionId: `test-txn-med-${Date.now()}`,
        amount: -50100, // 0.2% off
        date: today,
        merchantName: 'UNKNOWN SENDER',
        name: 'WIRE TRANSFER 9981',
        matchStatus: 'pending',
      },
    });

    const result = await runMatcherOnTransaction(MAYA, {
      id: txn.id,
      amount: txn.amount,
      date: txn.date,
      name: txn.name,
      merchantName: txn.merchantName,
    });

    // The exact band depends on tuning; assert it's in [0.55, 0.85).
    expect(result.score).toBeGreaterThanOrEqual(0.55);
    expect(result.score).toBeLessThan(0.85);
    expect(result.matchStatus).toBe('exception');

    const refreshedTxn = await prisma.abBankTransaction.findUnique({
      where: { id: txn.id },
    });
    expect(refreshedTxn?.matchStatus).toBe('exception');

    // Invoice is NOT marked paid for medium confidence.
    const refreshedInv = await prisma.abInvoice.findUnique({ where: { id: invoice.id } });
    expect(refreshedInv?.status).toBe('sent');

    // Cleanup
    await prisma.abBankTransaction.delete({ where: { id: txn.id } });
    await prisma.abBankAccount.delete({ where: { id: acct.id } });
    await prisma.abInvoice.delete({ where: { id: invoice.id } });
    await prisma.abClient.delete({ where: { id: client.id } });
  });
});
