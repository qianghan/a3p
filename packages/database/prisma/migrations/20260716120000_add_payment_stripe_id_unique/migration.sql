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
