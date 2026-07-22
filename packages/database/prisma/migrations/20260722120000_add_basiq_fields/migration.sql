-- Migration: Basiq bank-sync fields (AU-1 task 1)
--
-- Basiq is a CDR-accredited Australian data provider, added as a new,
-- parallel bank-sync path alongside Plaid (Plaid does not support AU banks).
-- This migration is purely additive:
--   - AbTenantConfig.basiqUserId: Basiq's tenant-level user resource id,
--     created lazily on first AU bank-connect attempt.
--   - AbBankAccount / AbPersonalAccount: `provider` (default "plaid", so
--     every existing row is unaffected and reads as "plaid"), plus
--     `basiqAccountId` (unique, nullable) and `basiqConnectionId` (nullable)
--     for Basiq-linked accounts.
--   - AbBankTransaction / AbPersonalTransaction: `basiqTransactionId`
--     (unique, nullable) mirroring the existing `plaidTransactionId` column,
--     used as the upsert key for Basiq-sourced transactions.
--
-- No existing Plaid column is altered, renamed, or dropped. `provider` is
-- the only NOT NULL column added, and it carries a default so every
-- pre-existing row backfills to "plaid" automatically.
--
-- Idempotent: uses IF NOT EXISTS / guarded index creation so re-running
-- against a DB that already received these columns via `prisma db push` is
-- a no-op — mirrors the existing 20260521260000_add_plaid_access_token_enc
-- migration's style.

ALTER TABLE "plugin_agentbook_core"."AbTenantConfig"
  ADD COLUMN IF NOT EXISTS "basiqUserId" TEXT;

ALTER TABLE "plugin_agentbook_expense"."AbBankAccount"
  ADD COLUMN IF NOT EXISTS "provider" TEXT NOT NULL DEFAULT 'plaid';

ALTER TABLE "plugin_agentbook_expense"."AbBankAccount"
  ADD COLUMN IF NOT EXISTS "basiqAccountId" TEXT;

ALTER TABLE "plugin_agentbook_expense"."AbBankAccount"
  ADD COLUMN IF NOT EXISTS "basiqConnectionId" TEXT;

ALTER TABLE "plugin_agentbook_expense"."AbBankTransaction"
  ADD COLUMN IF NOT EXISTS "basiqTransactionId" TEXT;

ALTER TABLE "plugin_agentbook_personal"."AbPersonalAccount"
  ADD COLUMN IF NOT EXISTS "provider" TEXT NOT NULL DEFAULT 'plaid';

ALTER TABLE "plugin_agentbook_personal"."AbPersonalAccount"
  ADD COLUMN IF NOT EXISTS "basiqAccountId" TEXT;

ALTER TABLE "plugin_agentbook_personal"."AbPersonalAccount"
  ADD COLUMN IF NOT EXISTS "basiqConnectionId" TEXT;

ALTER TABLE "plugin_agentbook_personal"."AbPersonalTransaction"
  ADD COLUMN IF NOT EXISTS "basiqTransactionId" TEXT;

-- Unique indexes for the Basiq resource ids used as upsert keys.
CREATE UNIQUE INDEX IF NOT EXISTS "AbBankAccount_basiqAccountId_key"
  ON "plugin_agentbook_expense"."AbBankAccount"("basiqAccountId");

CREATE UNIQUE INDEX IF NOT EXISTS "AbBankTransaction_basiqTransactionId_key"
  ON "plugin_agentbook_expense"."AbBankTransaction"("basiqTransactionId");

CREATE UNIQUE INDEX IF NOT EXISTS "AbPersonalAccount_basiqAccountId_key"
  ON "plugin_agentbook_personal"."AbPersonalAccount"("basiqAccountId");

CREATE UNIQUE INDEX IF NOT EXISTS "AbPersonalTransaction_basiqTransactionId_key"
  ON "plugin_agentbook_personal"."AbPersonalTransaction"("basiqTransactionId");
