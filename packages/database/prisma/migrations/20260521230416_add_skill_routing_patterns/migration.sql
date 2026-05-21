-- Migration: Add requirePatterns and excludePatterns to AbSkillManifest (G-011)
--
-- Wave 2 PR 10: replaces the hardcoded per-skill regex exclusion chain in
-- classifyAndExecuteV1 (server.ts) with manifest-driven routing.
--
-- New fields are optional string arrays; existing rows default to empty arrays
-- (semantically: no constraint). After this migration applies, callers should
-- POST /api/v1/agentbook-core/agent/seed-skills to backfill the new fields
-- onto existing AbSkillManifest rows from BUILT_IN_SKILLS.

ALTER TABLE "plugin_agentbook_core"."AbSkillManifest"
  ADD COLUMN "requirePatterns" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "plugin_agentbook_core"."AbSkillManifest"
  ADD COLUMN "excludePatterns" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
