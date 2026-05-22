-- Migration: AbHttpIdempotencyKey + AbJournalEntry unique constraint (G-020, G-021)
--
-- Wave 3 PR 15:
--   1. New table `AbHttpIdempotencyKey` — backs the `withHttpIdempotency`
--      wrapper on the four financial POST endpoints
--      (journal-entries, expenses, invoices, payments). Caches the
--      response for replay-on-retry and rejects same-key-different-body
--      requests with 422.
--   2. Unique constraint `(tenantId, sourceType, sourceId)` on
--      `AbJournalEntry` — prevents cron retries / webhook replays from
--      posting duplicate journal entries for the same source.
--      Postgres treats NULL as distinct in unique constraints, so manual
--      entries (sourceId IS NULL) are NOT subject to the constraint.
--
-- Pre-flight: in dev, dedup any pre-existing duplicates before the
-- constraint is created. In prod, the same dedup is safe to re-run.

-- ---------------------------------------------------------------------
-- 1. Deduplicate any pre-existing AbJournalEntry rows that would violate
--    the new constraint. Keep the oldest by createdAt; delete the rest.
--    Restricted to rows where sourceId IS NOT NULL — NULL pairs are not
--    constrained.
-- ---------------------------------------------------------------------
WITH dups AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY "tenantId", "sourceType", "sourceId"
      ORDER BY "createdAt" ASC, "id" ASC
    ) AS rn
  FROM "plugin_agentbook_core"."AbJournalEntry"
  WHERE "sourceId" IS NOT NULL
)
DELETE FROM "plugin_agentbook_core"."AbJournalEntry"
WHERE id IN (SELECT id FROM dups WHERE rn > 1);

-- ---------------------------------------------------------------------
-- 2. Unique constraint on AbJournalEntry.
--    Postgres treats NULL as distinct, so multiple manual entries with
--    sourceId=NULL coexist; only non-NULL sourceIds get deduped.
-- ---------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS "AbJournalEntry_tenantId_sourceType_sourceId_key"
  ON "plugin_agentbook_core"."AbJournalEntry" ("tenantId", "sourceType", "sourceId");

-- ---------------------------------------------------------------------
-- 3. AbHttpIdempotencyKey table.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "plugin_agentbook_core"."AbHttpIdempotencyKey" (
  "id"           TEXT PRIMARY KEY,
  "tenantId"     TEXT NOT NULL,
  "key"          TEXT NOT NULL,
  "endpoint"     TEXT NOT NULL,
  "requestHash"  TEXT NOT NULL,
  "responseJson" TEXT NOT NULL,
  "status"       INTEGER NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"    TIMESTAMP(3) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "AbHttpIdempotencyKey_tenantId_key_endpoint_key"
  ON "plugin_agentbook_core"."AbHttpIdempotencyKey" ("tenantId", "key", "endpoint");

CREATE INDEX IF NOT EXISTS "AbHttpIdempotencyKey_expiresAt_idx"
  ON "plugin_agentbook_core"."AbHttpIdempotencyKey" ("expiresAt");
