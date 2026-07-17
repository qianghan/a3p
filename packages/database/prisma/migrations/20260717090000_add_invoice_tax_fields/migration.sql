-- Migration: AbInvoice.taxRate / AbInvoice.taxCents (Launch-gap PR-6, G-6A)
--
-- Purely additive — no pre-flight dedup needed (unlike PR-5's unique-
-- constraint migration). taxCents defaults to 0 so every existing invoice
-- row is unaffected (amountCents keeps meaning "grand total", now simply
-- with an implicit taxCents of 0 for pre-existing rows). taxRate is
-- nullable with no default, meaning "no tax jurisdiction applied" for all
-- existing rows.

ALTER TABLE "plugin_agentbook_invoice"."AbInvoice"
  ADD COLUMN IF NOT EXISTS "taxRate" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "taxCents" INTEGER NOT NULL DEFAULT 0;
