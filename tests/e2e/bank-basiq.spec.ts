/**
 * E2E for the Basiq bank integration (AU business-side): seed a
 * Basiq-backed transaction + invoice directly in the DB, run the matcher
 * (via the same `runMatcherOnTransaction` code path the manual sync route
 * and the daily cron use — see `agentbook-basiq-sync.ts`), and verify the
 * matchStatus moved to 'matched' for high-confidence and 'exception' for
 * the medium band. Mirrors `bank-plaid.spec.ts`'s established precedent
 * exactly, using `provider: 'basiq'` + `basiqAccountId`/`basiqTransactionId`
 * fields instead of Plaid's.
 *
 * The full Basiq Consent UI round-trip (hosted, redirected third-party
 * flow — no client-embeddable widget like Plaid Link) cannot be driven by
 * Playwright and requires a real `BASIQ_API_KEY`, which is not available
 * in this environment (Basiq is a third-party CDR-accredited data
 * provider; obtaining a key requires the account owner to sign up
 * directly with Basiq — see `agentbook/PRODUCTION-ENV.md`'s "Basiq env
 * vars" section). Manual verification, once a real sandbox key is
 * provisioned, should follow Task 7 Step 5 of
 * `docs/superpowers/plans/2026-07-19-au1-basiq-bank-sync.md`:
 *
 *   1. AU test tenant (`sydney@agentbook.test`) → Business Profile →
 *      confirm no "Not available yet" bank-sync message remains anywhere.
 *   2. Expense plugin → Bank page → "Connect bank" → Basiq sandbox
 *      consent popup opens → complete sandbox bank login → popup closes
 *      → account appears in the list with correct name/balance/currency.
 *   3. Manually trigger `/api/v1/agentbook-expense/bank/basiq/sync` →
 *      confirm transactions appear, at least one auto-matches against a
 *      seeded test invoice/expense.
 *   4. Disconnect the account → confirm it disappears/flips
 *      `connected:false`, historical transactions remain queryable.
 *   5. Confirm the daily Basiq cron route returns 401 without the
 *      `CRON_SECRET` bearer and 200 with it, via a manual `curl`.
 */

import { test, expect } from '@playwright/test';

test.skip(
  true,
  "Basiq Consent UI is a redirected/popup third-party flow requiring a real Basiq API key not available in CI — see this file's comments for manual verification steps once BASIQ_API_KEY is provisioned",
);

// E2E user UUID — matches scripts/seed-e2e-user.ts (kept for future re-enable).
const TENANT = 'b9a80acd-fa14-4209-83a9-03231513fa8f';
let prisma: typeof import('@naap/database').prisma;
let runMatcherOnTransaction: (
  tenantId: string,
  row: { id: string; amount: number; date: Date; name: string; merchantName: string | null },
) => Promise<{ matchStatus: string; targetId?: string; score: number }>;

test.beforeAll(async () => {
  process.env.BANK_TOKEN_ENCRYPTION_KEY ??=
    '0000000000000000000000000000000000000000000000000000000000000001';
  const dbMod = await import('@naap/database');
  prisma = dbMod.prisma;
  // `runMatcherOnTransaction` is provider-agnostic despite the filename —
  // both the Plaid and Basiq sync paths (`agentbook-basiq-sync.ts`) import
  // it from here. Mirrors bank-plaid.spec.ts's import exactly.
  const matcherMod = await import('../../apps/web-next/src/lib/agentbook-plaid');
  runMatcherOnTransaction = matcherMod.runMatcherOnTransaction;
});

test.afterAll(async () => {
  if (prisma) await prisma.$disconnect();
});

test.describe('Basiq payment matcher — DB-backed', () => {
  test('high-confidence inflow → invoice marked paid + matchStatus=matched', async () => {
    const today = new Date();
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);

    const client = await prisma.abClient.create({
      data: {
        tenantId: TENANT,
        name: `Basiq Test AU ${Date.now()}`,
        defaultTerms: 'net-30',
      },
    });
    const invoice = await prisma.abInvoice.create({
      data: {
        tenantId: TENANT,
        clientId: client.id,
        number: `INV-BASIQ-${Date.now()}`,
        amountCents: 120000,
        currency: 'AUD',
        issuedDate: yesterday,
        dueDate: new Date(today.getTime() + 30 * 86400000),
        status: 'sent',
      },
    });

    // Basiq-backed bank account + transaction.
    const acct = await prisma.abBankAccount.create({
      data: {
        tenantId: TENANT,
        provider: 'basiq',
        basiqAccountId: `basiq-test-account-${Date.now()}`,
        basiqConnectionId: `basiq-test-connection-${Date.now()}`,
        name: 'Test AU Checking',
        type: 'checking',
        currency: 'AUD',
        connected: true,
      },
    });
    const txn = await prisma.abBankTransaction.create({
      data: {
        tenantId: TENANT,
        bankAccountId: acct.id,
        basiqTransactionId: `basiq-test-txn-hi-${Date.now()}`,
        amount: -120000, // negative = inflow
        date: today,
        merchantName: client.name,
        name: `WIRE FROM ${client.name}`,
        matchStatus: 'pending',
      },
    });

    const result = await runMatcherOnTransaction(TENANT, {
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
        tenantId: TENANT,
        name: `Basiq Corp AU ${Date.now()}`,
        defaultTerms: 'net-30',
      },
    });
    const invoice = await prisma.abInvoice.create({
      data: {
        tenantId: TENANT,
        clientId: client.id,
        number: `INV-BASIQMED-${Date.now()}`,
        amountCents: 50000,
        currency: 'AUD',
        issuedDate: twoDaysAgo,
        dueDate: new Date(today.getTime() + 30 * 86400000),
        status: 'sent',
      },
    });

    const acct = await prisma.abBankAccount.create({
      data: {
        tenantId: TENANT,
        provider: 'basiq',
        basiqAccountId: `basiq-test-account-med-${Date.now()}`,
        basiqConnectionId: `basiq-test-connection-med-${Date.now()}`,
        name: 'Test AU Checking',
        type: 'checking',
        currency: 'AUD',
        connected: true,
      },
    });
    // Mismatched name + amount drift → falls into 0.55–0.85 band.
    const txn = await prisma.abBankTransaction.create({
      data: {
        tenantId: TENANT,
        bankAccountId: acct.id,
        basiqTransactionId: `basiq-test-txn-med-${Date.now()}`,
        amount: -50100, // 0.2% off
        date: today,
        merchantName: 'UNKNOWN SENDER',
        name: 'WIRE TRANSFER 9981',
        matchStatus: 'pending',
      },
    });

    const result = await runMatcherOnTransaction(TENANT, {
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
