-- Migration: AbBankAccount.accessTokenEnc + cursorToken (G-019)
--
-- Wave 3 PR 16:
--   Persist Plaid access tokens encrypted-at-rest on the AbBankAccount row
--   so that Vercel cold starts don't drop them (the old code stashed them
--   in a process-local `const plaidAccessTokens = {}` Map, which silently
--   evaporated on every cold start, causing /bank-sync to return
--   "0 imported" with no error).
--
--   The legacy plugin backend (Express) now uses the same AES-256-GCM
--   helper that the Next.js path already uses (apps/web-next/src/lib/
--   agentbook-bank-token.ts), populating the same `accessTokenEnc` column.
--
--   `cursorToken` is added at the same time so the legacy backend can
--   migrate to Plaid's /transactions/sync cursor model in a follow-up (the
--   Next.js path already uses it). Both columns are nullable so existing
--   rows survive the migration; users without an encrypted token on file
--   will need to re-link via Plaid Link.
--
-- Idempotent: uses IF NOT EXISTS so re-running against a DB that already
-- received these columns via `prisma db push` is a no-op.

ALTER TABLE "plugin_agentbook_expense"."AbBankAccount"
  ADD COLUMN IF NOT EXISTS "accessTokenEnc" TEXT;

ALTER TABLE "plugin_agentbook_expense"."AbBankAccount"
  ADD COLUMN IF NOT EXISTS "cursorToken" TEXT;
