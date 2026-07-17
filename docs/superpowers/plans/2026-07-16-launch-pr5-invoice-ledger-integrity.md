# Launch-gap PR-5: Invoice + Ledger Integrity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three independent money-correctness bugs in the invoice/payment/ledger path: (a) the manual payment-recording route has no idempotency/race protection and can double-book cash; (b) the Stripe checkout webhook silently posts no journal entry because it looks up account codes `1010`/`1200` against a chart that actually uses `1000`/`1100`; (c) skill routing can misroute "invoice Acme $5000 for consulting" to `record-expense` because two skills' patterns both match and there's no deterministic tie-break.

**Architecture:** Each bug is fixed at its root cause, not papered over: (a) a DB-level unique constraint plus a row lock inside the existing transaction close the race; (b) the hardcoded account-code literals are corrected to match the real chart of accounts (already jurisdiction-uniform, confirmed against all four packs); (c) `record-expense`'s exclude patterns are extended to defer to `create-invoice` via a shared regex constant (the codebase's established pattern for resolving skill collisions), and the three `AbSkillManifest.findMany()` call sites get a deterministic `orderBy` as defense-in-depth.

**Tech Stack:** Prisma 5.20 (Postgres, multi-schema), Express (`@naap/plugin-server-sdk`) for the invoice plugin backend, Next.js route handlers for the Stripe webhook, Vitest for all tests.

## Global Constraints

- Scope boundary (from the roadmap): fix the account-code constants and add the missing `orderBy`/idempotency check — do not redesign the skill-routing engine or the payment-recording flow beyond what's needed to make both deterministic and safe.
- Every schema change needs a hand-written migration under `packages/database/prisma/migrations/`, following the existing convention (see `20260521250000_add_http_idempotency_and_journal_unique/migration.sql`): a comment header explaining the change, a pre-flight dedup step before any new unique constraint, then `CREATE UNIQUE INDEX IF NOT EXISTS`.
- Never run `prisma db push`/migrations against the shared local dev DB or production directly from this plan — verify schema changes against an isolated, throwaway Postgres container (`docker run --rm -d -p <port>:5432 -e POSTGRES_PASSWORD=postgres --name <name> postgres:16`), per established session convention. Production migration + deploy happens as an explicit, separately-confirmed step after this branch is reviewed.
- All new code must match existing file conventions exactly: the invoice backend's Express handlers return `{ success: boolean, data?/error? }` JSON bodies; the Stripe webhook `handlers.ts` uses `console.warn`/`console.error` for non-fatal issues, never throws for missing chart-of-accounts rows (best-effort journal entries).
- Test additions follow this codebase's established convention for this exact plugin: `plugins/agentbook-invoice/backend/src/__tests__/invoice-logic.test.ts` tests business logic as **extracted pure functions**, not via HTTP/supertest against the Express app. New payment-logic tests must follow that same convention.

---

### Task 1: Schema — unique constraint on `AbPayment(invoiceId, stripePaymentId)`

**Files:**
- Modify: `packages/database/prisma/schema.prisma` (`model AbPayment`, lines 2122–2138)
- Create: `packages/database/prisma/migrations/20260716120000_add_payment_stripe_id_unique/migration.sql`

**Interfaces:**
- Produces: a DB-level guarantee that two `AbPayment` rows can never share the same non-null `(invoiceId, stripePaymentId)` pair. Postgres treats NULL as distinct in composite unique indexes, so manual/cash payments (`stripePaymentId IS NULL`) are unaffected — only Stripe-sourced payments are deduped. Task 2 and Task 3 both rely on this constraint.

- [ ] **Step 1: Add the unique constraint to the Prisma schema**

In `packages/database/prisma/schema.prisma`, find:

```prisma
model AbPayment {
  id              String     @id @default(uuid())
  tenantId        String
  invoiceId       String?
  invoice         AbInvoice? @relation(fields: [invoiceId], references: [id])
  amountCents     Int
  method          String     @default("manual") // manual | stripe | bank_transfer
  date            DateTime
  stripePaymentId String?
  feesCents       Int        @default(0)
  journalEntryId  String?
  createdAt       DateTime   @default(now())

  @@index([tenantId, date])
  @@index([invoiceId])
  @@schema("plugin_agentbook_invoice")
}
```

Replace with:

```prisma
model AbPayment {
  id              String     @id @default(uuid())
  tenantId        String
  invoiceId       String?
  invoice         AbInvoice? @relation(fields: [invoiceId], references: [id])
  amountCents     Int
  method          String     @default("manual") // manual | stripe | bank_transfer
  date            DateTime
  stripePaymentId String?
  feesCents       Int        @default(0)
  journalEntryId  String?
  createdAt       DateTime   @default(now())

  @@index([tenantId, date])
  @@index([invoiceId])
  // G-5A: dedupes a Stripe-sourced payment applied twice to the same
  // invoice (retried webhook, retried client submit). Postgres treats
  // NULL as distinct, so manual/cash payments (stripePaymentId IS NULL)
  // are never constrained by this index — only real Stripe payment IDs
  // dedupe.
  @@unique([invoiceId, stripePaymentId])
  @@schema("plugin_agentbook_invoice")
}
```

- [ ] **Step 2: Write the migration file**

Create `packages/database/prisma/migrations/20260716120000_add_payment_stripe_id_unique/migration.sql`:

```sql
-- Migration: AbPayment unique constraint on (invoiceId, stripePaymentId)
-- (Launch-gap PR-5, G-5A)
--
-- Prevents a Stripe-sourced payment from being recorded twice against the
-- same invoice (a retried webhook delivery, or a retried client submit that
-- carries the same stripePaymentId). Postgres treats NULL as distinct in a
-- unique index, so manual/cash payments (stripePaymentId IS NULL) are never
-- subject to this constraint — only rows with a real Stripe payment id
-- dedupe.
--
-- Pre-flight: dedup any pre-existing duplicate (invoiceId, stripePaymentId)
-- rows before the constraint is created (mirrors the AbJournalEntry dedup
-- in 20260521250000_add_http_idempotency_and_journal_unique).

-- ---------------------------------------------------------------------
-- 1. Deduplicate any pre-existing AbPayment rows that would violate the
--    new constraint. Keep the oldest by createdAt; delete the rest.
--    Restricted to rows where invoiceId AND stripePaymentId are both
--    NOT NULL — NULL pairs are not constrained.
-- ---------------------------------------------------------------------
WITH dups AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY "invoiceId", "stripePaymentId"
      ORDER BY "createdAt" ASC, "id" ASC
    ) AS rn
  FROM "plugin_agentbook_invoice"."AbPayment"
  WHERE "invoiceId" IS NOT NULL AND "stripePaymentId" IS NOT NULL
)
DELETE FROM "plugin_agentbook_invoice"."AbPayment"
WHERE id IN (SELECT id FROM dups WHERE rn > 1);

-- ---------------------------------------------------------------------
-- 2. Unique constraint.
-- ---------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS "AbPayment_invoiceId_stripePaymentId_key"
  ON "plugin_agentbook_invoice"."AbPayment" ("invoiceId", "stripePaymentId");
```

- [ ] **Step 3: Regenerate the Prisma client**

Run: `cd packages/database && npx prisma generate`
Expected: `✔ Generated Prisma Client` with no errors.

- [ ] **Step 4: Verify against an isolated throwaway Postgres (never the shared local dev DB)**

```bash
docker run --rm -d -p 55432:5432 -e POSTGRES_PASSWORD=postgres --name pr5-verify-db postgres:16
sleep 3
DATABASE_URL="postgresql://postgres:postgres@localhost:55432/verify" \
DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@localhost:55432/verify" \
  npx prisma migrate deploy --schema packages/database/prisma/schema.prisma
```

Expected: all migrations apply cleanly, including the new one, with no errors. Then:

```bash
docker stop pr5-verify-db
```

- [ ] **Step 5: Commit**

```bash
git add packages/database/prisma/schema.prisma packages/database/prisma/migrations/20260716120000_add_payment_stripe_id_unique
git commit -m "schema: unique constraint on AbPayment(invoiceId, stripePaymentId)"
```

---

### Task 2: Fix manual payment-recording race + add Stripe-replay idempotency

**Files:**
- Modify: `plugins/agentbook-invoice/backend/src/server.ts` (the `POST /api/v1/agentbook-invoice/payments` handler, lines 675–851)
- Modify: `plugins/agentbook-invoice/backend/src/__tests__/invoice-logic.test.ts` (extend the existing "Payment Overpayment Prevention" section)

**Interfaces:**
- Consumes: the `AbPayment_invoiceId_stripePaymentId_key` unique index from Task 1.
- Produces: no new exported functions — this task changes the internal control flow of one route handler. Task 3 and Task 4 do not depend on anything from this task.

**Context on the bug:** the current handler reads `invoice.payments` and computes `remainingBalance` *before* opening the `$transaction`, then writes inside the transaction — a classic check-then-act race. Two concurrent submissions (a retried manual entry, or two near-simultaneous requests) can both pass the balance check and both write, double-booking cash. There is also no idempotency for a client-supplied `stripePaymentId` — a retried request creates a second `AbPayment` + a second `AbJournalEntry` for the same Stripe payment.

- [ ] **Step 1: Add a typed error for the balance check**

In `plugins/agentbook-invoice/backend/src/server.ts`, near the top of the file (after the `getAccountByCode` helper, around line 98), add:

```ts
// ============================================
// HELPER: Typed error for the payment-transaction balance re-check
// ============================================

class PaymentExceedsBalanceError extends Error {
  constructor(public readonly amountCents: number, public readonly remainingBalance: number) {
    super(`Payment amount (${amountCents}) exceeds remaining balance (${remainingBalance})`);
    this.name = 'PaymentExceedsBalanceError';
  }
}
```

- [ ] **Step 2: Move the balance re-check inside the transaction, behind a row lock**

Replace the full `POST /api/v1/agentbook-invoice/payments` handler (lines 675–851) with:

```ts
app.post('/api/v1/agentbook-invoice/payments', async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).tenantId;
    const { invoiceId, amountCents, method, date, stripePaymentId, feesCents } = req.body;

    if (!invoiceId || !amountCents || amountCents <= 0) {
      return res.status(400).json({ success: false, error: 'invoiceId and positive amountCents are required' });
    }

    // Fast-path existence/void check (cheap, outside the transaction — the
    // authoritative balance check happens inside the locked transaction
    // below, so a stale read here can't cause an incorrect write).
    const invoicePrecheck = await db.abInvoice.findFirst({ where: { id: invoiceId, tenantId } });
    if (!invoicePrecheck) {
      return res.status(404).json({ success: false, error: 'Invoice not found' });
    }
    if (invoicePrecheck.status === 'void') {
      return res.status(422).json({ success: false, error: 'Cannot pay a voided invoice' });
    }

    // Look up accounts for journal entry
    const arAccount = await getAccountByCode(tenantId, '1100');
    // Cash account: typically code 1000
    const cashAccount = await getAccountByCode(tenantId, '1000');
    // Fees expense account: typically code 5200 (Bank Fees / Payment Processing Fees)
    const feesAccount = feesCents && feesCents > 0
      ? await getAccountByCode(tenantId, '5200')
      : null;

    if (!arAccount || !cashAccount) {
      return res.status(422).json({
        success: false,
        error: 'AR account (1100) or Cash account (1000) not found. Ensure chart of accounts is seeded.',
      });
    }

    const fees = feesCents || 0;

    const { payment, alreadyRecorded } = await db.$transaction(async (tx) => {
      // Idempotent replay: a Stripe-sourced payment retried with the same
      // stripePaymentId returns the payment already recorded for it,
      // instead of creating a duplicate (the unique index on
      // (invoiceId, stripePaymentId) would reject the insert anyway — this
      // check makes the replay path return 200 with the existing row
      // rather than a raw constraint-violation error).
      if (stripePaymentId) {
        const existingForStripeId = await tx.abPayment.findFirst({
          where: { invoiceId, stripePaymentId },
        });
        if (existingForStripeId) {
          return { payment: existingForStripeId, alreadyRecorded: true };
        }
      }

      // Row-lock the invoice for the remainder of this transaction. Any
      // concurrent submission against the SAME invoice (manual double-
      // submit, or two Stripe retries with different payment ids) blocks
      // here until this transaction commits or rolls back — so the
      // re-read below is always up to date with any payment that already
      // committed, closing the check-then-act race the pre-transaction
      // balance check had.
      await tx.$queryRaw`SELECT id FROM "plugin_agentbook_invoice"."AbInvoice" WHERE id = ${invoiceId} FOR UPDATE`;

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

      const fullyPaid = (existingPaid + amountCents) >= invoice.amountCents;

      // Create journal entry: debit Cash (net of fees), credit AR
      // If fees: debit Fees Expense, credit Cash (for the fee portion)
      const journalLines: Array<{
        tenantId: string;
        accountId: string;
        debitCents: number;
        creditCents: number;
        description: string;
      }> = [
        {
          tenantId, // G-009
          accountId: cashAccount.id,
          debitCents: amountCents,
          creditCents: 0,
          description: `Cash received - Invoice ${invoice.number}`,
        },
        {
          tenantId, // G-009
          accountId: arAccount.id,
          debitCents: 0,
          creditCents: amountCents,
          description: `AR payment - Invoice ${invoice.number}`,
        },
      ];

      // If there are processing fees, add fee journal lines
      if (fees > 0 && feesAccount) {
        journalLines.push(
          {
            tenantId, // G-009
            accountId: feesAccount.id,
            debitCents: fees,
            creditCents: 0,
            description: `Payment processing fees - Invoice ${invoice.number}`,
          },
          {
            tenantId, // G-009
            accountId: cashAccount.id,
            debitCents: 0,
            creditCents: fees,
            description: `Fees deducted from cash - Invoice ${invoice.number}`,
          },
        );
      }

      const journalEntry = await tx.abJournalEntry.create({
        data: {
          tenantId,
          date: new Date(date || Date.now()),
          memo: `Payment for Invoice ${invoice.number}`,
          sourceType: 'payment',
          verified: true,
          lines: {
            create: journalLines,
          },
        },
      });

      // Create payment record
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

      // Update journal entry sourceId
      await tx.abJournalEntry.update({
        where: { id: journalEntry.id },
        data: { sourceId: pmt.id },
      });

      // Update invoice status if fully paid
      if (fullyPaid) {
        await tx.abInvoice.update({
          where: { id: invoiceId },
          data: { status: 'paid' },
        });
      }

      // Update client totalPaidCents
      await tx.abClient.update({
        where: { id: invoice.clientId },
        data: {
          totalPaidCents: { increment: amountCents },
        },
      });

      // Emit payment.received event
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
            fullyPaid,
            clientId: invoice.clientId,
            clientName: invoice.client.name,
          },
          constraintsPassed: ['balance_invariant'],
          verificationResult: 'passed',
        },
      });

      return { payment: pmt, alreadyRecorded: false };
    });

    res.status(alreadyRecorded ? 200 : 201).json({ success: true, data: payment, alreadyRecorded });
  } catch (err) {
    if (err instanceof PaymentExceedsBalanceError) {
      return res.status(422).json({ success: false, error: err.message });
    }
    res.status(500).json({ success: false, error: String(err) });
  }
});
```

- [ ] **Step 3: Extend the extracted-logic test file with the new decision rules**

In `plugins/agentbook-invoice/backend/src/__tests__/invoice-logic.test.ts`, after the existing `describe('Payment Overpayment Prevention', ...)` block (ends around line 280 — find the block's closing `});` and insert after it), add:

```ts
// ---------------------------------------------------------------------------
// Extracted: idempotent-replay decision for a Stripe-sourced payment
// (server.ts's POST /payments — Launch-gap PR-5, G-5A). Given a payment
// already recorded for this (invoiceId, stripePaymentId) pair, the handler
// must return that existing row (200, alreadyRecorded: true) instead of
// attempting to create a duplicate.
// ---------------------------------------------------------------------------

interface ExistingPaymentLookup {
  stripePaymentId: string | null | undefined;
  existingPayment: { id: string } | null;
}

function decideReplay(input: ExistingPaymentLookup): { isReplay: boolean; paymentId?: string } {
  if (!input.stripePaymentId) return { isReplay: false };
  if (!input.existingPayment) return { isReplay: false };
  return { isReplay: true, paymentId: input.existingPayment.id };
}

describe('Payment Idempotent Replay (Stripe-sourced)', () => {
  it('is not a replay when no stripePaymentId is supplied (manual/cash payment)', () => {
    const result = decideReplay({ stripePaymentId: null, existingPayment: null });
    expect(result.isReplay).toBe(false);
  });

  it('is not a replay when a stripePaymentId is supplied but no existing payment matches it', () => {
    const result = decideReplay({ stripePaymentId: 'pi_123', existingPayment: null });
    expect(result.isReplay).toBe(false);
  });

  it('is a replay when a stripePaymentId is supplied and a payment already exists for it', () => {
    const result = decideReplay({ stripePaymentId: 'pi_123', existingPayment: { id: 'pay_1' } });
    expect(result.isReplay).toBe(true);
    expect(result.paymentId).toBe('pay_1');
  });
});

// ---------------------------------------------------------------------------
// Extracted: balance re-check must use payments read AFTER the row lock is
// acquired, not the pre-transaction read. Confirms the fix's core invariant:
// a second submission that only sees payments committed before it acquired
// the lock is correctly rejected once the first payment is included.
// ---------------------------------------------------------------------------

describe('Payment Balance Re-check Reflects Post-Lock State', () => {
  it('rejects a second concurrent submission once the first payment is visible', () => {
    const invoiceAmountCents = 10000;

    // First submission's pre-transaction read: no payments yet.
    const firstCheck = validatePaymentAmount({
      amountCents: 6000,
      existingPaidCents: 0,
      invoiceAmountCents,
    });
    expect(firstCheck.valid).toBe(true);

    // Second submission's re-check, executed only after acquiring the row
    // lock — by then the first payment has committed, so existingPaidCents
    // reflects it. Without the fix, a second submission's balance check ran
    // against the SAME stale pre-transaction read as the first (both saw
    // existingPaidCents: 0) and could also pass, double-booking cash.
    const secondCheckAfterLock = validatePaymentAmount({
      amountCents: 6000,
      existingPaidCents: 6000, // first payment now committed and visible
      invoiceAmountCents,
    });
    expect(secondCheckAfterLock.valid).toBe(false);
    expect(secondCheckAfterLock.remainingBalance).toBe(4000);
  });
});
```

Note: `validatePaymentAmount` is the function already extracted earlier in this same test file (see "Extracted: Payment overpayment check (server.ts lines 583-589)", signature `(check: { amountCents: number; invoiceAmountCents: number; existingPaidCents: number }) => { valid: boolean; error?: string; remainingBalance?: number }`) — reuse it, do not redefine it.

- [ ] **Step 4: Run the test file**

Run: `cd plugins/agentbook-invoice/backend && npx vitest run src/__tests__/invoice-logic.test.ts`
Expected: all tests pass, including the new `Payment Idempotent Replay` and `Payment Balance Re-check Reflects Post-Lock State` describe blocks.

- [ ] **Step 5: Typecheck the plugin backend**

Run: `cd plugins/agentbook-invoice/backend && npx tsc --noEmit`
Expected: no new errors introduced by this task's edits to `server.ts`.

- [ ] **Step 6: Commit**

```bash
git add plugins/agentbook-invoice/backend/src/server.ts plugins/agentbook-invoice/backend/src/__tests__/invoice-logic.test.ts
git commit -m "fix(invoice): close payment-recording race + add Stripe-replay idempotency"
```

---

### Task 3: Fix Stripe webhook journal-entry account codes

**Files:**
- Modify: `apps/web-next/src/app/api/v1/agentbook/stripe-webhook/handlers.ts` (lines 205–228)
- Modify: `apps/web-next/src/__tests__/api/v1/agentbook/stripe-webhook.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1/2.
- Produces: nothing consumed by other tasks — independent fix.

**Context on the bug:** the `checkout.session.completed` handler looks up `AbAccount` rows with `code: '1010'` (Cash) and `code: '1200'` (intended as AR) — neither code exists in any of the four jurisdiction chart-of-accounts packs (`packages/agentbook-jurisdictions/src/{us,ca,au,uk}/chart-of-accounts.ts`), which all uniformly use `1000` = Cash and `1100` = Accounts Receivable (confirmed by reading all four packs; `1200` exists but is a secondary bank account, not AR). The lookup silently returns `null` for every tenant in every jurisdiction, so the `if (cashAccount && arAccount)` guard is always false and the whole journal-entry block is skipped with no log — the payment is still recorded and the invoice marked paid, but the books never balance. The sibling manual-payment route (`plugins/agentbook-invoice/backend/src/server.ts`, fixed in Task 2) already uses the correct codes `1100`/`1000` via `getAccountByCode`, confirming these are the right values.

- [ ] **Step 1: Fix the account codes and add an observability log for the still-missing case**

In `apps/web-next/src/app/api/v1/agentbook/stripe-webhook/handlers.ts`, replace:

```ts
      // Best-effort journal entry — won't block payment recording if accounts missing.
      try {
        const cashAccount = await prisma.abAccount.findFirst({ where: { tenantId, code: '1010' } });
        const arAccount = await prisma.abAccount.findFirst({ where: { tenantId, code: '1200' } });
        if (cashAccount && arAccount) {
          await prisma.abJournalEntry.create({
            data: {
              tenantId,
              date: new Date(),
              memo: `Stripe payment for ${invoice.number}`,
              sourceType: 'payment',
              sourceId: invoice.id,
              lines: {
                create: [
                  { tenantId, accountId: cashAccount.id, debitCents: amountCents, creditCents: 0 }, // G-009
                  { tenantId, accountId: arAccount.id, debitCents: 0, creditCents: amountCents }, // G-009
                ],
              },
            },
          });
        }
      } catch (err) {
        console.warn('[stripe-webhook] journal entry creation failed (non-fatal):', err);
      }
```

with:

```ts
      // Best-effort journal entry — won't block payment recording if accounts missing.
      // Account codes: 1000 = Cash, 1100 = Accounts Receivable. Uniform across
      // every jurisdiction pack (us/ca/au/uk chart-of-accounts) — see
      // plugins/agentbook-invoice/backend/src/server.ts's getAccountByCode
      // calls in the manual-payment route, which use the same two codes.
      try {
        const cashAccount = await prisma.abAccount.findFirst({ where: { tenantId, code: '1000' } });
        const arAccount = await prisma.abAccount.findFirst({ where: { tenantId, code: '1100' } });
        if (cashAccount && arAccount) {
          await prisma.abJournalEntry.create({
            data: {
              tenantId,
              date: new Date(),
              memo: `Stripe payment for ${invoice.number}`,
              sourceType: 'payment',
              sourceId: invoice.id,
              lines: {
                create: [
                  { tenantId, accountId: cashAccount.id, debitCents: amountCents, creditCents: 0 }, // G-009
                  { tenantId, accountId: arAccount.id, debitCents: 0, creditCents: amountCents }, // G-009
                ],
              },
            },
          });
        } else {
          console.warn(
            `[stripe-webhook] journal entry skipped for invoice ${invoice.number}: ` +
            `Cash (1000) or AR (1100) account not found for tenant ${tenantId}. ` +
            `Payment was still recorded; ensure chart of accounts is seeded.`,
          );
        }
      } catch (err) {
        console.warn('[stripe-webhook] journal entry creation failed (non-fatal):', err);
      }
```

- [ ] **Step 2: Extend the existing webhook test file with `checkout.session.completed` coverage**

In `apps/web-next/src/__tests__/api/v1/agentbook/stripe-webhook.test.ts`, add the following mock functions alongside the existing ones (after line 17, `const billAddOnSubUpdate = vi.fn();`):

```ts
const abPaymentFindFirst = vi.fn();
const abPaymentCreate = vi.fn();
const abInvoiceFindFirst = vi.fn();
const abInvoiceUpdate = vi.fn();
const abAccountFindFirst = vi.fn();
const abJournalEntryCreate = vi.fn();
const abEventCreate = vi.fn();
```

Extend the `vi.mock('@naap/database', ...)` block's `prisma` object (after the existing `billAddOnSubscription` entry, before the closing `},`) to add:

```ts
    abPayment: {
      findFirst: (...a: unknown[]) => abPaymentFindFirst(...a),
      create: (...a: unknown[]) => abPaymentCreate(...a),
    },
    abInvoice: {
      findFirst: (...a: unknown[]) => abInvoiceFindFirst(...a),
      update: (...a: unknown[]) => abInvoiceUpdate(...a),
    },
    abAccount: { findFirst: (...a: unknown[]) => abAccountFindFirst(...a) },
    abJournalEntry: { create: (...a: unknown[]) => abJournalEntryCreate(...a) },
    abEvent: { create: (...a: unknown[]) => abEventCreate(...a) },
```

Add the new mocks to the `beforeEach` reset block (after `billAddOnSubUpdate.mockReset();`):

```ts
  abPaymentFindFirst.mockReset();
  abPaymentCreate.mockReset();
  abInvoiceFindFirst.mockReset();
  abInvoiceUpdate.mockReset();
  abAccountFindFirst.mockReset();
  abJournalEntryCreate.mockReset();
  abEventCreate.mockReset();
```

Then add a new `describe` block at the end of the file, before the final closing `});` of `describe('Stripe webhook', ...)` (i.e. as the last set of `it(...)` blocks inside that describe, after the `'marks a BillAddOnSubscription canceled...'` test):

```ts
  it('checkout.session.completed creates a balanced journal entry using account codes 1000/1100', async () => {
    constructEvent.mockReturnValue({
      id: 'evt_checkout_1',
      type: 'checkout.session.completed',
      data: { object: {
        metadata: { invoiceId: 'inv_1', tenantId: 'tenant-1' },
        payment_intent: 'pi_123',
        amount_total: 50000,
      } },
    });
    billEventCreate.mockResolvedValue({});
    billEventUpdate.mockResolvedValue({});
    abPaymentFindFirst.mockResolvedValue(null); // no existing payment for this PaymentIntent
    abInvoiceFindFirst.mockResolvedValue({ id: 'inv_1', number: 'INV-2026-0001', amountCents: 50000, status: 'sent' });
    abPaymentCreate.mockResolvedValue({});
    abInvoiceUpdate.mockResolvedValue({});
    abAccountFindFirst.mockImplementation(async ({ where }: { where: { code: string } }) => {
      if (where.code === '1000') return { id: 'acct-cash' };
      if (where.code === '1100') return { id: 'acct-ar' };
      return null;
    });
    abJournalEntryCreate.mockResolvedValue({});
    abEventCreate.mockResolvedValue({});

    const r = await POST(req('{}', 'sig'));

    expect(r.status).toBe(200);
    expect(abAccountFindFirst).toHaveBeenCalledWith({ where: { tenantId: 'tenant-1', code: '1000' } });
    expect(abAccountFindFirst).toHaveBeenCalledWith({ where: { tenantId: 'tenant-1', code: '1100' } });
    expect(abJournalEntryCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        lines: {
          create: [
            { tenantId: 'tenant-1', accountId: 'acct-cash', debitCents: 50000, creditCents: 0 },
            { tenantId: 'tenant-1', accountId: 'acct-ar', debitCents: 0, creditCents: 50000 },
          ],
        },
      }),
    }));
  });

  it('checkout.session.completed records the payment even when accounts 1000/1100 are missing (best-effort, non-fatal)', async () => {
    constructEvent.mockReturnValue({
      id: 'evt_checkout_2',
      type: 'checkout.session.completed',
      data: { object: {
        metadata: { invoiceId: 'inv_2', tenantId: 'tenant-2' },
        payment_intent: 'pi_456',
        amount_total: 25000,
      } },
    });
    billEventCreate.mockResolvedValue({});
    billEventUpdate.mockResolvedValue({});
    abPaymentFindFirst.mockResolvedValue(null);
    abInvoiceFindFirst.mockResolvedValue({ id: 'inv_2', number: 'INV-2026-0002', amountCents: 25000, status: 'sent' });
    abPaymentCreate.mockResolvedValue({});
    abInvoiceUpdate.mockResolvedValue({});
    abAccountFindFirst.mockResolvedValue(null); // chart of accounts not seeded for this tenant
    abEventCreate.mockResolvedValue({});

    const r = await POST(req('{}', 'sig'));

    expect(r.status).toBe(200);
    expect(abJournalEntryCreate).not.toHaveBeenCalled();
    expect(abPaymentCreate).toHaveBeenCalledTimes(1);
    expect(abInvoiceUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: { status: 'paid' },
    }));
  });

  it('checkout.session.completed is idempotent on a retried PaymentIntent', async () => {
    constructEvent.mockReturnValue({
      id: 'evt_checkout_3',
      type: 'checkout.session.completed',
      data: { object: {
        metadata: { invoiceId: 'inv_3', tenantId: 'tenant-3' },
        payment_intent: 'pi_789',
        amount_total: 10000,
      } },
    });
    billEventCreate.mockResolvedValue({});
    billEventUpdate.mockResolvedValue({});
    abPaymentFindFirst.mockResolvedValue({ id: 'existing-payment' }); // already recorded

    const r = await POST(req('{}', 'sig'));

    expect(r.status).toBe(200);
    expect(abPaymentCreate).not.toHaveBeenCalled();
    expect(abInvoiceFindFirst).not.toHaveBeenCalled();
  });
```

- [ ] **Step 3: Run the test file**

Run: `cd apps/web-next && npx vitest run src/__tests__/api/v1/agentbook/stripe-webhook.test.ts`
Expected: all tests pass, including the 3 new `checkout.session.completed` cases.

- [ ] **Step 4: Commit**

```bash
git add apps/web-next/src/app/api/v1/agentbook/stripe-webhook/handlers.ts apps/web-next/src/__tests__/api/v1/agentbook/stripe-webhook.test.ts
git commit -m "fix(billing): correct Stripe webhook journal-entry account codes (1010/1200 -> 1000/1100)"
```

---

### Task 4: Fix skill-routing determinism (create-invoice vs. record-expense)

**Files:**
- Modify: `plugins/agentbook-core/backend/src/skill-routing.ts` (add a new shared constant)
- Modify: `plugins/agentbook-core/backend/src/built-in-skills.ts` (create-invoice's trigger, record-expense's excludePatterns)
- Modify: `plugins/agentbook-core/backend/src/agent-brain.ts` (line 957 `findMany` call)
- Modify: `plugins/agentbook-core/backend/src/server.ts` (lines 2922 and 5815 `findMany` calls)
- Create: `plugins/agentbook-core/backend/src/__tests__/skill-manifest-query-order.test.ts` (assert the new `orderBy`)

**Interfaces:**
- Consumes: nothing from Task 1/2/3.
- Produces: `CREATE_INVOICE_TRIGGER_PATTERN` (new named export from `skill-routing.ts`) — a regex string, reused by both `create-invoice`'s `triggerPatterns` and `record-expense`'s `excludePatterns` in `built-in-skills.ts` so the two can never drift apart.

**Context on the bug:** `create-invoice`'s trigger (`'invoice .+ \\$'`) and `record-expense`'s triggers (`'\\$\\d'` etc.) both match "invoice Acme $5000 for consulting". `record-expense`'s existing `excludePatterns` already defer to `create-invoice` for "to invoice"/"invoice to" phrasing and explicit creation verbs ("send/create/issue/write/prepare/make/draft an invoice") — added for a prior bug (F4-03) — but not for this bare "invoice `<name>` `$<amount>`" imperative shape, which is exactly `create-invoice`'s own trigger shape. Confirmed live: `plugins/agentbook-core/backend/src/__tests__/skill-routing-canonical.test.ts` already has a case for this exact phrase (`{ text: 'invoice Acme $5000 for consulting', expected: 'create-invoice' }`, line ~79) and it currently fails (`record-expense` wins, confirmed by running `npx vitest run src/__tests__/skill-routing-canonical.test.ts -t "invoice Acme"` against a clean worktree at HEAD `5dd49b9c`). Separately, none of the three `AbSkillManifest.findMany()` call sites that feed skill routing have an `orderBy`, so which of two matching skills' array position comes first depends on undefined DB row order — adding `orderBy: { name: 'asc' }` makes this deterministic regardless of DB internals (defense-in-depth; the exclude-pattern fix above is what makes the *outcome* correct, not just deterministic).

- [ ] **Step 1: Add the shared trigger-pattern constant**

In `plugins/agentbook-core/backend/src/skill-routing.ts`, after the existing `TAX_FAST_TRACK_TRIGGER_PATTERNS` export (after line 175, before `function toStringArray`), add:

```ts
/**
 * create-invoice's triggerPatterns (built-in-skills.ts), re-exported so
 * record-expense's excludePatterns can reuse the exact same regex rather
 * than approximating it. Both '\\$\\d' (record-expense's own trigger) and
 * 'invoice .+ \\$' (create-invoice's trigger) match a bare imperative like
 * "invoice Acme $5000 for consulting" — record-expense's excludePatterns
 * already defer to create-invoice for "to invoice"/"invoice to" and
 * explicit creation verbs (F4-03), but not for this bare
 * "invoice <name> $<amount>" shape, which is create-invoice's own trigger
 * shape. Reusing the same pattern as an exclude guarantees the two skills
 * can never both match, regardless of array order (see the `orderBy`
 * additions in agent-brain.ts/server.ts for why array order can't be
 * trusted in the first place — Launch-gap PR-5).
 */
export const CREATE_INVOICE_TRIGGER_PATTERN = 'invoice .+ \\$';
```

- [ ] **Step 2: Use the constant in both manifests**

In `plugins/agentbook-core/backend/src/built-in-skills.ts`, add the import at the top of the file (alongside the existing imports from `./skill-routing.js` — find the existing import line for `BUSINESS_PHRASE_PATTERN`/`PERSONAL_ACCOUNT_CUE_PATTERN` and add `CREATE_INVOICE_TRIGGER_PATTERN` to the same import list).

Then change `record-expense`'s `excludePatterns` (line 69) from:

```ts
    excludePatterns: ['\\bto\\s+invoice\\b|\\binvoice\\s+to\\b|\\b(?:send|create|issue|write|prepare|make|draft)\\s+(?:an?\\s+)?invoice\\b', 'what\\s*if\\b', 'got.*\\$.*from', 'alert.*when|notify.*when|automat', 'received.*payment', '^(?:estimate|quote|proposal)\\s', 'is.*taxable|scholarship|fellowship|grant.*taxable|t2202|1098-?t|aotc|american opportunity|lifetime learning|tuition.*credit|education.*credit|\\bresp\\b|\\b529\\b', 'nonresident alien|non-resident alien|1040-?nr|sprintax|glacier tax|1042-?s|fica exempt|international student.*tax|tax treaty',
      `^(?!.*(?:${BUSINESS_PHRASE_PATTERN})).*(?:${PERSONAL_ACCOUNT_CUE_PATTERN})`,
    ],
```

to:

```ts
    excludePatterns: ['\\bto\\s+invoice\\b|\\binvoice\\s+to\\b|\\b(?:send|create|issue|write|prepare|make|draft)\\s+(?:an?\\s+)?invoice\\b', CREATE_INVOICE_TRIGGER_PATTERN, 'what\\s*if\\b', 'got.*\\$.*from', 'alert.*when|notify.*when|automat', 'received.*payment', '^(?:estimate|quote|proposal)\\s', 'is.*taxable|scholarship|fellowship|grant.*taxable|t2202|1098-?t|aotc|american opportunity|lifetime learning|tuition.*credit|education.*credit|\\bresp\\b|\\b529\\b', 'nonresident alien|non-resident alien|1040-?nr|sprintax|glacier tax|1042-?s|fica exempt|international student.*tax|tax treaty',
      `^(?!.*(?:${BUSINESS_PHRASE_PATTERN})).*(?:${PERSONAL_ACCOUNT_CUE_PATTERN})`,
    ],
```

And change `create-invoice`'s `triggerPatterns` (line 129) from:

```ts
    triggerPatterns: ['invoice .+ \\$'],
```

to:

```ts
    triggerPatterns: [CREATE_INVOICE_TRIGGER_PATTERN],
```

- [ ] **Step 3: Run the canonical routing test to confirm the fix**

Run: `cd plugins/agentbook-core/backend && npx vitest run src/__tests__/skill-routing-canonical.test.ts`
Expected: all tests pass, including `"invoice Acme $5000 for consulting" -> create-invoice` (previously failing). No other case in this file regresses (none of the other 30+ canonical cases contain the word "invoice", so `CREATE_INVOICE_TRIGGER_PATTERN` as a new exclude on `record-expense` cannot affect them).

- [ ] **Step 4: Add deterministic `orderBy` to the three routing-relevant `findMany` call sites**

In `plugins/agentbook-core/backend/src/agent-brain.ts`, change (around line 957):

```ts
    db.abSkillManifest.findMany({
      where: { enabled: true, OR: [{ tenantId: null }, { tenantId }] },
    }),
```

to:

```ts
    db.abSkillManifest.findMany({
      where: { enabled: true, OR: [{ tenantId: null }, { tenantId }] },
      orderBy: { name: 'asc' }, // deterministic array order — see CREATE_INVOICE_TRIGGER_PATTERN's comment in skill-routing.ts for why correctness never depends on this (Launch-gap PR-5)
    }),
```

In `plugins/agentbook-core/backend/src/server.ts`, apply the identical change at both remaining call sites (around line 2922):

```ts
      skills || db.abSkillManifest.findMany({
        where: { enabled: true, OR: [{ tenantId: null }, { tenantId }] },
      }),
```

becomes:

```ts
      skills || db.abSkillManifest.findMany({
        where: { enabled: true, OR: [{ tenantId: null }, { tenantId }] },
        orderBy: { name: 'asc' },
      }),
```

and around line 5815:

```ts
        skills: await db.abSkillManifest.findMany({
          where: { enabled: true, OR: [{ tenantId: null }, { tenantId }] },
        }),
```

becomes:

```ts
        skills: await db.abSkillManifest.findMany({
          where: { enabled: true, OR: [{ tenantId: null }, { tenantId }] },
          orderBy: { name: 'asc' },
        }),
```

- [ ] **Step 5: Add a new, self-contained test asserting the `orderBy`**

Create `plugins/agentbook-core/backend/src/__tests__/skill-manifest-query-order.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildTestContext } from './helpers/test-context';

/**
 * Launch-gap PR-5, G-5C: AbSkillManifest.findMany() must request a
 * deterministic row order (`orderBy: { name: 'asc' }`) — without it, which
 * of two colliding skills' array position comes first depends on undefined
 * DB row order. This doesn't make the routing OUTCOME correct by itself
 * (see skill-routing-canonical.test.ts and CREATE_INVOICE_TRIGGER_PATTERN's
 * comment in skill-routing.ts for the actual correctness fix) — it only
 * guarantees production's row order matches whatever this plan fixed it to,
 * rather than depending on Postgres internals.
 */

const skillManifestFindMany = vi.fn(async () => []);

vi.mock('../db/client.js', () => ({
  db: {
    abConversation: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []), create: vi.fn(async () => ({})) },
    abAgentSession: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({ count: 0 })) },
    abTaxQuestionnaireSession: { findFirst: vi.fn(async () => null), updateMany: vi.fn(async () => ({ count: 0 })) },
    abTenantConfig: { findFirst: vi.fn(async () => null) },
    abUserMemory: { findMany: vi.fn(async () => []) },
    abSkillManifest: { findMany: skillManifestFindMany },
    abEvent: { create: vi.fn(async () => ({})) },
    $executeRaw: vi.fn(async () => 1),
  },
}));

beforeEach(() => {
  skillManifestFindMany.mockClear();
});

describe('AbSkillManifest.findMany — deterministic order (Launch-gap PR-5)', () => {
  it('requests rows ordered by name ascending', async () => {
    const harness = buildTestContext({
      text: 'spent $5 on coffee',
      tenantId: 'tenant-order-check',
      classification: {
        selectedSkill: { name: 'record-expense', endpoint: { method: 'POST', path: '/expenses' } },
        extractedParams: { amountCents: 500 },
        confidence: 0.9,
      },
      skillResponses: { 'POST /expenses': { data: { id: 'exp-1' } } },
    });

    const { handleAgentMessage } = await import('../agent-brain');
    await handleAgentMessage(harness.req as any, harness.ctx as any);

    expect(skillManifestFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { name: 'asc' } }),
    );
  });
});
```

This is deliberately a new, self-contained file rather than an edit to `agent-brain-confirm-flow.test.ts` — that file's mock choreography (the shared `mockState` object, the manual `$executeRaw` patching) is delicate and scenario-specific to the confirm/execute flow it tests; a fresh, minimal mock avoids any risk of disturbing it.

- [ ] **Step 6: Run the new test file**

Run: `cd plugins/agentbook-core/backend && npx vitest run src/__tests__/skill-manifest-query-order.test.ts`
Expected: the test passes, confirming `agent-brain.ts`'s `db.abSkillManifest.findMany` call now includes `orderBy: { name: 'asc' }`.

- [ ] **Step 7: Typecheck**

Run: `cd plugins/agentbook-core/backend && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 8: Commit**

```bash
git add plugins/agentbook-core/backend/src/skill-routing.ts plugins/agentbook-core/backend/src/built-in-skills.ts plugins/agentbook-core/backend/src/agent-brain.ts plugins/agentbook-core/backend/src/server.ts plugins/agentbook-core/backend/src/__tests__/skill-manifest-query-order.test.ts
git commit -m "fix(routing): create-invoice/record-expense collision + deterministic AbSkillManifest order"
```

---

### Task 5: Full verification, PR, and production rollout

**Files:** none (verification-only task).

**Interfaces:** none.

- [ ] **Step 1: Run every affected package's full test suite**

```bash
cd plugins/agentbook-invoice/backend && npx vitest run
cd plugins/agentbook-core/backend && npx vitest run
cd apps/web-next && npx vitest run
```

Expected: no failures beyond any already-established pre-existing/unrelated failures (confirm any failure is present on a clean `origin/main` checkout before treating it as pre-existing, per this session's established practice).

- [ ] **Step 2: Typecheck the whole affected surface**

```bash
cd apps/web-next && npx tsc --noEmit
cd plugins/agentbook-invoice/backend && npx tsc --noEmit
cd plugins/agentbook-core/backend && npx tsc --noEmit
```

Expected: no new errors introduced by this branch.

- [ ] **Step 3: Manual concurrency check against an isolated Postgres**

This exercises the real race-condition fix from Task 2, which a mocked unit test cannot: two near-simultaneous HTTP calls against a live Express instance.

```bash
docker run --rm -d -p 55433:5432 -e POSTGRES_PASSWORD=postgres --name pr5-race-check postgres:16
sleep 3
DATABASE_URL="postgresql://postgres:postgres@localhost:55433/racecheck" \
DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@localhost:55433/racecheck" \
  npx prisma migrate deploy --schema packages/database/prisma/schema.prisma
```

Seed one tenant with one client, one $100 invoice, and a minimal chart of accounts (codes 1000, 1100) directly via a short throwaway script using `@naap/database`'s `prisma` client pointed at this DB. Start the invoice backend against this DB (`DATABASE_URL=... PORT=4052 npx tsx plugins/agentbook-invoice/backend/src/server.ts`). Fire two concurrent `POST /api/v1/agentbook-invoice/payments` requests for $60 each (combined $120 exceeds the $100 invoice) with no `stripePaymentId`, using `Promise.all` from a short script or two parallel `curl` backgrounded processes. Confirm: exactly one request succeeds (`201`), the other fails with `422` and the "exceeds remaining balance" message; querying `AbPayment` for the invoice shows exactly one row; `AbClient.totalPaidCents` reflects exactly one $60 increment. Then repeat with two requests carrying the SAME `stripePaymentId` for a $50 payment: confirm exactly one `AbPayment` row exists afterward (the second returns `200` with `alreadyRecorded: true`, not a duplicate).

```bash
docker stop pr5-race-check
```

- [ ] **Step 4: Final whole-branch review**

Dispatch a code-reviewer subagent on the most capable available model, pointed at the full diff from `origin/main` to this branch's HEAD. Ask it to specifically verify: (a) the row lock in Task 2 is acquired before the balance re-read, not after; (b) Task 3's account codes match all four jurisdiction packs; (c) Task 4's `CREATE_INVOICE_TRIGGER_PATTERN` reuse means the two manifests can never drift; (d) no other call site of the manual-payment route or the Stripe webhook handler was missed.

- [ ] **Step 5: Push, open PR, wait for CI**

Follow this session's established pattern: push the branch, open a PR describing all three fixes, wait for CI. The chronic pre-existing `Audit`/`Build`/`Quality-Gates`/`Shell-Tests` failure (caused by `DATABASE_URL` pointing at `localhost:5432` in CI with no real DB) is expected and safe to merge past once confirmed unrelated to this branch's diff — verify via `gh run view --job --log` before merging, same as prior PRs this session.

- [ ] **Step 6: Production rollout**

After merge: run the new migration (Task 1) against production as its own explicit, separately-confirmed step — BEFORE the code deploy, per this session's established practice for schema changes reaching production. Then deploy via the established `vercel pull/build/deploy --prebuilt --prod` flow. Manually verify: record a manual payment against a real invoice in production and confirm a journal entry now appears (Bug B/Task 3's fix, exercised end-to-end); confirm the skill-routing fix by sending "invoice Acme $500 for consulting" through the chat/Telegram interface and confirming it creates an invoice rather than an expense.
