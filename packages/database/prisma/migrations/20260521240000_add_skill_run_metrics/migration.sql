-- Migration: Add AbSkillRun for per-skill metrics (G-016)
--
-- Wave 2 PR 14: writes a metric row per classify→execute. Powers the
-- /agent/skills/metrics aggregation endpoint (success rate, p50/p95 latency,
-- error breakdown per skill). Closes the -2 auto-deduction on Tier 1 #2.
--
-- Note: this DDL is what `prisma db push` already applied in dev. Captured here
-- as a SQL migration so prod deploys (and future shadow-DB runs) replay it.

CREATE TABLE IF NOT EXISTS "plugin_agentbook_core"."AbSkillRun" (
  "id"           TEXT PRIMARY KEY,
  "tenantId"     TEXT NOT NULL,
  "skillName"    TEXT NOT NULL,
  "status"       TEXT NOT NULL,
  "durationMs"   INTEGER NOT NULL,
  "confidence"   DOUBLE PRECISION,
  "tokenCost"    INTEGER,
  "errorType"    TEXT,
  "errorMessage" TEXT,
  "channel"      TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "AbSkillRun_tenantId_createdAt_idx"
  ON "plugin_agentbook_core"."AbSkillRun" ("tenantId", "createdAt");

CREATE INDEX IF NOT EXISTS "AbSkillRun_skillName_status_createdAt_idx"
  ON "plugin_agentbook_core"."AbSkillRun" ("skillName", "status", "createdAt");
