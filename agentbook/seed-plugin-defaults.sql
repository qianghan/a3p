-- Reset the plugin registry to AgentBook-as-default.
--
-- Two registries cooperate:
--   WorkflowPlugin  — the global plugin list. /api/v1/base/plugins/personalized
--                     filters where enabled=true.
--   PluginPackage   — `isCore=true` marks plugins that get auto-installed into
--                     UserPluginPreference on a user's first /personalized hit.
--
-- This script:
--   1. Enables only the 5 AgentBook plugins in WorkflowPlugin (others disabled).
--   2. Marks those 5 as isCore in PluginPackage (others demoted).
--   3. Wipes UserPluginPreference so the auto-install path re-runs and seeds
--      every user with AgentBook on next page load.
--
-- Idempotent: re-running has no further effect.
--
-- Run against the naap Neon project (a3book.brainliber.com).
--
-- Usage:
--   psql "$DATABASE_URL_UNPOOLED" -f agentbook/seed-plugin-defaults.sql

BEGIN;

UPDATE "WorkflowPlugin"
SET enabled = false
WHERE name NOT LIKE 'agentbook%';

UPDATE "WorkflowPlugin"
SET enabled  = true,
    "order"  = CASE name
      WHEN 'agentbookCore'    THEN 0
      WHEN 'agentbookExpense' THEN 1
      WHEN 'agentbookInvoice' THEN 2
      WHEN 'agentbookTax'     THEN 3
      WHEN 'agentbookBilling' THEN 4
      ELSE "order"
    END
WHERE name LIKE 'agentbook%';

UPDATE "PluginPackage"
SET "isCore" = false
WHERE name NOT LIKE 'agentbook%';

UPDATE "PluginPackage"
SET "isCore" = true
WHERE name LIKE 'agentbook%';

DELETE FROM "UserPluginPreference"
WHERE "pluginName" NOT LIKE 'agentbook%';

COMMIT;

\echo 'Enabled WorkflowPlugin rows:'
SELECT name, "order" FROM "WorkflowPlugin" WHERE enabled = true ORDER BY "order";
\echo 'Core PluginPackage rows:'
SELECT name FROM "PluginPackage" WHERE "isCore" = true ORDER BY name;
\echo 'Remaining UserPluginPreference rows (non-AgentBook):'
SELECT COUNT(*) FROM "UserPluginPreference" WHERE "pluginName" NOT LIKE 'agentbook%';
